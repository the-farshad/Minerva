/**
 * Edge access log — emits one line per /api/* request so we can
 * tell, from `docker logs minerva-web`, what the client is actually
 * requesting when something "doesn't work". Cheaper than enabling
 * full Next access logging and scoped to API routes so static
 * asset requests don't drown the signal.
 */
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  if (url.pathname.startsWith('/api/')) {
    console.log(`[req] ${req.method} ${url.pathname}${url.search}`);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
