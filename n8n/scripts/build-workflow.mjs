/**
 * Builds n8n/workflows/ai-customer-ops-pipeline.json.
 *
 * The workflow is assembled programmatically so the embedded Code-node
 * JavaScript stays readable (and lint-checkable) instead of being a wall of
 * \n escapes inside JSON.
 *
 *   node n8n/scripts/build-workflow.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'workflows', 'ai-customer-ops-pipeline.json');

let idCounter = 0;
const nid = () =>
  `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

/* ------------------------------------------------------------------ */
/* Node helpers                                                         */
/* ------------------------------------------------------------------ */

const code = (name, jsCode, position, extra = {}) => ({
  id: nid(),
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  parameters: { jsCode },
  ...extra,
});

const setNode = (name, fields, position, extra = {}) => ({
  id: nid(),
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.3,
  position,
  parameters: {
    assignments: {
      assignments: fields.map(([fieldName, type, value]) => ({
        id: nid(),
        name: fieldName,
        type,
        value,
      })),
    },
    options: {},
  },
  ...extra,
});

const ifNode = (name, leftValue, position) => ({
  id: nid(),
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: nid(),
          leftValue,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
});

const supabaseNode = (
  name,
  operation,
  tableId,
  position,
  { fields = [], filter = null, extraParams = {}, ...extra } = {},
) => {
  const parameters = { operation, tableId, ...extraParams };
  if (fields.length) {
    parameters.dataToSend = 'defineBelow';
    parameters.fieldsUi = {
      fieldValues: fields.map(([fieldId, fieldValue]) => ({ fieldId, fieldValue })),
    };
  }
  if (filter) {
    parameters.filterType = 'manual';
    parameters.matchType = 'allFilters';
    parameters.filters = {
      conditions: [{ keyName: filter.key, condition: 'eq', keyValue: filter.value }],
    };
  }
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.supabase',
    typeVersion: 1,
    position,
    parameters,
    ...extra,
  };
};

const gmailSend = (name, position, extra = {}) => ({
  id: nid(),
  name,
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2.1,
  position,
  parameters: {
    sendTo: '={{ $json.to }}',
    subject: '={{ $json.subject }}',
    emailType: 'text',
    message: '={{ $json.message }}',
    options: { addAttribution: false },
  },
  ...extra,
});

/* ------------------------------------------------------------------ */
/* Code node sources                                                    */
/* ------------------------------------------------------------------ */

const NORMALIZE_REQUEST = String.raw`// Normalises the two entry points into a single request shape:
//   1. Gmail Trigger  (raw Gmail message, Simplify = false)
//   2. Webhook Intake (JSON body from the dashboard / external system)
const first = $input.first().json;
const warnings = [];

function decodeBase64Url(data) {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch (e) {
    return '';
  }
}

function collectBodies(payload, out) {
  if (!payload) return;
  if (payload.body && payload.body.data) out.push(decodeBase64Url(payload.body.data));
  (payload.parts || []).forEach((part) => collectBodies(part, out));
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAddress(raw) {
  const angled = String(raw || '').match(/^(.*)<([^>]+)>/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"|"$/g, ''),
      email: angled[2].trim(),
    };
  }
  const value = String(raw || '').trim();
  return { name: value.split('@')[0], email: value };
}

let email = '';
let name = '';
let subject = '';
let body = '';
let threadId = '';
let messageId = '';
let source = 'webhook';

if (first.payload && Array.isArray(first.payload.headers)) {
  // ---- raw Gmail message ------------------------------------------
  source = 'email';
  const headers = {};
  first.payload.headers.forEach((h) => {
    headers[String(h.name).toLowerCase()] = h.value;
  });
  const from = splitAddress(headers.from);
  email = from.email;
  name = from.name;
  subject = String(headers.subject || '(no subject)');
  const chunks = [];
  collectBodies(first.payload, chunks);
  body = chunks.join('\n').trim();
  if (!body && first.text) body = String(first.text).trim();
  if (!body && first.html) body = stripHtml(first.html);
  if (!body && first.snippet) body = String(first.snippet).trim();
  threadId = String(first.threadId || '');
  messageId = String(first.id || '');
} else if (first.from) {
  // ---- simplified Gmail message -----------------------------------
  source = 'email';
  const from = splitAddress(first.from);
  email = from.email;
  name = from.name;
  subject = String(first.subject || '(no subject)');
  if (first.text) body = String(first.text).trim();
  else if (first.html) body = stripHtml(first.html);
  else body = String(first.snippet || '').trim();
  threadId = String(first.threadId || '');
  messageId = String(first.id || '');
} else {
  // ---- webhook / dashboard payload --------------------------------
  // n8n Webhook node wraps the POSTed JSON in .body; fall back to the
  // top level so flat payloads (curl, tests) keep working too.
  const p = (first.body && typeof first.body === 'object') ? first.body : first;
  email = String(p.email || p.sender_email || '');
  name = String(p.name || p.full_name || '');
  subject = String(p.subject || p.title || '');
  body = String(p.body || p.message || p.text || '');
  threadId = String(p.threadId || '');
  messageId = String(p.messageId || '');
  if (!subject) {
    subject = '(no subject)';
    warnings.push('Subject was missing - a default was applied');
  }
  if (!body.trim()) warnings.push('Request body was empty');
}

email = String(email).trim().toLowerCase();
const bracketed = email.match(/<([^>]+)>/);
if (bracketed) email = bracketed[1].trim();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  warnings.push('Sender address missing or invalid - routed to human review');
  email = 'unverified-sender@invalid.local';
}
if (!name) name = email.split('@')[0];
if (body.length > 8000) {
  body = body.slice(0, 8000);
  warnings.push('Message was truncated to 8000 characters');
}

return [
  {
    json: {
      email,
      name,
      subject,
      body,
      threadId,
      messageId,
      source,
      receivedAt: new Date().toISOString(),
      intakeWarnings: warnings,
    },
  },
];`;

