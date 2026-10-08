import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { DECISIONS, REQUEST_STATUSES, type RequestStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

async function forwardResolutionToN8n(requestId: string): Promise<{ forwarded: boolean; warning: string | null }> {
  const n8nUrl = process.env.N8N_RESOLUTION_WEBHOOK_URL;
  if (!n8nUrl) {
    return { forwarded: false, warning: 'N8N_RESOLUTION_WEBHOOK_URL is not set' };
  }

  try {
    const res = await fetch(n8nUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.N8N_WEBHOOK_SECRET ? { 'x-webhook-secret': process.env.N8N_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(10000),
    });

    const forwarded = res.ok;
    if (forwarded) return { forwarded: true, warning: null };

    let warning = `n8n responded with HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) warning = `${warning}: ${text.slice(0, 500)}`;
    } catch {
      /* ignore */
    }
    return { forwarded: false, warning };
  } catch (err) {
    const warning = err instanceof Error ? err.message : 'n8n unreachable';
    return { forwarded: false, warning };
  }
}

/** GET /api/requests/:id - full request record + activity timeline. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const supabase = getSupabaseAdmin();
    const [requestRes, activityRes] = await Promise.all([
      supabase
        .from('requests')
        .select('*, customer:customers(*)')
        .eq('id', params.id)
        .maybeSingle(),
      supabase
        .from('request_activities')
        .select('*')
        .eq('request_id', params.id)
        .order('created_at', { ascending: true }),
    ]);

    if (requestRes.error) {
      return NextResponse.json({ error: requestRes.error.message }, { status: 502 });
    }
    if (!requestRes.data) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    return NextResponse.json({
      request: { ...requestRes.data, request_activities: activityRes.data ?? [] },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Configuration error' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/requests/:id
 * Human intervention: claim a request, change status, add a resolution note, review/queue reply before sending.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!(REQUEST_STATUSES as readonly string[]).includes(body.status as string)) {
      return NextResponse.json(
        { error: `Invalid status. Allowed: ${REQUEST_STATUSES.join(', ')}` },
        { status: 422 },
      );
    }
    update.status = body.status as RequestStatus;
    if (body.status === 'failed' && body.last_error !== undefined) {
      update.last_error = String(body.last_error).slice(0, 1000);
    }
  }
  if (body.assigned_to !== undefined) {
    update.assigned_to = String(body.assigned_to).slice(0, 120) || null;
  }
  if (body.resolution_note !== undefined) {
    update.resolution_note = String(body.resolution_note).slice(0, 4000) || null;
  }
  if (body.decision !== undefined) {
    if (!(DECISIONS as readonly string[]).includes(String(body.decision))) {
      return NextResponse.json(
        { error: `Invalid decision. Allowed: ${DECISIONS.join(', ')}` },
        { status: 422 },
      );
    }
    update.decision = String(body.decision);
  }
  if (body.reply_subject !== undefined) {
    update.reply_subject = String(body.reply_subject).slice(0, 500) || null;
  }
  if (body.reply_draft !== undefined) {
    update.reply_draft = String(body.reply_draft).slice(0, 10000) || null;
  }
  if (body.reply_sent_at !== undefined) {
    update.reply_sent_at = body.reply_sent_at ? String(body.reply_sent_at) : null;
  }
  if (body.reply_sent_error !== undefined) {
    update.reply_sent_error = String(body.reply_sent_error).slice(0, 1000) || null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updatable fields supplied' }, { status: 400 });
  }

  // Taking ownership implicitly claims the request.
  if (update.status === 'in_progress' && update.assigned_to === undefined) {
    update.assigned_to = 'dashboard-operator';
  }
  if (update.status === 'resolved' || update.status === 'auto_handled') {
    if (!update.resolved_at) {
      update.resolved_at = new Date().toISOString();
    }
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('requests')
      .update(update)
      .eq('id', params.id)
      .select('*, customer:customers(*)')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    let replyTriggered = false;
    let replyWarning: string | null = null;
    const shouldSendReply =
      body.send_reply === true &&
      (update.status === 'resolved' || body.status === 'resolved') &&
      body.reply_draft !== undefined &&
      String(body.reply_draft).trim().length > 0;

    if (shouldSendReply) {
      const res = await forwardResolutionToN8n(params.id);
      replyTriggered = res.forwarded;
      replyWarning = res.warning;

      if (replyTriggered) {
        await supabase
          .from('requests')
          .update({
            reply_sent_at: new Date().toISOString(),
            reply_sent_error: null,
          })
          .eq('id', params.id);
      } else if (replyWarning) {
        await supabase
          .from('requests')
          .update({
            reply_sent_error: replyWarning.slice(0, 1000),
          })
          .eq('id', params.id);
      }
    }

    const final = await supabase
      .from('requests')
      .select('*, customer:customers(*)')
      .eq('id', params.id)
      .maybeSingle();

    return NextResponse.json({
      request: final.data ?? data,
      replyTriggered,
      ...(replyWarning ? { replyWarning } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Configuration error' },
      { status: 500 },
    );
  }
}