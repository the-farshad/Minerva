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
    const res = provider === 'semanticscholar'
      ? await fetchRelatedFromSemanticScholar({ ref, title, limit })
      : await fetchRelatedFromOpenAlex({ ref, title, limit, email: session.user.email ?? undefined });

    if (res.ok) {
      return NextResponse.json({
        papers: res.papers,
        resolvedVia: res.resolvedVia,
        dropped: 'dropped' in res ? res.dropped : 0,
        provider,
      });
    }
    return NextResponse.json(
      { error: res.error, rateLimited: res.rateLimited, provider },
      { status: res.status },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, provider }, { status: 502 });
  }
}