const PREPARE_CONTEXT = String.raw`// Builds the prompt context for the AI agent and the column-aligned record
// for the "Create Request" row (auto-mapped with "Inputs to Ignore").
function safeFirst(nodeName) {
  try {
    const item = $(nodeName).first();
    return item ? item.json : null;
  } catch (e) {
    return null; // node did not run on this branch
  }
}

const intake = safeFirst('Normalize Request') || {};
const found = safeFirst('Find Customer');
const created = safeFirst('Create Customer');

let customer = null;
if (found && found.email) customer = found;
else if (created && created.email) customer = created;

const context = {
  request: {
    subject: intake.subject,
    body: intake.body,
    sender_email: intake.email,
    sender_name: intake.name,
    source: intake.source,
    received_at: intake.receivedAt,
    intake_warnings: intake.intakeWarnings || [],
  },
  customer: customer
    ? {
        id: customer.id,
        full_name: customer.full_name,
        plan: customer.plan,
        lifetime_value: customer.lifetime_value,
        open_requests: customer.open_requests,
        notes: customer.notes || null,
      }
    : null,
};

return [
  {
    json: {
      sender_email: intake.email,
      subject: intake.subject,
      body: intake.body,
      source: intake.source,
      thread_id: intake.threadId || null,
      message_id: intake.messageId || null,
      customer_id: customer ? customer.id : null,
      status: 'analyzing',
      context: JSON.stringify(context, null, 2),
      customerKnown: Boolean(customer),
      intakeWarnings: intake.intakeWarnings || [],
    },
  },
];`;

const AI_FAILURE_HANDLER = String.raw`// Normalises the AI Agent error output so "Parse Analysis" always receives
// the same shape, whether the model succeeded or failed.
const err = $input.first().json || {};
const detail =
  (err.error && err.error.message) ||
  err.message ||
  (typeof err.error === 'string' ? err.error : '') ||
  'AI agent produced no output';

return [
  {
    json: {
      output: '',
      aiError: String(detail).slice(0, 500),
    },
  },
];`;

