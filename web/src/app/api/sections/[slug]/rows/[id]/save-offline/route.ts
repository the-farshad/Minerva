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
import { uploadToMinervaDrive, DRIVE_SUBFOLDERS, paperFolderSegments, syncPaperShortcuts } from '@/lib/drive';
import { notifyTelegram } from '@/lib/telegram';
import { getServerPref } from '@/lib/server-prefs';
import { bus } from '@/lib/event-bus';

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
    // Prefer the row's title for the on-Drive filename — yt-dlp's
    // own Content-Disposition is usually `<title>-<videoId>.<ext>`
    // which clutters the user's Drive. Fall back to the helper's
    // name only when the row has no title at all. Audio-only saves
    // get `.mp3`; everything else keeps the original extension from
    // the helper if it gave one, or `.mp4` as a default.
    const disp = r.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="?([^"]+)"?/);
    const helperLeaf = m ? m[1] : '';
    const extMatch = helperLeaf.match(/\.([a-z0-9]{2,4})$/i);
    const ext = quality === 'audio' ? 'mp3' : (extMatch?.[1] || 'mp4');
    const stem = (data.title || data.id || helperLeaf.replace(/\.[a-z0-9]+$/i, '') || 'video')
      .toString()
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 100);
    const leaf = `${stem}.${ext}`;
    // Playlist becomes a folder under videos/ on Drive (e.g.
    // `Minerva offline/videos/Tutorials/<title>.mp4`). Local mirror
    // already groups under the playlist; the comment that used to
    // say "Drive keeps the flat name" no longer applies.
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
    // Page count for the reading-time badge. Lazy import so the
    // module doesn't load on the video branch (which is the common
    // case for save-offline).
    if (!data.pages) {
      try {
        const { extractPdfMeta } = await import('@/lib/pdf-meta');
        const pdfMeta = extractPdfMeta(new Uint8Array(bytes));
        if (pdfMeta.pages && pdfMeta.pages > 0) (data as unknown as Record<string, unknown>).pages = pdfMeta.pages;
      } catch { /* tolerate — pages stays unset, reading-time falls back to null */ }
    }
  }

  let fileId: string;
  try {
    // `filename` may carry a `<playlist>/<leaf>` shape from the
    // video branch. Split it into the nested-folder path expected
    // by uploadToMinervaDrive — for papers it's `papers/<first-
    // category>/`, for videos with a playlist it's
    // `videos/<playlist>`. Category folders sanitised via
    // paperFolderSegments so a tag like "AI / ML" doesn't
    // create a fake nested path. Multi-tagged papers land in
    // their FIRST category — Option B from the design spec.
    const parts = filename.split('/').filter(Boolean);
    const driveName = parts.pop() || filename;
    let folderPath: string[] = [];
    if (kind === 'paper') {
      folderPath = paperFolderSegments(data);
    } else if (DRIVE_SUBFOLDERS[kind]) {
      folderPath = [DRIVE_SUBFOLDERS[kind]!];
    }
    folderPath.push(...parts);
    const up = await uploadToMinervaDrive(
      userId, bytes, driveName, mime,
      folderPath.length > 0 ? folderPath : null,
    );
    fileId = up.id;
  } catch (e) {
    throw new StatusError((e as Error).message, 502);
  }

  const prevOffline = String(data.offline || '').trim();
  const parts = prevOffline ? prevOffline.split(' · ').filter(Boolean) : [];
  const without = parts.filter((p) => !p.startsWith('drive:'));
  without.push(`drive:${fileId}`);
  const nextData: Record<string, unknown> = { ...data, offline: without.join(' · ') };

  // Multi-category papers: drop a shortcut in every non-primary
  // category folder so the PDF browses in all its tagged folders
  // without bytes duplication. Preserves any prior shortcut IDs
  // recorded on row.data._shortcuts and reconciles against the
  // current category list.
  if (kind === 'paper') {
    const cats = String(data.category || '').split(',').map((c) => c.trim()).filter(Boolean);
    if (cats.length > 1) {
      try {
        const fileLeaf = filename.split('/').pop() || filename;
        const existing = ((data._shortcuts as unknown) as Record<string, string> | undefined) || {};
        const shortcuts = await syncPaperShortcuts(userId, fileId, fileLeaf, cats[0], cats, existing);
        if (Object.keys(shortcuts).length > 0) nextData._shortcuts = shortcuts;
        else delete nextData._shortcuts;
      } catch (e) {
        console.warn('[save-offline] shortcuts:', (e as Error).message);
      }
    }
  }

  await db.update(schema.rows)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(schema.rows.id, row.id));
  bus.emit(userId, { kind: 'row.updated', sectionSlug: sec.slug, rowId: row.id, data: nextData });
  // HTML parse-mode + escaped dynamic content. Section titles
  // and filenames routinely contain `_`, `(`, `&` etc. that
  // would 400 the Markdown path.
  //
  // Push the file itself to Telegram alongside the notification:
  // for papers + short audio (under the 50 MB Bot API ceiling) the
  // user receives the bytes in chat with the caption *as* the
  // notification — one message, no text-then-fetch round-trip. For
  // files over the limit (mostly long videos) sendTelegramDocument
  // returns false and we fall back to the text-only notice plus a
  // Drive link in the caption.
  const { escapeTelegramHtml: esc, sendTelegramDocument } = await import('@/lib/telegram');
  const fileLeaf = filename.split('/').pop() || filename;
  const caption = `<b>[${esc(sec.title)}]</b> offline copy ready: ${esc(fileLeaf)}`;
  void (async () => {
    const sent = await sendTelegramDocument(userId, bytes, fileLeaf, caption);
    if (sent) return;
    // Either Telegram isn't configured (no-op), or the file was
    // too big for Bot API. Either way, a plain text notice with
    // the Drive URL keeps the user informed.
    const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
    await notifyTelegram(
      userId,
      `${caption}\n<a href="${driveUrl}">Open in Drive</a>`,
    );
  })();
  return { fileId, kind, filename };
}
