'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Loader2, Plus, Check, ExternalLink, Network, Download, Calendar as CalIcon, FileText, BookOpen, ChevronDown, X, List, GitBranch, Workflow } from 'lucide-react';
import { RelatedGraph } from './related-graph';
import { RelatedSankey } from './related-sankey';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

interface Paper {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string; CorpusId?: string };
  title?: string;
  authors?: { name?: string }[];
  year?: number;
  abstract?: string;
  openAccessPdf?: { url?: string };
  venue?: string;
}

/** Pick the best external URL for a paper — prefer the openAccess
 *  PDF (clicks straight into reading), then arXiv abs (renders
 *  well in our preview), then a DOI lookup. */
function paperUrl(p: Paper): string | null {
  if (p.openAccessPdf?.url) return p.openAccessPdf.url;
  if (p.externalIds?.ArXiv) return `https://arxiv.org/abs/${p.externalIds.ArXiv}`;
  if (p.externalIds?.DOI) return `https://doi.org/${p.externalIds.DOI}`;
  return null;
}

function paperKey(p: Paper): string {
  return p.externalIds?.DOI || p.externalIds?.ArXiv || p.paperId || p.title || '';
}

export function RelatedView({
  sectionSlug, rowId, seedRef, seedTitle, seedAuthors, seedYear,
}: {
  sectionSlug: string;
  rowId: string;
  seedRef: string | null;
  seedTitle: string;
  seedAuthors: string;
  seedYear: string;
}) {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [provider, setProvider] = useState<string>('openalex');
  const [fallbackFrom, setFallbackFrom] = useState<string>('');
  const [resolvedVia, setResolvedVia] = useState<string>('');
  const [dropped, setDropped] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<Set<string>>(new Set());
  /** Paper keys whose Drive-mirror save-offline call is in flight.
   *  Updated as the NDJSON stream from /save-offline progresses;
   *  cleared on 'done' or 'error'. */
  const [mirroring, setMirroring] = useState<Set<string>>(new Set());
  const [mirrored, setMirrored] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [view, setView] = useState<'list' | 'graph' | 'sankey'>('list');
  /** Incremental list reveal. The server returns up to 80 related
   *  papers; rendering them all at once is a wall. Show 30
   *  initially, "Load more" reveals another 30. Reset to 30 when
   *  the filter set changes so a freshly-narrowed list starts at
   *  the top. Graph / Sankey always get the full `filtered` set —
   *  they're spatial, not a scroll list. */
  const PAGE_STEP = 30;
  const [listLimit, setListLimit] = useState(PAGE_STEP);
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const yearPickerRef = useRef<HTMLDivElement>(null);

  // Close the year-picker popover on any outside click. Cheaper
  // than wiring Radix Popover for a one-off control.
  useEffect(() => {
    if (!yearPickerOpen) return;
    function onDoc(e: MouseEvent) {
      if (yearPickerRef.current && !yearPickerRef.current.contains(e.target as Node)) {
        setYearPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [yearPickerOpen]);

  /** Human-readable summary of the current year filter — used as
   *  the chip label so the active state is obvious at a glance. */
  /** Persist a different related-papers backend to the user's
   *  server prefs and trigger a re-fetch. Used by the empty-
   *  state nudge when one backend yields nothing useful. */
  async function switchProviderAndRefetch(next: 'openalex' | 'semanticscholar') {
    setSwitchingProvider(true);
    try {
      const r = await fetch('/api/userprefs/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'related_papers_provider', value: next }),
      });
      if (!r.ok) throw new Error(`save: ${r.status}`);
      setProvider(next);
      setPapers(null);
      setErr(null);
      const params = new URLSearchParams({ limit: '80' });
      if (seedRef) params.set('ref', seedRef);
      if (seedTitle) params.set('title', seedTitle);
      const r2 = await fetch(`/api/related-papers?${params.toString()}`);
      const j = (await r2.json()) as { papers?: Paper[]; error?: string; provider?: string; resolvedVia?: string; dropped?: number; fallbackFrom?: string };
      setDropped(j.dropped ?? 0);
      if (j.provider) setProvider(j.provider);
      if (j.resolvedVia) setResolvedVia(j.resolvedVia);
      setFallbackFrom(j.fallbackFrom || '');
      if (!r2.ok) throw new Error(j.error || `Recommendations: ${r2.status}`);
      setPapers(j.papers || []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSwitchingProvider(false);
    }
  }

  function yearLabel(): string {
    const from = yearFrom ? Number(yearFrom) : null;
    const to = yearTo ? Number(yearTo) : null;
    if (!from && !to) return 'Any year';
    if (from && !to) return `Since ${from}`;
    if (!from && to) return `Up to ${to}`;
    if (from === to) return `${from}`;
    return `${from}–${to}`;
  }
  // Filters apply on top of the search query. All client-side so
  // they're instant — the result set is small enough (≤ 50 from
  // either backend) that no server round-trip is needed.
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [pdfOnly, setPdfOnly] = useState(false);
  const [venueFilter, setVenueFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<'relevance' | 'year-desc' | 'year-asc' | 'title'>('relevance');

  useEffect(() => {
    if (!seedRef && !seedTitle) {
      setErr("This paper has no title, arXiv ID, or DOI to look up — add some metadata first.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Always send the title alongside the ref so the server
        // can fall back to a title-search when SS doesn't index
        // the paper under the ref shape (common for non-arXiv,
        // non-CrossRef DOIs).
        const params = new URLSearchParams({ limit: '80' });
        if (seedRef) params.set('ref', seedRef);
        if (seedTitle) params.set('title', seedTitle);
        const r = await fetch(`/api/related-papers?${params.toString()}`);
        const j = (await r.json()) as { papers?: Paper[]; error?: string; provider?: string; resolvedVia?: string; dropped?: number; fallbackFrom?: string };
        if (cancelled) return;
        if (j.provider) setProvider(j.provider);
        if (j.resolvedVia) setResolvedVia(j.resolvedVia);
        setDropped(j.dropped ?? 0);
        setFallbackFrom(j.fallbackFrom || '');
        if (!r.ok) throw new Error(j.error || `Recommendations: ${r.status}`);
        setPapers(j.papers || []);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [seedRef, seedTitle]);

  /** Distinct venues across the loaded result set — drives the
   *  venue dropdown so users only see options that match the
   *  current backend's response. */
  const allVenues = useMemo(() => {
    if (!papers) return [] as string[];
    const set = new Set<string>();
    for (const p of papers) if (p.venue) set.add(p.venue);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [papers]);

  /** Distinct publication years in the loaded result set, newest
   *  first. Drives both the year-picker dropdowns and the slider
   *  bounds so the user can only pick years that actually exist
   *  in the list. */
  const allYears = useMemo(() => {
    if (!papers) return [] as number[];
    const set = new Set<number>();
    for (const p of papers) if (p.year) set.add(p.year);
    return Array.from(set).sort((a, b) => b - a);
  }, [papers]);
  const yearMin = allYears.length ? allYears[allYears.length - 1] : null;
  const yearMax = allYears.length ? allYears[0] : null;

  const filtered = useMemo(() => {
    if (!papers) return [];
    const Q = q.trim().toLowerCase();
    const yFrom = yearFrom ? Number(yearFrom) : null;
    const yTo = yearTo ? Number(yearTo) : null;
    const venue = venueFilter.trim().toLowerCase();
    const out = papers.filter((p) => {
      if (Q) {
        const t = (p.title || '').toLowerCase();
        const a = (p.authors || []).map((x) => x.name || '').join(' ').toLowerCase();
        const v = (p.venue || '').toLowerCase();
        if (!(t.includes(Q) || a.includes(Q) || v.includes(Q))) return false;
      }
      if (yFrom != null && (p.year == null || p.year < yFrom)) return false;
      if (yTo != null && (p.year == null || p.year > yTo)) return false;
      if (pdfOnly && !p.openAccessPdf?.url) return false;
      if (venue && (p.venue || '').toLowerCase() !== venue) return false;
      return true;
    });
    // Sorting — relevance preserves backend order (already
    // ranked); the explicit options key off year / title.
    if (sortBy === 'year-desc') out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else if (sortBy === 'year-asc') out.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
    else if (sortBy === 'title') out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return out;
  }, [papers, q, yearFrom, yearTo, pdfOnly, venueFilter, sortBy]);

  const filtersActive = !!(yearFrom || yearTo || pdfOnly || venueFilter || sortBy !== 'relevance');
  function clearFilters() {
    setYearFrom(''); setYearTo(''); setPdfOnly(false); setVenueFilter(''); setSortBy('relevance');
  }

  // Reset the incremental reveal whenever the filtered set changes
  // — a freshly-narrowed list should start at the top, not deep in
  // a previous list's pagination.
  useEffect(() => {
    setListLimit(PAGE_STEP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, yearFrom, yearTo, pdfOnly, venueFilter, sortBy, papers]);
  const visible = useMemo(() => filtered.slice(0, listLimit), [filtered, listLimit]);

  async function addOne(p: Paper): Promise<boolean> {
    const key = paperKey(p);
    if (!key || added.has(key) || adding.has(key)) return false;
    const url = paperUrl(p);
    if (!url) { notify.error(`No fetchable URL for "${p.title}"`); return false; }
    setAdding((s) => new Set(s).add(key));
    try {
      const data: Record<string, unknown> = {
        url,
        title: p.title || '',
        authors: (p.authors || []).map((a) => a.name || '').filter(Boolean).join(', '),
      };
      if (p.year) data.year = String(p.year);
      if (p.abstract) data.abstract = p.abstract;
      if (p.venue) data.venue = p.venue;
      if (p.externalIds?.DOI) data.doi = p.externalIds.DOI;
      if (p.externalIds?.ArXiv) data.arxiv = p.externalIds.ArXiv;
      const r = await fetch(`/api/sections/${sectionSlug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error(`add: ${r.status}`);
      const created = (await r.json()) as { id?: string };
      setAdded((s) => new Set(s).add(key));
      // Fire-and-forget Drive mirror so the user gets an offline
      // PDF copy on every paper they add. save-offline returns
      // NDJSON; we read it to flip mirroring → mirrored, but
      // never await it inside addOne so the caller (and the
      // add-all loop) stays responsive. Failures are silent
      // — a paper whose URL is a publisher landing page rather
      // than a direct PDF will fail, and that's expected.
      if (created.id) {
        setMirroring((s) => new Set(s).add(key));
        void streamSaveOffline(created.id, key);
      }
      return true;
    } catch (e) {
      notify.error(`${p.title}: ${(e as Error).message}`);
      return false;
    } finally {
      setAdding((s) => { const next = new Set(s); next.delete(key); return next; });
    }
  }

  async function streamSaveOffline(rowId: string, key: string) {
    try {
      const r = await fetch(`/api/sections/${sectionSlug}/rows/${rowId}/save-offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'paper' }),
      });
      if (!r.ok || !r.body) {
        setMirroring((s) => { const next = new Set(s); next.delete(key); return next; });
        return;
      }
      // Consume the NDJSON heartbeat stream. We only need the
      // final line; heartbeats are intentionally ignored.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let success = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { type?: string };
            if (msg.type === 'done') success = true;
          } catch { /* malformed line — skip */ }
        }
      }
      setMirroring((s) => { const next = new Set(s); next.delete(key); return next; });
      if (success) setMirrored((s) => new Set(s).add(key));
    } catch {
      setMirroring((s) => { const next = new Set(s); next.delete(key); return next; });
    }
  }

  async function addAll() {
    if (filtered.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    for (const p of filtered) {
      const key = paperKey(p);
      if (!key || added.has(key)) continue;
      if (await addOne(p)) done += 1;
    }
    setBulkBusy(false);
    toast.success(`Added ${done} paper${done === 1 ? '' : 's'} to ${sectionSlug}.`);
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href={`/s/${encodeURIComponent(sectionSlug)}`}
        className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="h-3 w-3" /> Back to {sectionSlug}
      </Link>

      <header className="mb-4 flex items-start gap-3">
        <Network className="mt-1 h-5 w-5 shrink-0 text-zinc-500" />
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Related papers</div>
            {papers && (
              <span
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                title={fallbackFrom
                  ? `Resolved via ${resolvedVia || 'ref'} — your preferred provider (${fallbackFrom}) returned no results so we auto-fell back to ${provider}.`
                  : `Resolved via ${resolvedVia || 'ref'}`}
              >
                {provider === 'semanticscholar' ? 'Semantic Scholar' : 'OpenAlex'}
                {fallbackFrom && <span className="ml-1 normal-case text-[9px] text-zinc-500">(Semantic Scholar empty)</span>}
              </span>
            )}
            {papers && dropped > 0 && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                title="Some related-work IDs OpenAlex pointed at are no longer resolvable — typically deindexed papers"
              >
                {papers.length} readable · {dropped} dropped
              </span>
            )}
            {/* Inline provider toggle — flips between OpenAlex
              * and Semantic Scholar without leaving the page;
              * persists to the same server pref Settings uses. */}
            {papers && (
              <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                {([
                  { v: 'openalex',         label: 'OpenAlex' },
                  { v: 'semanticscholar',  label: 'Semantic Scholar' },
                ] as const).map((p) => {
                  const active = provider === p.v;
                  return (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => { if (!active) void switchProviderAndRefetch(p.v); }}
                      disabled={switchingProvider}
                      title={`Switch to ${p.label}`}
                      className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide transition disabled:opacity-50 ${
                        active
                          ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                          : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <h1 className="mt-0.5 text-lg font-semibold leading-tight">{seedTitle}</h1>
          {(seedAuthors || seedYear) && (
            <p className="mt-0.5 text-xs text-zinc-500">
              {seedAuthors}{seedAuthors && seedYear ? ' · ' : ''}{seedYear}
            </p>
          )}
        </div>
      </header>


      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, authors, venue…"
            className="w-full rounded-full border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <button
          type="button"
          onClick={addAll}
          disabled={bulkBusy || filtered.length === 0 || !papers}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {bulkBusy
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…</>
            : <><Download className="h-3.5 w-3.5" /> Add all {filtered.length ? `(${filtered.length})` : ''}</>}
        </button>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => setView('list')}
            title="List view"
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
              view === 'list'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            <List className="h-3.5 w-3.5" /> List
          </button>
          <button
            type="button"
            onClick={() => setView('graph')}
            title="Force-directed graph view"
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
              view === 'graph'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            <GitBranch className="h-3.5 w-3.5" /> Graph
          </button>
          <button
            type="button"
            onClick={() => setView('sankey')}
            title="Citation flow — which paper has been cited by which one"
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
              view === 'sankey'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            <Workflow className="h-3.5 w-3.5" /> Citations
          </button>
        </div>
      </div>

      {/* Filter strip — chip-style pills that visibly carry their
        * own state. Each pill flips to the inverse-colour scheme
        * when active so users can see at a glance what's narrowed
        * the list. Sort is a segmented control on the right so it
        * doesn't compete with the filters' Active/Off duality. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {/* Year filter — click the chip to open a popover with
          * one-tap presets ("Since 5 years ago", "Last decade")
          * plus a custom From/To picker that lists only the years
          * actually present in the loaded results. The chip's
          * label summarises the current state so users never
          * have to expand the popover just to read what's set. */}
        <div ref={yearPickerRef} className="relative">
          <button
            type="button"
            onClick={() => setYearPickerOpen((v) => !v)}
            aria-expanded={yearPickerOpen}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 transition ${
              yearFrom || yearTo
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            <CalIcon className="h-3 w-3 opacity-70" />
            <span className="text-xs">{yearLabel()}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          {yearPickerOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
              {(() => {
                // Quick presets — read off the most recent year in
                // the result set so "last 5 years" actually means
                // last 5 years relative to what's loaded, not
                // wall-clock now (which can drift after the page is
                // open for a while).
                const nowYr = yearMax ?? new Date().getFullYear();
                const presets: { label: string; from: string; to: string }[] = [
                  { label: 'Any year',         from: '',                 to: '' },
                  { label: 'Last 5 years',     from: String(nowYr - 4),  to: '' },
                  { label: 'Last 10 years',    from: String(nowYr - 9),  to: '' },
                  { label: 'Last 20 years',    from: String(nowYr - 19), to: '' },
                ];
                return (
                  <div className="grid grid-cols-2 gap-1.5">
                    {presets.map((p) => {
                      const active = yearFrom === p.from && yearTo === p.to;
                      return (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => { setYearFrom(p.from); setYearTo(p.to); }}
                          className={`rounded-md border px-2 py-1.5 text-xs transition ${
                            active
                              ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Custom range</div>
                <div className="mt-1.5 flex items-center gap-2 text-xs">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1800}
                    max={2100}
                    value={yearFrom}
                    onChange={(e) => setYearFrom(e.target.value)}
                    placeholder={yearMin != null ? String(yearMin) : 'from'}
                    aria-label="Year from"
                    className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-center dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <span className="text-zinc-400">–</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1800}
                    max={2100}
                    value={yearTo}
                    onChange={(e) => setYearTo(e.target.value)}
                    placeholder={yearMax != null ? String(yearMax) : 'to'}
                    aria-label="Year to"
                    className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-center dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </div>
                {yearMin != null && yearMax != null && (
                  <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
                    <span>Loaded papers span {yearMin}–{yearMax}.</span>
                    <button
                      type="button"
                      onClick={() => { setYearFrom(String(yearMin)); setYearTo(String(yearMax)); }}
                      className="text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
                    >
                      Use full range
                    </button>
                  </div>
                )}
              </div>
              {(yearFrom || yearTo) && (
                <button
                  type="button"
                  onClick={() => { setYearFrom(''); setYearTo(''); }}
                  className="mt-3 w-full rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Clear year filter
                </button>
              )}
            </div>
          )}
        </div>

        {/* PDF-only — real toggle button instead of a checkbox.
          * Click anywhere on the pill flips it. */}
        <button
          type="button"
          onClick={() => setPdfOnly((v) => !v)}
          aria-pressed={pdfOnly}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 transition ${
            pdfOnly
              ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500 dark:text-zinc-900'
              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
          }`}
        >
          <FileText className="h-3 w-3" />
          PDF only
          {pdfOnly && <Check className="h-3 w-3" />}
        </button>

        {/* Venue picker — only shows when the list has more than
          * one. The pill carries the venue when picked; click to
          * cycle back to "all". */}
        {allVenues.length > 1 && (
          <div
            className={`relative inline-flex items-center rounded-full border transition ${
              venueFilter
                ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500 dark:text-zinc-900'
                : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
            }`}
          >
            <BookOpen className="ml-3 h-3 w-3 opacity-70" />
            <select
              value={venueFilter}
              onChange={(e) => setVenueFilter(e.target.value)}
              aria-label="Filter by venue"
              className="appearance-none bg-transparent py-1 pl-2 pr-7 text-xs focus:outline-none"
            >
              <option value="" className="text-zinc-900 dark:text-zinc-100">All venues ({allVenues.length})</option>
              {allVenues.map((v) => (
                <option key={v} value={v} className="text-zinc-900 dark:text-zinc-100">{v}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 opacity-60" />
          </div>
        )}

        {/* Sort — segmented pill bar. Click cycles between the
          * four sort options; visual state is unambiguous. */}
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          {([
            { v: 'relevance', label: 'Relevance' },
            { v: 'year-desc', label: 'Newest' },
            { v: 'year-asc',  label: 'Oldest' },
            { v: 'title',     label: 'A–Z' },
          ] as const).map((opt) => {
            const active = sortBy === opt.v;
            return (
              <button
                key={opt.v}
                type="button"
                onClick={() => setSortBy(opt.v)}
                className={`rounded-full px-2.5 py-1 text-xs transition ${
                  active
                    ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Clear all filters"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {err && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
          {err}
        </div>
      )}

      {!err && papers === null && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading recommendations from Semantic Scholar…
        </div>
      )}

      {!err && papers && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700">
          {papers.length === 0 ? (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {provider === 'semanticscholar'
                  ? 'Semantic Scholar returned no recommendations for this paper. They build their similarity index opportunistically — well-cited classics sometimes have an empty list.'
                  : 'OpenAlex returned no related works for this paper.'}
              </p>
              <button
                type="button"
                onClick={() => void switchProviderAndRefetch(provider === 'semanticscholar' ? 'openalex' : 'semanticscholar')}
                disabled={switchingProvider}
                className="mt-4 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                {switchingProvider
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Retrying…</>
                  : <>Try {provider === 'semanticscholar' ? 'OpenAlex' : 'Semantic Scholar'} instead</>}
              </button>
              <p className="mt-3 text-[10px] text-zinc-500">
                This sets your <span className="font-medium">Related-papers source</span> in Settings.
              </p>
            </>
          ) : (
            <p className="text-sm text-zinc-500">No matches for &ldquo;{q}&rdquo;.</p>
          )}
        </div>
      )}

      {view === 'graph' && papers && (
        <RelatedGraph
          seedTitle={seedTitle}
          seedYear={seedYear}
          seedAuthors={seedAuthors}
          papers={filtered}
          added={added}
          adding={adding}
          onAdd={addOne}
        />
      )}

      {view === 'sankey' && papers && (
        <RelatedSankey
          seedTitle={seedTitle}
          papers={filtered}
          added={added}
        />
      )}

      <ul className={`mt-2 space-y-2 ${view !== 'list' ? 'hidden' : ''}`}>
        {visible.map((p, idx) => {
          const key = paperKey(p);
          const url = paperUrl(p);
          const isAdded = added.has(key);
          const isBusy = adding.has(key);
          const isMirroring = mirroring.has(key);
          const isMirrored = mirrored.has(key);
          const authors = (p.authors || []).map((a) => a.name || '').filter(Boolean).join(', ');
          return (
            <li
              key={key || p.paperId || `idx-${idx}`}
              className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  {(() => {
                    const synth = p.title?.startsWith('〔synth〕');
                    const cleanTitle = synth ? (p.title || '').replace(/^〔synth〕/, '') : p.title;
                    if (cleanTitle) {
                      const className = synth
                        ? 'text-sm italic text-zinc-700 hover:underline dark:text-zinc-300'
                        : 'text-sm font-medium hover:underline';
                      const inner = (
                        <>
                          {cleanTitle}
                          {synth && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0 text-[9px] uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">untitled</span>}
                        </>
                      );
                      return url
                        ? <a href={url} target="_blank" rel="noopener" className={className}>{inner}</a>
                        : <span className={className}>{inner}</span>;
                    }
                    /* Genuinely no usable label — neither
                       OpenAlex nor CrossRef nor the synthesise
                       fallback gave us anything. Render the
                       paperId verbatim. */
                    return url ? (
                      <a href={url} target="_blank" rel="noopener" className="text-sm italic text-zinc-500 hover:underline dark:text-zinc-400">
                        Untitled work
                        {p.paperId && <span className="ml-1 font-mono text-[10px] text-zinc-400">{p.paperId}</span>}
                      </a>
                    ) : (
                      <span className="text-sm italic text-zinc-500 dark:text-zinc-400">
                        Untitled work
                        {p.paperId && <span className="ml-1 font-mono text-[10px] text-zinc-400">{p.paperId}</span>}
                      </span>
                    );
                  })()}
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {authors}
                    {p.year && <span> · {p.year}</span>}
                    {p.venue && <span> · {p.venue}</span>}
                  </div>
                  {p.abstract && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {p.abstract}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener"
                      title="Open externally"
                      className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void addOne(p)}
                    disabled={isAdded || isBusy || !url}
                    title={isAdded ? 'Already added' : 'Add to your papers section'}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
                      isAdded
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200'
                    }`}
                  >
                    {isBusy
                      ? <><Loader2 className="h-3 w-3 animate-spin" /></>
                      : isAdded
                        ? <><Check className="h-3 w-3" /> Added</>
                        : <><Plus className="h-3 w-3" /> Add</>}
                  </button>
                  {/* Drive-mirror status pill — only shows after
                    * the row's been added. Streams from "Mirroring…"
                    * (spinner) to "Offline" (cloud check) or
                    * disappears silently on failure. */}
                  {isAdded && isMirroring && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                      title="Downloading the PDF to your Drive"
                    >
                      <Loader2 className="h-2.5 w-2.5 animate-spin" /> Mirroring
                    </span>
                  )}
                  {isAdded && !isMirroring && isMirrored && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      title="PDF is on your Drive"
                    >
                      <Download className="h-2.5 w-2.5" /> Offline
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {view === 'list' && filtered.length > listLimit && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setListLimit((n) => n + PAGE_STEP)}
            className="rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Load more — showing {listLimit} of {filtered.length}
          </button>
        </div>
      )}
    </main>
  );
}