const PARSE_ANALYSIS = String.raw`// Parses + validates the model output and applies deterministic guardrails.
// The model never routes on its own: every safety rule below is plain code.
const agentItem = $('AI Agent').first().json;
const intake = $('Normalize Request').first().json;
const raw = typeof agentItem.output === 'string' ? agentItem.output.trim() : '';
const warnings = intake.intakeWarnings || [];

function parseJsonObject(text) {
  if (!text) return null;
  const cleaned = text.replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (e) {
    return null;
  }
}

const parsed = parseJsonObject(raw);

if (!parsed) {
  // No usable model output: never guess, hand the request to a human.
  return [
    {
      json: {
        intent: 'unclassified',
        category: 'other',
        priority: 'high',
        sentiment: 'neutral',
        summary: 'AI analysis unavailable - the model output could not be parsed.',
        recommended_action:
          'Manually triage this request: read the original message, classify it and reply to the customer.',
        decision: 'human_review',
        confidence: 0,
        reply: { subject: '', body: '' },
        needsHuman: true,
        analysisFailed: true,
        aiError:
          (agentItem.aiError || 'Model returned unparseable output').slice(0, 500),
        rawAnalysis: { raw: raw.slice(0, 2000), parseError: true },
      },
    },
  ];
}

const priorities = ['low', 'medium', 'high', 'urgent'];
const sentiments = ['positive', 'neutral', 'negative', 'angry'];
const decisions = ['auto_resolve', 'human_review', 'escalate'];
const categories = [
  'account_access',
  'billing',
  'technical',
  'shipping',
  'product',
  'feedback',
  'compliance',
  'other',
];

const intent =
  typeof parsed.intent === 'string' && parsed.intent
    ? parsed.intent.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60)
    : 'other';
const category = categories.includes(parsed.category) ? parsed.category : 'other';
const priority = priorities.includes(parsed.priority) ? parsed.priority : 'medium';
const sentiment = sentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
const summary =
  typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1000) : '';
const recommendedAction =
  typeof parsed.recommended_action === 'string'
    ? parsed.recommended_action.slice(0, 1000)
    : 'Review the request manually';
let decision = decisions.includes(parsed.decision) ? parsed.decision : 'human_review';
let confidence =
  typeof parsed.confidence === 'number' && isFinite(parsed.confidence)
    ? Math.min(1, Math.max(0, parsed.confidence))
    : 0;
const reply = {
  subject:
    parsed.reply && typeof parsed.reply.subject === 'string' ? parsed.reply.subject : '',
  body:
    parsed.reply && typeof parsed.reply.body === 'string' ? parsed.reply.body : '',
};

// ---- deterministic guardrails -----------------------------------------
if (confidence < 0.6) decision = decision === 'auto_resolve' ? 'human_review' : decision;
if (priority === 'urgent' && decision === 'auto_resolve') decision = 'escalate';
if (sentiment === 'angry' && decision === 'auto_resolve') decision = 'human_review';
if (warnings.length > 0 && decision === 'auto_resolve') decision = 'human_review';
if (!intake.customerKnown && decision === 'auto_resolve') decision = 'human_review';
if (decision === 'auto_resolve' && !reply.body) decision = 'human_review';

return [
  {
    json: {
      intent,
      category,
      priority,
      sentiment,
      summary,
      recommended_action: recommendedAction,
      decision,
      confidence,
      reply,
      needsHuman: decision !== 'auto_resolve',
      analysisFailed: false,
      aiError: '',
      rawAnalysis: parsed,
    },
  },
];`;

const HANDLE_SEND_FAILURE = String.raw`// The customer reply could not be delivered - record why so the request can
// be retried by a human instead of silently disappearing.
const requestId = $('Create Request').first().json.id;
const err = $input.first().json || {};
const detail =
  (err.error && err.error.message) ||
  err.message ||
  (typeof err.error === 'string' ? err.error : '') ||
  JSON.stringify(err).slice(0, 300);

return [
  {
    json: {
      requestId,
      lastError: 'Customer reply could not be delivered: ' + String(detail).slice(0, 400),
    },
  },
];`;

const ALERT_DELIVERY_FAILED = String.raw`// The internal review alert email failed - the request still enters the
// human queue, but the failure is surfaced here and in the execution log.
const err = $input.first().json || {};
const detail =
  (err.error && err.error.message) ||
  err.message ||
  JSON.stringify(err).slice(0, 300);

return [
  {
    json: {
      alertDeliveryFailed: true,
      warning: 'Ops review alert email failed: ' + String(detail).slice(0, 300),
    },
  },
];`;

