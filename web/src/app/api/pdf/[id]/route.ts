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
    const token = await getGoogleAccessToken(userId);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive[1])}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    if (r.ok) {
      return new Response(r.body, {
        headers: {
          'Content-Type': r.headers.get('Content-Type') || 'application/pdf',
          'Cache-Control': 'private, max-age=300',
        },
      });
    }
    // fall through to the next source on 404 (file deleted etc.)
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
          'Cache-Control': 'private, max-age=300',
        },
      });
    }
  }

  // 3. Helper /proxy of the live URL.
  const pdfUrl = pdfDirectUrl(String(data.pdf || data.url || ''));
  if (!pdfUrl) return new Response('No source URL', { status: 404 });
  const r = await fetch(`${HELPER}/proxy?${encodeURIComponent(pdfUrl)}`, { cache: 'no-store' });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return new Response(`Upstream ${r.status}: ${txt.slice(0, 200)}`, { status: 502 });
  }
  return new Response(r.body, {
    headers: {
      'Content-Type': r.headers.get('Content-Type') || 'application/pdf',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
