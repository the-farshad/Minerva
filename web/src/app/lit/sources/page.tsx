/**
 * Static page describing every upstream data source the literature
 * explorer queries. Linked from the /lit footer so the home view
 * stays uncluttered while curious users can see (a) what's behind
 * a given lookup and (b) which sources are free vs paid.
 */
import Link from 'next/link';

export const metadata = { title: 'Sources — Literature' };
export const dynamic = 'force-static';

type Source = {
  name: string;
  url: string;
  free: boolean;
  scope: string;
  used: string;
};

const SOURCES: Source[] = [
  {
    name: 'arXiv',
    url: 'https://arxiv.org',
    free: true,
    scope: 'Preprints — physics, mathematics, computer science, quantitative biology, statistics, economics.',
    used: 'Metadata lookup when a query resolves to an arXiv ID.',
  },
  {
    name: 'CrossRef',
    url: 'https://www.crossref.org',
    free: true,
    scope: 'DOI registration agency — most peer-reviewed journal & conference papers worldwide.',
    used: 'Metadata lookup for any DOI; backfills titles missing from other sources.',
  },
  {
    name: 'DBLP',
    url: 'https://dblp.org',
    free: true,
    scope: 'CS-focused bibliographic index — strong on conferences, workshops, technical reports.',
    used: 'Third backend in the parallel keyword-search merge (alongside SS + OpenAlex).',
  },
  {
    name: 'Europe PMC',
    url: 'https://europepmc.org',
    free: true,
    scope: 'Biomedical literature — mirrors PubMed + bioRxiv + medRxiv. Open-access full-text linkouts.',
    used: 'Metadata + OA PDF resolution for biomed papers; title-based search fallback.',
  },
  {
    name: 'OpenAlex',
    url: 'https://openalex.org',
    free: true,
    scope: 'Multidisciplinary open scholarly graph from OurResearch — 250M+ works, authors, concepts.',
    used: 'Keyword + author search, concept tagging, references/citations fallback, related-papers default.',
  },
  {
    name: 'OpenCitations',
    url: 'https://opencitations.net',
    free: true,
    scope: 'Open citation index — bare DOI-to-DOI links across hundreds of millions of papers.',
    used: 'Fallback for the References / Cited-by tabs when Semantic Scholar is rate-limiting.',
  },
  {
    name: 'Semantic Scholar',
    url: 'https://www.semanticscholar.org',
    free: true,
    scope: 'AI-curated literature index — best free citation context + similarity ranker for paper search.',
    used: 'Primary backend for paper search, related-papers, references, and citations.',
  },
];

export default function SourcesPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6">
      <header className="mb-6">
        <Link href="/lit" className="text-xs text-zinc-500 hover:underline">← back to /lit</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sources</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Every result on this site is assembled live from these free, public scholarly indexes.
          No subscriptions, no API keys — just polite-pool clients hitting the upstream services.
        </p>
      </header>
      <ul className="space-y-4">
        {SOURCES.map((s) => (
          <li key={s.name} className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <a href={s.url} target="_blank" rel="noopener" className="text-base font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                {s.name}
              </a>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
                {s.free ? 'free + public' : 'paid'}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{s.scope}</p>
            <p className="mt-1 text-xs text-zinc-500">{s.used}</p>
          </li>
        ))}
      </ul>
      <footer className="mt-12 text-center text-xs text-zinc-400">
        <Link href="/lit" className="hover:underline">← back to /lit</Link>
      </footer>
    </main>
  );
}
