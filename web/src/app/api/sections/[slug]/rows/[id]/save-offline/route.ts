/**
 * Save a row's source URL as an offline copy on Drive.
 *
 *   POST /api/sections/<slug>/rows/<id>/save-offline
 *     { kind: 'video' | 'paper' }
 *
 * Response is `application/x-ndjson` — one JSON object per line:
 *
 *   {"type":"heartbeat","t":...}     emitted every 20 s
 *   {"type":"done","fileId":...}     final, on success
 *   {"type":"error","error":"..."}   final, on failure
 *
 * The heartbeat exists solely to keep Cloudflare's 100-second edge
 * timeout from killing the connection while yt-dlp is downloading
 * a large file. The client reads the stream and applies the final
 * `done`/`error` message; intermediate heartbeats are discarded.
 *
 * For videos: calls the helper's /download endpoint (yt-dlp), then
 * uploads the resulting bytes to the user's Drive in the
 * "Minerva offline" folder. For papers: fetches the pdf URL
 * directly (the helper's /proxy fronts CORS-restricted hosts), then
 * uploads. Writes `drive:<fileId>` into row.data.offline so the
 * preview's next open mounts the Drive blob.
 */
import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { uploadToMinervaDrive, DRIVE_SUBFOLDERS } from '@/lib/drive';
import { notifyTelegram } from '@/lib/telegram';
import { getServerPref } from '@/lib/server-prefs';

const HELPER = (process.env.HELPER_BASE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

type SaveOfflineResult = {
  fileId: string;
  kind: 'video' | 'paper';
  filename?: string;
  skipped?: boolean;
};

class StatusError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); }
        catch { closed = true; }
      };
      const heartbeat = setInterval(() => send({ type: 'heartbeat', t: Date.now() }), 20_000);
      try {
        const result = await saveOffline(req, ctx);
        send({ type: 'done', ...result });
      } catch (e) {
        const msg = (e as Error).message || String(e);
        const status = e instanceof StatusError ? e.status : 500;
        send({ type: 'error', error: msg, status });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Tell nginx/Cloudflare reverse proxies not to buffer the
      // response — without this, the heartbeats stack in a buffer
      // and the edge still sees no bytes for 100 s.
      'X-Accel-Buffering': 'no',
    },
  });
}