const SYSTEM_MESSAGE = `You are the AI analyst for an AI-powered customer operations system.

You receive ONE customer request as JSON with two keys:
- "request": the incoming customer message (sender, subject, body, source, intake_warnings)
- "customer": the CRM record for this sender, or null when unknown

Analyse the request and respond with ONLY a single JSON object. No markdown, no commentary, no code fences.

Required schema:
{
  "intent": "machine-readable intent, e.g. login_issue, password_reset, billing_question, plan_upgrade, refund_request, bug_report, outage, cancel_subscription, feedback, shipping, other",
  "category": "one of: account_access, billing, technical, shipping, product, feedback, compliance, other",
  "priority": "one of: low, medium, high, urgent",
  "sentiment": "one of: positive, neutral, negative, angry",
  "summary": "1-2 sentence summary of what the customer wants",
  "recommended_action": "the concrete next step for the customer operations team",
  "decision": "one of: auto_resolve, human_review, escalate",
  "confidence": 0.0 to 1.0,
  "reply": {
    "subject": "subject line for the reply email",
    "body": "complete, customer-ready plain-text reply"
  }
}

Decision rules:
- auto_resolve: only routine, low-risk requests you can fully answer from the context (plan questions, FAQs, password reset instructions, positive feedback). The reply must be complete and ready to send.
- human_review: anything that changes account state, involves money (refunds, credits, cancellations), legal or compliance topics, ambiguous intent, missing information, technical incidents, or when confidence is below 0.7.
- escalate: outages, security or data-loss incidents, threats, legal action, or angry enterprise customers.

Other rules:
- Never invent prices, policies, refunds, discounts, account data or deadlines that are not in the context. If a needed fact is missing, choose human_review.
- priority "urgent" is reserved for time-critical or business-stopping issues.
- If request.intake_warnings is non-empty or customer is null, never choose auto_resolve.
- When decision is not auto_resolve, still fill reply.body with what a human agent should send.
- Keep replies polite, specific and free of placeholders such as [insert ...].`;

/* ------------------------------------------------------------------ */
/* Nodes                                                                */
/* ------------------------------------------------------------------ */

