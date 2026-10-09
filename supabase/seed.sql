-- ============================================================================
-- Demo data for local development / dashboard screenshots.
-- Run AFTER schema.sql. Everything is idempotent thanks to upserts.
-- Indian demo data: names, +91 phone numbers, .in email domains, INR values.
-- ============================================================================

insert into public.customers (email, full_name, plan, lifetime_value, phone)
values
  ('priya.sharma@bharatmart.in', 'Priya Sharma', 'enterprise', 482000.00, '+91 98765 43210'),
  ('rahul.verma@techveda.co.in', 'Rahul Verma',  'pro',         91200.00, '+91 98200 11223'),
  ('ananya.iyer@kalparetail.in', 'Ananya Iyer',  'starter',     11500.00, '+91 98450 77889'),
  ('vikram.singh@nexgenlabs.in', 'Vikram Singh', 'pro',         64000.00, '+91 99100 55667')
on conflict (email) do nothing;

with seed(email, subject, body, status, intent, category, priority, sentiment,
          summary, recommended_action, decision, confidence, resolution_note) as (
  values
    ('priya.sharma@bharatmart.in',
     'Cannot access my account - urgent',
     'I have been locked out of my seller account for 3 hours. We have a Big Billion Days prep call at 2pm IST and I cannot get in. This is extremely frustrating - we pay for the enterprise plan!',
     'pending_review', 'login_issue', 'account_access', 'urgent', 'angry',
     'Enterprise customer locked out before a critical planning call; angry sentiment and urgent priority.',
     'Escalate to human support with password reset + session review',
     'escalate', 0.94::numeric, null),
    ('rahul.verma@techveda.co.in',
     'Question about upgrading my plan',
     'Hi, we are growing fast and I think we need the Pro plan now. Can you tell me what the differences are and how billing works when upgrading? We would prefer to pay via UPI or NEFT - please share the GST invoice process too.',
     'auto_handled', 'plan_upgrade', 'billing', 'medium', 'positive',
     'Prospective upgrade question; informational, no account risk.',
     'Send automated plan comparison + upgrade link',
     'auto_resolve', 0.91::numeric, 'Auto-replied with plan comparison, upgrade link and GST invoice details.'),
    ('ananya.iyer@kalparetail.in',
     'API returning 500 errors since this morning',
     'Your /v2/orders endpoint started returning 500 errors around 9am IST. About 12% of our order syncs are failing and it is hitting our Diwali sale prep. Please advise.',
     'in_progress', 'api_incident', 'technical', 'high', 'negative',
     'Production API errors affecting order sync; high impact but customer is calm.',
     'Route to engineering on-call with correlation IDs',
     'human_review', 0.88::numeric, null),
    ('vikram.singh@nexgenlabs.in',
     'Thanks for the quick fix!',
     'Just wanted to say the issue from last week was resolved fast. Great support team - truly appreciative!',
     'resolved', 'positive_feedback', 'feedback', 'low', 'positive',
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
