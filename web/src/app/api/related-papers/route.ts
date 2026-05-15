/**
 * Connected-papers proxy. Two backends ship in this codebase
 * — OpenAlex (default, no key needed) and Semantic Scholar
 * (opt-in via Settings → Integrations; needs
 * SEMANTIC_SCHOLAR_API_KEY in the droplet env for real volume).
 *
 *   GET /api/related-papers?ref=ARXIV:2401.12345&title=…
 *   GET /api/related-papers?title=Attention+Is+All+You+Need
 *
 * The route picks a backend based on the user's
 * `related_papers_provider` server pref ('openalex' |
 * 'semanticscholar'), defaulting to 'openalex'. If the chosen
 * backend fails for non-input reasons (rate-limit / network), we
 * surface the error directly rather than silently swapping —
 * the user picked a provider for a reason and a transparent
 * failure points them at the right knob to turn.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getServerPref } from '@/lib/server-prefs';
import { parseRef } from '@/lib/related-papers/types';
import { fetchRelatedFromOpenAlex } from '@/lib/related-papers/openalex';
import { fetchRelatedFromSemanticScholar } from '@/lib/related-papers/semanticscholar';
import { getCached, setCached } from '@/lib/related-papers/cache';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Public — same rationale as /api/papers/refs and /api/import/lookup.
  // Upstream data (OpenAlex / Semantic Scholar) is freely available,
  // the route is just a normalising proxy. Auth, when present, only
  // switches in the user's preferred provider; anonymous callers
  // get OpenAlex (no key needed, polite-pool friendly).
  const session = await auth();
  const userId = session?.user ? (session.user as { id: string }).id : '';

  const ref = parseRef(req.nextUrl.searchParams.get('ref'));
  const title = req.nextUrl.searchParams.get('title');
  if (!ref && !title) {
    return NextResponse.json({ error: '`ref` or `title` is required.' }, { status: 400 });
  }
  // Caller-supplied page size. Capped at 100 — the upstream
  // OpenAlex /works/<id>/related_works endpoint returns 25 fixed,
  // so the headroom above 50 lets the cited-by leg pull a longer
  // tail. The Sankey / graph views become hard to read above 100,
  // so 100 is also the practical UI ceiling.
  //
  // True lazy-load (paginating the cited-by query with ?offset) is
  // a separate slice — the API surface and client refetch loop
  // need their own design pass.
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 30));

  const provider = userId
    ? ((await getServerPref<string>(userId, 'related_papers_provider')) || 'openalex')
    : 'openalex';

  /** Cache key: provider + the most stable identifier we have.
   *  Falls back to title if no ref was supplied — title queries are
   *  inherently fuzzy and rare, but cacheable for the 6 h window. */
  const cacheKey = `${provider}:${ref ? `${ref.kind}:${ref.id}` : `title:${title}`}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) {
    if (cached.ok) {
      return NextResponse.json({
        papers: cached.papers,
        resolvedVia: cached.resolvedVia,
        dropped: 'dropped' in cached ? cached.dropped : 0,
        provider,
        cached: true,
      });
    }
  }

  try {
    if (provider === 'semanticscholar') {
      const ss = await fetchRelatedFromSemanticScholar({ ref, title, limit });
      // SS-empty is a real failure mode for well-cited classics
      // — their similarity index is opportunistic and routinely
      // returns recommendedPapers:[] for foundational papers.
      // Rather than punish the user for picking SS, transparently
      // fall through to OpenAlex when SS resolves cleanly but
      // returns nothing, and label the response so the UI can
      // tell them what happened.
      if (ss.ok && ss.papers.length === 0) {
        const oa = await fetchRelatedFromOpenAlex({ ref, title, limit, email: session?.user?.email ?? undefined });
        if (oa.ok) {
          // Cache the OpenAlex fallback under the OpenAlex key so a
          // later openalex-provider query picks it up. Not cached
          // under the SS key — SS empty results should re-check next
          // time the user explicitly picks SS.
          setCached(cacheKey.replace(/^semanticscholar:/, 'openalex:'), oa);
          return NextResponse.json({
            papers: oa.papers,
            resolvedVia: oa.resolvedVia,
            dropped: 'dropped' in oa ? oa.dropped : 0,
            provider: 'openalex',
            fallbackFrom: 'semanticscholar',
          });
        }
        // OpenAlex fallback failed too — return the original
        // SS-empty result rather than the OpenAlex error, since
        // the SS path was the requested one.
      }
      if (ss.ok) {
        setCached(cacheKey, ss);
        return NextResponse.json({
          papers: ss.papers,
          resolvedVia: ss.resolvedVia,
          dropped: 0,
          provider: 'semanticscholar',
        });
      }
      return NextResponse.json(
        { error: ss.error, rateLimited: ss.rateLimited, provider: 'semanticscholar' },
        { status: ss.status },
      );
    }

    const oa = await fetchRelatedFromOpenAlex({ ref, title, limit, email: session?.user?.email ?? undefined });
    if (oa.ok) {
      setCached(cacheKey, oa);
      return NextResponse.json({
        papers: oa.papers,
        resolvedVia: oa.resolvedVia,
        dropped: 'dropped' in oa ? oa.dropped : 0,
        provider: 'openalex',
      });
    }
    return NextResponse.json(
      { error: oa.error, rateLimited: oa.rateLimited, provider: 'openalex' },
      { status: oa.status },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, provider }, { status: 502 });
  }
}
