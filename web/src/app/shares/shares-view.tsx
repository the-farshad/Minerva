'use client';

/**
 * Sharing inbox / outbox. Lists every incoming share (with Accept /
 * Decline) and every outgoing share (with Revoke). Live-updates
 * via the share.received SSE event so an accept on one tab clears
 * the pending badge on every other tab without a refresh.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox, Outdent, Check, X, Trash2, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

type IncomingShare = {
  recipientId: string;
  shareId: string;
  scope: string;
  targetId: string;
  targetTitle: string | null;
  mode: 'view' | 'edit';
  acceptedAt: string | null;
  declinedAt: string | null;
  createdAt: string;
  ownerId: string;
  ownerUsername: string | null;
  ownerName: string | null;
};

type OutgoingShare = {
  id: string;
  scope: string;
  targetId: string;
  targetTitle: string | null;
  mode: 'view' | 'edit';
  createdAt: string;
  revokedAt: string | null;
  recipients: {
    id: string;
    shareId: string;
    userId: string | null;
    username: string | null;
    mode: 'view' | 'edit';
    acceptedAt: string | null;
    declinedAt: string | null;
    shareProgress: boolean;
    recipientShareProgress: boolean;
  }[];
};

export function SharesView() {
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');
  const [incoming, setIncoming] = useState<IncomingShare[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingShare[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadIncoming() {
    const r = await fetch('/api/shares?direction=incoming', { cache: 'no-store' });
    const j = (await r.json()) as { shares: IncomingShare[] };
    setIncoming(j.shares || []);
  }
  async function loadOutgoing() {
    const r = await fetch('/api/shares?direction=outgoing', { cache: 'no-store' });
    const j = (await r.json()) as { shares: OutgoingShare[] };
    setOutgoing(j.shares || []);
  }

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([loadIncoming(), loadOutgoing()]);
      } catch (e) {
        notify.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Live updates via SSE — the share.received event covers create /
  // accept / decline / revoke on either side.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/sse');
    const refresh = () => { void loadIncoming(); void loadOutgoing(); };
    es.addEventListener('share.received', refresh);
    return () => { es.close(); };
  }, []);

  async function act(recId: string, action: 'accept' | 'decline') {
    try {
      const r = await fetch(`/api/shares/recipients/${recId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error(`${action}: ${r.status}`);
      toast.success(action === 'accept' ? 'Share accepted.' : 'Share declined.');
      await loadIncoming();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function revoke(shareId: string) {
    if (!confirm('Revoke this share? Recipients lose access immediately.')) return;
    try {
      const r = await fetch(`/api/shares/${shareId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`revoke: ${r.status}`);
      toast.success('Share revoked.');
      await loadOutgoing();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function revokeRecipient(shareId: string, recipientId: string) {
    try {
      const r = await fetch(`/api/shares/${shareId}/recipients/${recipientId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`revoke-recipient: ${r.status}`);
      toast.success('Recipient removed from this share.');
      await loadOutgoing();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  const pendingIn = incoming.filter((s) => !s.acceptedAt && !s.declinedAt).length;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <Link href="/" className="text-xs text-zinc-500 hover:underline">← back home</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Shares</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Things other users have shared with you and things you&apos;ve shared out. Pick a username from the section header to start a new share.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900 w-fit">
        <button
          type="button"
          onClick={() => setTab('incoming')}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
            tab === 'incoming'
              ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          <Inbox className="h-3.5 w-3.5" /> Incoming
          {pendingIn > 0 && (
            <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-white">{pendingIn}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab('outgoing')}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
            tab === 'outgoing'
              ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          <Outdent className="h-3.5 w-3.5" /> Outgoing
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : tab === 'incoming' ? (
        incoming.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nothing shared with you yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {incoming.map((s) => (
              <li key={s.recipientId} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">
                    {s.targetTitle ?? `(${s.scope} ${s.targetId.slice(0, 8)})`}
                  </span>
                  <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {s.mode}
                  </span>
                  <span className="text-xs text-zinc-500">
                    from {s.ownerUsername ? <>@{s.ownerUsername}</> : (s.ownerName || 'a user')}
                  </span>
                  <span className="ml-auto text-[11px] text-zinc-400">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {s.acceptedAt ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="h-3.5 w-3.5" /> Accepted
                      </span>
                      <Link
                        href={`/shared-with-me/${s.recipientId}`}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        View
                      </Link>
                      <button
                        type="button"
                        onClick={() => void act(s.recipientId, 'decline')}
                        className="ml-auto rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Decline now
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void act(s.recipientId, 'accept')}
                        className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-zinc-900"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => void act(s.recipientId, 'decline')}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Decline
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : outgoing.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          You haven&apos;t shared anything yet. Open a section, then use the Share button in the header.
        </p>
      ) : (
        <ul className="space-y-2">
          {outgoing.map((s) => (
            <li key={s.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium">
                  {s.targetTitle ?? `(${s.scope} ${s.targetId.slice(0, 8)})`}
                </span>
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {s.mode}
                </span>
                <span className="ml-auto text-[11px] text-zinc-400">
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </div>
              <ul className="mt-2 flex flex-wrap items-center gap-1.5">
                {s.recipients.map((r) => (
                  <li
                    key={r.id}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                      r.acceptedAt
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : r.declinedAt
                          ? 'bg-rose-100 text-rose-700 line-through dark:bg-rose-900/40 dark:text-rose-300'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {r.username ? `@${r.username}` : '(link)'}
                    {r.recipientShareProgress && (
                      <span title="This recipient is sharing their progress back to you" className="ml-0.5 text-blue-600 dark:text-blue-400">↕</span>
                    )}
                    {r.shareProgress && (
                      <span title="You are sharing your progress with this recipient" className="ml-0.5 text-zinc-500 dark:text-zinc-400">→</span>
                    )}
                    {/* Per-recipient revoke — drops just this user
                      *  without tearing down the whole share. */}
                    <button
                      type="button"
                      onClick={() => void revokeRecipient(s.id, r.id)}
                      title={`Remove ${r.username ? '@' + r.username : 'this link'} from this share`}
                      className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/20"
                      aria-label="Revoke recipient"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => void revoke(s.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-3 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke share
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-12 text-center text-xs text-zinc-400">
        <Link href="/settings" className="hover:underline">
          <ExternalLink className="mr-1 inline h-3 w-3" />
          Manage your username in Settings
        </Link>
      </footer>
    </main>
  );
}
