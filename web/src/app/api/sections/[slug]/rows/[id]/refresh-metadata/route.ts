/**
 * Refresh a row's metadata from an external source:
 *   • YouTube URL → YouTube Data API v3 (videos.list,
 *     playlistItems.list when a playlist is encoded in the URL).
 *     Requires `youtube_api_key` in the user's server-only prefs.
 *   • arxiv abs/pdf URL → export.arxiv.org/api/query
 *   • DOI in row.data.doi → api.crossref.org/works/<doi>
 *
 *   POST /api/sections/<slug>/rows/<id>/refresh-metadata
 *
 * Existing values in row.data are NOT overwritten when row.data._userEdited
 * lists the field. The merged result is returned to the client so the
 * UI can flip the visible row without a full refetch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getServerPref } from '@/lib/server-prefs';
import { fetchDriveFileBytes } from '@/lib/drive';
import { extractPdfMeta } from '@/lib/pdf-meta';

// Scope to actual YouTube hostnames — the previous bare `v=...{11}`
// pattern matched ANY URL with a `v=` query param (e.g. a publisher
// download link carrying `?v=abcdef...`), making Refresh wrongly
// dispatch to the YouTube branch on papers.
const YT_VIDEO_RE = /(?:youtube\.com\/(?:watch\?(?:[^&]*&)*v=|shorts\/|embed\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/i;
const YT_PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]+(?:v\d+)?|[a-z\-]+\/\d+)/i;
const DOI_RE = /^10\.[0-9]{4,9}\/\S+$/;
const ISBN_RE = /^(?:97[89])?\d{9}[\dX]$/i;
function normalizeIsbn(s: string): string { return String(s || '').replace(/[\s-]/g, '').toUpperCase(); }

type RowData = Record<string, unknown>;

function isoDurationToSeconds(iso: string): number {
  // PT#H#M#S → seconds
  const m = /^P(?:T)?(?:(\d+)D)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, mi, s] = m;
  return ((Number(d) || 0) * 86400)
       + ((Number(h) || 0) * 3600)
       + ((Number(mi) || 0) * 60)
       + (Number(s) || 0);
}

function formatDuration(secs: number): string {
  if (secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

async function fetchYouTubeVideo(apiKey: string, videoId: string): Promise<RowData> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
    { cache: 'no-store' },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`YouTube Data API ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json() as { items?: Array<{
    snippet?: { title?: string; channelTitle?: string; publishedAt?: string; description?: string; thumbnails?: Record<string, { url?: string }>; tags?: string[] };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string };
  }> };
  const item = j.items?.[0];
  if (!item) throw new Error(`YouTube returned no item for ${videoId}.`);
  const out: RowData = {};
  if (item.snippet?.title) out.title = item.snippet.title;
  if (item.snippet?.channelTitle) out.channel = item.snippet.channelTitle;
  if (item.snippet?.publishedAt) out.published = item.snippet.publishedAt.slice(0, 10);
  if (item.snippet?.description) out.description = item.snippet.description;
  if (item.snippet?.thumbnails) {
    const thumb = item.snippet.thumbnails.maxres
      || item.snippet.thumbnails.standard
      || item.snippet.thumbnails.high
      || item.snippet.thumbnails.medium
      || item.snippet.thumbnails.default;
    if (thumb?.url) out.thumbnail = thumb.url;
  }
  if (item.contentDetails?.duration) {
    out.duration = formatDuration(isoDurationToSeconds(item.contentDetails.duration));
  }
  if (item.statistics?.viewCount) out.views = item.statistics.viewCount;
  if (item.statistics?.likeCount) out.likes = item.statistics.likeCount;
  return out;
}

async function fetchYouTubePlaylistTitle(apiKey: string, playlistId: string): Promise<string | null> {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`,
    { cache: 'no-store' },
  );
  if (!r.ok) return null;
  const j = await r.json() as { items?: Array<{ snippet?: { title?: string } }> };
  return j.items?.[0]?.snippet?.title || null;
}

async function fetchArxiv(arxivId: string): Promise<RowData> {
  const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`arxiv ${r.status}`);
  const xml = await r.text();
  const out: RowData = {};
  const title = /<title>([^<]+)<\/title>/g.exec(xml.replace(/<title>arXiv[^<]+<\/title>/, ''));
  if (title) out.title = title[1].replace(/\s+/g, ' ').trim();
  const summary = /<summary>([\s\S]+?)<\/summary>/.exec(xml);
  if (summary) out.abstract = summary[1].replace(/\s+/g, ' ').trim();
  const authors = Array.from(xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
  if (authors.length) out.authors = authors.join(', ');
  const published = /<published>([^<]+)<\/published>/.exec(xml);
  if (published) out.year = published[1].slice(0, 4);
  return out;
}

async function fetchOpenLibrary(isbn: string): Promise<RowData> {
  // Open Library returns a dictionary keyed by the bibkey we passed.
  // jscmd=data gives us a cleanly-shaped object (title, authors,
  // publishers, publish_date, …).
  const key = `ISBN:${isbn}`;
  const r = await fetch(
    `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`,
    { cache: 'no-store' },
  );
  if (!r.ok) throw new Error(`Open Library ${r.status}`);
  const j = await r.json() as Record<string, {
    title?: string; subtitle?: string;
    authors?: Array<{ name?: string }>;
    publishers?: Array<{ name?: string }>;
    publish_date?: string;
    number_of_pages?: number;
    cover?: { large?: string; medium?: string; small?: string };
    url?: string;
    notes?: string;
    subjects?: Array<{ name?: string }>;
  }>;
  const item = j[key];
  if (!item) throw new Error(`Open Library has no record for ISBN ${isbn}.`);
  const out: RowData = {};
  if (item.title) {
    out.title = item.subtitle ? `${item.title}: ${item.subtitle}` : item.title;
  }
  if (item.authors?.length) {
    out.authors = item.authors.map((a) => a.name).filter(Boolean).join(', ');
  }
  if (item.publishers?.length) {
    out.publisher = item.publishers.map((p) => p.name).filter(Boolean).join(', ');
  }
  if (item.publish_date) {
    const y = item.publish_date.match(/\d{4}/);
    if (y) out.year = y[0];
  }
  if (item.number_of_pages) out.pages = String(item.number_of_pages);
  if (item.cover?.large || item.cover?.medium) {
    out.thumbnail = item.cover.large || item.cover.medium!;
  }
  if (item.subjects?.length) {
    out.subjects = item.subjects.slice(0, 8).map((s) => s.name).filter(Boolean).join(', ');
  }
  out.isbn = isbn;
  return out;
}

async function fetchCrossref(doi: string): Promise<RowData> {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`crossref ${r.status}`);
  const j = await r.json() as {
    message?: {
      title?: string[];
      author?: Array<{ given?: string; family?: string }>;
      'container-title'?: string[];
      publisher?: string;
      volume?: string; issue?: string; page?: string;
      issued?: { 'date-parts'?: number[][] };
      DOI?: string;
    };
  };
  const m = j.message;
  if (!m) throw new Error('crossref returned no message');
  const out: RowData = {};
  if (m.title?.[0]) out.title = m.title[0];
  if (m.author?.length) out.authors = m.author.map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
  if (m['container-title']?.[0]) out.journal = m['container-title'][0];
  if (m.publisher) out.publisher = m.publisher;
  if (m.volume) out.volume = m.volume;
  if (m.issue) out.issue = m.issue;
  if (m.page) out.pages = m.page;
  if (m.DOI) out.doi = m.DOI;
  const year = m.issued?.['date-parts']?.[0]?.[0];
  if (year) out.year = String(year);
  return out;
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

    const data = row.data as RowData;
    const url = String(data.url || '');
    let fetched: RowData = {};
    let source = 'unknown';

    const ytVid = YT_VIDEO_RE.exec(url);
    if (ytVid) {
      const apiKey = await getServerPref<string>(userId, 'youtube_api_key');
      if (!apiKey) {
        return NextResponse.json(
          { error: 'No YouTube API key configured. Set one in Settings → Integrations.' },
          { status: 409 },
        );
      }
      fetched = await fetchYouTubeVideo(apiKey, ytVid[1]);
      const pl = YT_PLAYLIST_RE.exec(url);
      if (pl) {
        const plTitle = await fetchYouTubePlaylistTitle(apiKey, pl[1]).catch(() => null);
        if (plTitle) fetched.playlist = plTitle;
      }
      source = 'youtube';
    } else if (ARXIV_RE.test(url)) {
      const m = ARXIV_RE.exec(url)!;
      fetched = await fetchArxiv(m[1]);
      source = 'arxiv';
    } else if (typeof data.doi === 'string' && DOI_RE.test(String(data.doi).trim())) {
      fetched = await fetchCrossref(String(data.doi).trim());
      source = 'crossref';
    } else if (/^doi\.org\//i.test(url) || /^https?:\/\/(dx\.)?doi\.org\//i.test(url)) {
      const doi = url.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
      fetched = await fetchCrossref(doi);
      source = 'crossref';
    } else {
      // ISBN — check data.isbn, data.isbn10, data.isbn13. The user
      // may have typed any of them in the Info pane Edit mode.
      const rawIsbn = String(data.isbn || data.isbn13 || data.isbn10 || '');
      const isbn = normalizeIsbn(rawIsbn);
      if (isbn && ISBN_RE.test(isbn)) {
        fetched = await fetchOpenLibrary(isbn);
        source = 'openlibrary';
      } else {
        // PDF-scan fallback: papers added before the DOI extractor
        // landed have no data.doi and a Drive-only URL. Pull the
        // cached PDF bytes through Drive and re-run extractPdfMeta
        // so the row's DOI / title / authors / year get backfilled.
        const offline = String(data.offline || '');
        const driveId = offline.match(/drive:([\w-]{20,})/)?.[1];
        if (driveId) {
          try {
            const { bytes, mime } = await fetchDriveFileBytes(userId, driveId);
            if (!mime.startsWith('application/pdf') && !mime.includes('pdf')) {
              return NextResponse.json(
                { error: `Cached file is not a PDF (got ${mime}). Add a doi / arxiv / isbn field in the Info pane and click Refresh.` },
                { status: 409 },
              );
            }
            const meta = extractPdfMeta(new Uint8Array(bytes));
            fetched = { ...meta } as RowData;
            source = 'pdf-scan';
          } catch (e) {
            return NextResponse.json(
              { error: `Couldn't read the cached PDF: ${(e as Error).message}` },
              { status: 502 },
            );
          }
        } else {
          return NextResponse.json(
            { error: 'No metadata source matches this row. Supported: YouTube (with API key), arxiv URLs, DOI (data.doi or doi.org URL), ISBN-10/13 (data.isbn), or an offline PDF copy. Add a `doi` / `isbn` field in the Info pane and click Refresh.' },
            { status: 409 },
          );
        }
      }
    }

    // Respect manual edits: keys listed in data._userEdited stay
    // untouched even if the upstream now has a value for them.
    const protectedKeys = new Set(
      Array.isArray(data._userEdited) ? (data._userEdited as string[]) : [],
    );
    const merged: RowData = { ...data };
    for (const [k, v] of Object.entries(fetched)) {
      if (protectedKeys.has(k)) continue;
      if (v == null || v === '') continue;
      merged[k] = v;
    }
    merged._metadataSource = source;
    merged._metadataRefreshedAt = new Date().toISOString();

    const [updated] = await db.update(schema.rows)
      .set({ data: merged, updatedAt: new Date() })
      .where(eq(schema.rows.id, id))
      .returning();

    return NextResponse.json({
      source,
      data: updated.data,
      fetched,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
