import { createHash, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Constant-time secret comparison. Hashing first keeps both sides the same
 * length, so timingSafeEqual never throws and response time does not leak
 * how much of the provided secret matched.
 */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Optional guard for the write endpoints (POST /api/requests,
 * PATCH /api/requests/:id). When DASHBOARD_API_TOKEN is not configured the
 * API stays open - convenient for local demos, but set a token before
 * exposing the dashboard beyond localhost.
 */
export function writeAuthorized(req: NextRequest): boolean {
  const token = process.env.DASHBOARD_API_TOKEN;
  if (!token) return true;
  return secretMatches(req.headers.get('x-admin-token'), token);
}
