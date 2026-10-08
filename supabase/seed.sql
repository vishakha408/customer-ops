-- ============================================================================
-- Demo data for local development / dashboard screenshots.
-- Run AFTER schema.sql. Everything is idempotent thanks to upserts.
-- ============================================================================

insert into public.customers (email, full_name, plan, lifetime_value, phone)
values
  ('amelia.jones@northwind.io',  'Amelia Jones',  'enterprise', 48200.00, '+1 415 555 0110'),
  ('bruno.santos@vertexlabs.co', 'Bruno Santos',  'pro',         9120.00, '+1 415 555 0132'),
  ('chen.wei@atlas-retail.com',  'Chen Wei',      'starter',     1150.00, '+1 415 555 0177'),
  ('dana.k@brightpath.dev',      'Dana Kaplan',   'pro',         6400.00, '+1 415 555 0193')
on conflict (email) do nothing;

with seed(email, subject, body, status, intent, category, priority, sentiment,
          summary, recommended_action, decision, confidence, resolution_note) as (
  values
    ('amelia.jones@northwind.io',
     'Cannot access my account - urgent',
     'I have been locked out of my account for 3 hours. We have an investor demo at 2pm and I cannot get in. This is extremely frustrating - we pay for the enterprise plan!',
     'pending_review', 'login_issue', 'account_access', 'urgent', 'angry',
     'Enterprise customer locked out before a critical demo; angry sentiment and urgent priority.',
     'Escalate to human support with password reset + session review',
     'escalate', 0.94::numeric, null),
    ('bruno.santos@vertexlabs.co',
     'Question about upgrading my plan',
     'Hi, we are growing and I think we need the Pro plan. Can you tell me what the differences are and how billing works when upgrading?',
     'auto_handled', 'billing', 'plan_upgrade', 'medium', 'positive',
     'Prospective upgrade question; informational, no account risk.',
     'Send automated plan comparison + upgrade link',
     'auto_resolve', 0.91::numeric, 'Auto-replied with plan comparison and upgrade link.'),
    ('chen.wei@atlas-retail.com',
     'API returning 500 errors since this morning',
     'Your /v2/orders endpoint started returning 500 errors around 9am UTC. About 12% of our order syncs are failing. Please advise.',
     'in_progress', 'technical', 'api_incident', 'high', 'negative',
     'Production API errors affecting order sync; high impact but customer is calm.',
     'Route to engineering on-call with correlation IDs',
     'human_review', 0.88::numeric, null),
    ('dana.k@brightpath.dev',
     'Thanks for the quick fix!',
     'Just wanted to say the issue from last week was resolved fast. Great support team.',
     'resolved', 'feedback', 'positive_feedback', 'low', 'positive',
     'Positive feedback; no action required beyond acknowledgement.',
     'Send thank-you note and log to account timeline',
     'auto_resolve', 0.97::numeric, 'Acknowledgement sent.')
),
created as (
  insert into public.requests
    (customer_id, sender_email, subject, body, source, status, intent, category,
     priority, sentiment, summary, recommended_action, decision, confidence,
     analyzed_at, resolved_at, reply_sent, resolution_note)
  select
    c.id,
    s.email,
    s.subject,
    s.body,
    'email',
    s.status,
    s.intent,
    s.category,
    s.priority,
    s.sentiment,
    s.summary,
    s.recommended_action,
    s.decision,
    s.confidence,
    case when s.status <> 'new' then now() - interval '20 minutes' end,
    case when s.status in ('auto_handled', 'resolved') then now() - interval '12 minutes' end,
    s.status in ('auto_handled', 'resolved'),
    s.resolution_note
  from seed s
  join public.customers c on c.email = s.email
  -- skip rows that already exist (same sender + subject)
  where not exists (
    select 1 from public.requests r
     where r.sender_email = s.email and r.subject = s.subject
  )
  returning id, status, subject
)
insert into public.request_activities (request_id, type, actor, message, metadata)
select created.id, 'intake', 'n8n', 'Request received via Gmail and normalised',
       '{"source": "email"}'::jsonb
from created
union all
select created.id, 'analysis', 'agent', 'AI analysis completed',
       jsonb_build_object('status', created.status)
from created
where created.status <> 'new';