const nodes = [
  {
    id: nid(),
    name: 'Gmail Trigger',
    type: 'n8n-nodes-base.gmailTrigger',
    typeVersion: 1.1,
    position: [0, 340],
    parameters: {
      pollTimes: { itemMode: 'everyMinute' },
      event: 'messageReceived',
      simple: false,
      filters: { labelIds: ['INBOX'], readStatus: 'unread' },
      options: {},
    },
  },
  {
    id: nid(),
    name: 'Webhook Intake',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 560],
    parameters: {
      httpMethod: 'POST',
      path: 'customer-ops-intake',
      responseMode: 'onReceived',
      options: {},
    },
    webhookId: 'b7f3c1a2-9d4e-4f6b-8c2a-1e5d9f0a3b7c',
  },

  code('Normalize Request', NORMALIZE_REQUEST, [240, 420]),

  supabaseNode(
    'Find Customer',
    'getAll',
    'customers',
    [460, 420],
    {
      filter: { key: 'email', value: '={{ $json.email }}' },
      extraParams: { returnAll: false, limit: 1 },
      alwaysOutputData: true,
    },
  ),
  ifNode('Customer Found?', '={{ !!$json.email }}', [680, 420]),
  supabaseNode(
    'Create Customer',
    'create',
    'customers',
    [900, 540],
    {
      fields: [
        ['email', '={{ $("Normalize Request").first().json.email }}'],
        ['full_name', '={{ $("Normalize Request").first().json.name }}'],
      ],
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
    },
  ),

  code('Prepare Context', PREPARE_CONTEXT, [1120, 420]),

  supabaseNode('Create Request', 'create', 'requests', [1340, 420], {
    extraParams: {
      dataToSend: 'autoMapInputData',
      inputsToIgnore: 'context,customerKnown,intakeWarnings',
    },
    onError: 'continueErrorOutput',
  }),
  setNode(
    'Intake Failure Alert',
    [
      ['to', 'string', 'customer-ops@yourcompany.com'],
      ['subject', 'string', '[Customer Ops] FAILED to record a new request'],
      [
        'message',
        'string',
        "='The intake step failed, so this request is NOT stored in Supabase and needs manual handling.\\n\\nSender: ' + $('Normalize Request').first().json.email + '\\nSubject: ' + $('Normalize Request').first().json.subject + '\\n\\nError: ' + JSON.stringify($json).slice(0, 500)",
      ],
    ],
    [1560, 640],
  ),
  {
    id: nid(),
    name: 'Send Intake Failure Alert',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1780, 640],
    parameters: {
      sendTo: '={{ $json.to }}',
      subject: '={{ $json.subject }}',
      emailType: 'text',
      message: '={{ $json.message }}',
      options: { addAttribution: false },
    },
    onError: 'continueRegularOutput',
  },

  supabaseNode('Log Request Created', 'create', 'request_activities', [1560, 340], {
    fields: [
      ['request_id', '={{ $json.id }}'],
      ['type', 'intake'],
      ['actor', 'n8n'],
      [
        'message',
        "={{ 'Request received via ' + $json.source + ' from ' + $json.sender_email + ' - ' + $json.subject }}",
      ],
    ],
  }),

  {
    id: nid(),
    name: 'Mark Email Read',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1780, 340],
    parameters: {
      operation: 'markAsRead',
      messageId: '={{ $("Normalize Request").first().json.messageId }}',
    },
    onError: 'continueRegularOutput',
  },

  {
    id: nid(),
    name: 'AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 1.6,
    position: [2000, 340],
    parameters: {
      promptType: 'define',
      text: '={{ $json.context }}',
      options: { systemMessage: SYSTEM_MESSAGE },
    },
    onError: 'continueErrorOutput',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  },
  {
    id: nid(),
    name: 'Anthropic Claude',
    type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
    typeVersion: 1.3,
    position: [2000, 540],
    parameters: {
      model: {
        __rl: true,
        value: 'claude-sonnet-4-5-20250929',
        mode: 'list',
        cachedResultName: 'Claude Sonnet 4.5',
      },
      options: {},
    },
  },

  code('AI Failure Handler', AI_FAILURE_HANDLER, [2220, 540]),
  code('Parse Analysis', PARSE_ANALYSIS, [2440, 340]),

  supabaseNode('Log Analysis', 'create', 'request_activities', [2660, 340], {
    fields: [
      ['request_id', '={{ $("Create Request").first().json.id }}'],
      ['type', 'analysis'],
      ['actor', 'agent'],
      [
        'message',
        "={{ 'AI analysis: ' + $json.intent + ' / ' + $json.category + ', priority ' + $json.priority + ', sentiment ' + $json.sentiment + ', decision ' + $json.decision + ' (confidence ' + $json.confidence + ')' }}",
      ],
    ],
  }),

  ifNode('Requires Human?', '={{ $json.needsHuman }}', [2880, 340]),

  setNode(
    'Build Review Alert',
    [
      ['to', 'string', 'customer-ops@yourcompany.com'],
      [
        'subject',
        'string',
        "={{ '[Customer Ops] ' + $('Parse Analysis').first().json.priority.toUpperCase() + ' - human review required: ' + $('Normalize Request').first().json.subject }}",
      ],
      [
        'message',
        'string',
        "='A customer request requires human review.\\n\\nFrom: ' + $('Normalize Request').first().json.name + ' <' + $('Normalize Request').first().json.email + '>\\nSubject: ' + $('Normalize Request').first().json.subject + '\\nPriority: ' + $('Parse Analysis').first().json.priority + '\\nSentiment: ' + $('Parse Analysis').first().json.sentiment + '\\nDecision: ' + $('Parse Analysis').first().json.decision + '\\nConfidence: ' + $('Parse Analysis').first().json.confidence + '\\n\\nSummary: ' + $('Parse Analysis').first().json.summary + '\\nRecommended action: ' + $('Parse Analysis').first().json.recommended_action + ($('Parse Analysis').first().json.aiError ? '\\n\\nAI analysis error: ' + $('Parse Analysis').first().json.aiError : '') + '\\n\\nOriginal message:\\n' + $('Normalize Request').first().json.body + '\\n\\nDashboard: http://localhost:3000/requests/' + $('Create Request').first().json.id",
      ],
    ],
    [3100, 220],
  ),
  gmailSend('Send Review Alert', [3320, 220], { onError: 'continueErrorOutput' }),
  code('Alert Delivery Failed', ALERT_DELIVERY_FAILED, [3540, 100]),

  setNode(
    'Set Status Pending Review',
    [
      ['id', 'string', '={{ $("Create Request").first().json.id }}'],
      ['status', 'string', 'pending_review'],
      ['decision', 'string', '={{ $("Parse Analysis").first().json.decision }}'],
      ['intent', 'string', '={{ $("Parse Analysis").first().json.intent }}'],
      ['category', 'string', '={{ $("Parse Analysis").first().json.category }}'],
      ['priority', 'string', '={{ $("Parse Analysis").first().json.priority }}'],
      ['sentiment', 'string', '={{ $("Parse Analysis").first().json.sentiment }}'],
      ['summary', 'string', '={{ $("Parse Analysis").first().json.summary }}'],
      ['recommended_action', 'string', '={{ $("Parse Analysis").first().json.recommended_action }}'],
      ['confidence', 'number', '={{ $("Parse Analysis").first().json.confidence }}'],
      ['raw_analysis', 'object', '={{ $("Parse Analysis").first().json.rawAnalysis }}'],
      ['reply_sent', 'boolean', false],
      ['analyzed_at', 'string', '={{ new Date().toISOString() }}'],
    ],
    [3760, 220],
  ),

  setNode(
    'Build Customer Reply',
    [
      ['to', 'string', '={{ $("Normalize Request").first().json.email }}'],
      [
        'subject',
        'string',
        "={{ 'Re: ' + $('Normalize Request').first().json.subject }}",
      ],
      [
        'message',
        'string',
        "={{ $('Parse Analysis').first().json.reply.body || 'Thanks for reaching out to us. A member of our team will follow up shortly.' }}",
      ],
    ],
    [3100, 480],
  ),
  gmailSend('Send Customer Reply', [3320, 480], { onError: 'continueErrorOutput' }),
  code('Handle Send Failure', HANDLE_SEND_FAILURE, [3540, 600]),

  setNode(
    'Set Status Auto Resolved',
    [
      ['id', 'string', '={{ $("Create Request").first().json.id }}'],
      ['status', 'string', 'auto_handled'],
      ['decision', 'string', '={{ $("Parse Analysis").first().json.decision }}'],
      ['intent', 'string', '={{ $("Parse Analysis").first().json.intent }}'],
      ['category', 'string', '={{ $("Parse Analysis").first().json.category }}'],
      ['priority', 'string', '={{ $("Parse Analysis").first().json.priority }}'],
      ['sentiment', 'string', '={{ $("Parse Analysis").first().json.sentiment }}'],
      ['summary', 'string', '={{ $("Parse Analysis").first().json.summary }}'],
      ['recommended_action', 'string', '={{ $("Parse Analysis").first().json.recommended_action }}'],
      ['confidence', 'number', '={{ $("Parse Analysis").first().json.confidence }}'],
      ['raw_analysis', 'object', '={{ $("Parse Analysis").first().json.rawAnalysis }}'],
      ['reply_sent', 'boolean', true],
      ['analyzed_at', 'string', '={{ new Date().toISOString() }}'],
      ['resolved_at', 'string', '={{ new Date().toISOString() }}'],
    ],
    [3760, 400],
  ),
  setNode(
    'Set Status Failed',
    [
      ['id', 'string', '={{ $json.requestId }}'],
      ['status', 'string', 'failed'],
      ['decision', 'string', '={{ $("Parse Analysis").first().json.decision }}'],
      ['intent', 'string', '={{ $("Parse Analysis").first().json.intent }}'],
      ['category', 'string', '={{ $("Parse Analysis").first().json.category }}'],
      ['priority', 'string', '={{ $("Parse Analysis").first().json.priority }}'],
      ['sentiment', 'string', '={{ $("Parse Analysis").first().json.sentiment }}'],
      ['summary', 'string', '={{ $("Parse Analysis").first().json.summary }}'],
      ['recommended_action', 'string', '={{ $("Parse Analysis").first().json.recommended_action }}'],
      ['confidence', 'number', '={{ $("Parse Analysis").first().json.confidence }}'],
      ['raw_analysis', 'object', '={{ $("Parse Analysis").first().json.rawAnalysis }}'],
      ['reply_sent', 'boolean', false],
      ['last_error', 'string', '={{ $json.lastError }}'],
      ['analyzed_at', 'string', '={{ new Date().toISOString() }}'],
    ],
    [3760, 600],
  ),

  {
    id: nid(),
    name: 'Update Request Status',
    type: 'n8n-nodes-base.supabase',
    typeVersion: 1,
    position: [3980, 420],
    parameters: {
      operation: 'update',
      tableId: 'requests',
      dataToSend: 'autoMapInputData',
      inputsToIgnore: '',
      filterType: 'manual',
      matchType: 'allFilters',
      filters: {
        conditions: [{ keyName: 'id', condition: 'eq', keyValue: '={{ $json.id }}' }],
      },
    },
  },

  supabaseNode('Log Status Activity', 'create', 'request_activities', [4200, 420], {
    fields: [
      ['request_id', '={{ $json.id }}'],
      [
        'type',
        "={{ $json.status === 'auto_handled' ? 'auto_resolution' : ($json.status === 'failed' ? 'error' : 'review_requested') }}",
      ],
      ['actor', 'n8n'],
      [
        'message',
        "={{ $json.status === 'auto_handled' ? 'AI auto-resolved the request and emailed the customer' : ($json.status === 'failed' ? 'Workflow error: ' + ($json.last_error || 'unknown error') : 'Routed to the human review queue (decision: ' + $json.decision + ')' + ($('Parse Analysis').first().json.aiError ? ' - AI error: ' + $('Parse Analysis').first().json.aiError : '')) }}",
      ],
    ],
  }),
];

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

