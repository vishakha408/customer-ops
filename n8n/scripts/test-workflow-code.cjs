// Quick sanity harness for the Code-node sources inside the n8n workflow JSON.
const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', 'ai-customer-ops-pipeline.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label} ${extra}`);
  }
};

function run(code, input, nodes = {}, env = {}) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Node ${name} not executed`);
    return { first: () => ({ json: nodes[name] }) };
  };
  const $env = env;
  const fn = new Function('$input', '$', 'Buffer', '$env', code);
  const out = fn($input, $, Buffer, $env);
  return out[0].json;
}

/** Asserts that the code throws (used for the webhook secret rejection). */
function runExpectingThrow(code, input, env = {}) {
  try {
    run(code, input, {}, env);
    return false;
  } catch (e) {
    return /x-webhook-secret/.test(String(e.message));
  }
}

/* ---------------- Normalize Request ---------------- */
const normalize = codeOf('Normalize Request');

console.log('Normalize Request:');
const gmailRaw = run(normalize, {
  id: 'msg123',
  threadId: 'thr1',
  payload: {
    headers: [
      { name: 'From', value: 'Priya Sharma <priya.sharma@bharatmart.in>' },
      { name: 'Subject', value: 'Cannot log in' },
    ],
    parts: [
      {
        body: {
          data: Buffer.from('I am locked out of my account since 3 hours!', 'utf8').toString(
            'base64url',
          ),
        },
      },
    ],
  },
});
check('raw gmail parses sender', gmailRaw.email === 'priya.sharma@bharatmart.in');
check('raw gmail parses name', gmailRaw.name === 'Priya Sharma', gmailRaw.name);
check('raw gmail parses subject', gmailRaw.subject === 'Cannot log in');
check('raw gmail decodes body', gmailRaw.body.includes('locked out'), gmailRaw.body);
check('raw gmail source=email', gmailRaw.source === 'email');
check('raw gmail messageId', gmailRaw.messageId === 'msg123');

const simplified = run(normalize, {
  id: 'm2',
  from: 'Rahul Verma <rahul@techveda.co.in>',
  subject: 'Upgrade question',
  snippet: 'Can we move to Pro?',
});
check('simplified gmail sender', simplified.email === 'rahul@techveda.co.in');
check('simplified gmail snippet body', simplified.body === 'Can we move to Pro?');

// Gmail trigger/node sometimes returns header fields as nested objects
// ({ value: [{ name, address }], text }). Must not become "[object Object]".
const objectFrom = run(normalize, {
  id: 'm3',
  from: {
    value: [{ name: 'Priya Sharma', address: 'Priya.Sharma@bharatmart.in' }],
    text: 'Priya Sharma <Priya.Sharma@bharatmart.in>',
  },
  subject: { value: [{ text: 'Refund please' }], text: 'Refund please' },
  text: { text: 'Charged twice for invoice 1042' },
});
check('object from -> email', objectFrom.email === 'priya.sharma@bharatmart.in', objectFrom.email);
check('object from -> name', objectFrom.name === 'Priya Sharma', objectFrom.name);
check('object subject -> text', objectFrom.subject === 'Refund please', objectFrom.subject);
check('object text -> body', objectFrom.body === 'Charged twice for invoice 1042', objectFrom.body);

const addressOnly = run(normalize, {
  id: 'm4',
  from: { value: [{ address: 'solo@example.com' }] },
  subject: 'Hi',
  text: 'body',
});
check('object from without name -> email', addressOnly.email === 'solo@example.com', addressOnly.email);

const webhook = run(normalize, {
  email: 'Ananya.Iyer@kalparetail.in',
  subject: 'API errors',
  body: '500s on /v2/orders',
});
check('webhook email normalised', webhook.email === 'ananya.iyer@kalparetail.in');
check('webhook source', webhook.source === 'webhook');
check('webhook body', webhook.body === '500s on /v2/orders');

const noEmail = run(normalize, { subject: 'hi', body: 'help please' });
check(
  'missing email -> placeholder + warning',
  noEmail.email === 'unverified-sender@invalid.local' && noEmail.intakeWarnings.length > 0,
  JSON.stringify(noEmail.intakeWarnings),
);

const empty = run(normalize, {});
check(
  'empty payload -> defaults + warnings',
  empty.subject === '(no subject)' && empty.intakeWarnings.length >= 1,
);