async function saveOffline(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
): Promise<SaveOfflineResult> {
  const session = await auth();
  if (!session?.user) throw new StatusError('Unauthorized', 401);
  const userId = (session.user as { id: string }).id;
  const { slug, id } = await ctx.params;

  const sec = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!sec) throw new StatusError('Section not found', 404);
  const row = await db.query.rows.findFirst({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.id, id),
    ),
  });
  if (!row) throw new StatusError('Row not found', 404);

  const body = (await req.json().catch(() => ({}))) as { kind?: 'video' | 'paper'; quality?: string };
  const data = row.data as Record<string, string>;
  const kind = body.kind ?? (
    /\.pdf(\?|#|$)|arxiv\.org\/(?:abs|pdf)\//i.test(data.url || '') ? 'paper' : 'video'
  );

  const existing = String(data.offline || '').match(/drive:([\w-]{20,})/);
  if (existing) {
    return { fileId: existing[1], kind, skipped: true };
  }

  let bytes: ArrayBuffer;
  let filename: string;
  let mime: string;

  if (kind === 'video') {
    // Quality precedence: explicit `quality` in the request body
    // wins (per-click override), else the user's server pref, else
    // the helper's hard default ("best mp4").
    const defaultQuality = (await getServerPref<string>(userId, 'yt_quality').catch(() => null)) || 'best';
    const quality = String(body.quality || defaultQuality || 'best').trim().toLowerCase();
    const format = quality === 'audio' ? 'mp3' : 'mp4';
    const r = await fetch(`${HELPER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.url, format, quality: quality === 'audio' ? '' : quality }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      let friendly: string;
      if (/Sign in to confirm (?:you[''’’]?re|youre) not a bot/i.test(txt)) {
        friendly = /no cookies file found/i.test(txt)
          ? "YouTube blocked this download (bot check). The droplet has no cookies — go to Settings → Integrations → YouTube cookies (yt-dlp) and upload a cookies.txt exported from a logged-in browser."
          : "YouTube blocked this download. yt-dlp tried all five player clients and the Piped fallback instances also refused. Fix: in YOUR browser (signed in to YouTube), use the \"Get cookies.txt LOCALLY\" extension to export youtube.com cookies, then Settings → Integrations → YouTube cookies (yt-dlp) → Upload cookies.txt.";
      } else if (/age[- ]?restrict|age[- ]?confirm/i.test(txt)) {
        friendly = "YouTube says this video is age-restricted. Cookies from a signed-in, age-confirmed account are required.";
      } else if (/Private video|This video is private/i.test(txt)) {
        friendly = "This video is private — yt-dlp can't reach it.";
      } else if (/Video unavailable|This video is no longer available/i.test(txt)) {
        friendly = "YouTube says this video is unavailable (removed, region-locked, or DMCA).";
      } else if (/HTTP Error 429|Too Many Requests/i.test(txt)) {
        friendly = "YouTube is rate-limiting this server. Wait a few minutes and retry.";
      } else {
        const head = txt.split('\n').find((l) => l.trim()) ?? '';
        friendly = `Helper /download ${r.status}: ${head.slice(0, 400)}`;
      }
      throw new StatusError(friendly, 502);
    }
    bytes = await r.arrayBuffer();
    mime = r.headers.get('Content-Type') || 'video/mp4';
    const head4 = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(32, bytes.byteLength)));
    const looksHtml = /^\s*<(?:!doctype|html|head|body|script)\b/i.test(head4);
    const looksMp4 = bytes.byteLength > 16 && /ftyp/i.test(new TextDecoder('latin1').decode(bytes.slice(4, 12)));
    if (/text\/html/i.test(mime) || looksHtml || (!looksMp4 && bytes.byteLength < 64 * 1024)) {
      const head = new TextDecoder().decode(bytes.slice(0, 4096));
      const reason =
        /consent\.youtube\.com|consent\.google\.com/i.test(head) ? 'YouTube is showing the consent page — cookies are likely stale.'
        : /(captcha|recaptcha|challenge)/i.test(head) ? 'YouTube served a captcha challenge — cookies are likely stale.'
        : /sign in to confirm/i.test(head) ? 'YouTube asked yt-dlp to sign in — cookies are stale or expired.'
        : `yt-dlp returned ${mime || 'unknown content-type'} (${bytes.byteLength} bytes) instead of a video.`;
      throw new StatusError(`${reason} Refresh YT cookies on the droplet, then retry.`, 502);
    }
    const disp = r.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="?([^"]+)"?/);
    const stem = (data.title || data.id || 'video').toString().replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    const leaf = m ? m[1] : `${stem}.mp4`;
    const pl = String(data.playlist || '').trim().replace(/[/\\]+/g, '_').slice(0, 80);
    filename = pl ? `${pl}/${leaf}` : leaf;
  } else {
    let pdfUrl = (data.pdf || '').toString().trim() || data.url;
    if (/arxiv\.org\/abs\//i.test(pdfUrl)) {
      pdfUrl = pdfUrl.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
    }
    let resp = await fetch(pdfUrl);
    if (!resp.ok) {
      resp = await fetch(`${HELPER}/proxy?${encodeURIComponent(pdfUrl)}`);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new StatusError(`Paper fetch ${resp.status}: ${txt.slice(0, 200)}`, 502);
    }
    bytes = await resp.arrayBuffer();
    const upstreamMime = resp.headers.get('Content-Type') || '';
    if (!/pdf|octet-stream/i.test(upstreamMime) && bytes.byteLength < 8 * 1024) {
      const snippet = new TextDecoder().decode(bytes.slice(0, 300));
      throw new StatusError(
        `Upstream returned ${upstreamMime || 'unknown'} (${bytes.byteLength} bytes) instead of a PDF. Snippet: ${snippet}`,
        502,
      );
    }
    mime = 'application/pdf';
    const stem = (data.title || data.id || 'paper').toString().replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    filename = `${stem}.pdf`;
  }

  let fileId: string;
  try {
    const driveName = filename.split('/').pop() || filename;
    const subfolder = DRIVE_SUBFOLDERS[kind] || null;
    const up = await uploadToMinervaDrive(userId, bytes, driveName, mime, subfolder);
    fileId = up.id;
  } catch (e) {
    throw new StatusError((e as Error).message, 502);
  }

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
  return { fileId, kind, filename };
}
