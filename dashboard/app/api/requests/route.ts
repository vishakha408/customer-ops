import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { REQUEST_STATUSES, PRIORITIES } from '@/lib/types';
import { processIntake } from '@/lib/intake';
import { writeAuthorized } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/requests?status=a,b&priority=urgent&q=text&limit=200
 * Lists requests (newest first) with their customer record.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 200, 1), 500);

  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from('requests')
      .select('*, customer:customers(*)')
      .order('created_at', { ascending: false })
      .limit(limit);

    const status = params.get('status');
    if (status && status !== 'all') {
      const allowed = status.split(',').filter((s) =>
        (REQUEST_STATUSES as readonly string[]).includes(s),
      );
      if (allowed.length) query = query.in('status', allowed);
    }

    const priority = params.get('priority');
    if (priority && priority !== 'all' && (PRIORITIES as readonly string[]).includes(priority)) {
      query = query.eq('priority', priority);
    }

    const q = (params.get('q') ?? '').trim();
    if (q) {
      // PostgREST `or=` filter; strip characters that would break the syntax.
      const safe = q.replace(/[,%()"'\\]/g, ' ').trim();
      if (safe) {
        query = query.or(
          `subject.ilike.%${safe}%,sender_email.ilike.%${safe}%,summary.ilike.%${safe}%,intent.ilike.%${safe}%`,
        );
      }
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ requests: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Configuration error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/requests
 * Dashboard "new request" form: same pipeline as the webhook entry point,
 * with source = "dashboard".
 */
export async function POST(req: NextRequest) {
  if (!writeAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = await processIntake({
    email: String(body.email ?? ''),
    name: body.name ? String(body.name) : undefined,
    subject: body.subject ? String(body.subject) : undefined,
    body: String(body.body ?? ''),
    source: 'dashboard',
  });

  return NextResponse.json(result.payload, { status: result.status });
}