// The n8n Webhook node (v2) wraps the POSTed JSON in a `body` key, so the
// real shape is { headers, params, query, body: { email, subject, body } }.
const wrapped = run(normalize, {
  headers: { 'content-type': 'application/json' },
  params: {},
  query: {},
  body: {
    email: 'Priya.Sharma@bharatmart.in',
    name: 'Priya Sharma',
    subject: 'Refund for invoice 1042',
    body: 'We were charged twice - please refund.',
  },
});
check('wrapped webhook email', wrapped.email === 'priya.sharma@bharatmart.in', wrapped.email);
check('wrapped webhook name', wrapped.name === 'Priya Sharma', wrapped.name);
check('wrapped webhook body', wrapped.body === 'We were charged twice - please refund.');
check('wrapped webhook source', wrapped.source === 'webhook');
check('wrapped webhook no warnings', wrapped.intakeWarnings.length === 0);

const wrappedNoBody = run(normalize, { headers: {}, params: {}, query: {} });
check(
  'wrapped webhook missing body -> no crash, placeholder',
  wrappedNoBody.email === 'unverified-sender@invalid.local' &&
    wrappedNoBody.subject === '(no subject)',
  JSON.stringify(wrappedNoBody.intakeWarnings),
);

const wrappedStringBody = run(normalize, { body: 'plain text body' });
check(
  'wrapped webhook string body -> no crash',
  wrappedStringBody.source === 'webhook',
  JSON.stringify(wrappedStringBody),
);

// Dashboard-forwarded requests carry the row id created by the intake API,
// so the workflow analyses that row instead of inserting a duplicate.
const withRequestId = run(normalize, {
  headers: {},
  params: {},
  query: {},
  body: {
    email: 'priya.sharma@bharatmart.in',
    subject: 'Refund',
    body: 'Charged twice',
    requestId: 'row-123',
  },
});
check('webhook requestId captured', withRequestId.requestId === 'row-123', withRequestId.requestId);

const gmailNoRequestId = run(normalize, {
  id: 'm9',
  from: 'Priya <priya.sharma@bharatmart.in>',
  subject: 'Hi',
  text: 'Help',
});
check('gmail requestId empty', gmailNoRequestId.requestId === '');

const flatNoRequestId = run(normalize, { email: 'a@b.com', subject: 's', body: 'b' });
check('flat webhook requestId defaults to empty', flatNoRequestId.requestId === '');

// Webhook secret enforcement: skipped when unconfigured, enforced when set.
const SECRET = 's3cret-value';
const SECRET_ENV = { N8N_WEBHOOK_SECRET: SECRET };
const secretPayload = {
  headers: {},
  params: {},
  query: {},
  body: { email: 'a@b.com', subject: 's', body: 'b' },
};
check(
  'secret configured + header missing -> rejected',
  runExpectingThrow(normalize, secretPayload, SECRET_ENV),
);
check(
  'secret configured + wrong header -> rejected',
  runExpectingThrow(
    normalize,
    { ...secretPayload, headers: { 'x-webhook-secret': 'nope' } },
    SECRET_ENV,
  ),
);
const goodSecret = run(
  normalize,
  { ...secretPayload, headers: { 'X-Webhook-Secret': SECRET } },
  SECRET_ENV,
);
check('secret configured + correct header -> accepted', goodSecret.email === 'a@b.com');
check(
  'no secret configured -> accepted without header',
  run(normalize, secretPayload).email === 'a@b.com',
);

/* ---------------- Parse Analysis ---------------- */
const parse = codeOf('Parse Analysis');
const intake = {
  email: 'a@b.com',
  subject: 's',
  body: 'b',
  intakeWarnings: [],
  customerKnown: true,
};

console.log('Parse Analysis:');
// Parse Analysis reads $input: the AI Agent output on the success path, or
// the "AI Failure Handler" output ({ output: '', aiError }) on the error path.
const good = {
  output: JSON.stringify({
    intent: 'plan_upgrade',
    category: 'billing',
    priority: 'medium',
    sentiment: 'positive',
    summary: 'Wants Pro plan',
    recommended_action: 'Send plan comparison',
    decision: 'auto_resolve',
    confidence: 0.92,
    reply: { subject: 'Re: plans', body: 'Here are our plans...' },
  }),
};
let r = run(parse, good, { 'Normalize Request': intake });
check('valid json -> auto_resolve', r.decision === 'auto_resolve' && r.needsHuman === false);
check('confidence kept', r.confidence === 0.92);

const fenced = { output: '```json\n' + good.output + '\n```' };
r = run(parse, fenced, { 'Normalize Request': intake });
check('markdown-fenced json parsed', r.intent === 'plan_upgrade');

