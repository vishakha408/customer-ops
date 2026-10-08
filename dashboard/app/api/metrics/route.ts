import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { DashboardMetrics } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: DashboardMetrics = {
  total: 0,
  new: 0,
  analyzing: 0,
  pending_review: 0,
  in_progress: 0,
  auto_handled: 0,
  resolved: 0,
  failed: 0,
  urgent_open: 0,
  negative_sentiment_open: 0,
  avg_minutes_to_resolve: null,
};

/**
 * GET /api/metrics - header cards for the dashboard.
 * Uses the dashboard_metrics() SQL function (see supabase/schema.sql);
 * falls back to a plain count query when the function has not been created.
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('dashboard_metrics');
    if (!error && data) {
      return NextResponse.json({ metrics: { ...EMPTY, ...(data as object) } });
    }

    // Fallback: count rows by status without the RPC.
    const { data: rows, error: rowsError } = await supabase
      .from('requests')
      .select('status, priority, sentiment, resolved_at, created_at');
    if (rowsError) {
      return NextResponse.json({ error: rowsError.message }, { status: 502 });
    }

    const metrics: DashboardMetrics = { ...EMPTY };
    const statusKeys = [
      'new',
      'analyzing',
      'pending_review',
      'in_progress',
      'auto_handled',
      'resolved',
      'failed',
    ];
    for (const row of rows ?? []) {
      metrics.total += 1;
      if (statusKeys.includes(row.status)) {
        const key = row.status as keyof DashboardMetrics;
        metrics[key] = (metrics[key] as number) + 1;
      }
      const open = ['new', 'analyzing', 'pending_review', 'in_progress'].includes(row.status);
      if (open && row.priority === 'urgent') metrics.urgent_open += 1;
      if (open && (row.sentiment === 'negative' || row.sentiment === 'angry')) {
        metrics.negative_sentiment_open += 1;
      }
    }
    return NextResponse.json({ metrics });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Configuration error' },
      { status: 500 },
    );
  }
}
