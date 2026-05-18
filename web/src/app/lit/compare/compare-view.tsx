'use client';

/**
 * Side-by-side comparison of pinned papers. Pins live in
 * localStorage (see ./pinned.ts) so the user can drop into the
 * Compare view from anywhere in /lit and find every paper they
 * starred. Up to 6 pins.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Star, Trash2 } from 'lucide-react';
import { getPinned, unpin, clearPinned, type PinnedPaper } from '../pinned';

function authorsOf(p: PinnedPaper): string {
  if (typeof p.authors === 'string') return p.authors;
  return (p.authors || []).map((a) => a.name).filter(Boolean).join(', ');
}

function paperUrl(p: PinnedPaper): string | null {
  if (p.openAccessPdf?.url) return p.openAccessPdf.url;
  if (p.pdf) return p.pdf;
  if (p.url) return p.url;
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) return `https://doi.org/${doi}`;
  const arxiv = p.arxiv || p.externalIds?.ArXiv;
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  return null;
}

export function CompareView() {
  const [papers, setPapers] = useState<PinnedPaper[]>([]);
  useEffect(() => {
    setPapers(getPinned());
    function onStorage() { setPapers(getPinned()); }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-10 sm:px-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link href="/lit" className="text-xs text-zinc-500 hover:underline">← back to /lit</Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Compare</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {papers.length === 0
              ? 'Pin papers from any result list by clicking the star on a card. Up to 6 pins, stored on this device.'
              : `${papers.length} pinned paper${papers.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        {papers.length > 0 && (
          <button
            type="button"
            onClick={() => { clearPinned(); setPapers([]); }}
            title="Remove every pin"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear all
          </button>
        )}
      </header>

      {papers.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          <Star className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
          <p>No pinned papers yet.</p>
          <Link href="/lit" className="mt-3 inline-block text-zinc-600 hover:underline dark:text-zinc-300">
            Start exploring →
          </Link>
        </div>
      ) : (
        <div className="grid auto-rows-min gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {papers.map((p) => {
            const link = paperUrl(p);
            const authors = authorsOf(p);
            const doi = p.doi || p.externalIds?.DOI;
            const arxiv = p.arxiv || p.externalIds?.ArXiv;
            return (
              <article
                key={(doi || arxiv || p.title || '') + '-' + (p.pinnedAt || '')}
                className="flex flex-col rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                    {link ? (
                      <a href={link} target="_blank" rel="noopener" className="hover:underline">
                        {p.title || '(untitled)'}
                      </a>
                    ) : (
                      p.title || '(untitled)'
                    )}
                  </h2>
                  <button
                    type="button"
                    title="Unpin"
                    onClick={() => { unpin(p); setPapers(getPinned()); }}
                    className="shrink-0 rounded-full p-1 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                  >
                    <Star className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-zinc-500">Year</dt>
                  <dd className="col-span-2 text-zinc-700 dark:text-zinc-300">{p.year ?? '—'}</dd>
                  <dt className="text-zinc-500">Cites</dt>
                  <dd className="col-span-2 text-zinc-700 dark:text-zinc-300">
                    {typeof p.citationCount === 'number' ? p.citationCount.toLocaleString() : '—'}
                  </dd>
                  {typeof p.influentialCitationCount === 'number' && p.influentialCitationCount > 0 && (
                    <>
                      <dt className="text-zinc-500">Influential</dt>
                      <dd className="col-span-2 text-zinc-700 dark:text-zinc-300">
                        {p.influentialCitationCount.toLocaleString()}
                      </dd>
                    </>
                  )}
                  {p.venue && (
                    <>
                      <dt className="text-zinc-500">Venue</dt>
                      <dd className="col-span-2 truncate text-zinc-700 dark:text-zinc-300" title={p.venue}>{p.venue}</dd>
                    </>
                  )}
                  {authors && (
                    <>
                      <dt className="text-zinc-500">Authors</dt>
                      <dd className="col-span-2 line-clamp-2 text-zinc-700 dark:text-zinc-300">{authors}</dd>
                    </>
                  )}
                  {doi && (
                    <>
                      <dt className="text-zinc-500">DOI</dt>
                      <dd className="col-span-2 truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-400" title={doi}>{doi}</dd>
                    </>
                  )}
                  {arxiv && !doi && (
                    <>
                      <dt className="text-zinc-500">arXiv</dt>
                      <dd className="col-span-2 truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-400">{arxiv}</dd>
                    </>
                  )}
                </dl>
                {p.abstract && (
                  <p className="mt-3 line-clamp-6 whitespace-pre-line text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {p.abstract}
                  </p>
                )}
                {link && (
                  <a
                    href={link} target="_blank" rel="noopener"
                    className="mt-auto inline-flex items-center gap-1 pt-3 text-[11px] text-zinc-500 hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <ExternalLink className="h-3 w-3" /> Open paper
                  </a>
                )}
              </article>
            );
          })}
        </div>
      )}

      <footer className="mt-12 pt-6 text-center text-xs text-zinc-400">
        <Link href="/lit" className="hover:underline">← back to /lit</Link>
      </footer>
    </main>
  );
}
