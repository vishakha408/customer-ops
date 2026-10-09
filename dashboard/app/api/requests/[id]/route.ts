import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { DECISIONS, REQUEST_STATUSES, type RequestStatus } from '@/lib/types';
import { writeAuthorized } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

const OPEN_STATUSES = ['new', 'analyzing', 'pending_review', 'in_progress'];

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
 * Human intervention: claim a request, change status, add a resolution note.
 * The DB trigger writes the matching timeline entry automatically.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!writeAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updatable fields supplied' }, { status: 400 });
  }

  // Taking ownership implicitly claims the request.
  if (update.status === 'in_progress' && update.assigned_to === undefined) {
    update.assigned_to = 'dashboard-operator';
  }
  if (update.status === 'resolved' || update.status === 'auto_handled') {
    update.resolved_at = new Date().toISOString();
  } else if (typeof update.status === 'string' && OPEN_STATUSES.includes(update.status)) {
    // Reopened: clear the stale timestamp so avg. resolution metrics only
    // reflect requests that are actually closed.
    update.resolved_at = null;
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
    return NextResponse.json({ request: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Configuration error' },
      { status: 500 },
    );
  }
}
