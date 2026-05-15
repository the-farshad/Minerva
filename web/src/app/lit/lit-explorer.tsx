'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Loader2, ExternalLink, FileText, Quote, GitBranch, List, Network, Download } from 'lucide-react';
import { RelatedGraph } from '@/app/papers/related/[rowId]/related-graph';

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

/** Best identifier we can use as a lookup query for this paper —
 *  DOI > arXiv > title. Returned as the same string the lookup
 *  route accepts. Used by the click-to-explore handler. */
function lookupQueryOf(p: Paper): string {
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) return doi;
  const arxiv = p.arxiv || p.externalIds?.ArXiv;
  if (arxiv) return arxiv;
  return p.title || '';
}

function bibtexOf(p: Paper): string {
  const doi = p.doi || p.externalIds?.DOI || '';
  const arxiv = p.arxiv || p.externalIds?.ArXiv || '';
  const key = (doi || arxiv || (p.title || 'paper').slice(0, 20))
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'paper';
  const authors = authorsStr(p).split(/,\s*/).filter(Boolean).join(' and ');
  const lines: string[] = [`@article{${key}`];
  if (p.title) lines.push(`  title = {${p.title}}`);
  if (authors) lines.push(`  author = {${authors}}`);
  if (p.year) lines.push(`  year = {${p.year}}`);
  if (p.venue) lines.push(`  journal = {${p.venue}}`);
  if (doi) lines.push(`  doi = {${doi}}`);
  const url = publicUrl(p);
  if (url) lines.push(`  url = {${url}}`);
  return lines.join(',\n') + '\n}\n';
}

function bibtexBulk(papers: Paper[]): string {
  return papers.map(bibtexOf).join('\n');
}

function risBulk(papers: Paper[]): string {
  return papers.map(risOf).join('\n');
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function csvOf(papers: Paper[]): string {
  const cols = ['title', 'authors', 'year', 'venue', 'doi', 'arxiv', 'citationCount', 'url'];
  const head = cols.join(',');
  const rows = papers.map((p) => {
    const doi = p.doi || p.externalIds?.DOI || '';
    const arxiv = p.arxiv || p.externalIds?.ArXiv || '';
    return [
      p.title ?? '',
      authorsStr(p),
      p.year != null ? String(p.year) : '',
      p.venue ?? '',
      doi,
      arxiv,
      typeof p.citationCount === 'number' ? String(p.citationCount) : '',
      publicUrl(p),
    ].map(csvEscape).join(',');
  });
  return [head, ...rows].join('\n') + '\n';
}

function risOf(p: Paper): string {
  const lines = ['TY  - JOUR'];
  if (p.title) lines.push(`TI  - ${p.title}`);
  for (const a of authorsStr(p).split(/,\s*/).filter(Boolean)) lines.push(`AU  - ${a}`);
  if (p.year) lines.push(`PY  - ${p.year}`);
  if (p.venue) lines.push(`JO  - ${p.venue}`);
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) lines.push(`DO  - ${doi}`);
  const url = publicUrl(p);
  if (url) lines.push(`UR  - ${url}`);
  if (p.abstract) lines.push(`AB  - ${p.abstract}`);
  lines.push('ER  - ');
  return lines.join('\n') + '\n';
}

