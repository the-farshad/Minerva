/**
 * GET /api/authors/profile?q=<name>
 *
 * Public, unauthenticated. Resolves an author name to OpenAlex's
 * best match and returns a compact profile: h-index, paper count,
 * total citations, top concepts, institution(s), year span. Used
 * by /lit to render a profile card above the author-hub
 * candidates pane.
 */
import { NextRequest, NextResponse } from 'next/server';

const MAILTO = 'minerva@thefarshad.com';

export const dynamic = 'force-dynamic';

type Concept = { display_name?: string; level?: number | null; score?: number };
type Institution = { display_name?: string; country_code?: string; type?: string };
type SummaryStats = { h_index?: number; i10_index?: number; '2yr_mean_citedness'?: number };
type OAAuthor = {
  id?: string;
  display_name?: string;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: SummaryStats;
  x_concepts?: Concept[];
  last_known_institutions?: Institution[];
  counts_by_year?: { year: number; works_count: number; cited_by_count: number }[];
};

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ author: null });

  const url =
    `https://api.openalex.org/authors?search=${encodeURIComponent(q)}` +
    `&per_page=1&select=id,display_name,works_count,cited_by_count,summary_stats,x_concepts,last_known_institutions,counts_by_year` +
    `&mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!r.ok) return NextResponse.json({ author: null });
    const j = (await r.json()) as { results?: OAAuthor[] };
    const a = j.results?.[0];
    if (!a?.id) return NextResponse.json({ author: null });

    const id = a.id.replace(/^https:\/\/openalex\.org\//, '');
    const concepts = (a.x_concepts || [])
      .filter((c) => c.display_name && (c.score ?? 0) > 0.2)
      .slice(0, 6)
      .map((c) => ({ name: c.display_name!, score: c.score ?? 0 }));
    const institutions = (a.last_known_institutions || [])
      .filter((i) => i.display_name)
      .slice(0, 3)
      .map((i) => ({ name: i.display_name!, country: i.country_code || '', type: i.type || '' }));
    const cby = (a.counts_by_year || []).filter((c) => c.year && (c.works_count > 0 || c.cited_by_count > 0));
    const yearMin = cby.length ? Math.min(...cby.map((c) => c.year)) : null;
    const yearMax = cby.length ? Math.max(...cby.map((c) => c.year)) : null;
    return NextResponse.json({
      author: {
        id,
        name: a.display_name || q,
        worksCount: a.works_count ?? 0,
        citedByCount: a.cited_by_count ?? 0,
        hIndex: a.summary_stats?.h_index ?? null,
        i10Index: a.summary_stats?.i10_index ?? null,
        topConcepts: concepts,
        institutions,
        yearMin,
        yearMax,
      },
    });
  } catch (e) {
    return NextResponse.json({ author: null, error: (e as Error).message }, { status: 502 });
  }
}