// Models can emit raw newlines at arbitrary points (illegal inside JSON
// strings). Parse Analysis must strip them while keeping the escaped \n that
// belong in the reply body.
const newlineWrappedRaw =
  '{\n  "\nintent": "plan_up\ngrade",\n  "category\n": "billing",\n' +
  '  "\npriority": "medium",\n  "sentiment": "\npositive",\n' +
  '  "summary\n": "An\n existing customer",\n' +
  '  "recommended_action": "Route\n to billing",\n' +
  '  "decision": "human\n_review",\n  "confid\nence": 0.85,\n' +
  '  "reply": {\n    "subject": "\nRe: plans",\n    "body": "Hi,\\n\\nThanks"\n  }\n}';
const newlineWrapped = { output: newlineWrappedRaw };
r = run(parse, newlineWrapped, { 'Normalize Request': intake });
check('raw newlines inside json tolerated', r.intent === 'plan_upgrade', r.intent);
check(
  'repair keeps escaped newlines in body',
  r.reply.body === 'Hi,\n\nThanks',
  JSON.stringify(r.reply.body),
);

const garbage = { output: 'I cannot help with that.' };
r = run(parse, garbage, { 'Normalize Request': intake });
check('garbage -> human_review', r.decision === 'human_review' && r.needsHuman === true);
check('garbage flagged analysisFailed', r.analysisFailed === true);

// Error path: AI Failure Handler forwards { output: '', aiError }.
const handlerOutput = { output: '', aiError: 'model timeout' };
r = run(parse, handlerOutput, { 'Normalize Request': intake });
check('agent error -> human_review', r.decision === 'human_review' && r.analysisFailed);
check('agent error surfaced as aiError', r.aiError === 'model timeout', r.aiError);

// Guardrail: urgent + auto_resolve must escalate
const urgentAuto = {
  output: JSON.stringify({
    ...JSON.parse(good.output),
    priority: 'urgent',
    confidence: 0.95,
  }),
};
r = run(parse, urgentAuto, { 'Normalize Request': intake });
check('urgent auto_resolve -> escalate', r.decision === 'escalate', r.decision);

// Guardrail: angry sentiment never auto-resolves
const angry = {
  output: JSON.stringify({ ...JSON.parse(good.output), sentiment: 'angry' }),
};
r = run(parse, angry, { 'Normalize Request': intake });
check('angry auto_resolve -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: low confidence
const lowConf = { output: JSON.stringify({ ...JSON.parse(good.output), confidence: 0.4 }) };
r = run(parse, lowConf, { 'Normalize Request': intake });
check('confidence 0.4 -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: unknown customer
const unknownIntake = { ...intake, customerKnown: false };
r = run(parse, good, { 'Normalize Request': unknownIntake });
check('unknown customer -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: missing reply body
const noReply = { output: JSON.stringify({ ...JSON.parse(good.output), reply: {} }) };
r = run(parse, noReply, { 'Normalize Request': intake });
check('missing reply body -> human_review', r.decision === 'human_review', r.decision);

// Invalid enum values fall back to safe defaults
const badEnums = {
  output: JSON.stringify({
    intent: 'X',
    category: 'nonsense',
    priority: 'asap',
    sentiment: 'furious',
    decision: 'do_everything',
    confidence: 'high',
    summary: 42,
  }),
};
r = run(parse, badEnums, { 'Normalize Request': intake });
check(
  'invalid enums -> safe defaults',
  r.priority === 'medium' &&
    r.sentiment === 'neutral' &&
    r.category === 'other' &&
    r.decision === 'human_review' &&
    r.confidence === 0,
  JSON.stringify(r),
);

/* ---------------- Prepare Context ---------------- */
console.log('Prepare Context:');
const prep = codeOf('Prepare Context');
r = run(
  prep,
  {},
  {
    'Normalize Request': intake,
    'Find Customer': {
      email: 'a@b.com',
      full_name: 'Ann',
      plan: 'pro',
      lifetime_value: 5000,
      open_requests: 1,
      notes: null,
    },
  },
);
check('context has customer', r.context.includes('"plan": "pro"'));
check('customerKnown true', r.customerKnown === true);
check('column-aligned output', r.sender_email === 'a@b.com' && r.status === 'analyzing');

r = run(prep, {}, { 'Normalize Request': intake, 'Find Customer': {} });
check(
  'no customer -> customerKnown false',
  r.customerKnown === false && r.context.includes('"customer": null'),
);

r = run(
  prep,
  {},
  { 'Normalize Request': { ...intake, requestId: 'row-9' }, 'Find Customer': {} },
);
check('requestId forwarded to row update', r.requestId === 'row-9', r.requestId);
r = run(prep, {}, { 'Normalize Request': intake, 'Find Customer': {} });
check('requestId defaults to empty', r.requestId === '');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
