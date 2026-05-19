'use client';

/**
 * Share-with-user dialog. Username autocomplete (debounced) →
 * recipient chips → mode (view / edit) → POST /api/shares.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Share2, X, Check, Loader2, AtSign, Link2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

type Found = { id: string; username: string | null; name: string | null; image: string | null };
type ExistingRecipient = {
  id: string;
  shareId: string;
  username: string | null;
  mode: 'view' | 'edit';
  acceptedAt: string | null;
  declinedAt: string | null;
};

export function ShareDialog({
  scope,
  targetId,
  targetTitle,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  scope: 'section' | 'group' | 'row';
  targetId: string;
  targetTitle: string;
  trigger?: React.ReactNode;
  /** Controlled-mode props. When omitted, the dialog manages its
   *  own state via the trigger node. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setOpenLocal(next);
  };
  const [tab, setTab] = useState<'people' | 'link'>('people');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found[]>([]);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  /** Phase-4 opt-in: when checked the recipient sees the owner's
   *  watch progress on every shared row. Defaults false so a
   *  brand-new share doesn't leak progress without consent. */
  const [shareProgress, setShareProgress] = useState(false);
  // Existing shares for this exact target — loaded on dialog open
  // and on share.received. Rendered above the picker with inline
  // Unshare so the user doesn't have to leave the dialog (or visit
  // /shares) to remove a previously-shared user.
  const [existing, setExisting] = useState<ExistingRecipient[]>([]);
  const [refreshExistingTick, setRefreshExistingTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/shares?direction=outgoing', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { shares: { id: string; scope: string; targetId: string; revokedAt: string | null; recipients: ExistingRecipient[] }[] };
        const matches = (j.shares || []).filter((s) => s.scope === scope && s.targetId === targetId && !s.revokedAt);
        const list: ExistingRecipient[] = [];
        for (const s of matches) {
          for (const r of (s.recipients || [])) {
            if (!r.declinedAt) list.push({ ...r, shareId: s.id });
          }
        }
        if (!cancelled) setExisting(list);
      } catch { /* tolerate */ }
    }
    void load();
    return () => { cancelled = true; };
  }, [open, scope, targetId, refreshExistingTick]);

  async function unshare(shareId: string, recipientId: string) {
    try {
      const r = await fetch(`/api/shares/${shareId}/recipients/${recipientId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`unshare: ${r.status}`);
      toast.success('Recipient removed.');
      setRefreshExistingTick((n) => n + 1);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  /** Once a public link is generated for this scope+target this
   *  open lifetime, remember it so the user can copy it again
   *  without re-creating a fresh token. */
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

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
          shareProgress,
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
      setPicked([]); setQ(''); setResults([]); setMode('view'); setShareProgress(false);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function generatePublicLink() {
    setBusy(true);
    try {
      const r = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, targetId, mode: 'view', publicLink: true }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; publicUrl?: string };
      if (!r.ok || !j.publicUrl) throw new Error(j.error || `link: ${r.status}`);
      setPublicUrl(j.publicUrl);
      toast.success('Public link created.');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPublicLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Link copied.');
    } catch {
      notify.error('Clipboard blocked — long-press the field to copy manually.');
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
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

          {/* People / Public link tabs */}
          <div className="mb-3 flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900 w-fit">
            <button
              type="button"
              onClick={() => setTab('people')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition ${
                tab === 'people'
                  ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              <AtSign className="h-3 w-3" /> People
            </button>
            <button
              type="button"
              onClick={() => setTab('link')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition ${
                tab === 'link'
                  ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              <Link2 className="h-3 w-3" /> Public link
            </button>
          </div>

          {/* Existing recipients for this target — always shown
            *  (in either tab) so 'Unshare' is reachable without
            *  leaving the dialog. */}
          {existing.length > 0 && (
            <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 dark:border-emerald-900 dark:bg-emerald-950/20">
              <p className="mb-1.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Already shared with
              </p>
              <ul className="flex flex-wrap items-center gap-1.5">
                {existing.map((r) => (
                  <li
                    key={r.id}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] dark:bg-zinc-900"
                  >
                    <AtSign className="h-3 w-3 text-zinc-500" />
                    {r.username ?? '(link)'}
                    <span className="text-[10px] text-zinc-500">· {r.mode}</span>
                    {!r.acceptedAt && <span className="text-[10px] text-amber-600 dark:text-amber-400">pending</span>}
                    <button
                      type="button"
                      onClick={() => void unshare(r.shareId, r.id)}
                      title={`Unshare from ${r.username ? '@' + r.username : 'this link'}`}
                      className="rounded-full p-0.5 text-red-500 hover:bg-red-100 dark:hover:bg-red-950/40"
                      aria-label="Unshare"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'link' ? (
            <div className="space-y-3">
              <p className="text-xs text-zinc-500">
                Anyone with the link can view this {scope} — read-only, no sign-in required. You can revoke it any time from the Shares page.
              </p>
              {publicUrl ? (
                <div className="flex items-stretch gap-2">
                  <input
                    type="text"
                    value={publicUrl}
                    readOnly
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className="flex-1 rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <button
                    type="button"
                    onClick={() => void copyPublicLink()}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void generatePublicLink()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                  Generate public link
                </button>
              )}
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
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
          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={shareProgress}
              onChange={(e) => setShareProgress(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
            />
            <span>
              Share my watch progress
              <span className="ml-1 text-zinc-500">— recipient sees how far you&apos;ve watched each item.</span>
            </span>
          </label>

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
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
