'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Loader2, Plus, Check, ExternalLink, Network, Download } from 'lucide-react';
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

/** Translate the seed paper's ref into the connectedpapers.com
 *  main-view URL. They accept DOI directly and arXiv IDs via the
 *  same /main/<id>/Lookup path. Returns null when we have nothing
 *  to send them. */
function connectedPapersUrl(ref: string | null): string | null {
  if (!ref) return null;
  // ARXIV:2401.12345 → main/arxiv:2401.12345/Lookup
  const arxivMatch = ref.match(/^ARXIV:(.+)$/i);
  if (arxivMatch) return `https://www.connectedpapers.com/main/arxiv:${encodeURIComponent(arxivMatch[1])}/Lookup`;
  // DOI:10.x/y → main/<doi>/Lookup
  const doiMatch = ref.match(/^DOI:(.+)$/i);
  if (doiMatch) return `https://www.connectedpapers.com/main/${encodeURIComponent(doiMatch[1])}/Lookup`;
  return null;
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
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

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
        const params = new URLSearchParams({ limit: '40' });
        if (seedRef) params.set('ref', seedRef);
        if (seedTitle) params.set('title', seedTitle);
        const r = await fetch(`/api/related-papers?${params.toString()}`);
        const j = (await r.json()) as { papers?: Paper[]; error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error || `Recommendations: ${r.status}`);
        setPapers(j.papers || []);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [seedRef, seedTitle]);

  const filtered = useMemo(() => {
    if (!papers) return [];
    const Q = q.trim().toLowerCase();
    if (!Q) return papers;
    return papers.filter((p) => {
      const t = (p.title || '').toLowerCase();
      const a = (p.authors || []).map((x) => x.name || '').join(' ').toLowerCase();
      const v = (p.venue || '').toLowerCase();
      return t.includes(Q) || a.includes(Q) || v.includes(Q);
    });
  }, [papers, q]);

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
      setAdded((s) => new Set(s).add(key));
      return true;
    } catch (e) {
      notify.error(`${p.title}: ${(e as Error).message}`);
      return false;
    } finally {
      setAdding((s) => { const next = new Set(s); next.delete(key); return next; });
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
        href={`/s/${encodeURIComponent(sectionSlug)}?row=${encodeURIComponent(rowId)}`}
        className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="h-3 w-3" /> Back to {sectionSlug}
      </Link>

      <header className="mb-4 flex items-start gap-3">
        <Network className="mt-1 h-5 w-5 shrink-0 text-zinc-500" />
        <div className="flex-1">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Related papers</div>
          <h1 className="mt-0.5 text-lg font-semibold leading-tight">{seedTitle}</h1>
          {(seedAuthors || seedYear) && (
            <p className="mt-0.5 text-xs text-zinc-500">
              {seedAuthors}{seedAuthors && seedYear ? ' · ' : ''}{seedYear}
            </p>
          )}
        </div>
        {connectedPapersUrl(seedRef) && (
          <a
            href={connectedPapersUrl(seedRef)!}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            title="Open the same paper on connectedpapers.com"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in Connected Papers
          </a>
        )}
      </header>

      {/* Connected Papers graph visualisation. Their /main/<id>/
        * route is iframe-friendly; this gives the user the same
        * 2D graph they recognise from connectedpapers.com without
        * leaving Minerva. Falls back gracefully when we can't
        * resolve an arXiv ID / DOI to pass to them. */}
      {connectedPapersUrl(seedRef) && (
        <div className="mb-6 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <iframe
            src={connectedPapersUrl(seedRef)!}
            title="Connected Papers graph"
            className="h-[60vh] w-full bg-white dark:bg-zinc-950"
            referrerPolicy="no-referrer"
          />
        </div>
      )}

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
        <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {papers.length === 0
            ? 'No related papers came back for this seed. Semantic Scholar may not index it yet.'
            : `No matches for "${q}".`}
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {filtered.map((p) => {
          const key = paperKey(p);
          const url = paperUrl(p);
          const isAdded = added.has(key);
          const isBusy = adding.has(key);
          const authors = (p.authors || []).map((a) => a.name || '').filter(Boolean).join(', ');
          return (
            <li
              key={key || (p.paperId ?? Math.random().toString(36))}
              className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener"
                      className="text-sm font-medium hover:underline"
                    >
                      {p.title || '(untitled)'}
                    </a>
                  ) : (
                    <span className="text-sm font-medium">{p.title || '(untitled)'}</span>
                  )}
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
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
