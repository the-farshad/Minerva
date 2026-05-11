/**
 * Auth-gated single-URL PDF source for the embedded viewer.
 *
 * Resolves a row id → its PDF bytes in priority order:
 *   1. Drive copy (the offline `drive:<fileId>` marker, or
 *      `data.driveFileId`) — streamed via the user's access token.
 *   2. Host copy (`host:<path>` from save-offline on the helper).
 *   3. Helper /proxy fetch of `data.pdf` or `data.url` (arxiv abs
 *      rewritten to /pdf/).
 *
 *   GET /api/pdf/<rowId>
 *
 * The viewer iframe uses `?file=/api/pdf/<rowId>` — no nested query
 * strings, no URL-encoding gymnastics, no race against an
 * auto-mirror finishing. Everything resolves server-side from the
 * row data.
 */
import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getGoogleAccessToken } from '@/lib/google';

const HELPER = (process.env.HELPER_BASE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

function pdfDirectUrl(url: string): string {
  if (/arxiv\.org\/abs\//i.test(url)) {
    return url.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
  }
  return url;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    return await serve(req, ctx);
  } catch (e) {
    // Loud server log + JSON error so PDF.js shows something useful
    // and we can see what blew up in `docker logs minerva-web`.
    const msg = (e as Error).message || String(e);
    console.error('[/api/pdf]', msg);
    return new Response(`PDF route error: ${msg}`, { status: 500 });
  }
}

async function serve(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;

  const row = await db.query.rows.findFirst({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.id, id)),
  });
  if (!row) return new Response('Row not found', { status: 404 });
  const data = row.data as Record<string, unknown>;
  const offline = String(data.offline || '');

  // 1. Drive copy.
  const drive = offline.match(/drive:([\w-]{20,})/);
  if (drive) {
    try {
      const token = await getGoogleAccessToken(userId);
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive[1])}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      );
      if (r.ok) {
        return new Response(r.body, {
          headers: {
            'Content-Type': r.headers.get('Content-Type') || 'application/pdf',
            // no-store so an annotation save (which overwrites the underlying
// Drive bytes in place) is visible the next time the iframe asks
// for the same /api/pdf/<rowId> URL — without this, the browser
// served the pre-save body for 5 min and "click does not show the
// edited version" was the resulting bug.
'Cache-Control': 'no-store',
          },
        });
      }
      console.warn(`[/api/pdf] drive fetch ${drive[1]} → ${r.status}, falling through`);
    } catch (e) {
      console.warn(`[/api/pdf] drive auth/fetch threw: ${(e as Error).message}, falling through`);
    }
  }

  // 2. Host copy on the helper.
  const host = offline.split(' · ').map((s) => s.trim()).find((s) => s.startsWith('host:'));
  if (host) {
    const path = host.slice(5).trim();
    const r = await fetch(`${HELPER}/file/serve?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (r.ok) {
      return new Response(r.body, {
        headers: {
          'Content-Type': r.headers.get('Content-Type') || 'application/pdf',
          // no-store so an annotation save (which overwrites the underlying
// Drive bytes in place) is visible the next time the iframe asks
// for the same /api/pdf/<rowId> URL — without this, the browser
// served the pre-save body for 5 min and "click does not show the
// edited version" was the resulting bug.
'Cache-Control': 'no-store',
        },
      });
    }
    console.warn(`[/api/pdf] host fetch ${path} → ${r.status}, falling through`);
  }

  // 3. Helper /proxy of the live URL.
  const pdfUrl = pdfDirectUrl(String(data.pdf || data.url || ''));
  if (!pdfUrl) return new Response('No source URL on this row.', { status: 404 });
  const r = await fetch(`${HELPER}/proxy?${encodeURIComponent(pdfUrl)}`, { cache: 'no-store' });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.warn(`[/api/pdf] helper proxy ${pdfUrl} → ${r.status}: ${txt.slice(0, 200)}`);
    return new Response(`Upstream ${r.status}: ${txt.slice(0, 200)}`, { status: 502 });
  }
  // Refuse to stream HTML — Cloudflare / consent / bot-check pages
  // would otherwise be parsed as PDF and produce Chrome's generic
  // "this page couldn't load" inside the viewer.
  const ct = r.headers.get('Content-Type') || '';
  if (/text\/html/i.test(ct)) {
    const peek = (await r.text().catch(() => '')).slice(0, 200);
    console.warn(`[/api/pdf] helper proxy returned HTML (${ct}) — likely Cloudflare/consent wall: ${peek.replace(/\s+/g, ' ')}`);
    return new Response(`Upstream returned HTML, not a PDF: ${peek.slice(0, 120)}`, { status: 502 });
  }
  return new Response(r.body, {
    headers: {
      'Content-Type': ct || 'application/pdf',
      // no-store so an annotation save (which overwrites the underlying
// Drive bytes in place) is visible the next time the iframe asks
// for the same /api/pdf/<rowId> URL — without this, the browser
// served the pre-save body for 5 min and "click does not show the
// edited version" was the resulting bug.
'Cache-Control': 'no-store',
    },
  });
}
