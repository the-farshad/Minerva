/**
 * GET /api/papers/concepts?ref=ARXIV:<id>|DOI:<id>[&top=<n>]
 *
 * Public, unauthenticated. Returns the OpenAlex concepts (topics) on
 * a paper, ordered by OpenAlex's relevance score. Used by /lit to
 * render clickable topic chips on a paper's overview.
 *
 * Concepts come back as { id, display_name, level, score }.
 * Level 0 = root field (e.g. Computer science), higher = more
 * specific. We keep the level so the UI can prefer specific concepts
 * over root ones when ranking.
 */
import { NextRequest, NextResponse } from 'next/server';
import { parseRef } from '@/lib/related-papers/types';

const DEFAULT_TOP = 5;
const MAX_TOP = 10;

export const dynamic = 'force-dynamic';

type OAConcept = {
  id?: string;
  display_name?: string;
  level?: number;
  score?: number;
  wikidata?: string;
};

type OAWork = { concepts?: OAConcept[] };

function politeUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://api.openalex.org${path}${sep}mailto=${encodeURIComponent('minerva@thefarshad.com')}`;
}

async function fetchOAConcepts(doi: string | null, arxiv: string | null): Promise<OAConcept[]> {
  // OpenAlex's per-work endpoint accepts an arXiv submission as the
  // CrossRef-shaped DOI 10.48550/arXiv.<id>. Try the explicit DOI
  // first, fall back to the arXiv-shaped DOI.
  const tryIds: string[] = [];
  if (doi) tryIds.push(`doi:${doi}`);
  if (arxiv) tryIds.push(`doi:10.48550/arXiv.${arxiv}`);
  for (const id of tryIds) {
    try {
      const r = await fetch(politeUrl(`/works/${encodeURIComponent(id)}?select=concepts`), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 3600 },
      });
      if (!r.ok) continue;
      const j = (await r.json()) as OAWork;
      if (Array.isArray(j.concepts) && j.concepts.length > 0) return j.concepts;
    } catch {
      // try next id
    }
  }
  return [];
}

export async function GET(req: NextRequest) {
  const refParam = req.nextUrl.searchParams.get('ref');
  const top = Math.min(
    MAX_TOP,
    Math.max(1, Number(req.nextUrl.searchParams.get('top')) || DEFAULT_TOP),
  );
  const ref = parseRef(refParam);
  if (!ref) {
    return NextResponse.json(
      { error: 'Pass ref=ARXIV:<id> or ref=DOI:<id>.' },
      { status: 400 },
    );
  }
  if (ref.kind === 'TITLE_ONLY') {
    return NextResponse.json({ concepts: [] });
  }

  const doi = ref.kind === 'DOI' ? ref.id : null;
  const arxiv = ref.kind === 'ARXIV' ? ref.id : null;
  const concepts = await fetchOAConcepts(doi, arxiv);

  // Rank: higher score wins. Drop low-confidence noise (< 0.2). Skip
  // level-0 root fields when more specific concepts exist; they're
  // accurate but too broad to be useful as a chip ("Computer science").
  const filtered = concepts.filter((c) => (c.score ?? 0) >= 0.2 && c.display_name);
  const hasSpecific = filtered.some((c) => (c.level ?? 0) > 0);
  const ranked = filtered
    .filter((c) => (hasSpecific ? (c.level ?? 0) > 0 : true))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, top)
    .map((c) => ({
      id: (c.id || '').replace(/^https:\/\/openalex\.org\//, ''),
      name: c.display_name,
      level: c.level ?? 0,
      score: c.score ?? 0,
    }));

  return NextResponse.json({ concepts: ranked, provider: 'openalex' });
}
