/**
 * GET /api/papers/path?from=<ref>&to=<ref>&maxDepth=4
 *
 * Finds the shortest citation path between two papers — Inciteful's
 * signature feature. BFS walks `referenced_works` outward from the
 * `from` paper, looking for the `to` paper. Returns the path as a
 * list of paper-metadata objects, or null if no path is reachable
 * within the depth cap.
 *
 * Bounds:
 *   - maxDepth ≤ 4 (so a path has at most 5 papers, fast enough
 *     for interactive use with caching).
 *   - 200 total OpenAlex lookups per request (each cited paper is
 *     one lookup); BFS terminates early once that ceiling is hit.
 *
 * Each ref param is DOI:<doi> or ARXIV:<id>; both resolve to an
 * OpenAlex Work via the same chain the edges fetch uses
 * (DOI → arxiv-doi shape → title search).
 */
import { NextRequest, NextResponse } from 'next/server';
import { parseRef } from '@/lib/related-papers/types';
import type { RelatedPaper } from '@/lib/related-papers/types';
import { getCachedLookup, setCachedLookup } from '@/lib/paper-cache';

const TTL_SEC = 6 * 3600;
const MAILTO = 'minerva@thefarshad.com';
const MAX_VISITS = 200;
const MAX_DEPTH_HARD = 5;

export const dynamic = 'force-dynamic';

type OAWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  authorships?: { author?: { display_name?: string } }[];
  publication_year?: number | null;
  cited_by_count?: number | null;
  referenced_works?: string[];
};

function stripOA(id?: string | null): string {
  return (id || '').replace(/^https:\/\/openalex\.org\//, '');
}

function workToPaper(w: OAWork): RelatedPaper {
  const rawDoi = w.doi || '';
  const doi = rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined;
  const arxivMatch = doi?.match(/^10\.48550\/arXiv\.(.+)$/i);
  return {
    paperId: stripOA(w.id),
    externalIds: { DOI: doi, ArXiv: arxivMatch?.[1] },
    title: w.title || undefined,
    authors: (w.authorships || [])
      .map((a) => ({ name: a.author?.display_name || '' }))
      .filter((a) => a.name),
    year: w.publication_year ?? undefined,
    citationCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : undefined,
  };
}

async function resolveSeed(ref: { kind: 'ARXIV' | 'DOI'; id: string }): Promise<string | null> {
  const tryDoi = ref.kind === 'DOI' ? ref.id : `10.48550/arXiv.${ref.id}`;
  const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(tryDoi)}?select=id&mailto=${encodeURIComponent(MAILTO)}`);
  if (r.ok) {
    const j = (await r.json()) as { id?: string };
    return stripOA(j.id) || null;
  }
  return null;
}

async function fetchWork(id: string): Promise<OAWork | null> {
  const url = `https://api.openalex.org/works/${encodeURIComponent(id)}?select=id,doi,title,authorships,publication_year,cited_by_count,referenced_works&mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!r.ok) return null;
    return (await r.json()) as OAWork;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const from = parseRef(req.nextUrl.searchParams.get('from'));
  const to = parseRef(req.nextUrl.searchParams.get('to'));
  const maxDepth = Math.min(MAX_DEPTH_HARD, Math.max(1, Number(req.nextUrl.searchParams.get('maxDepth')) || 4));
  if (!from || !to) {
    return NextResponse.json({ error: '`from` and `to` are required.' }, { status: 400 });
  }
  if (from.kind === 'TITLE_ONLY' || to.kind === 'TITLE_ONLY') {
    return NextResponse.json({ error: 'Need a DOI or arXiv id on both sides.' }, { status: 400 });
  }

  const cacheKey = `path:${from.kind}:${from.id}->${to.kind}:${to.id}:${maxDepth}`;
  const cached = await getCachedLookup<{ path: RelatedPaper[]; hops: number }>(cacheKey, TTL_SEC);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  const fromId = await resolveSeed(from);
  const toId = await resolveSeed(to);
  if (!fromId) return NextResponse.json({ error: '`from` paper not found in OpenAlex.' }, { status: 404 });
  if (!toId) return NextResponse.json({ error: '`to` paper not found in OpenAlex.' }, { status: 404 });
  if (fromId === toId) return NextResponse.json({ error: '`from` and `to` are the same paper.' }, { status: 400 });

  // BFS — frontier is a map of paperId → parent-trace so we can
  // reconstruct the full path on hit. Reads referenced_works
  // outward from `from`; the visited set short-circuits cycles
  // and revisits.
  const parent = new Map<string, string | null>();
  parent.set(fromId, null);
  let frontier: string[] = [fromId];
  let depth = 0;
  let visits = 0;
  let foundAt: string | null = null;
  outer: while (depth < maxDepth && frontier.length > 0 && visits < MAX_VISITS) {
    const next: string[] = [];
    // Fan out lookups for this layer in parallel; cap each fetch
    // so a single overloaded paper doesn't dominate.
    const layerWorks = await Promise.all(frontier.slice(0, MAX_VISITS - visits).map(fetchWork));
    visits += layerWorks.length;
    for (const w of layerWorks) {
      if (!w) continue;
      const pid = stripOA(w.id);
      for (const refUrl of (w.referenced_works || [])) {
        const rid = stripOA(refUrl);
        if (!rid || parent.has(rid)) continue;
        parent.set(rid, pid);
        if (rid === toId) { foundAt = rid; break outer; }
        next.push(rid);
      }
    }
    frontier = next;
    depth += 1;
  }

  if (!foundAt) {
    const body = { path: [] as RelatedPaper[], hops: 0, reason: `No path within ${maxDepth} hops (checked ${visits} papers).` };
    return NextResponse.json(body);
  }

  // Reconstruct path: from `toId` back to `fromId` via parent map.
  const idsRev: string[] = [];
  let cur: string | null = foundAt;
  while (cur) {
    idsRev.push(cur);
    cur = parent.get(cur) ?? null;
  }
  const ids = idsRev.reverse();
  // Batch-fetch metadata for every paper in the path.
  const filter = ids.map((i) => i).join('|');
  const metaR = await fetch(
    `https://api.openalex.org/works?filter=ids.openalex:${encodeURIComponent(filter)}&per_page=${ids.length}&select=id,doi,title,authorships,publication_year,cited_by_count&mailto=${encodeURIComponent(MAILTO)}`,
  );
  let path: RelatedPaper[] = [];
  if (metaR.ok) {
    const mj = (await metaR.json()) as { results?: OAWork[] };
    const byId = new Map<string, OAWork>();
    for (const w of mj.results || []) byId.set(stripOA(w.id), w);
    path = ids.map((id) => byId.get(id)).filter((w): w is OAWork => !!w).map(workToPaper);
  }

  const body = { path, hops: path.length - 1 };
  await setCachedLookup(cacheKey, body);
  return NextResponse.json(body);
}
