/**
 * Bibliographic / video URL → row metadata lookup. Same gateway as
 * v1's import.js but server-side and authenticated. Supports arXiv,
 * DOI (CrossRef), and YouTube (single video).
 *
 *   POST /api/import/lookup  { url }
 *
 * Returns a flat object the caller can spread onto a new row's data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { fetchPaperStatsFromSS } from '@/lib/related-papers/semanticscholar';

const ARXIV_RE = /(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i;
const DOI_RE = /(?:doi\.org\/|^)(10\.\d{4,9}\/\S+)/i;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/;
const YT_LIST_RE = /[?&]list=([\w-]+)/;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const raw = String(body.url || '').trim();
  if (!raw) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  // arXiv
  const ax = raw.match(ARXIV_RE);
  if (/arxiv\.org/i.test(raw) || /^\d{4}\.\d{4,5}/.test(raw) || (ax && ax[1])) {
    if (ax) return NextResponse.json(await arxivLookup(ax[1]));
  }
  // DOI
  const dm = raw.match(DOI_RE);
  if (dm) return NextResponse.json(await crossrefLookup(dm[1]));
  // YouTube playlist (preferred over single video when both are
  // present in the URL — `?list=...&v=...`).
  const lm = raw.match(YT_LIST_RE);
  if (lm) {
    const { name, items } = await youtubePlaylist(lm[1]);
    return NextResponse.json({ kind: 'playlist', playlistId: lm[1], playlistName: name, items });
  }
  // YouTube single video
  const ym = raw.match(YT_RE);
  if (ym) return NextResponse.json(await youtubeLookup(ym[1], raw));

  // Generic publisher fallback: nearly every journal site (MDPI,
  // Nature, Springer, IEEE, ACM, Wiley, Elsevier, ACS, …) exposes
  // `<meta name="citation_*">` tags meant exactly for this. If we
  // find a citation_doi, defer to CrossRef for the canonical
  // record; otherwise scrape title / authors / year / pdf
  // straight off the page so the row at least lands populated.
  const scraped = await genericArticleLookup(raw);
  if (scraped) return NextResponse.json(scraped);

  // Last-resort fallback: bare URL.
  return NextResponse.json({ kind: 'article', url: raw });
}

async function genericArticleLookup(url: string) {
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 10_000);
    const r = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: ac.signal,
      // A real-browser UA — several publishers (MDPI included)
      // serve a 403 / different page to default fetch UAs.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Minerva/2.0; +https://minerva.thefarshad.com)' },
    }).finally(() => clearTimeout(timeout));
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    const html = await r.text();
    const meta = (name: string): string => {
      const re = new RegExp(
        `<meta\\s+[^>]*?(?:name|property)=["']${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}["'][^>]*?content=["']([^"']+)["']`,
        'i',
      );
      const m = html.match(re);
      if (m) return m[1].trim();
      const reAlt = new RegExp(
        `<meta\\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:name|property)=["']${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}["']`,
        'i',
      );
      const ma = html.match(reAlt);
      return ma ? ma[1].trim() : '';
    };
    const doi = meta('citation_doi') || meta('dc.identifier');
    if (doi && /^10\.\d{4,9}\//.test(doi)) {
      try { return await crossrefLookup(doi); } catch { /* fall through */ }
    }
    const title = meta('citation_title') || meta('dc.title') || meta('og:title');
    if (!title) return null;
    const authorMatches = html.matchAll(
      /<meta\s+[^>]*?(?:name|property)=["'](?:citation_author|dc\.creator)["'][^>]*?content=["']([^"']+)["']/gi,
    );
    const authors = Array.from(authorMatches, (m) => m[1].trim()).filter(Boolean).join(', ');
    const dateRaw = meta('citation_date') || meta('citation_publication_date') || meta('dc.date') || '';
    const year = dateRaw.match(/\d{4}/)?.[0] || '';
    const venue = meta('citation_journal_title') || meta('citation_conference_title') || meta('dc.source') || '';
    const pdf = meta('citation_pdf_url') || '';
    return {
      kind: 'paper',
      title,
      authors,
      year,
      venue,
      ...(doi ? { doi } : {}),
      ...(pdf ? { pdf } : {}),
      url,
    };
  } catch {
    return null;
  }
}

