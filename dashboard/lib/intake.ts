import { getSupabaseAdmin } from './supabase';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface IntakeInput {
  email: string;
  name?: string;
  subject?: string;
  body: string;
  source?: 'webhook' | 'dashboard';
}

export interface IntakeResult {
  status: number;
  payload: Record<string, unknown>;
}

/**
 * Stores an incoming customer request (customer upsert + request row +
 * timeline entry) and makes a best-effort handoff to the n8n pipeline.
 *
 * Design rule: the database write always happens first, so a failing n8n
 * instance never loses a request - it simply stays in status "new" until the
 * Gmail trigger or a manual webhook replay picks it up.
 */
export async function processIntake(input: IntakeInput): Promise<IntakeResult> {
  const email = String(input.email ?? '').trim().toLowerCase();
  const name = String(input.name ?? '').trim();
  const subject = String(input.subject ?? '').trim() || '(no subject)';
  const message = String(input.body ?? '').trim();
  const source = input.source === 'dashboard' ? 'dashboard' : 'webhook';

  if (!EMAIL_RE.test(email)) {
    return { status: 422, payload: { error: 'A valid "email" field is required' } };
  }
  if (!message) {
    return { status: 422, payload: { error: 'A non-empty "body" field is required' } };
  }

  try {
    const supabase = getSupabaseAdmin();

    // 1. Upsert the customer so the AI agent has context.
    const customerPayload: Record<string, unknown> = { email };
    if (name) customerPayload.full_name = name;
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .upsert(customerPayload, { onConflict: 'email' })
      .select('id')
      .single();
    if (customerError) {
      return { status: 502, payload: { error: customerError.message } };
    }

    // 2. Store the request.
    const { data: request, error: requestError } = await supabase
      .from('requests')
      .insert({
        customer_id: customer.id,
        sender_email: email,
        subject: subject.slice(0, 500),
        body: message.slice(0, 20000),
        source,
        status: 'new',
      })
      .select('id')
      .single();
    if (requestError) {
      return { status: 502, payload: { error: requestError.message } };
    }

    // 3. Timeline entry.
    await supabase.from('request_activities').insert({
      request_id: request.id,
      type: 'intake',
      actor: 'system',
      message: `Request received via ${source} from ${email} - ${subject.slice(0, 200)}`,
    });

    // 4. Best-effort handoff to n8n for AI analysis.
    let forwarded = false;
    let warning: string | null = null;
    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    if (n8nUrl) {
      try {
        const res = await fetch(n8nUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env.N8N_WEBHOOK_SECRET
              ? { 'x-webhook-secret': process.env.N8N_WEBHOOK_SECRET }
              : {}),
          },
          body: JSON.stringify({ email, name, subject, body: message, requestId: request.id }),
          signal: AbortSignal.timeout(5000),
        });
        forwarded = res.ok;
        if (!res.ok) warning = `n8n responded with HTTP ${res.status}`;
      } catch (err) {
        warning = err instanceof Error ? err.message : 'n8n unreachable';
      }
    }

    return {
      status: 202,
      payload: {
        ok: true,
        requestId: request.id,
        forwarded,
        warning,
        message: n8nUrl
          ? forwarded
            ? 'Stored and handed off to n8n for AI analysis'
            : `Stored, but the n8n handoff failed (${warning}) - the request stays queued as "new"`
          : 'Stored. Set N8N_WEBHOOK_URL to hand requests to n8n automatically',
      },
    };
  } catch (err) {
    return {
      status: 500,
      payload: { error: err instanceof Error ? err.message : 'Intake failed' },
    };
  }
}
