'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Loader2, ExternalLink, FileText, Quote, GitBranch } from 'lucide-react';

type Paper = {
  kind?: string;
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: string | { name?: string }[];
  year?: string | number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  pmcid?: string;
  abstract?: string;
  url?: string;
  pdf?: string;
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  openAccessPdf?: { url?: string };
};

function publicUrl(p: Paper): string {
  if (p.openAccessPdf?.url && /^https?:\/\//i.test(p.openAccessPdf.url)) return p.openAccessPdf.url;
  if (p.pdf && /^https?:\/\//i.test(p.pdf)) return p.pdf;
  if (p.url && /^https?:\/\//i.test(p.url)) return p.url;
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) return `https://doi.org/${doi}`;
  const arxiv = p.arxiv || p.externalIds?.ArXiv;
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  return '';
}

function authorsStr(p: Paper): string {
  if (typeof p.authors === 'string') return p.authors;
  if (Array.isArray(p.authors)) return p.authors.map((a) => a.name || '').filter(Boolean).join(', ');
  return '';
}

/** Build the `ref` query param the public refs / related endpoints
 *  understand. Returns null when the paper has neither a DOI nor an
 *  arXiv id (the connected-graph endpoints can't do anything with
 *  a free-text title). */
function refOf(p: Paper): string | null {
  const arxiv = p.arxiv || p.externalIds?.ArXiv;
  if (arxiv) return `ARXIV:${arxiv}`;
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) return `DOI:${doi}`;
  return null;
}

type Tab = 'overview' | 'refs' | 'cites' | 'related';

export function LitExplorer() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [err, setErr] = useState<string>('');

  const [tab, setTab] = useState<Tab>('overview');
  // Connected-graph fetches, cached per `${ref}:${kind}` key so
  // tab-flipping doesn't refetch.
  const [edgeCache, setEdgeCache] = useState<Record<string, Paper[]>>({});
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [edgeError, setEdgeError] = useState<string>('');

  const ref = paper ? refOf(paper) : null;
  const cacheKey = ref && tab !== 'overview' ? `${ref}:${tab}` : '';
  const edgePapers = cacheKey ? edgeCache[cacheKey] : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setErr('');
    setPaper(null);
    setEdgeCache({});
    setTab('overview');
    try {
      const r = await fetch('/api/import/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      const j = (await r.json().catch(() => ({}))) as Paper & { error?: string };
      if (!r.ok) {
        setErr(j.error || `lookup: ${r.status}`);
      } else if (!j.title && j.kind !== 'paper') {
        setErr('No paper match. Try a DOI (10.x/y), arXiv id (2401.12345), a paper URL, or a more specific title.');
      } else {
        setPaper(j);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Lazy-fetch whichever connected-graph leg is active, cached
  // per direction so a tab flip is instant.
  useEffect(() => {
    if (!cacheKey || edgePapers !== undefined || edgeLoading || !ref) return;
    setEdgeLoading(true);
    setEdgeError('');
    const url = tab === 'related'
      ? `/api/related-papers?ref=${encodeURIComponent(ref)}&limit=50`
      : `/api/papers/refs?ref=${encodeURIComponent(ref)}&direction=${tab === 'refs' ? 'references' : 'citations'}&limit=100`;
    void fetch(url)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { papers?: Paper[]; error?: string };
        if (!r.ok) {
          setEdgeError(j.error || `${tab}: ${r.status}`);
          setEdgeCache((c) => ({ ...c, [cacheKey]: [] }));
        } else {
          setEdgeCache((c) => ({ ...c, [cacheKey]: j.papers || [] }));
        }
      })
      .catch((e) => {
        setEdgeError((e as Error).message);
        setEdgeCache((c) => ({ ...c, [cacheKey]: [] }));
      })
      .finally(() => setEdgeLoading(false));
  }, [cacheKey, edgePapers, edgeLoading, ref, tab]);

  const tabs = useMemo<{ id: Tab; label: string; Icon: typeof FileText }[]>(() => ([
    { id: 'overview', label: 'Overview', Icon: FileText },
    { id: 'refs',     label: 'References', Icon: Quote },
    { id: 'cites',    label: 'Cited by', Icon: Quote },
    { id: 'related',  label: 'Related', Icon: GitBranch },
  ]), []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <h1 className="text-3xl font-semibold tracking-tight">Literature</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Look up any paper by DOI, arXiv id, URL, or title. Free, stateless &mdash; nothing saved.
        </p>
      </header>

      <form onSubmit={onSubmit} className="mb-6">
        <label className="flex items-stretch rounded-full border border-zinc-300 bg-white shadow-sm focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          <span className="flex shrink-0 items-center pl-4 text-zinc-400">
            <Search className="h-4 w-4" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="10.3390/healthcare12111109 · 2401.12345 · https://arxiv.org/abs/… · Attention Is All You Need"
            className="flex-1 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="m-1 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
          >
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up</> : 'Search'}
          </button>
        </label>
      </form>

      {err && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </div>
      )}

      {paper && (
        <>
          <div className="mb-4 inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
            {tabs.map((t) => {
              const disabled = (t.id === 'refs' || t.id === 'cites' || t.id === 'related') && !ref;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  disabled={disabled}
                  title={disabled ? 'Needs a DOI or arXiv id on the resolved paper' : t.label}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    tab === t.id
                      ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                      : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                  }`}
                >
                  <t.Icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'overview' && <PaperOverview paper={paper} />}

          {tab !== 'overview' && (
            <div>
              {edgeLoading && (
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              )}
              {!edgeLoading && edgeError && (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
                  {edgeError}
                </div>
              )}
              {!edgeLoading && !edgeError && edgePapers && edgePapers.length === 0 && (
                <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
                  No results for this leg.
                </p>
              )}
              {!edgeLoading && edgePapers && edgePapers.length > 0 && (
                <ul className="space-y-2">
                  {edgePapers.map((p, idx) => <PaperRow key={`${idx}-${p.paperId ?? p.title}`} paper={p} />)}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {!paper && !err && !loading && (
        <div className="rounded-md border border-dashed border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">What this is</p>
          <p className="mt-2">
            A literature explorer. Paste any paper reference above and it&rsquo;ll be resolved across
            arXiv, CrossRef, Europe PMC, and most publisher pages. Then browse its references, the
            papers that cite it, and similar work &mdash; no sign-in needed.
          </p>
        </div>
      )}

      <footer className="mt-12 text-center text-xs text-zinc-400">
        <a href="https://thefarshad.com" className="hover:underline">thefarshad.com</a>
      </footer>
    </main>
  );
}

function PaperOverview({ paper }: { paper: Paper }) {
  const link = publicUrl(paper);
  const authors = authorsStr(paper);
  return (
    <article className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {link ? (
          <a href={link} target="_blank" rel="noopener" className="text-lg font-semibold text-zinc-900 hover:underline dark:text-zinc-100">
            {paper.title}
          </a>
        ) : (
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{paper.title}</h2>
        )}
        {paper.year && <span className="text-sm text-zinc-500">{String(paper.year)}</span>}
        {typeof paper.citationCount === 'number' && paper.citationCount > 0 && (
          <span
            title={`${paper.citationCount.toLocaleString()} citations`}
            className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {paper.citationCount >= 1000
              ? `${(paper.citationCount / 1000).toFixed(paper.citationCount >= 10_000 ? 0 : 1)}k`
              : paper.citationCount} cites
          </span>
        )}
      </div>
      {(authors || paper.venue) && (
        <div className="mt-1 text-sm text-zinc-500">
          {authors}
          {authors && paper.venue ? ' · ' : ''}
          {paper.venue}
        </div>
      )}
      {paper.abstract && (
        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {paper.abstract}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        {paper.doi && (
          <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener"
             className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
            <ExternalLink className="h-3 w-3" /> doi.org/{paper.doi}
          </a>
        )}
        {paper.pdf && publicUrl(paper) !== paper.pdf && (
          <a href={paper.pdf} target="_blank" rel="noopener"
             className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
            <ExternalLink className="h-3 w-3" /> PDF
          </a>
        )}
        {paper.pmid && <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-800">PMID {paper.pmid}</span>}
        {paper.pmcid && <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-800">{paper.pmcid}</span>}
      </div>
    </article>
  );
}

function PaperRow({ paper }: { paper: Paper }) {
  const link = publicUrl(paper);
  const authors = authorsStr(paper);
  const cc = typeof paper.citationCount === 'number' ? paper.citationCount : null;
  return (
    <li className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {link ? (
          <a href={link} target="_blank" rel="noopener" className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">
            {paper.title || '(untitled)'}
          </a>
        ) : (
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{paper.title || '(untitled)'}</span>
        )}
        {paper.year && <span className="text-xs text-zinc-500">{String(paper.year)}</span>}
        {cc !== null && cc > 0 && (
          <span title={`${cc.toLocaleString()} citations`} className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {cc >= 1000 ? `${(cc / 1000).toFixed(cc >= 10_000 ? 0 : 1)}k` : cc}
          </span>
        )}
      </div>
      {(authors || paper.venue) && (
        <div className="mt-0.5 truncate text-xs text-zinc-500">
          {authors}
          {authors && paper.venue ? ' · ' : ''}
          {paper.venue}
        </div>
      )}
    </li>
  );
}
