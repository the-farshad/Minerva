/**
 * Save a row's source URL as an offline copy on Drive.
 *
 *   POST /api/sections/<slug>/rows/<id>/save-offline
 *     { kind: 'video' | 'paper' }
 *
 * For videos: calls the helper's /download endpoint (yt-dlp), then
 * uploads the resulting bytes to the user's Drive in the
 * "Minerva offline" folder. For papers: fetches the pdf URL
 * directly (the helper's /proxy fronts CORS-restricted hosts), then
 * uploads. Writes `drive:<fileId>` into row.data.offline so the
 * preview's next open mounts the Drive blob.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { uploadToMinervaDrive, DRIVE_SUBFOLDERS } from '@/lib/drive';
import { notifyTelegram } from '@/lib/telegram';

const HELPER = (process.env.HELPER_BASE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  try {
    return await saveOffline(req, ctx);
  } catch (e) {
    // Wrap any unhandled error in JSON so the client doesn't choke
    // on a "JSON.parse: unexpected character at line 1" trying to
    // parse Next's HTML 500 page.
    return NextResponse.json({ error: (e as Error).message || 'save-offline crashed' }, { status: 500 });
  }
}

async function saveOffline(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
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

  const body = (await req.json().catch(() => ({}))) as { kind?: 'video' | 'paper' };
  const data = row.data as Record<string, string>;
  const kind = body.kind ?? (
    /\.pdf(\?|#|$)|arxiv\.org\/(?:abs|pdf)\//i.test(data.url || '') ? 'paper' : 'video'
  );

  // Skip the round-trip if the row already carries a Drive copy.
  const existing = String(data.offline || '').match(/drive:([\w-]{20,})/);
  if (existing) {
    return NextResponse.json({ fileId: existing[1], skipped: true });
  }

  let bytes: ArrayBuffer;
  let filename: string;
  let mime: string;

  if (kind === 'video') {
    const r = await fetch(`${HELPER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.url, format: 'mp4' }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return NextResponse.json({ error: `Helper /download ${r.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    bytes = await r.arrayBuffer();
    mime = r.headers.get('Content-Type') || 'video/mp4';
    // Guard against yt-dlp returning HTML even when Content-Type
    // claims video/mp4 — we sniff the first 4 bytes for MP4's
    // `ftyp` box marker. Real MP4s have `....ftyp` at offset 4;
    // HTML starts with `<!DO` or whitespace+`<!`. Without this
    // sniff a bot-check HTML page would land in Drive as
    // "video.mp4" and you'd play it as a movie.
    const head4 = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(32, bytes.byteLength)));
    const looksHtml = /^\s*<(?:!doctype|html|head|body|script)\b/i.test(head4);
    const looksMp4 = bytes.byteLength > 16 && /ftyp/i.test(new TextDecoder('latin1').decode(bytes.slice(4, 12)));
    if (/text\/html/i.test(mime) || looksHtml || (!looksMp4 && bytes.byteLength < 64 * 1024)) {
      const head = new TextDecoder().decode(bytes.slice(0, 4096));
      // Sniff the most common bot-check / consent signatures and
      // tell the user the actionable thing instead of dumping HTML.
      const reason =
        /consent\.youtube\.com|consent\.google\.com/i.test(head) ? 'YouTube is showing the consent page — cookies are likely stale.'
        : /(captcha|recaptcha|challenge)/i.test(head) ? 'YouTube served a captcha challenge — cookies are likely stale.'
        : /sign in to confirm/i.test(head) ? 'YouTube asked yt-dlp to sign in — cookies are stale or expired.'
        : `yt-dlp returned ${mime || 'unknown content-type'} (${bytes.byteLength} bytes) instead of a video.`;
      return NextResponse.json(
        { error: `${reason} Refresh YT cookies on the droplet, then retry.` },
        { status: 502 },
      );
    }
    const disp = r.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="?([^"]+)"?/);
    const stem = (data.title || data.id || 'video').toString().replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    const leaf = m ? m[1] : `${stem}.mp4`;
    // Group playlist downloads under <playlist>/ in the local mirror.
    // The Drive copy keeps the flat name — Drive folders are already
    // a separate UX path the user can ignore.
    const pl = String(data.playlist || '').trim().replace(/[/\\]+/g, '_').slice(0, 80);
    filename = pl ? `${pl}/${leaf}` : leaf;
  } else {
    // Paper. Prefer the row's `pdf` column when present, else
    // rewrite arxiv abs → pdf.
    let pdfUrl = (data.pdf || '').toString().trim() || data.url;
    if (/arxiv\.org\/abs\//i.test(pdfUrl)) {
      pdfUrl = pdfUrl.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
    }
    let resp = await fetch(pdfUrl);
    if (!resp.ok) {
      // CORS-blocked / 403 / 404 → bounce through the helper's
      // allow-listed /proxy.
      resp = await fetch(`${HELPER}/proxy?${encodeURIComponent(pdfUrl)}`);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return NextResponse.json({ error: `Paper fetch ${resp.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    bytes = await resp.arrayBuffer();
    const upstreamMime = resp.headers.get('Content-Type') || '';
    if (!/pdf|octet-stream/i.test(upstreamMime) && bytes.byteLength < 8 * 1024) {
      const snippet = new TextDecoder().decode(bytes.slice(0, 300));
      return NextResponse.json(
        { error: `Upstream returned ${upstreamMime || 'unknown'} (${bytes.byteLength} bytes) instead of a PDF. Snippet: ${snippet}` },
        { status: 502 },
      );
    }
    mime = 'application/pdf';
    const stem = (data.title || data.id || 'paper').toString().replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    filename = `${stem}.pdf`;
  }

  let fileId: string;
  try {
    // Drive treats `/` as a literal in filenames — flatten before upload
    // so the file appears with a clean leaf name. The client receives
    // the path-prefixed version for the local mirror. Subfolder picks
    // between `videos/` and `papers/` under "Minerva offline".
    const driveName = filename.split('/').pop() || filename;
    const subfolder = DRIVE_SUBFOLDERS[kind] || null;
    const up = await uploadToMinervaDrive(userId, bytes, driveName, mime, subfolder);
    fileId = up.id;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Writeback the offline marker. Existing markers (e.g. host:)
  // are preserved alongside the new drive:<id> entry.
  const prevOffline = String(data.offline || '').trim();
  const parts = prevOffline ? prevOffline.split(' · ').filter(Boolean) : [];
  const without = parts.filter((p) => !p.startsWith('drive:'));
  without.push(`drive:${fileId}`);
  const nextData = { ...data, offline: without.join(' · ') };
  await db.update(schema.rows)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(schema.rows.id, row.id));
  void notifyTelegram(
    userId,
    `*[${sec.title}]* offline copy ready: ${filename}`,
  );
  return NextResponse.json({ fileId, kind, filename });
}
