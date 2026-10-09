# n8n — AI Customer Operations Pipeline

`workflows/ai-customer-ops-pipeline.json` is the end-to-end orchestration layer:

```
Gmail Trigger ─┐
               ├─▶ Normalize Request ─▶ Find/Create Customer ─▶ Prepare Context
Webhook Intake ┘                                                       │
                                                                Existing Request?
                                                      no ────────────┴─────────── yes
                                                      ▼                            ▼
                                        Create Request (Supabase)     Update Existing Request
                                                      │                (row stored by the
                                        Log Request Created             dashboard intake)
                                                      └────────┬───────────────┘
                                                               ▼
                                                       Mark Email Read
                                                               │
                                            AI Agent (Claude) ─ Anthropic Claude
                                                               │
                                       ┌────────────── error output ──┤
                                       ▼                              ▼
                              AI Failure Handler ────────────▶ Parse Analysis
                                                               │
                                                           Log Analysis
                                                               │
                                                        Requires Human?
                                                      ┌────────┴────────┐
                                        no (auto)     │                 │  yes
                                                      ▼                 ▼
                                    Build Customer Reply      Build Review Alert
                                     Send Customer Reply       Send Review Alert
                                     (Gmail → customer)        (Gmail → ops team)
                                  ┌─── success ──┐           └── success / failed ──┐
                                  ▼              ▼ error                            ▼
                     Set Status Auto Resolved   Handle Send Failure   Set Status Pending Review
                                  │              ▼                             │
                                  │       Set Status Failed                    │
                                  └──────────────┬─────────────────────────────┘
                                                 ▼
                                    Update Request Status ─▶ Log Status Activity
```

Requests forwarded by the dashboard / webhook intake already carry a row id
(`requestId` in the payload), so the workflow **updates** that row to
`analyzing` instead of inserting a duplicate. Gmail-originated requests take
the `Create Request` path as before.

## 1. Import

1. n8n → **Workflows → Import from File** → select `workflows/ai-customer-ops-pipeline.json`
2. The import is credential-free on purpose — attach your own (below).

## 2. Credentials

| Credential type | Node(s) | Values |
| --- | --- | --- |
| **Gmail OAuth2** (`gmailOAuth2`) | Gmail Trigger, Mark Email Read, Send Customer Reply, Send Review Alert, Send Intake Failure Alert | Google OAuth client id/secret, then connect the **support Google account** |
| **Supabase** (`supabaseApi`) | Find Customer, Create Customer, Create Request, Update Existing Request, Log Request Created, Log Analysis, Update Request Status, Log Status Activity | Host = `https://<project-ref>.supabase.co`, Secret Key = the **service role** key (Project Settings → API) |
| **Anthropic API** (`anthropicApi`) | Anthropic Claude | Anthropic API key |

After attaching the Supabase credential, open **Find Customer** once so the table/column
dropdowns can load; the field mappings themselves are plain column names and import
faithfully.

## 3. Things to edit before activating

| Where | What |
| --- | --- |
| `Build Review Alert` → *To* | Your operations inbox (literal, currently `customer-ops@yourcompany.com`) |
| `Build Review Alert` → *Dashboard link* | The dashboard deep link is a literal inside the message (`http://localhost:3002`); change it if you host the dashboard elsewhere |
| n8n env var `N8N_WEBHOOK_SECRET` | Optional. When set, `Webhook Intake` rejects payloads without a matching `x-webhook-secret` header — use the same value in `dashboard/.env.local` |
| `Intake Failure Alert` → *To* | Same ops inbox |
| `Anthropic Claude` → *Model* | Defaults to `claude-sonnet-4-5-20250929`; pick any Claude model available to your account |

## 4. Activate and schedule

- Toggle the workflow **Active**.
- **Gmail Trigger** ships with `pollTimes: everyMinute` plus `labelIds: INBOX` +
  `readStatus: unread`. In n8n versions that schedule polling trigger nodes at the
  workflow/trigger level, set the poll interval in the trigger node UI instead — the extra
  `pollTimes` parameter is simply ignored.
- Each processed email is **marked as read** (`Mark Email Read`) right after the request row
  is created, so it is never picked up twice. Webhook-sourced items skip this gracefully
  (the node is set to *continue on fail*).

## 5. Test it

```bash
# a) Webhook entry point (use "Listen for test event" first)
curl -X POST https://<n8n>/webhook/customer-ops-intake \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $N8N_WEBHOOK_SECRET" \
  -d '{"email":"priya.sharma@bharatmart.in","subject":"Refund for invoice 1042",
       "body":"Hi, we were charged twice for invoice 1042. Please refund the duplicate."}'
```

```bash
# b) The dashboard's "+ New request" button (needs N8N_WEBHOOK_URL in dashboard/.env.local).
#    The dashboard forwards the row id it stored as "requestId", so the workflow
#    analyses that row instead of creating a second one.

# c) Send a real email to the connected support inbox
```

Watch the execution: each run shows the Supabase rows it created/updated, the model output
parsed by `Parse Analysis`, and which branch (auto reply vs human review) was taken.

## 6. How routing works

`Parse Analysis` never trusts the model blindly. The model returns a JSON proposal; then
plain code applies guardrails:

| Rule (in code) | Effect |
| --- | --- |
| Unparseable / missing model output | `human_review`, priority `high`, flagged `analysisFailed` |
| Confidence < 0.6 | forced out of `auto_resolve` |
| Priority `urgent` chosen as `auto_resolve` | upgraded to `escalate` |
| Sentiment `angry` | never auto-resolved |
| Intake warnings (bad sender, empty body…) | never auto-resolved |
| Unknown customer (`customer: null`) | never auto-resolved |
| `auto_resolve` without a reply body | forced to `human_review` |

`decision` is the single source of truth for routing; `Requires Human?` reads the
`needsHuman` flag straight from `Parse Analysis` (the preceding `Log Analysis` node
outputs the inserted activity row, so `$json.needsHuman` would be undefined there).

## 7. Error handling built into the workflow

| Failure | Handling |
| --- | --- |
| AI agent fails / returns garbage | 3 retries (5s apart) → error output → `AI Failure Handler` → deterministic fallback analysis → routed to human review |
| Customer reply email fails to send | error output → `Handle Send Failure` → status `failed` + `last_error` recorded on the request + timeline entry |
| Ops review alert fails | error output → `Alert Delivery Failed` → the request still enters `pending_review` (failure visible in the execution log) |
| Request row cannot be created/updated | error output → `Intake Failure Alert` email to the ops team with the raw error, so nothing disappears silently |
| Customer already exists (race on placeholder/unknown sender) | `Create Customer` set to *continue on fail*, pipeline keeps going with `customer: null` |
| Webhook called without the shared secret | `Normalize Request` throws when `N8N_WEBHOOK_SECRET` is set and the `x-webhook-secret` header does not match — the run shows up as a failed execution |

## 8. Regenerating the JSON

The workflow file is generated so the Code-node sources stay readable:

```bash
node n8n/scripts/build-workflow.mjs
```

Edit `scripts/build-workflow.mjs`, re-run, re-import. Connection wiring and node IDs are
produced by the script — do not hand-edit the JSON.
