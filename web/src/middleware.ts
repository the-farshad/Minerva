/**
 * Edge middleware — does two unrelated things, both cheap:
 *
 * 1. `/api/*` access log. One line per API hit lands in
 *    `docker logs minerva-web` so we can tell what the client is
 *    actually requesting when something "doesn't work". Scoped to
 *    APIs so static-asset noise doesn't drown the signal.
 *
 * 2. Hostname-based rewrite for `lit.thefarshad.com`. Any request
 *    arriving with that Host header gets internally rewritten to
 *    `/lit` (the public papers view). That means the only thing
 *    that has to be configured on the Cloudflare / DNS side is
 *    "send lit.thefarshad.com to this origin" — no Transform Rule,
 *    no droplet-side Caddy / nginx vhost juggling. The URL bar
 *    stays as `lit.thefarshad.com`; it's an internal rewrite, not
 *    a redirect.
 */
import { NextRequest, NextResponse } from 'next/server';

const LIT_HOST = 'lit.thefarshad.com';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const host = (req.headers.get('host') || '').toLowerCase();

  if (
    host === LIT_HOST
    && !url.pathname.startsWith('/lit')
    && !url.pathname.startsWith('/_next')
    && !url.pathname.startsWith('/api/')
  ) {
    const rewriteUrl = url.clone();
    rewriteUrl.pathname = '/lit';
    return NextResponse.rewrite(rewriteUrl);
  }

  if (url.pathname.startsWith('/api/')) {
    console.log(`[req] ${req.method} ${url.pathname}${url.search}`);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything except the Next build assets — needed so the
  // lit-hostname rewrite catches the root path, not only /api/*.
  // The matcher is a pattern; the per-request gate is in the
  // function body so it stays fast.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
