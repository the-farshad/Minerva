/**
 * Authenticated proxy to the `minerva-services` Python helper.
 * Anything under /api/helper/* is forwarded after a Next.js session
 * check, so the helper itself can keep being a localhost-only
 * service.
 *
 * Examples:
 *   POST /api/helper/download            → POST <helper>/download
 *   POST /api/helper/file/save?...       → POST <helper>/file/save?...
 *   GET  /api/helper/file/serve?path=... → GET  <helper>/file/serve?path=...
 *   GET  /api/helper/proxy?<encoded url> → GET  <helper>/proxy?<encoded url>
 *   POST /api/helper/pdf/extract         → POST <helper>/pdf/extract
 *
 * The auth check uses the same NextAuth session every other route
 * uses — no session, no proxy.
 */
import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { forwardToHelper } from '@/lib/helper';

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  const { path } = await ctx.params;
  const helperPath = '/' + (path?.join('/') || '');
  return forwardToHelper(req, helperPath);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
