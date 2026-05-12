'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Copy, Plus, Trash2, ExternalLink, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { appConfirm } from '@/components/confirm';

/**
 * Organizer's index page — every poll the signed-in user has
 * created, with a share-link copy + delete affordance and quick
 * stats. Doubles as the natural landing surface when the side-nav
 * "Meeting polls" entry is clicked.
 */

type PollSummary = {
  token: string;
  title: string;
  days: string[];
  slots: { fromHour: number; toHour: number; slotMin: number; tz: string };
  closesAt: string | null;
  location: string;
  finalSlot: string | null;
  mode: 'group' | 'book';
  kind: 'meeting' | 'yesno' | 'ranked';
  responseCount: number;
  createdAt: string;
};

function KindBadge({ kind, mode }: { kind: 'meeting' | 'yesno' | 'ranked'; mode: 'group' | 'book' }) {
  const label =
    kind === 'yesno'  ? 'yes / no'      :
    kind === 'ranked' ? 'ranked'        :
    mode === 'book'   ? '1-to-1 booking':
                        'group';
  const tone =
    kind === 'yesno'  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'   :
    kind === 'ranked' ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300' :
                        'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>{label}</span>
  );
}

function PollSubline({ poll }: { poll: PollSummary }) {
  const kind = poll.kind || 'meeting';
  const respLabel = `${poll.responseCount} response${poll.responseCount === 1 ? '' : 's'}`;
  if (kind === 'yesno') {
    return <>
      <span className="line-clamp-1 break-all">{poll.days[0] || '(no question)'}</span>
      <span> · {respLabel}</span>
      {poll.location && <><span> · </span><span className="break-all">{poll.location}</span></>}
    </>;
  }
  if (kind === 'ranked') {
    return <>
      <span>{poll.days.length} options</span>
      <span> · {respLabel}</span>
      {poll.location && <><span> · </span><span className="break-all">{poll.location}</span></>}
    </>;
  }
  return <>
    {fmtDaysRange(poll.days)} · {poll.slots.fromHour}:00–{poll.slots.toHour}:00 · {poll.slots.slotMin} min · {respLabel}
    {poll.location && <><span> · </span><span className="break-all">{poll.location}</span></>}
  </>;
}

function fmtDaysRange(days: string[]): string {
  if (days.length === 0) return '';
  if (days.length === 1) return new Date(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const first = new Date(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const last = new Date(days[days.length - 1]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${first} → ${last} · ${days.length} days`;
}

export default function PollsIndex() {
  const [polls, setPolls] = useState<PollSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/polls');
      if (!r.ok) {
        if (r.status === 401) { window.location.href = '/sign-in'; return; }
        throw new Error(String(r.status));
      }
      const j = await r.json() as { polls: PollSummary[] };
      setPolls(j.polls);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);

  async function deletePoll(p: PollSummary) {
    const ok = await appConfirm(`Delete "${p.title}"?`, {
      body: 'The share link stops working and every response is dropped. Cannot be undone.',
      dangerLabel: 'Delete',
    });
    if (!ok) return;
    setBusyDelete(p.token);
    try {
      const r = await fetch(`/api/polls/${encodeURIComponent(p.token)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(String(r.status));
      setPolls((cur) => (cur || []).filter((x) => x.token !== p.token));
      toast.success('Deleted.');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusyDelete(null);
    }
  }

  function copyLink(p: PollSummary) {
    const url = `${window.location.origin}/meet/${p.token}`;
    try { void navigator.clipboard.writeText(url); toast.success('Share link copied.'); } catch { /* tolerate */ }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-center gap-3">
        <CalendarDays className="h-5 w-5" />
        <h1 className="text-lg font-semibold">Polls</h1>
        <Link
          href="/meet/new"
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          <Plus className="h-3 w-3" /> New poll
        </Link>
      </header>

      {err && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
          {err}
        </div>
      )}
      {!err && polls === null && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {polls && polls.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No polls yet. <Link href="/meet/new" className="font-medium underline">Create the first one</Link>.
        </div>
      )}
      {polls && polls.length > 0 && (
        <ul className="space-y-2">
          {polls.map((p) => (
            <li
              key={p.token}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/meet/${p.token}`} className="truncate text-sm font-medium hover:underline">{p.title}</Link>
                  <KindBadge kind={p.kind || 'meeting'} mode={p.mode} />
                  {p.finalSlot && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> Finalized
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  <PollSubline poll={p} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => copyLink(p)}
                title="Copy share link"
                className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <Link
                href={`/meet/${p.token}`}
                title="Open poll"
                className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              <button
                type="button"
                onClick={() => deletePoll(p)}
                disabled={busyDelete === p.token}
                title="Delete poll"
                className="rounded-full p-1.5 text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