function downloadText(content: string, filename: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Tab = 'overview' | 'refs' | 'cites' | 'related';
type RelatedView = 'list' | 'graph';
type SearchMode = 'id' | 'keyword';

export function LitExplorer() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('id');
  const [loading, setLoading] = useState(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [err, setErr] = useState<string>('');
  const [candidates, setCandidates] = useState<Paper[] | null>(null);

  const [tab, setTab] = useState<Tab>('overview');
  const [relatedView, setRelatedView] = useState<RelatedView>('list');
  // List filters / sort — apply across all three connected-graph
  // legs (refs / cites / related). Reset on every new seed search
  // via the `setX('')` block in `resolveAndSetSeed` below.
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [minCites, setMinCites] = useState<string>('');
  const [textFilter, setTextFilter] = useState<string>('');
  const [oaOnly, setOaOnly] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<'relevance' | 'cites-desc' | 'year-desc' | 'year-asc'>('relevance');
  // Connected-graph fetches, cached per `${ref}:${kind}` key so
  // tab-flipping doesn't refetch.
  const [edgeCache, setEdgeCache] = useState<Record<string, Paper[]>>({});
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [edgeError, setEdgeError] = useState<string>('');

  const ref = paper ? refOf(paper) : null;
  const cacheKey = ref && tab !== 'overview' ? `${ref}:${tab}` : '';
  const edgePapers = cacheKey ? edgeCache[cacheKey] : null;

  async function resolveAndSetSeed(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setErr('');
    setPaper(null);
    setCandidates(null);
    setEdgeCache({});
    setTab('overview');
    // Reset list filters whenever the seed changes — a year range
    // useful for paper A is almost never the same as for paper B.
    setYearFrom(''); setYearTo(''); setMinCites(''); setTextFilter('');
    setOaOnly(false); setSortBy('relevance');
    try {
      const r = await fetch('/api/import/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: q.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as Paper & { error?: string };
      if (!r.ok) {
        setErr(j.error || `lookup: ${r.status}`);
      } else if (!j.title && j.kind !== 'paper') {
        setErr('No paper match. Try a DOI, arXiv ID, paper URL, or a more specific title.');
      } else {
        setPaper(j);
        // Keep the query bar in sync with the active seed so the
        // user can see what's being explored and edit / re-search.
        setQuery(q.trim());
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runKeywordSearch(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setErr('');
    setPaper(null);
    setCandidates(null);
    setEdgeCache({});
    setTab('overview');
    try {
      const r = await fetch(`/api/papers/search?q=${encodeURIComponent(q.trim())}&limit=25`);
      const j = (await r.json().catch(() => ({}))) as { papers?: Paper[]; error?: string };
      if (!r.ok) {
        setErr(j.error || `search: ${r.status}`);
        setCandidates([]);
      } else {
        setCandidates(j.papers || []);
        if ((j.papers || []).length === 0) {
          setErr('No matches. Try different wording or a more specific phrase.');
        }
      }
    } catch (e) {
      setErr((e as Error).message);
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'keyword') {
      await runKeywordSearch(query);
    } else {
      await resolveAndSetSeed(query);
    }
  }

  /** Click-to-explore: take a paper from the refs / cited / related
   *  list (or the keyword-search candidates) and re-resolve it as
   *  the new seed. The list cards pass through whichever identifier
   *  they have (DOI > arXiv > title) and the lookup chain handles
   *  all three. Flips back to id-mode so the input reflects the
   *  resolved seed. */
  function exploreFromPaper(p: Paper) {
    const q = lookupQueryOf(p);
    if (!q) return;
    setMode('id');
    void resolveAndSetSeed(q);
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

  // Filter + sort the active list. Source order is "relevance" —
  // SS / OA return papers in the order their similarity ranker
  // chose, which is meaningful on its own, so it's the default
  // sort and a no-op when selected.
  const filteredEdges = useMemo<Paper[] | null>(() => {
    if (!edgePapers) return edgePapers;
    const yFrom = Number(yearFrom) || 0;
    const yTo = Number(yearTo) || 9999;
    const minC = Number(minCites) || 0;
    const needle = textFilter.trim().toLowerCase();
    const out = edgePapers.filter((p) => {
      const y = typeof p.year === 'number' ? p.year : Number(p.year) || 0;
      if (y && (y < yFrom || y > yTo)) return false;
      if (yearFrom && !y) return false;
      if (yearTo && !y) return false;
      if (oaOnly && !(p.openAccessPdf?.url || p.pdf)) return false;
      if (minC > 0 && (p.citationCount ?? -1) < minC) return false;
      if (needle) {
        const hay = `${authorsStr(p)} ${p.venue ?? ''} ${p.title ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    if (sortBy === 'cites-desc') {
      out.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
    } else if (sortBy === 'year-desc' || sortBy === 'year-asc') {
      const dir = sortBy === 'year-asc' ? 1 : -1;
      out.sort((a, b) => {
        const ya = typeof a.year === 'number' ? a.year : Number(a.year) || 0;
        const yb = typeof b.year === 'number' ? b.year : Number(b.year) || 0;
        return dir * (ya - yb);
      });
    }
    return out;
  }, [edgePapers, yearFrom, yearTo, oaOnly, sortBy]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Literature</h1>
      </header>

      <form onSubmit={onSubmit} className="mb-6">
        <div className="mb-2 inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          {(['id', 'keyword'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-full px-2.5 py-1 text-xs transition ${
                mode === m
                  ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              {m === 'id' ? 'Identifier' : 'Keyword'}
            </button>
          ))}
        </div>
        <label className="flex items-stretch rounded-full border border-zinc-300 bg-white shadow-sm focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          <span className="flex shrink-0 items-center pl-4 text-zinc-400">
            <Search className="h-4 w-4" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'id'
              ? 'Search by DOI, arXiv ID, URL, or title'
              : 'Search by keyword, phrase, or topic'}
            className="flex-1 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="m-1 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
          >
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {mode === 'id' ? 'Looking up' : 'Searching'}</>
              : 'Search'}
          </button>
        </label>
      </form>

      {err && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </div>
      )}

      {!paper && candidates && candidates.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-zinc-500">
            {candidates.length} result{candidates.length === 1 ? '' : 's'} — click a title to explore.
          </p>
          <ul className="space-y-2">
            {candidates.map((p, idx) => (
              <PaperRow
                key={`cand-${idx}-${p.paperId ?? p.title}`}
                paper={p}
                onExplore={() => exploreFromPaper(p)}
              />
            ))}
          </ul>
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
              {edgePapers && edgePapers.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="text-zinc-400">
                    {filteredEdges?.length ?? 0}
                    {filteredEdges && edgePapers && filteredEdges.length !== edgePapers.length
                      ? ` of ${edgePapers.length}`
                      : ''}
                  </span>
                  <input
                    type="number"
                    value={yearFrom}
                    onChange={(e) => setYearFrom(e.target.value)}
                    placeholder="from"
                    aria-label="Year from"
                    className="w-16 rounded-full border border-zinc-200 bg-transparent px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700"
                  />
                  <span className="text-zinc-400">–</span>
                  <input
                    type="number"
                    value={yearTo}
                    onChange={(e) => setYearTo(e.target.value)}
                    placeholder="to"
                    aria-label="Year to"
                    className="w-16 rounded-full border border-zinc-200 bg-transparent px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700"
                  />
                  <input
                    type="number"
                    value={minCites}
                    onChange={(e) => setMinCites(e.target.value)}
                    placeholder="min cites"
                    aria-label="Minimum citations"
                    className="w-20 rounded-full border border-zinc-200 bg-transparent px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700"
                  />
                  <input
                    type="text"
                    value={textFilter}
                    onChange={(e) => setTextFilter(e.target.value)}
                    placeholder="author or venue"
                    aria-label="Filter by author or venue"
                    className="w-36 rounded-full border border-zinc-200 bg-transparent px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700"
                  />
                  <label className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={oaOnly}
                      onChange={(e) => setOaOnly(e.target.checked)}
                      className="accent-zinc-900 dark:accent-zinc-200"
                    />
                    Open access
                  </label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    aria-label="Sort order"
                    className="rounded-full border border-zinc-200 bg-transparent px-2 py-0.5 text-xs outline-none dark:border-zinc-700"
                  >
                    <option value="relevance">Relevance</option>
                    <option value="cites-desc">Most cited</option>
                    <option value="year-desc">Newest</option>
                    <option value="year-asc">Oldest</option>
                  </select>
                  <span className="mx-1 text-zinc-300 dark:text-zinc-700">|</span>
                  <button
                    type="button"
                    title="Download current list as BibTeX"
                    onClick={() => {
                      if (!filteredEdges?.length) return;
                      downloadText(bibtexBulk(filteredEdges), `lit-${tab}.bib`);
                    }}
                    disabled={!filteredEdges?.length}
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                  >
                    <Download className="h-3 w-3" /> BibTeX
                  </button>
                  <button
                    type="button"
                    title="Download current list as RIS"
                    onClick={() => {
                      if (!filteredEdges?.length) return;
                      downloadText(risBulk(filteredEdges), `lit-${tab}.ris`);
                    }}
                    disabled={!filteredEdges?.length}
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                  >
                    <Download className="h-3 w-3" /> RIS
                  </button>
                  <button
                    type="button"
                    title="Download current list as CSV"
                    onClick={() => {
                      if (!filteredEdges?.length) return;
                      downloadText(csvOf(filteredEdges), `lit-${tab}.csv`, 'text/csv;charset=utf-8');
                    }}
                    disabled={!filteredEdges?.length}
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                  >
                    <Download className="h-3 w-3" /> CSV
                  </button>
                  {tab === 'related' && (
                    <div className="ml-auto inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                      <button
                        type="button"
                        onClick={() => setRelatedView('list')}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
                          relatedView === 'list'
                            ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                            : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                        }`}
                      >
                        <List className="h-3 w-3" /> List
                      </button>
                      <button
                        type="button"
                        onClick={() => setRelatedView('graph')}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
                          relatedView === 'graph'
                            ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                            : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                        }`}
                      >
                        <Network className="h-3 w-3" /> Graph
                      </button>
                    </div>
                  )}
                </div>
              )}
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
              {!edgeLoading && filteredEdges && filteredEdges.length > 0 && tab === 'related' && relatedView === 'graph' && (
                <RelatedGraph
                  seedTitle={paper.title || ''}
                  seedYear={paper.year ? String(paper.year) : ''}
                  seedAuthors={authorsStr(paper)}
                  // Coerce our looser Paper.authors (string | array)
                  // into the array-only shape RelatedGraph expects.
                  papers={filteredEdges.map((p) => ({
                    ...p,
                    authors: Array.isArray(p.authors)
                      ? p.authors
                      : (typeof p.authors === 'string' && p.authors
                          ? p.authors.split(/,\s*/).map((n) => ({ name: n }))
                          : []),
                    year: typeof p.year === 'number' ? p.year : (p.year ? Number(p.year) || undefined : undefined),
                  }))}
                  added={new Set()}
                  adding={new Set()}
                  onAdd={async () => false}
                />
              )}
              {!edgeLoading && filteredEdges && filteredEdges.length > 0 && !(tab === 'related' && relatedView === 'graph') && (
                <ul className="space-y-2">
                  {filteredEdges.map((p, idx) => (
                    <PaperRow
                      key={`${idx}-${p.paperId ?? p.title}`}
                      paper={p}
                      onExplore={() => exploreFromPaper(p)}
                    />
                  ))}
                </ul>
              )}
              {!edgeLoading && edgePapers && edgePapers.length > 0 && filteredEdges && filteredEdges.length === 0 && (
                <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
                  {edgePapers.length} loaded, none match the current filters.
                </p>
              )}
            </div>
          )}
        </>
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
        <span className="mx-1 text-zinc-300 dark:text-zinc-700">|</span>
        <button
          type="button"
          onClick={() => {
            const base = ((paper.doi || paper.arxiv || paper.externalIds?.DOI || paper.externalIds?.ArXiv || paper.title || 'paper')
              .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));
            downloadText(bibtexOf(paper), `${base}.bib`);
          }}
          title="Download BibTeX"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          <Download className="h-3 w-3" /> BibTeX
        </button>
        <button
          type="button"
          onClick={() => {
            const base = ((paper.doi || paper.arxiv || paper.externalIds?.DOI || paper.externalIds?.ArXiv || paper.title || 'paper')
              .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));
            downloadText(risOf(paper), `${base}.ris`);
          }}
          title="Download RIS"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          <Download className="h-3 w-3" /> RIS
        </button>
        <button
          type="button"
          onClick={() => {
            const base = ((paper.doi || paper.arxiv || paper.externalIds?.DOI || paper.externalIds?.ArXiv || paper.title || 'paper')
              .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));
            downloadText(JSON.stringify(paper, null, 2), `${base}.json`, 'application/json;charset=utf-8');
          }}
          title="Download JSON"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          <Download className="h-3 w-3" /> JSON
        </button>
      </div>
    </article>
  );
}

function PaperRow({ paper, onExplore }: { paper: Paper; onExplore?: () => void }) {
  const link = publicUrl(paper);
  const authors = authorsStr(paper);
  const cc = typeof paper.citationCount === 'number' ? paper.citationCount : null;
  const explorable = onExplore && (paper.doi || paper.externalIds?.DOI || paper.arxiv || paper.externalIds?.ArXiv || paper.title);
  return (
    <li className="group rounded-md border border-zinc-200 bg-white p-3 transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-600">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {explorable ? (
              <button
                type="button"
                onClick={onExplore}
                title="Explore this paper — make it the new seed"
                className="text-left text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
              >
                {paper.title || '(untitled)'}
              </button>
            ) : link ? (
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
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener"
            title="Open original"
            className="shrink-0 rounded-full p-1.5 text-zinc-400 opacity-0 transition hover:bg-zinc-100 hover:text-zinc-700 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}
