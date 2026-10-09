import { NextRequest, NextResponse } from 'next/server';
import { processIntake } from '@/lib/intake';
import { secretMatches } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhook/intake
 *
 * Frontend/webhook entry point alternative to the Gmail trigger.
 * Stores the request in Supabase first (so nothing is ever lost), then
 * forwards it to the n8n "Webhook Intake" node for AI analysis when
 * N8N_WEBHOOK_URL is configured.
 *
 * Body: { email, name?, subject?, body, source? }
 * Header: x-webhook-secret (required when N8N_WEBHOOK_SECRET is set)
 */
export async function POST(req: NextRequest) {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  const provided = req.headers.get('x-webhook-secret');
  if (secret && !secretMatches(provided, secret)) {
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 });
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
    body: String(body.body ?? body.message ?? ''),
    source: 'webhook',
  });

  return NextResponse.json(result.payload, { status: result.status });
}
