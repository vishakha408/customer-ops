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

function run(code, input, nodes = {}) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Node ${name} not executed`);
    return { first: () => ({ json: nodes[name] }) };
  };
  const fn = new Function('$input', '$', 'Buffer', code);
  const out = fn($input, $, Buffer);
  return out[0].json;
}

/* ---------------- Normalize Request ---------------- */
const normalize = codeOf('Normalize Request');

console.log('Normalize Request:');
const gmailRaw = run(normalize, {
  id: 'msg123',
  threadId: 'thr1',
  payload: {
    headers: [
      { name: 'From', value: 'Amelia Jones <amelia.jones@northwind.io>' },
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
check('raw gmail parses sender', gmailRaw.email === 'amelia.jones@northwind.io');
check('raw gmail parses name', gmailRaw.name === 'Amelia Jones', gmailRaw.name);
check('raw gmail parses subject', gmailRaw.subject === 'Cannot log in');
check('raw gmail decodes body', gmailRaw.body.includes('locked out'), gmailRaw.body);
check('raw gmail source=email', gmailRaw.source === 'email');
check('raw gmail messageId', gmailRaw.messageId === 'msg123');

const simplified = run(normalize, {
  id: 'm2',
  from: 'Bruno Santos <bruno@vertexlabs.co>',
  subject: 'Upgrade question',
  snippet: 'Can we move to Pro?',
});
check('simplified gmail sender', simplified.email === 'bruno@vertexlabs.co');
check('simplified gmail snippet body', simplified.body === 'Can we move to Pro?');

const webhook = run(normalize, {
  email: 'Chen.Wei@atlas-retail.com',
  subject: 'API errors',
  body: '500s on /v2/orders',
});
check('webhook email normalised', webhook.email === 'chen.wei@atlas-retail.com');
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
let r = run(parse, intake, { 'AI Agent': good, 'Normalize Request': intake });
check('valid json -> auto_resolve', r.decision === 'auto_resolve' && r.needsHuman === false);
check('confidence kept', r.confidence === 0.92);

const fenced = { output: '```json\n' + good.output + '\n```' };
r = run(parse, intake, { 'AI Agent': fenced, 'Normalize Request': intake });
check('markdown-fenced json parsed', r.intent === 'plan_upgrade');

const garbage = { output: 'I cannot help with that.' };
r = run(parse, intake, { 'AI Agent': garbage, 'Normalize Request': intake });
check('garbage -> human_review', r.decision === 'human_review' && r.needsHuman === true);
check('garbage flagged analysisFailed', r.analysisFailed === true);

const noOutput = { error: 'model timeout' };
r = run(parse, intake, { 'AI Agent': noOutput, 'Normalize Request': intake });
check('agent error -> human_review', r.decision === 'human_review' && r.analysisFailed);

// Guardrail: urgent + auto_resolve must escalate
const urgentAuto = {
  output: JSON.stringify({
    ...JSON.parse(good.output),
    priority: 'urgent',
    confidence: 0.95,
  }),
};
r = run(parse, intake, { 'AI Agent': urgentAuto, 'Normalize Request': intake });
check('urgent auto_resolve -> escalate', r.decision === 'escalate', r.decision);

// Guardrail: angry sentiment never auto-resolves
const angry = {
  output: JSON.stringify({ ...JSON.parse(good.output), sentiment: 'angry' }),
};
r = run(parse, intake, { 'AI Agent': angry, 'Normalize Request': intake });
check('angry auto_resolve -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: low confidence
const lowConf = { output: JSON.stringify({ ...JSON.parse(good.output), confidence: 0.4 }) };
r = run(parse, intake, { 'AI Agent': lowConf, 'Normalize Request': intake });
check('confidence 0.4 -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: unknown customer
r = run(parse, { ...intake, customerKnown: false }, {
  'AI Agent': good,
  'Normalize Request': { ...intake, customerKnown: false },
});
check('unknown customer -> human_review', r.decision === 'human_review', r.decision);

// Guardrail: missing reply body
const noReply = { output: JSON.stringify({ ...JSON.parse(good.output), reply: {} }) };
r = run(parse, intake, { 'AI Agent': noReply, 'Normalize Request': intake });
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
r = run(parse, intake, { 'AI Agent': badEnums, 'Normalize Request': intake });
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
