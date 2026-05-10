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

const ARXIV_RE = /(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i;
const DOI_RE = /(?:doi\.org\/|^)(10\.\d{4,9}\/\S+)/i;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/;

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
  // YouTube single video
  const ym = raw.match(YT_RE);
  if (ym) return NextResponse.json(await youtubeLookup(ym[1], raw));

  // Fallback: bare URL.
  return NextResponse.json({ kind: 'article', url: raw });
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
  return {
    kind: 'paper',
    title: get('title'),
    authors: authors.join(', '),
    year: published.slice(0, 4),
    abstract: get('summary'),
    url: `https://arxiv.org/abs/${id}`,
    pdf: `https://arxiv.org/pdf/${id}.pdf`,
    venue: 'arXiv',
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
  return {
    kind: 'paper',
    title: (m.title as string[])?.[0] || '',
    authors,
    year: issued?.[0] ? String(issued[0]) : '',
    venue: (m['container-title'] as string[])?.[0] || '',
    doi: m.DOI as string,
    url: (m.URL as string) || `https://doi.org/${doi}`,
  };
}

async function youtubeLookup(videoId: string, originalUrl: string) {
  // oEmbed is CORS-friendly and quota-free for basic metadata.
  const r = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(originalUrl)}&format=json`,
    { cache: 'no-store' },
  );
  if (!r.ok) {
    return { kind: 'video', url: `https://www.youtube.com/watch?v=${videoId}` };
  }
  const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    kind: 'video',
    title: j.title || '',
    channel: j.author_name || '',
    thumbnail: j.thumbnail_url || '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
