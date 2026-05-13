/**
 * Tiny public endpoint exposing the running container's
 * NEXT_PUBLIC_BUILD_SHA + BUILD_TIME so external tooling
 * (status pages, my own deploy scripts, this conversation's
 * curl probes) can read the live version without parsing the
 * HTML version-badge.
 *
 *   GET /api/version  → { sha, time, sha7 }
 *
 * Public on purpose — these values are baked into every page
 * already via the version badge; surfacing them through an API
 * doesn't leak anything new.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || 'unknown';
  const time = process.env.NEXT_PUBLIC_BUILD_TIME || 'unknown';
  return NextResponse.json(
    { sha, time, sha7: sha.slice(0, 7) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