const link = (from, to, output = 0) => ({ from, to, output });

const edges = [
  link('Gmail Trigger', 'Normalize Request'),
  link('Webhook Intake', 'Normalize Request'),
  link('Normalize Request', 'Find Customer'),
  link('Find Customer', 'Customer Found?'),
  link('Customer Found?', 'Prepare Context', 0),
  link('Customer Found?', 'Create Customer', 1),
  link('Create Customer', 'Prepare Context'),
  link('Prepare Context', 'Create Request'),
  link('Create Request', 'Intake Failure Alert', 1),
  link('Intake Failure Alert', 'Send Intake Failure Alert'),
  link('Create Request', 'Log Request Created', 0),
  link('Log Request Created', 'Mark Email Read'),
  link('Mark Email Read', 'AI Agent'),
  link('AI Agent', 'AI Failure Handler', 1),
  link('AI Agent', 'Parse Analysis', 0),
  link('AI Failure Handler', 'Parse Analysis'),
  link('Parse Analysis', 'Log Analysis'),
  link('Log Analysis', 'Requires Human?'),
  link('Requires Human?', 'Build Review Alert', 0),
  link('Requires Human?', 'Build Customer Reply', 1),
  link('Build Review Alert', 'Send Review Alert'),
  link('Send Review Alert', 'Set Status Pending Review', 0),
  link('Send Review Alert', 'Alert Delivery Failed', 1),
  link('Alert Delivery Failed', 'Set Status Pending Review'),
  link('Build Customer Reply', 'Send Customer Reply'),
  link('Send Customer Reply', 'Set Status Auto Resolved', 0),
  link('Send Customer Reply', 'Handle Send Failure', 1),
  link('Handle Send Failure', 'Set Status Failed'),
  link('Set Status Auto Resolved', 'Update Request Status'),
  link('Set Status Pending Review', 'Update Request Status'),
  link('Set Status Failed', 'Update Request Status'),
  link('Update Request Status', 'Log Status Activity'),
];

const connections = {};
for (const { from, to, output } of edges) {
  connections[from] ??= { main: [] };
  const branch = connections[from].main;
  while (branch.length <= output) branch.push([]);
  branch[output].push({ node: to, type: 'main', index: 0 });
}
connections['AI Agent'] = {
  ...connections['AI Agent'],
  ai_languageModel: [[{ node: 'Anthropic Claude', type: 'ai_languageModel', index: 0 }]],
};

const workflow = {
  name: 'AI Customer Operations Pipeline',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  versionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log(`Wrote ${OUT} (${nodes.length} nodes, ${edges.length} edges)`);
