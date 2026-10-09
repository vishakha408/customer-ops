# About — AI-Powered Customer Operations System
---

## 1. Workflow Walkthrough

### 1.1 Architecture at a glance

Three cooperating layers, connected by Supabase as the single source of truth:

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Orchestration | **n8n** (`AI Customer Operations Pipeline`, 31 nodes) | Intake, customer lookup, prompt assembly, AI call, routing, email, status writes |
| Intelligence | **Claude (Anthropic)** via the n8n *AI Agent* node (`claude-sonnet-4-5-20250929`) | intent, category, priority, sentiment, summary, recommended action, decision, draft reply |
| Data | **Supabase (Postgres)** | `customers`, `requests`, `request_activities`, triggers, `dashboard_metrics()` RPC |
| Communication | **Gmail (OAuth2)** | customer replies, internal review alerts, failure alerts, "mark as read" |
| Frontend | **Next.js 14 + TypeScript** | monitoring dashboard, human intervention controls, alternative intake |

### 1.2 Key nodes (in execution order)

| # | Node | Type | What it does |
| --- | --- | --- | --- |
| 1 | `Gmail Trigger` | Gmail Trigger | Polls the support inbox every minute for `INBOX` + `unread` messages (Simplify = off, so raw MIME is available) |
| 1 | `Webhook Intake` | Webhook | `POST /webhook/customer-ops-intake` — the programmatic entry point used by the dashboard and external systems (`responseMode: onReceived`) |
| 2 | `Normalize Request` | Code | Converts either entry point into one canonical shape `{email, name, subject, body, threadId, messageId, requestId, source, intakeWarnings[]}` — base64url decoding of Gmail MIME parts, HTML stripping, `Name <addr>` parsing, default subject, 8 000-char body cap, sender validation. Also rejects webhook calls whose `x-webhook-secret` header does not match `N8N_WEBHOOK_SECRET` (when configured) |
| 3 | `Find Customer` | Supabase | `select * from customers where email = ? limit 1` (`alwaysOutputData` so a miss doesn't break the branch) |
| 4 | `Customer Found?` | IF | `true → Prepare Context`, `false → Create Customer` (new senders get a stub CRM record) |
| 5 | `Create Customer` | Supabase | Inserts `email` + `full_name`; `onError: continueRegularOutput` so a race (duplicate email) degrades to `customer: null` instead of failing |
| 6 | `Prepare Context` | Code | Builds the AI prompt payload (see §1.4) and the column-aligned row for the `requests` insert |
| 7 | `Existing Request?` | IF | `true` (dashboard/webhook payload carries the `requestId` stamped by the intake API) → `Update Existing Request`; `false` (Gmail) → `Create Request` |
| 7a | `Create Request` | Supabase | Inserts the request with `status = 'analyzing'`; `onError: continueErrorOutput` → failure branch |
| 7b | `Update Existing Request` | Supabase | Updates the row already stored by the intake API to `status = 'analyzing'` — prevents duplicate request rows for forwarded requests |
| 7c | `Intake Failure Alert` → `Send Intake Failure Alert` | Set + Gmail | Error branch: ops email containing the sender, subject and the raw error — nothing disappears silently |
| 8 | `Log Request Created` | Supabase | Timeline row `type=intake, actor=n8n` |
| 9 | `Mark Email Read` | Gmail | `markAsRead` on the processed message so the poller never picks it up twice (`continue on fail`, so webhook runs skip it gracefully) |
| 10 | `AI Agent` | LangChain Agent | The Claude call — prompt = the `context` JSON, system message = the analysis contract. `retryOnFail`, `maxTries: 3`, `waitBetweenTries: 5000`, `onError: continueErrorOutput` |
| 10b | `Anthropic Claude` | LM Chat (Anthropic) | Model credential attached over the `ai_languageModel` handle — `claude-sonnet-4-5-20250929` |
| 11 | `AI Failure Handler` | Code | Normalises the error output to `{output:'', aiError:'…'}` so `Parse Analysis` sees the same shape whether the model succeeded or failed |
| 12 | `Parse Analysis` | Code | JSON extraction, allow-list validation, and **all** safety guardrails (§2) |
| 13 | `Log Analysis` | Supabase | Timeline row `type=analysis, actor=agent` with intent/category/priority/sentiment/decision/confidence |
| 14 | `Requires Human?` | IF | Reads `needsHuman` from `Parse Analysis` explicitly (the preceding `Log Analysis` outputs the inserted activity row). `false` → auto-reply branch; `true` → review-alert branch |
| 15 | `Build Review Alert` → `Send Review Alert` | Set + Gmail | Ops email: priority-prefixed subject, full analysis, original message, deep link `/requests/<id>` |
| 15b | `Alert Delivery Failed` | Code | Alert email error is logged but the request **still** becomes `pending_review` |
| 16 | `Build Customer Reply` → `Send Customer Reply` | Set + Gmail | `Re: <subject>` to the customer with the model's `reply.body` (guarded fallback text if empty) |
| 16b | `Handle Send Failure` | Code | Captures the delivery error as `lastError` |
| 17 | `Set Status Auto Resolved` / `Set Status Pending Review` / `Set Status Failed` | Set | Assemble the final row: status, all AI fields, `reply_sent`, `analyzed_at`, `resolved_at` / `last_error` |
| 18 | `Update Request Status` | Supabase | Single `update requests where id = …` — one convergence point for all three branches |
| 19 | `Log Status Activity` | Supabase | Semantic timeline row: `auto_resolution` / `review_requested` / `error` |

### 1.3 Data flow (one request, end to end)

```
email/webhook payload
   → Normalize Request        (canonical fields + intakeWarnings[] + requestId)
   → Find/Create Customer     (CRM context)
   → Prepare Context          (prompt JSON  +  DB row)
   → Existing Request?        requestId present? (dashboard/webhook: yes)
        no  → Create Request        status: 'analyzing'
            → Log Request Created   request_activities (intake, n8n)
        yes → Update Existing Request   status: 'analyzing' (row already stored)
   → Mark Email Read          (dedupe; no-op for webhook rows)
   → AI Agent (Claude)        raw JSON proposal
   → Parse Analysis           validated fields + guardrails → decision
   → Log Analysis             request_activities (analysis, agent)
   → Requires Human?          needsHuman = (decision !== 'auto_resolve')
   → auto:  Build/Send Reply  → status auto_handled, reply_sent = true
      or:   Build/Send Alert  → status pending_review, reply_sent = false
      or:   Send failure      → status failed, last_error set
   → Update Request Status    (one UPDATE)
   → Log Status Activity      (semantic timeline entry)
```

Every status change is written **twice on purpose**: once semantically by n8n and once by
the Postgres trigger `log_status_change()`, which catches any manual edit made outside the
workflow — so the timeline can never go stale.

### 1.4 AI agent configuration & prompts

**Configuration** (`AI Agent`, `@n8n/n8n-nodes-langchain.agent` v1.6):

- `promptType: define`, `text: ={{ $('Prepare Context').first().json.context }}` — the user
  turn is exactly the JSON built by `Prepare Context` (referenced explicitly because the item
  passes through `Mark Email Read`, whose Gmail output would replace `$json`).
- `options.systemMessage` = the analysis contract (below).
- Model: **Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`) through the `Anthropic Claude`
  LM node.
- Resilience: `retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 5000`,
  `onError: continueErrorOutput`.

**User message (built by `Prepare Context`):**

```json
{
  "request": {
    "subject": "Refund for invoice 1042",
    "body": "We were charged twice for invoice 1042 - please refund the duplicate charge.",
    "sender_email": "priya.sharma@bharatmart.in",
    "sender_name": "priya.sharma",
    "source": "email",
    "received_at": "2026-10-08T09:14:02.000Z",
    "intake_warnings": []
  },
  "customer": {
    "id": "…", "full_name": "Priya Sharma", "plan": "enterprise",
    "lifetime_value": 48200, "open_requests": 2, "notes": "…"
  }
}
```

**System message (verbatim contract, abridged):**

> You are the AI analyst for an AI-powered customer operations system. … Analyse the
> request and respond with ONLY a single JSON object. No markdown, no commentary, no code
> fences.
>
> Required schema: `{ "intent": …, "category": one of account_access|billing|technical|
> shipping|product|feedback|compliance|other, "priority": low|medium|high|urgent,
> "sentiment": positive|neutral|negative|angry, "summary", "recommended_action",
> "decision": auto_resolve|human_review|escalate, "confidence": 0.0-1.0,
> "reply": {"subject","body"} }`
>
> **Decision rules** — `auto_resolve` only for routine, low-risk requests fully answerable
> from context (FAQs, plan questions, password-reset instructions); `human_review` for
> anything that changes account state, involves money (refunds, credits, cancellations),
> legal/compliance, ambiguous intent, missing information, incidents, or confidence < 0.7;
> `escalate` for outages, security/data-loss, threats, legal action, or angry enterprise
> customers.
>
> Never invent prices, policies, refunds or deadlines not in the context. If `intake_warnings`
> is non-empty or `customer` is null, never choose `auto_resolve`. When the decision is not
> `auto_resolve`, still fill `reply.body` with what a human agent should send.

**Integrations used by the workflow:** Gmail OAuth2 (trigger, mark-as-read, customer reply,
ops alert, failure alert), Supabase service-role (8 nodes: customers / requests /
request_activities read-write), Anthropic API (Claude), plus the Next.js API
(`POST /api/requests`, `POST /api/webhook/intake`) feeding the same webhook.

### 1.5 Worked example: intake → analysis → decision → action → status

Request: `Refund for invoice 1042 — "we were charged twice"` from a known enterprise customer.

1. **Intake** — Gmail Trigger fires (or the dashboard form posts to `/api/requests`, which
   stores the row and forwards it to the webhook with its `requestId`). `Normalize Request`
   produces the canonical record; `Find Customer` returns the enterprise CRM record. Gmail
   requests take `Create Request` (insert), forwarded requests take `Update Existing Request`
   (same row → `analyzing`); the `intake` timeline entry is written for Gmail rows (the
   dashboard already logged one at intake).
2. **AI analysis** — Claude receives the context + system contract and returns:
   `intent: refund_request, category: billing, priority: high, sentiment: negative,
   decision: human_review, confidence: 0.93`, a 2-sentence summary, a recommended action
   ("verify the duplicate charge on invoice 1042 and issue a refund with finance's
   approval"), and a draft reply.
3. **Decision-making** — `Parse Analysis` validates every field against allow-lists, then
   applies the guardrails. Money is involved, so even if the model had proposed
   `auto_resolve`, the code-level rules and the confidence/sentiment checks keep it in the
   human queue; `needsHuman = true`.
4. **Action** — `Requires Human?` routes to `Build Review Alert`: an email to the ops inbox
   with `[Customer Ops] HIGH - human review required: Refund for invoice 1042`, the full
   analysis, the original message, and a deep link
   `http://localhost:3000/requests/<id>`. The customer is **not** emailed automatically.
5. **Status update** — `Set Status Pending Review` → `Update Request Status` writes
   `status = pending_review` plus all AI fields; `Log Status Activity` adds
   `review_requested` to the timeline (and the DB trigger adds `analyzing → pending_review`).
6. **Human close-out** — an operator opens the drawer, clicks *Take ownership*
   (`PATCH /api/requests/:id` → `in_progress`, `assigned_to = dashboard-operator`), handles
   the refund, then *Mark resolved* with a resolution note. Both transitions appear in the
   timeline automatically.

The auto-resolve path is symmetric: a routine FAQ message yields
`decision: auto_resolve` → `Send Customer Reply` → `status = auto_handled, reply_sent = true`,
visible on the dashboard within the 15-second refresh.

---

## 2. Customer Operations Logic

**Intent.** The model classifies `intent` as a machine-readable slug (examples from the
contract: `login_issue`, `password_reset`, `billing_question`, `refund_request`, `bug_report`,
`outage`, `cancel_subscription`, `feedback`, `shipping`) plus a constrained `category` from an
eight-value allow-list. `Parse Analysis` sanitises whatever comes back
(`lowercase`, non-alphanumerics → `_`, max 60 chars) and falls back to `other`, so the DB
check constraints can never be violated.

**Priority.** `low | medium | high | urgent`, chosen by the model under the rule that
`urgent` is reserved for time-critical or business-stopping issues; code coerces invalid
values to `medium`. Post-analysis, `urgent + auto_resolve` is upgraded to `escalate`, so an
urgent request can never be silently closed by the bot.

**Sentiment.** `positive | neutral | negative | angry`. `angry` is a hard veto on
auto-resolution — it forces `human_review` regardless of what the model proposed.

**Recommended action.** `recommended_action` is a mandatory field describing the concrete
next step for the operations team; it is stored on the request, shown in the detail drawer,
and included in the ops alert email. Missing values degrade to `"Review the request manually"`.

**Decision & whether human intervention is required.** The model *proposes*
`decision ∈ {auto_resolve, human_review, escalate}` with a `confidence` score — but routing
is decided by deterministic code in `Parse Analysis`, not by the prompt:

| Guardrail (plain JavaScript) | Effect |
| --- | --- |
| Model output unparseable / missing | `human_review`, priority `high`, `confidence 0`, `analysisFailed: true` |
| `confidence < 0.6` | `auto_resolve` → `human_review` |
| `priority === urgent` && `auto_resolve` | upgraded to `escalate` |
| `sentiment === angry` && `auto_resolve` | → `human_review` |
| any `intake_warnings` (bad sender, empty body, truncation) | `auto_resolve` → `human_review` |
| unknown customer (`customer: null`) | `auto_resolve` → `human_review` |
| `auto_resolve` with empty `reply.body` | → `human_review` |

The flag `needsHuman = decision !== 'auto_resolve'` is the single input to the
`Requires Human?` IF node. Consequently:

- **`auto_resolve`** → the only path that emails the customer directly → `auto_handled`.
- **`human_review`** → ops alert + `pending_review` queue → operator *Take ownership* → `in_progress` → `resolved`.
- **`escalate`** → same queue but flagged as `ESCALATED` in the alert subject and kept
  `urgent` on the dashboard.

Human judgement is therefore enforced by code: the model can suggest auto-resolution, but
low confidence, angry sentiment, urgent priority, unknown senders, intake warnings, missing
reply text or garbage output all route the request to a person.

---

## 3. Dashboard & Data

### 3.1 How data reaches the UI

| Endpoint | Feeds |
| --- | --- |
| `GET /api/requests?status=&priority=&q=&limit=` | request queue rows (+ customer join) |
| `GET /api/metrics` | header metric cards (`dashboard_metrics()` RPC, with a plain-count fallback) |
| `GET /api/requests/:id` | detail drawer: full record + activity timeline |
| `PATCH /api/requests/:id` | human intervention (status, assignee, resolution note; optional `x-admin-token`) |
| `POST /api/requests` / `POST /api/webhook/intake` | intake form and external webhook (optional `x-admin-token` / `x-webhook-secret`) |
| `GET /` and `/requests/[id]` | pages, shareable deep links used in ops alert emails |

`Dashboard.tsx` fetches the queue from `/api/requests` and the header aggregates from
`/api/metrics` (server-wide, backed by the `dashboard_metrics()` RPC) in parallel, so card
and chip counts stay correct even when the table caps at the 200 most recent rows. If
`/api/metrics` is unavailable the cards fall back to counts derived from the loaded rows.
The queue re-fetches every **15 s** ("Live · refreshing every 15 s" in the top bar), which is
how n8n's status writes appear without manual reloads.

### 3.2 What is reflected where

- **Customer requests** — the queue table shows subject + sender + short id, customer name
  and plan (or "Unknown"), received time, with status chips carrying live counts, a priority
  dropdown, and full-text search over subject, sender, summary, intent and customer name.
- **AI analysis** — intent/category tags in the *AI analysis* column; priority, sentiment
  and decision badges per row; in the drawer: summary, intent, category, recommended action,
  decision, analysed-at timestamp and a **confidence bar** (`93%`). A request not yet
  analysed shows "Not analyzed yet — still queued for the AI pipeline", and an
  `auto_handled` request shows whether the reply email was actually delivered
  (`reply_sent`).
- **Workflow status** — `StatusBadge` for `new / analyzing / pending_review / in_progress /
  auto_handled / resolved / failed`, plus the seven metric cards (needs review, in progress,
  auto-handled, resolved, urgent open, failed, avg. resolution minutes) and per-status chips
  with counts for filtering. `pending_review` shows a yellow banner ("Waiting for a human"),
  `failed` shows the red banner with `last_error`.
- **Activity** — the drawer's *Activity timeline* merges both writers: `intake` and
  `analysis` (actor `n8n` / `agent`), `auto_resolution` / `review_requested` / `error`
  (actor `n8n`), and the trigger-generated `status_change` entries (`n8n` for workflow
  statuses, `human` for dashboard actions, `system` otherwise), each with timestamp, actor
  and type.
- **Human intervention** — *Take ownership* (from `new / analyzing / pending_review /
  failed`), *Mark resolved* (from `in_progress`), *Reopen* (from `resolved / auto_handled`),
  and an optional resolution note; `PATCH` validates status/decision against allow-lists,
  sets `assigned_to`/`resolved_at` automatically, and clears `resolved_at` when a request is
  reopened.

### 3.3 Demo sequence

1. Import `n8n/workflows/ai-customer-ops-pipeline.json`, attach credentials, activate.
2. Submit the sample refund request via `POST /api/requests` (or *+ New request*).
3. Card **Needs review** increments, chip `new` → `analyzing` within 15 s, then
   `pending_review`; the row shows `refund_request · billing`, `HIGH`, `negative`,
   `human review`; the drawer timeline lists *intake → analysis → status change →
   review_requested*; the ops inbox has the alert with a working deep link.
4. Click *Take ownership* → card **In progress** increments; *Mark resolved* →
   **Resolved** increments and **Avg. resolution** updates.

---

## 4. Error / Edge Case Handling

### 4.1 Deep dive — the AI model fails (timeout, API error, or garbage output)

This is the failure most likely to lose a customer request, and it is handled in layers:

1. **Retries** — the `AI Agent` node runs with `retryOnFail: true`, `maxTries: 3`,
   `waitBetweenTries: 5000`; transient Anthropic errors usually recover here.
2. **Graceful degradation** — if it still fails, `onError: continueErrorOutput` routes to
   the **`AI Failure Handler`** Code node, which normalises the error into the *same shape*
   the success path produces (`{output: '', aiError: '<message, max 500 chars>'}`), so the
   downstream `Parse Analysis` never branches on "did the node fail?".
3. **Fallback analysis** — `Parse Analysis` cannot extract a JSON object, so it emits a
   complete, safe analysis: `intent: unclassified`, `priority: high`,
   `summary: "AI analysis unavailable — the model output could not be parsed."`,
   `recommended_action: "Manually triage this request…"`, `decision: human_review`,
   `confidence: 0`, `analysisFailed: true`, `aiError: <reason>`, plus the raw output
   (first 2 000 chars) for debugging.
4. **Routing to a human** — `needsHuman = true`, so the ops alert goes out with an extra
   `AI analysis error: …` line, and the request lands in `pending_review` — **never** in a
   dropped/limbo state, and **never** auto-replied to on the basis of a guess.
5. **Visibility** — the dashboard shows the request in *Needs review* with
   `unclassified / other / HIGH`, and the timeline entry records
   `review_requested … - AI error: …`.

The same principle covers the model returning *non-JSON but 200*: `parseJsonObject` strips
code fences, slices the first `{…}` block, and any parse/validation failure takes exactly
this path. Invalid enum values never reach the DB — they are coerced to allow-listed
defaults first.

### 4.2 Other handled failures / edge cases

| Edge case | Handling |
| --- | --- |
| **Missing/invalid sender address** | `Normalize Request` flags a warning and substitutes `unverified-sender@invalid.local`; the warning array forces `human_review`, and the human sees *why* |
| **Empty subject / body / oversize message** | Default `(no subject)`, warning `"Request body was empty"`, body truncated at 8 000 chars with a warning → all block auto-resolution |
| **Unknown sender (no CRM record)** | `Create Customer` creates a stub; if it races/duplicates (`continueRegularOutput`) the pipeline continues with `customer: null` → never auto-resolved |
| **Customer reply email fails to send** | `Send Customer Reply` error output → `Handle Send Failure` → status `failed` with `last_error` + `error` timeline entry; the drawer shows a red banner with the exact error; *Take ownership* recovers it |
| **Ops review alert fails to send** | `Alert Delivery Failed` logs the error but the request **still** becomes `pending_review` — a notification failure never blocks the queue |
| **Request row cannot be created/updated** | `Create Request` / `Update Existing Request` error output → `Intake Failure Alert` → ops email with sender, subject and raw error (≤500 chars): nothing is silently dropped |
| **n8n is down / unreachable** | Dashboard & webhook intake write to Supabase **first**, then best-effort forward to n8n (5 s timeout). Response `202 {forwarded: false, warning}`; the request waits as `new` for the next Gmail poll or a webhook replay — no data loss |
| **Duplicate email processing** | `Mark Email Read` right after record creation + `email` unique upsert in dashboard intake |
| **Duplicate request rows** | Forwarded payloads carry `requestId`, so n8n updates the row stored by the intake API instead of inserting a second one |
| **Malformed external payload** | `POST /api/webhook/intake` returns `400` for bad JSON, `401` for a wrong `x-webhook-secret`, `422` for missing/invalid `email` or empty `body`. The n8n `Webhook Intake` node independently rejects a mismatched secret when `N8N_WEBHOOK_SECRET` is set |
| **Invalid human PATCH** | `PATCH /api/requests/:id` rejects unknown status/decision values (`422`) and empty updates (`400`) |
| **Dashboard without DB migrations** | `/api/metrics` falls back from the RPC to a plain count query instead of 500ing |
| **Status changed outside the workflow** | Postgres trigger `log_status_change()` writes a `status_change` timeline entry for *any* status update, so the audit trail stays complete |
