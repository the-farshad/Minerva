'use client';

/**
 * "Search & add" modal for the Papers preset. Uses /lit's
 * multi-source search (Semantic Scholar primary, OpenAlex fallback)
 * via /api/papers/search and lets the user pick a result to land
 * it in the current section as a new row.
 *
 * Bridges /lit's discovery flow into the authenticated /papers
 * library without leaving the section page.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search, X, Loader2, Plus, Check } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

type Author = { name?: string };
type Paper = {
  paperId?: string;
  title?: string;
  authors?: Author[] | string;
  year?: string | number;
  venue?: string;
  citationCount?: number;
  externalIds?: { DOI?: string; ArXiv?: string };
  abstract?: string;
};

function authorsOf(p: Paper): string {
  if (typeof p.authors === 'string') return p.authors;
  return (p.authors || []).map((a) => a.name).filter(Boolean).join(', ');
}

function rowDataFromPaper(p: Paper): Record<string, unknown> {
  const doi = p.externalIds?.DOI || '';
  const arxiv = p.externalIds?.ArXiv || '';
  const url = doi
    ? `https://doi.org/${doi}`
    : arxiv
      ? `https://arxiv.org/abs/${arxiv}`
      : '';
  return {
    title: p.title || '',
    authors: authorsOf(p),
    year: p.year != null ? String(p.year) : '',
    venue: p.venue || '',
    doi,
    arxiv,
    url,
    citationCount: p.citationCount,
    abstract: p.abstract || '',
  };
}

export function PaperSearchModal({
  sectionSlug,
  trigger,
  onAdded,
}: {
  sectionSlug: string;
  trigger: React.ReactNode;
  /** Local-state callback so the section-view can prepend the
   *  freshly-added row without waiting for the SSE round-trip. */
  onAdded?: (row: { id: string; data: Record<string, unknown>; updatedAt?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Paper[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (q.trim().length < 2) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/papers/search?q=${encodeURIComponent(q.trim())}&limit=20`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`search: ${r.status}`);
        const j = (await r.json()) as { papers?: Paper[] };
        setResults(j.papers || []);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') notify.error((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  // Focus the input when the dialog opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else { setAdding(null); setAdded(new Set()); }
  }, [open]);

  async function addPaper(p: Paper) {
    const key = p.paperId || p.externalIds?.DOI || p.externalIds?.ArXiv || p.title || '';
    if (!key) return;
    setAdding(key);
    try {
      const data = rowDataFromPaper(p);
      const r = await fetch(`/api/sections/${sectionSlug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; data?: Record<string, unknown>; updatedAt?: string; error?: string };
      if (!r.ok) throw new Error(j.error || `add: ${r.status}`);
      if (j.id && j.data && onAdded) {
        onAdded({ id: j.id, data: j.data, updatedAt: j.updatedAt });
      }
      setAdded((prev) => new Set(prev).add(key));
      toast.success(`Added "${p.title || 'paper'}" to library.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                <Search className="h-4 w-4" /> Search papers
              </Dialog.Title>
              <p className="mt-0.5 text-xs text-zinc-500">
                Semantic Scholar + OpenAlex. Pick a result to add it to this section.
              </p>
            </div>
            <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <label className="relative mb-3 block">
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Title keywords, "quoted phrase", boolean AND / OR / NOT…'
              className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
              spellCheck={false}
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" />
            )}
          </label>

          <div className="-mx-1 flex-1 overflow-y-auto px-1">
            {q.trim().length < 2 ? (
              <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                Type at least two characters to start searching.
              </p>
            ) : results.length === 0 && !searching ? (
              <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                No results.
              </p>
            ) : (
              <ul className="space-y-2">
                {results.map((p) => {
                  const key = p.paperId || p.externalIds?.DOI || p.externalIds?.ArXiv || p.title || '';
                  const isAdded = added.has(key);
                  const isAdding = adding === key;
                  return (
                    <li
                      key={key}
                      className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium">{p.title || '(untitled)'}</span>
                        {p.year != null && <span className="text-xs text-zinc-500">{String(p.year)}</span>}
                        {typeof p.citationCount === 'number' && p.citationCount > 0 && (
                          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            {p.citationCount >= 1000 ? `${(p.citationCount / 1000).toFixed(p.citationCount >= 10_000 ? 0 : 1)}k` : p.citationCount} cites
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void addPaper(p)}
                          disabled={isAdding || isAdded}
                          className={`ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition disabled:opacity-50 ${
                            isAdded
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200'
                          }`}
                        >
                          {isAdded
                            ? <><Check className="h-3 w-3" /> Added</>
                            : isAdding
                              ? <><Loader2 className="h-3 w-3 animate-spin" /> Adding…</>
                              : <><Plus className="h-3 w-3" /> Add</>}
                        </button>
                      </div>
                      {authorsOf(p) && (
                        <p className="mt-0.5 truncate text-xs text-zinc-500">{authorsOf(p)}</p>
                      )}
                      {p.venue && <p className="text-[11px] text-zinc-400">{p.venue}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
