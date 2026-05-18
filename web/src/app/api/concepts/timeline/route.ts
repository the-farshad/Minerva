/**
 * GET /api/concepts/timeline?q=<query>
 *
 * For a free-text query, returns the best-matching OpenAlex
 * concept and a year-by-year tally of papers tagged with that
 * concept. Used by /lit to render a topic-activity sparkline above
 * keyword-search candidates so the user can see whether the topic
 * is trending up or fading.
 *
 * Two upstream calls:
 *   1. GET /concepts?search=<q>&per_page=1     — resolve concept
 *   2. GET /works?filter=concepts.id:<id>      — yearly group-by
 *      &group_by=publication_year
 *
 * The concept's own `counts_by_year` field is no longer populated
 * by OpenAlex (returns null), so the group_by aggregation is the
 * only reliable path.
 */
import { NextRequest, NextResponse } from 'next/server';

const MAILTO = 'minerva@thefarshad.com';

export const dynamic = 'force-dynamic';

type Group = { key: string; count: number };

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ concept: null, counts: [] });

  try {
    // Resolve concept.
    const lookupUrl =
      `https://api.openalex.org/concepts?search=${encodeURIComponent(q)}` +
      `&per_page=1&select=id,display_name,level,works_count` +
      `&mailto=${encodeURIComponent(MAILTO)}`;
    const lookupR = await fetch(lookupUrl, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!lookupR.ok) return NextResponse.json({ concept: null, counts: [] });
    const lookupJ = (await lookupR.json()) as {
      results?: { id?: string; display_name?: string; level?: number; works_count?: number }[];
    };
    const hit = lookupJ.results?.[0];
    if (!hit?.id) return NextResponse.json({ concept: null, counts: [] });
    const id = hit.id.replace(/^https:\/\/openalex\.org\//, '');

    // Year-by-year aggregation.
    const aggUrl =
      `https://api.openalex.org/works?filter=concepts.id:${encodeURIComponent(id)}` +
      `&group_by=publication_year&mailto=${encodeURIComponent(MAILTO)}`;
    const aggR = await fetch(aggUrl, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!aggR.ok) {
      return NextResponse.json({
        concept: { id, name: hit.display_name, level: hit.level ?? 0, worksCount: hit.works_count ?? 0 },
        counts: [],
      });
    }
    const aggJ = (await aggR.json()) as { group_by?: Group[] };
    // Coerce year keys to numbers, drop garbage / future-dated
    // rows (OA occasionally has 2028/2029/etc entries with count 1
    // that look like indexing noise), sort ascending.
    const now = new Date().getFullYear();
    const counts = (aggJ.group_by || [])
      .map((g) => ({ year: Number(g.key), count: g.count }))
      .filter((c) => Number.isFinite(c.year) && c.year >= 1950 && c.year <= now + 1 && c.count > 0)
      .sort((a, b) => a.year - b.year);

    return NextResponse.json({
      concept: {
        id,
        name: hit.display_name,
        level: hit.level ?? 0,
        worksCount: hit.works_count ?? 0,
      },
      counts,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, concept: null, counts: [] }, { status: 502 });
  }
}
