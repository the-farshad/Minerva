'use client';

/**
 * Citation-path finder. Two paper inputs (DOI or arXiv id on each
 * side) → BFS through OpenAlex's referenced_works graph → shortest
 * chain of citations connecting them. Inciteful-style.
 *
 * From and To live in the URL as ?from=...&to=... so a discovered
 * path is shareable.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ArrowRight, ExternalLink } from 'lucide-react';

type Paper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: { name?: string }[];
  year?: number;
  citationCount?: number;
};

function normalizeRef(raw: string): string {
  const q = raw.trim();
  if (!q) return '';
  if (/^DOI:|^ARXIV:/i.test(q)) return q.toUpperCase().replace(/^(DOI|ARXIV):/i, (m) => m.toUpperCase());
  // Strip a doi.org / arxiv.org URL down to its identifier.
  const doiInUrl = q.match(/(?:doi\.org\/)(10\.\d{4,9}\/\S+)/i)?.[1];
  if (doiInUrl) return `DOI:${doiInUrl}`;
  const arxivInUrl = q.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1];
  if (arxivInUrl) return `ARXIV:${arxivInUrl}`;
  if (/^10\.\d{4,9}\/\S+$/.test(q)) return `DOI:${q}`;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(q)) return `ARXIV:${q.replace(/v\d+$/, '')}`;
  return q;
}

function paperUrl(p: Paper): string | null {
  const doi = p.externalIds?.DOI;
  if (doi) return `https://doi.org/${doi}`;
  const arxiv = p.externalIds?.ArXiv;
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  return null;
}

function PathCard({ p }: { p: Paper }) {
  const link = paperUrl(p);
  const authors = (p.authors || []).map((a) => a.name).filter(Boolean).slice(0, 3).join(', ');
  const more = (p.authors || []).length - 3;
  return (
    <div className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {link ? (
          <a href={link} target="_blank" rel="noopener" className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
            {p.title || '(untitled)'}
          </a>
        ) : (
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{p.title || '(untitled)'}</span>
        )}
        {p.year && <span className="text-xs text-zinc-500">{p.year}</span>}
        {typeof p.citationCount === 'number' && p.citationCount > 0 && (
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {p.citationCount >= 1000 ? `${(p.citationCount / 1000).toFixed(p.citationCount >= 10_000 ? 0 : 1)}k` : p.citationCount}
          </span>
        )}
      </div>
      {authors && (
        <div className="mt-0.5 truncate text-xs text-zinc-500">
          {authors}{more > 0 ? ` + ${more} more` : ''}
        </div>
      )}
    </div>
  );
}

export function PathView() {
  const router = useRouter();
  const sp = useSearchParams();
  const [fromInput, setFromInput] = useState(sp.get('from') || '');
  const [toInput, setToInput] = useState(sp.get('to') || '');
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState<Paper[] | null>(null);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  async function findPath(rawFrom: string, rawTo: string) {
    const from = normalizeRef(rawFrom);
    const to = normalizeRef(rawTo);
    if (!from || !to) return;
    setLoading(true);
    setErr(''); setInfo(''); setPath(null);
    try {
      const r = await fetch(`/api/papers/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&maxDepth=4`);
      const j = (await r.json().catch(() => ({}))) as { path?: Paper[]; hops?: number; reason?: string; error?: string };
      if (!r.ok) {
        setErr(j.error || `path: ${r.status}`);
      } else if (!j.path || j.path.length === 0) {
        setInfo(j.reason || 'No citation path found within depth 4.');
      } else {
        setPath(j.path);
        setInfo(`Found in ${j.hops} hop${j.hops === 1 ? '' : 's'}.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Auto-run if both params are present on first mount, so a
  // shared URL renders the path on load.
  useEffect(() => {
    const f = sp.get('from'); const t = sp.get('to');
    if (f && t) void findPath(f, t);
    // Intentional: this should only run once on initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (fromInput.trim()) params.set('from', normalizeRef(fromInput));
    if (toInput.trim()) params.set('to', normalizeRef(toInput));
    router.push(`/lit/path?${params.toString()}`);
    void findPath(fromInput, toInput);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6">
      <header className="mb-6">
        <Link href="/lit" className="text-xs text-zinc-500 hover:underline">← back to /lit</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Citation path</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Find the shortest chain of citations between two papers. BFS over
          OpenAlex&apos;s reference graph, max 4 hops.
        </p>
      </header>

      <form onSubmit={onSubmit} className="mb-6 space-y-2">
        <input
          type="text"
          value={fromInput}
          onChange={(e) => setFromInput(e.target.value)}
          placeholder="From — DOI, arXiv ID, or URL"
          className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          type="text"
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          placeholder="To — DOI, arXiv ID, or URL"
          className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={loading || !fromInput.trim() || !toInput.trim()}
          className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
        >
          {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching</> : 'Find path'}
        </button>
      </form>

      {err && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </div>
      )}
      {info && !err && (
        <p className="mb-3 text-xs text-zinc-500">{info}</p>
      )}

      {path && path.length > 0 && (
        <div className="space-y-2">
          {path.map((p, i) => (
            <div key={`${i}-${p.paperId ?? p.title}`}>
              <PathCard p={p} />
              {i < path.length - 1 && (
                <div className="my-1 flex items-center justify-center text-zinc-400">
                  <ArrowRight className="h-4 w-4" />
                  <span className="ml-1 text-[11px]">cites</span>
                </div>
              )}
            </div>
          ))}
          <p className="mt-3 text-[11px] text-zinc-500">
            <ExternalLink className="mr-1 inline h-3 w-3" />
            Each card links to the paper&apos;s DOI or arXiv landing page. Direction
            is newer → older (each paper cites the next).
          </p>
        </div>
      )}

      <footer className="mt-auto pt-12 text-center text-xs text-zinc-400">
        <Link href="/lit" className="hover:underline">← back to /lit</Link>
      </footer>
    </main>
  );
}
