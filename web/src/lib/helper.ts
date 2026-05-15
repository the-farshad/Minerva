/**
 * Thin client for the `minerva-services` Python helper. Server-side
 * only — never import this into a 'use client' file. The
 * HELPER_BASE_URL env var points at a reachable helper instance
 * (the droplet's helper at 127.0.0.1:8765 in production, or your
 * laptop's helper in dev).
 *
 * The helper does not require auth itself — request authorization is
 * enforced by the Next.js route handler that calls it (which checks
 * the user session before forwarding).
 */
import { NextRequest, NextResponse } from 'next/server';

const FALLBACK_BASE = 'http://127.0.0.1:8765';

function helperBase() {
  return (process.env.HELPER_BASE_URL || FALLBACK_BASE).replace(/\/+$/, '');
}

export async function forwardToHelper(
  req: NextRequest,
  helperPath: string,
  opts?: {
    /** When set, append the request's query string to the helper URL. */
    forwardQuery?: boolean;
    /** When set, forward the request body verbatim. Default true for
     * POST / PUT / PATCH, false otherwise. */
    forwardBody?: boolean;
  },
): Promise<Response> {
  const base = helperBase();
  const url = new URL(helperPath, base + '/');
  if (opts?.forwardQuery !== false && req.nextUrl.search) {
    url.search = req.nextUrl.search.startsWith('?')
      ? req.nextUrl.search.slice(1)
      : req.nextUrl.search;
  }
  const method = req.method.toUpperCase();
  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const fwdBody = opts?.forwardBody ?? isMutating;
  const headers = new Headers();
  // Keep only headers the helper cares about. Avoid forwarding host
  // / cookie which would confuse it.
  const passthrough = ['accept', 'accept-language', 'content-type', 'content-length'];
  for (const h of passthrough) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  let body: BodyInit | undefined;
  if (fwdBody) body = await req.arrayBuffer();
  try {
    const resp = await fetch(url.toString(), {
      method, headers, body,
      // Disable Next's fetch cache for proxy requests.
      cache: 'no-store',
    });
    const respHeaders = new Headers();
    resp.headers.forEach((v, k) => {
      if (k.startsWith('access-control-')) return;
      respHeaders.set(k, v);
    });
    return new NextResponse(resp.body, {
      status: resp.status,
      headers: respHeaders,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'helper unreachable: ' + (e instanceof Error ? e.message : String(e)) },
      { status: 502 },
    );
  }
}
