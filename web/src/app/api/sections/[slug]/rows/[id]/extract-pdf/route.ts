/**
 * Extract structured text from a paper's PDF via opendataloader-pdf
 * on the helper. Auth + Drive-bytes loading happens HERE; the helper
 * gets the bytes as a multipart upload and just runs the loader. The
 * previous URL-based path failed because the helper would call back
 * to /api/pdf through Cloudflare and hit NextAuth — no session, no
 * bytes, 401 wrapped as 502.
 *
 *   POST /api/sections/<slug>/rows/<id>/extract-pdf
 *   → { ok, markdown | content | text, ... }
 */
import { NextRequest, NextResponse } from 'next/server';
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

async function loadPdfBytes(userId: string, data: Record<string, unknown>): Promise<ArrayBuffer> {
  const offline = String(data.offline || '');
  const drive = offline.match(/drive:([\w-]{20,})/);
  if (drive) {
    const token = await getGoogleAccessToken(userId);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive[1])}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    if (r.ok) return r.arrayBuffer();
  }
  const host = offline.split(' · ').map((s) => s.trim()).find((s) => s.startsWith('host:'));
  if (host) {
    const path = host.slice(5).trim();
    const r = await fetch(`${HELPER}/file/serve?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (r.ok) return r.arrayBuffer();
  }
  const pdfUrl = pdfDirectUrl(String(data.pdf || data.url || ''));
  if (!pdfUrl) throw new Error('Row has no PDF source.');
  const r = await fetch(`${HELPER}/proxy?${encodeURIComponent(pdfUrl)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Upstream PDF fetch ${r.status}.`);
  return r.arrayBuffer();
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as { id: string }).id;
    const { slug, id } = await ctx.params;

    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });
    const row = await db.query.rows.findFirst({
      where: and(
        eq(schema.rows.userId, userId),
        eq(schema.rows.sectionId, sec.id),
        eq(schema.rows.id, id),
      ),
    });
    if (!row) return NextResponse.json({ error: 'Row not found' }, { status: 404 });

    const bytes = await loadPdfBytes(userId, row.data as Record<string, unknown>);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), 'in.pdf');
    const r = await fetch(`${HELPER}/pdf/extract`, { method: 'POST', body: fd });
    const txt = await r.text();
    let j: Record<string, unknown>;
    try { j = JSON.parse(txt); } catch { j = { ok: false, error: txt.slice(0, 400) }; }
    if (!r.ok || j.ok === false) {
      return NextResponse.json({ error: String(j.error || `helper /pdf/extract: ${r.status}`) }, { status: 502 });
    }
    // The helper's payload shape: { ok: true, data: { raw_text, format? } } —
    // expose `markdown` for callers that already read that field.
    const payload = j.data as Record<string, unknown> | undefined;
    const text = String((payload?.raw_text as string) || '');
    return NextResponse.json({ ok: true, markdown: text, content: text, text });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
