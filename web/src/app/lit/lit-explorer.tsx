'use client';

import { useState } from 'react';
import { Search, Loader2, ExternalLink } from 'lucide-react';

type Paper = {
  kind?: string;
  title?: string;
  authors?: string;
  year?: string | number;
  venue?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  abstract?: string;
  url?: string;
  pdf?: string;
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
};

function publicUrl(p: Paper): string {
  if (p.pdf && /^https?:\/\//i.test(p.pdf)) return p.pdf;
  if (p.url && /^https?:\/\//i.test(p.url)) return p.url;
  if (p.doi) return `https://doi.org/${p.doi}`;
  return '';
}

export function LitExplorer() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [err, setErr] = useState<string>('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setErr('');
    setPaper(null);
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

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <h1 className="text-3xl font-semibold tracking-tight">Literature</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Look up any paper by DOI, arXiv id, URL, or title. Free, stateless &mdash; nothing saved.
        </p>
      </header>

      <form onSubmit={onSubmit} className="mb-8">
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
        <article className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {publicUrl(paper) ? (
              <a
                href={publicUrl(paper)}
                target="_blank"
                rel="noopener"
                className="text-lg font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
              >
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
          {(paper.authors || paper.venue) && (
            <div className="mt-1 text-sm text-zinc-500">
              {paper.authors}
              {paper.authors && paper.venue ? ' · ' : ''}
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
              <a
                href={`https://doi.org/${paper.doi}`}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
              >
                <ExternalLink className="h-3 w-3" /> doi.org/{paper.doi}
              </a>
            )}
            {paper.pdf && publicUrl(paper) !== paper.pdf && (
              <a
                href={paper.pdf}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
              >
                <ExternalLink className="h-3 w-3" /> PDF
              </a>
            )}
            {paper.pmid && <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-800">PMID {paper.pmid}</span>}
            {paper.pmcid && <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-800">{paper.pmcid}</span>}
          </div>
          <p className="mt-4 text-[10px] text-zinc-400">
            Connected-graph view (references &amp; citing papers) is coming next.
          </p>
        </article>
      )}

      {!paper && !err && !loading && (
        <div className="rounded-md border border-dashed border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">What this is</p>
          <p className="mt-2">
            A literature explorer. Paste any paper reference above and it&rsquo;ll be resolved across
            arXiv, CrossRef, Europe PMC, and most publisher pages. Connected-paper graph and
            reference list are next on the way.
          </p>
        </div>
      )}

      <footer className="mt-12 text-center text-xs text-zinc-400">
        <a href="https://thefarshad.com" className="hover:underline">thefarshad.com</a>
      </footer>
    </main>
  );
}
