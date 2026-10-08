# n8n â?" AI Customer Operations Pipeline

`workflows/ai-customer-ops-pipeline.json` is the end-to-end orchestration layer:

```
Gmail Trigger â"?â"?
               â"oâ"?â- Normalize Request â"?â- Find/Create Customer â"?â- Prepare Context
Webhook Intake â"~                                                       â",
                                                                       â-¼
                                                            Create Request (Supabase)
                                                                       â",
Log Request Created â-?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"? Mark Email Read
                                                                       â",
                                             AI Agent (Claude) â"? Anthropic Claude
                                                                       â",
                                        â"Oâ"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"? error output â"?â"?â"
                                        â-¼                              â-¼
                               AI Failure Handler â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â- Parse Analysis
                                                                       â",
                                                               Log Analysis
                                                                       â",
                                                                Requires Human?
                                                          â"Oâ"?â"?â"?â"?â"?â"?â"?â"?â"'â"?â"?â"?â"?â"?â"?â"?â"?â"?
                                            no (auto)     â",                 â",  yes
                                                          â-¼                 â-¼
                                    Build Customer Reply      Build Review Alert
                                     Send Customer Reply       Send Review Alert
                                     (Gmail â+' customer)        (Gmail â+' ops team)
                                  â"Oâ"?â"?â"? success â"?â"?â"?           â""â"?â"? success / failed â"?â"?â"?
                                  â-¼              â-¼ error                            â-¼
                     Set Status Auto Resolved   Handle Send Failure   Set Status Pending Review
                                  â",              â-¼                             â",
                                  â",       Set Status Failed                    â",
                                  â""â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"¬â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"?â"~
                                                 â-¼
                                    Update Request Status â"?â- Log Status Activity
```

## 6. Resolution reply workflow (new)\n\nworkflows/reply-to-resolved-request.json is a small webhook workflow that emails the customer when an operator reviews and sends a resolution reply from the dashboard.\n\n1. Import it into n8n (Workflows -> Import from File -> 
8n/workflows/reply-to-resolved-request.json)\n2. Attach the same **Gmail OAuth2** credential to Send Resolution Reply and Send Ops Alert.\n3. Attach the **Supabase** credential to the four Supabase nodes.\n4. Update the 	o field in **Build Ops Alert** to your ops inbox if different.\n5. Activate the workflow.\n6. In the dashboard .env.local, set N8N_RESOLUTION_WEBHOOK_URL to https://YOUR-N8N-HOST/webhook/send-resolution-reply (and share N8N_WEBHOOK_SECRET if used).\n\n## 1. Import

1. n8n â+' **Workflows â+' Import from File** â+' select `workflows/ai-customer-ops-pipeline.json`
2. The import is credential-free on purpose â?" attach your own (below).

## 2. Credentials

| Credential type | Node(s) | Values |
| --- | --- | --- |
| **Gmail OAuth2** (`gmailOAuth2`) | Gmail Trigger, Mark Email Read, Send Customer Reply, Send Review Alert, Send Intake Failure Alert | Google OAuth client id/secret, then connect the **support Google account** |
| **Supabase** (`supabaseApi`) | Find Customer, Create Customer, Create Request, Log Request Created, Log Analysis, Update Request Status, Log Status Activity | Host = `https://<project-ref>.supabase.co`, Secret Key = the **service role** key (Project Settings â+' API) |
| **Anthropic API** (`anthropicApi`) | Anthropic Claude | Anthropic API key |

After attaching the Supabase credential, open **Find Customer** once so the table/column
dropdowns can load; the field mappings themselves are plain column names and import
faithfully.

## 3. Things to edit before activating

| Where | What |
| --- | --- |
| `Build Review Alert` â+' *To* | Your operations inbox (literal, currently `customer-ops@yourcompany.com`) |
| `Build Review Alert` â+' *message* | The `http://localhost:3000/requests/` dashboard URL |
| `Intake Failure Alert` â+' *To* | Same ops inbox |
| `Anthropic Claude` â+' *Model* | Defaults to `claude-sonnet-4-5-20250929`; pick any Claude model available to your account |

## 4. Activate and schedule

- Toggle the workflow **Active**.
- **Gmail Trigger** ships with `pollTimes: everyMinute` plus `labelIds: INBOX` +
  `readStatus: unread`. In n8n versions that schedule polling trigger nodes at the
  workflow/trigger level, set the poll interval in the trigger node UI instead â?" the extra
  `pollTimes` parameter is simply ignored.
- Each processed email is **marked as read** (`Mark Email Read`) right after the request row
  is created, so it is never picked up twice. Webhook-sourced items skip this gracefully
  (the node is set to *continue on fail*).

## 5. Test it

```bash
# a) Webhook entry point (use "Listen for test event" first)
curl -X POST https://<n8n>/webhook/customer-ops-intake \
  -H "content-type: application/json" \
  -d '{"email":"amelia.jones@northwind.io","subject":"Refund for invoice 1042",
       "body":"Hi, we were charged twice for invoice 1042. Please refund the duplicate."}'
```

```bash
# b) The dashboard's "+ New request" button (needs N8N_WEBHOOK_URL in dashboard/.env.local)

# c) Send a real email to the connected support inbox
```

Watch the execution: each run shows the Supabase rows it created, the model output parsed by
`Parse Analysis`, and which branch (auto reply vs human review) was taken.

## 6. How routing works

`Parse Analysis` never trusts the model blindly. The model returns a JSON proposal; then
plain code applies guardrails:

| Rule (in code) | Effect |
| --- | --- |
| Unparseable / missing model output | `human_review`, priority `high`, flagged `analysisFailed` |
| Confidence < 0.6 | forced out of `auto_resolve` |
| Priority `urgent` chosen as `auto_resolve` | upgraded to `escalate` |
| Sentiment `angry` | never auto-resolved |
| Intake warnings (bad sender, empty bodyâ?¦) | never auto-resolved |
| Unknown customer (`customer: null`) | never auto-resolved |
| `auto_resolve` without a reply body | forced to `human_review` |

`decision` is the single source of truth for routing; `Requires Human?` only reads the
`needsHuman` flag derived from it.

## 7. Error handling built into the workflow

| Failure | Handling |
| --- | --- |
| AI agent fails / returns garbage | 3 retries (5s apart) â+' error output â+' `AI Failure Handler` â+' deterministic fallback analysis â+' routed to human review |
| Customer reply email fails to send | error output â+' `Handle Send Failure` â+' status `failed` + `last_error` recorded on the request + timeline entry |
| Ops review alert fails | error output â+' `Alert Delivery Failed` â+' the request still enters `pending_review` (failure visible in the execution log) |
| Request row cannot be created | error output â+' `Intake Failure Alert` email to the ops team with the raw error, so nothing disappears silently |
| Customer already exists (race on placeholder/unknown sender) | `Create Customer` set to *continue on fail*, pipeline keeps going with `customer: null` |

## 8. Regenerating the JSON

The workflow file is generated so the Code-node sources stay readable:

```bash
node n8n/scripts/build-workflow.mjs
```

Edit `scripts/build-workflow.mjs`, re-run, re-import. Connection wiring and node IDs are
produced by the script â?" do not hand-edit the JSON.

