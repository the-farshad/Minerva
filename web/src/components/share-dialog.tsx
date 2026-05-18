'use client';

/**
 * Share-with-user dialog. Username autocomplete (debounced) →
 * recipient chips → mode (view / edit) → POST /api/shares.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Share2, X, Check, Loader2, AtSign } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

type Found = { id: string; username: string | null; name: string | null; image: string | null };

export function ShareDialog({
  scope,
  targetId,
  targetTitle,
  trigger,
}: {
  scope: 'section' | 'row';
  targetId: string;
  targetTitle: string;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found[]>([]);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);

  // Debounced username search.
  useEffect(() => {
    if (!open) return;
    if (q.trim().length < 2) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/users/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`search: ${r.status}`);
        const j = (await r.json()) as { results: Found[] };
        setResults(j.results || []);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') notify.error((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  function pick(u: Found) {
    if (picked.some((p) => p.id === u.id)) return;
    setPicked((arr) => [...arr, u]);
    setQ(''); setResults([]);
  }
  function unpick(id: string) {
    setPicked((arr) => arr.filter((p) => p.id !== id));
  }

  async function submit() {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          targetId,
          mode,
          usernames: picked.map((p) => p.username).filter(Boolean),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; recipients?: unknown[]; missing?: string[] };
      if (!r.ok) throw new Error(j.error || `share: ${r.status}`);
      const n = (j.recipients || []).length;
      toast.success(`Shared with ${n} ${n === 1 ? 'person' : 'people'}.`);
      if ((j.missing || []).length) {
        notify.error(`Username(s) not found or hidden: ${j.missing!.join(', ')}`);
      }
      setOpen(false);
      setPicked([]); setQ(''); setResults([]); setMode('view');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                <Share2 className="h-4 w-4" /> Share
              </Dialog.Title>
              <p className="mt-0.5 truncate text-xs text-zinc-500">{targetTitle}</p>
            </div>
            <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Picked chips */}
          {picked.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                  <AtSign className="h-3 w-3 text-zinc-500" />
                  {p.username}
                  <button
                    type="button"
                    onClick={() => unpick(p.id)}
                    className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="relative block">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by username…"
              className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" />
            )}
          </label>

          {/* Search results */}
          {q.trim().length >= 2 && (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              {results.length === 0 && !searching && (
                <li className="px-3 py-2 text-xs text-zinc-500">No matches. Users hidden from search won&apos;t appear here.</li>
              )}
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => pick(u)}
                    disabled={picked.some((p) => p.id === u.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-900"
                  >
                    <AtSign className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="font-medium">{u.username}</span>
                    {u.name && <span className="truncate text-xs text-zinc-500">{u.name}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Permission</span>
            <div className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {(['view', 'edit'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                    mode === m
                      ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                      : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                  }`}
                >
                  {m === 'view' ? 'View only' : 'Can edit'}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || picked.length === 0}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Share
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