async function arxivLookup(id: string) {
  const r = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
  if (!r.ok) throw new Error(`arXiv ${r.status}`);
  const xml = await r.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return { kind: 'paper', url: `https://arxiv.org/abs/${id}` };
  const get = (tag: string) => {
    const m = entry[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  const authors: string[] = [];
  const aRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
  let am: RegExpExecArray | null;
  while ((am = aRe.exec(entry[1])) !== null) authors.push(am[1].trim());
  const published = get('published');
  const stats = await fetchPaperStatsFromSS({ kind: 'ARXIV', id });
  return {
    kind: 'paper',
    title: get('title'),
    authors: authors.join(', '),
    year: published.slice(0, 4),
    abstract: get('summary'),
    url: `https://arxiv.org/abs/${id}`,
    pdf: `https://arxiv.org/pdf/${id}.pdf`,
    venue: 'arXiv',
    ...(stats || {}),
  };
}

async function crossrefLookup(doi: string) {
  const r = await fetch(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  if (!r.ok) throw new Error(`CrossRef ${r.status}`);
  const data = (await r.json()) as { message: Record<string, unknown> };
  const m = data.message;
  const authors = ((m.author as { given?: string; family?: string }[]) || []).map(
    (a) => [a.given, a.family].filter(Boolean).join(' '),
  ).join(', ');
  const issued = ((m.issued as { 'date-parts'?: number[][] }) || {})['date-parts']?.[0];
  const stats = await fetchPaperStatsFromSS({ kind: 'DOI', id: doi });
  return {
    kind: 'paper',
    title: (m.title as string[])?.[0] || '',
    authors,
    year: issued?.[0] ? String(issued[0]) : '',
    venue: (m['container-title'] as string[])?.[0] || '',
    doi: m.DOI as string,
    url: (m.URL as string) || `https://doi.org/${doi}`,
    ...(stats || {}),
  };
}

async function youtubeLookup(videoId: string, originalUrl: string) {
  // oEmbed is CORS-friendly and quota-free for basic metadata
  // (title, author_name, thumbnail). It does NOT include duration,
  // upload date, view count, etc. — for those we scrape the watch
  // page through the helper's /proxy, which is the same path the
  // playlist scraper uses.
  const [embedded, scraped] = await Promise.all([
    fetchOEmbed(originalUrl).catch(() => null),
    scrapeWatchPage(videoId).catch(() => null),
  ]);
  return {
    kind: 'video',
    title: embedded?.title || scraped?.title || '',
    channel: embedded?.author_name || scraped?.channel || '',
    thumbnail: embedded?.thumbnail_url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    duration: scraped?.duration || '',
    published: scraped?.published || '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

async function fetchOEmbed(originalUrl: string) {
  const r = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(originalUrl)}&format=json`,
    { cache: 'no-store' },
  );
  if (!r.ok) return null;
  return (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
}

function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

async function scrapeWatchPage(videoId: string) {
  const helper = (process.env.HELPER_BASE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const r = await fetch(`${helper}/proxy?${encodeURIComponent(target)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const html = await r.text();
  const lengthMatch = html.match(/"lengthSeconds":"(\d+)"/);
  const titleMatch = html.match(/"videoDetails":\{[^}]*?"title":"([^"]+)"/);
  const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/) || html.match(/"author":"([^"]+)"/);
  const publishedMatch = html.match(/"publishDate":"([^"]+)"/) || html.match(/"uploadDate":"([^"]+)"/);
  return {
    duration: lengthMatch ? fmtSeconds(parseInt(lengthMatch[1], 10)) : '',
    title: titleMatch ? titleMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"') : '',
    channel: channelMatch ? channelMatch[1].replace(/\\u0026/g, '&') : '',
    published: publishedMatch ? publishedMatch[1].slice(0, 10) : '',
  };
}

/** Enumerate every video in a YouTube playlist via the helper's
 * /proxy (which fronts youtube.com on its allow-list). Uses the
 * lightweight `playlist?list=…` HTML page rather than the Data
 * API — no key required, but capped at the page-load default. */
async function youtubePlaylist(listId: string) {
  const helper = (process.env.HELPER_BASE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const target = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  const r = await fetch(`${helper}/proxy?${encodeURIComponent(target)}`, { cache: 'no-store' });
  if (!r.ok) return { name: '', items: [] as Array<{ url: string; title: string; channel: string; thumbnail: string; playlist?: string; position?: number }> };
  const html = await r.text();

  // Playlist name — YouTube HTML moves it around between updates, so
  // try several anchor patterns and pick whichever lands first.
  let name = '';
  const candidates = [
    /<meta property="og:title" content="([^"]+)"/,
    /<meta name="title" content="([^"]+)"/,
    /"microformatDataRenderer":\{[^}]*?"title":"([^"]+)"/,
    /"playlistMetadataRenderer":\{[^}]*?"title":"([^"]+)"/,
    /"playlistSidebarPrimaryInfoRenderer":[\s\S]{0,400}?"title":\{"runs":\[\{"text":"([^"]+)"/,
    /<title>([^<]+?) - YouTube<\/title>/,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1]) {
      name = m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/&amp;/g, '&').trim();
      if (name) break;
    }
  }

  // Owner / channel name applied to every item in the playlist.
  const ownerMatch = html.match(/"ownerText":\{"runs":\[\{"text":"([^"]+)"/);
  const owner = ownerMatch ? ownerMatch[1].replace(/\\u0026/g, '&') : '';

  const items: { url: string; title: string; channel: string; thumbnail: string; playlist?: string; position?: number }[] = [];
  const seen = new Set<string>();
  const re = /"playlistVideoRenderer":\s*\{[^}]*?"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, videoId, title] = m;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    items.push({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: title.replace(/\\u0026/g, '&').replace(/\\"/g, '"'),
      channel: owner,
      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      playlist: name || listId,
      // 1-based index in the playlist. The regex scans the HTML in
      // document order, which is the playlist's own order — persist
      // it so the rows can be sorted back into playlist order
      // regardless of import/insert timing.
      position: items.length + 1,
    });
    if (items.length >= 200) break;
  }
  return { name, items };
}
