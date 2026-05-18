/**
 * GET /api/authors/image?q=<name>
 *
 * Best-effort author portrait lookup via Wikidata. Returns
 *   { url: string | null }
 *
 * Flow:
 *   1. wbsearchentities to map the free-text name to candidate
 *      Wikidata items (Q-IDs).
 *   2. For each candidate, fetch claims and check P31 (instance
 *      of) contains Q5 (human). Skips "Yann LeCun the village"
 *      style false matches.
 *   3. Read the first P18 (image) claim and serve via
 *      commons.wikimedia.org/wiki/Special:FilePath/<file>?width=240
 *      which auto-handles the SHA-based thumbnail path.
 *
 * No image is the common case — most working researchers don't
 * have a Wikidata entry. The route returns { url: null } in that
 * case and the AuthorProfile falls back to the no-image layout.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCachedLookup, setCachedLookup } from '@/lib/paper-cache';

const TTL_SEC = 7 * 24 * 3600;

export const dynamic = 'force-dynamic';

type SearchHit = { id?: string; label?: string };
type Claim = { mainsnak?: { datavalue?: { value?: string | { id?: string } } } };
type Entity = { claims?: { P31?: Claim[]; P18?: Claim[] } };

async function findHumanQID(name: string): Promise<{ qid: string; entity: Entity } | null> {
  const searchUrl =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
    `&search=${encodeURIComponent(name)}&language=en&format=json&type=item&limit=3`;
  const sr = await fetch(searchUrl, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
  if (!sr.ok) return null;
  const sj = (await sr.json()) as { search?: SearchHit[] };
  const candidates = (sj.search || []).map((h) => h.id).filter((id): id is string => !!id);
  if (candidates.length === 0) return null;
  // Batch-fetch claims for every candidate in one call.
  const entUrl =
    `https://www.wikidata.org/w/api.php?action=wbgetentities` +
    `&ids=${candidates.join('|')}&props=claims&format=json`;
  const er = await fetch(entUrl, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
  if (!er.ok) return null;
  const ej = (await er.json()) as { entities?: Record<string, Entity> };
  for (const qid of candidates) {
    const entity = ej.entities?.[qid];
    if (!entity) continue;
    const p31 = entity.claims?.P31 || [];
    const isHuman = p31.some((c) => {
      const v = c.mainsnak?.datavalue?.value;
      return typeof v === 'object' && v?.id === 'Q5';
    });
    if (isHuman) return { qid, entity };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ url: null });

  const cacheKey = `wikidata-img:${q.toLowerCase()}`;
  const cached = await getCachedLookup<{ url: string | null }>(cacheKey, TTL_SEC);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  try {
    const hit = await findHumanQID(q);
    if (!hit) {
      const body = { url: null };
      await setCachedLookup(cacheKey, body);
      return NextResponse.json(body);
    }
    const p18 = hit.entity.claims?.P18 || [];
    const first = p18[0]?.mainsnak?.datavalue?.value;
    const filename = typeof first === 'string' ? first : null;
    if (!filename) {
      const body = { url: null };
      await setCachedLookup(cacheKey, body);
      return NextResponse.json(body);
    }
    const url =
      `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=240`;
    const body = { url };
    await setCachedLookup(cacheKey, body);
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ url: null, error: (e as Error).message }, { status: 502 });
  }
}
