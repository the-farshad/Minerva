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

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const ref = parseRef(req.nextUrl.searchParams.get('ref'));
  const title = req.nextUrl.searchParams.get('title');
  if (!ref && !title) {
    return NextResponse.json({ error: '`ref` or `title` is required.' }, { status: 400 });
  }
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 30));

  const provider = (await getServerPref<string>(userId, 'related_papers_provider')) || 'openalex';

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
        const oa = await fetchRelatedFromOpenAlex({ ref, title, limit, email: session.user.email ?? undefined });
        if (oa.ok) {
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

    const oa = await fetchRelatedFromOpenAlex({ ref, title, limit, email: session.user.email ?? undefined });
    if (oa.ok) {
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
