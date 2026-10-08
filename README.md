# AI-Powered Customer Operations System

An end-to-end pipeline that receives customer requests by email (or webhook/dashboard),
lets a **Claude** agent analyse them, automatically replies when it is safe to do so, routes
everything else to a human review queue, and gives the operations team a live dashboard.

Built with **n8n · Claude (Anthropic) · Supabase · Gmail · Next.js (React + TypeScript) ·
OpenCode · Git**.

## What it does

| Problem statement step | Where it lives |
| --- | --- |
| **Request intake** via Gmail / webhook | `n8n/workflows/…` Gmail Trigger + Webhook Intake; `POST /api/webhook/intake`; dashboard "+ New request" |
| **Customer & request data** in Supabase | `supabase/schema.sql` — `customers`, `requests`, `request_activities`, triggers, metrics RPC |
| **AI analysis** (intent, priority, sentiment, summary, action) | n8n **AI Agent** node with Claude; system message + customer context in `Prepare Context` |
| **Context & decision making** | `customers` record + request body injected into the prompt; deterministic guardrails in `Parse Analysis` |
| **Action & communication** through tools | Gmail reply to the customer, ops review alerts, Supabase status/timeline writes — all orchestrated in n8n |
| **Human intervention** | `human_review` / `escalate` → ops alert email → dashboard *Take ownership / Mark resolved* controls |
| **Status & monitoring** | Status column + activity timeline in Supabase, surfaced by the Next.js dashboard (`/`, `/requests/<id>`) |
| **Error handling** | AI retries + fallback, email-failure branches, intake failure alerts — table in `docs/architecture.md` |

## Repository layout

```
├── supabase/
│   ├── schema.sql            # tables, triggers, RLS, dashboard_metrics()
│   └── seed.sql              # demo customers + requests
├── n8n/
│   ├── workflows/ai-customer-ops-pipeline.json   # import this into n8n
│   ├── scripts/build-workflow.mjs                # regenerates the JSON
│   ├── scripts/test-workflow-code.cjs            # Code-node logic checks
│   └── README.md             # credentials, node-by-node docs, routing rules
├── dashboard/                # Next.js 14 + TypeScript monitoring UI
│   ├── app/                  # pages + API routes
│   ├── components/           # Dashboard, table, detail drawer, metrics
│   └── lib/                  # supabase client, types, intake logic
├── docs/architecture.md      # diagrams, data model, failure modes
├── .env.example
└── README.md
```

## Quick start

### 1. Supabase (5 min)

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor → run `supabase/schema.sql` (idempotent).
3. Optionally run `supabase/seed.sql` for demo data.
4. Copy **Project URL** and **service role key** (Settings → API).

### 2. n8n (10 min)

1. Import `n8n/workflows/ai-customer-ops-pipeline.json`.
2. Attach three credentials: **Gmail OAuth2**, **Supabase**, **Anthropic API** —
   details in [`n8n/README.md`](n8n/README.md).
3. Replace the two literal `customer-ops@yourcompany.com` addresses and the dashboard URL
   in the `Build Review Alert` / `Intake Failure Alert` nodes.
4. Activate the workflow.

### 3. Dashboard (2 min)

```bash
cd dashboard
npm install
cp .env.example .env.local      # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run dev                     # http://localhost:3000
```

### 4. End-to-end test

```bash
curl -X POST http://localhost:3000/api/requests \
  -H "content-type: application/json" \
  -d '{"email":"amelia.jones@northwind.io","subject":"Refund for invoice 1042",
       "body":"We were charged twice for invoice 1042 - please refund the duplicate charge."}'
```

Then either point `N8N_WEBHOOK_URL` at your n8n webhook so intake hands the request over
automatically, or send a real email to the connected support inbox. Watch the request move
through `new → analyzing → auto_handled | pending_review` on the dashboard.

## Dashboard features

- **Metric cards** — needs review, in progress, auto-handled, resolved, urgent open,
  failed, average resolution time (one RPC round-trip).
- **Request queue** — status chips with live counts, priority filter, full-text search,
  AI analysis tags per row, auto-refresh every 15 s.
- **Detail drawer** (`/requests/<id>`) — customer profile, full AI analysis with
  confidence bar, original message, activity timeline, and the human intervention
  controls (*Take ownership*, *Mark resolved*, *Reopen*, resolution notes).
- **Intake form** — the frontend entry point, same pipeline as the webhook.

## Routing rules (human oversight by design)

The model *proposes* `auto_resolve | human_review | escalate`; code decides:

- never auto-resolve with low confidence (< 0.6), angry sentiment, urgent priority,
  unknown customer, intake warnings, or a missing reply body;
- unparseable model output becomes a high-priority human-review item;
- only `auto_resolve` emails the customer; every other path alerts the ops inbox with a
  deep link to the dashboard.

## Error handling highlights

- AI agent: 3 retries → fallback analysis → human review (never a dropped request).
- Reply email failure: request marked `failed` with `last_error`, visible on the dashboard.
- Supabase insert failure: alert email with the raw error — nothing disappears silently.
- n8n down: intake still stores requests as `new` for later processing.

Full table in [`docs/architecture.md`](docs/architecture.md).

## Development

```bash
node n8n/scripts/build-workflow.mjs   # regenerate the workflow JSON
node n8n/scripts/test-workflow-code.cjs   # run guardrail/logic checks on Code nodes
cd dashboard && npm run typecheck     # tsc --noEmit
cd dashboard && npm run build         # production build
```

This project was developed with **OpenCode** (AI-assisted development) and is structured
for Git/GitHub version control — `git init`, commit, push to a repository of your choice.
