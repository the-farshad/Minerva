'use client';

import { useEffect, useMemo, useState, use } from 'react';
import { Loader2, Copy, Send, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { slotLabel, slotsPerDay, type Poll, type PollResponse, type PollSlots } from '@/lib/poll';

/**
 * Public participant view. Anyone with the URL can:
 *   - see the poll's days × slots grid
 *   - mark each cell as available / tentative / no
 *   - submit their availability with a display name
 *   - read everyone else's responses + the cell-level consensus
 *
 * The grid uses 1-bit-per-cell encoding: `1` available, `0` no,
 * `?` tentative. The string length always equals days × slots-per-day.
 */
type Cell = '0' | '1' | '?';

function cellNext(c: Cell): Cell {
  return c === '0' ? '1' : c === '1' ? '?' : '0';
}
function cellClass(c: Cell): string {
  if (c === '1') return 'bg-emerald-500 text-white';
  if (c === '?') return 'bg-amber-300 text-amber-900';
  return 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-600 dark:hover:bg-zinc-700';
}

export default function PollViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [poll, setPoll] = useState<Poll | null>(null);
  const [responses, setResponses] = useState<PollResponse[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cells, setCells] = useState<Cell[]>([]);

  async function load() {
    try {
      const r = await fetch(`/api/polls/${encodeURIComponent(token)}`);
      const j = (await r.json().catch(() => ({}))) as { poll?: Poll; responses?: PollResponse[]; error?: string };
      if (!r.ok || !j.poll) throw new Error(j.error || `load: ${r.status}`);
      setPoll(j.poll);
      setResponses(j.responses || []);
      const total = j.poll.days.length * slotsPerDay(j.poll.slots);
      setCells(Array.from({ length: total }, () => '0' as Cell));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const consensus = useMemo(() => {
    if (!poll) return [] as number[];
    const total = poll.days.length * slotsPerDay(poll.slots);
    const yes = Array.from({ length: total }, () => 0);
    for (const r of responses) {
      for (let i = 0; i < total && i < r.bits.length; i++) {
        if (r.bits[i] === '1') yes[i] += 1;
        else if (r.bits[i] === '?') yes[i] += 0.5;
      }
    }
    return yes;
  }, [responses, poll]);

  async function submit() {
    if (!poll) return;
    if (!name.trim()) { notify.error('Enter your name first.'); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/polls/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), bits: cells.join(''), note }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `submit: ${r.status}`);
      toast.success('Submitted — refresh to see your row alongside everyone else.');
      await load();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (err) {
    return (
      <main className="mx-auto max-w-md px-4 py-12 text-sm">
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
          {err}
        </div>
      </main>
    );
  }
  if (!poll) {
    return (
      <main className="mx-auto max-w-md px-4 py-12 text-sm">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    );
  }

  const slots = poll.slots as PollSlots;
  const perDay = slotsPerDay(slots);
  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/meet/${poll.token}` : '';
  const maxYes = consensus.length ? Math.max(...consensus) : 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Calendar className="h-5 w-5" />
        <h1 className="text-lg font-semibold">{poll.title}</h1>
        <span className="text-xs text-zinc-500">{slots.tz}</span>
        <button
          type="button"
          onClick={() => { try { void navigator.clipboard.writeText(shareUrl); toast.success('Share link copied.'); } catch { /* tolerate */ } }}
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Copy className="h-3.5 w-3.5" /> Copy share link
        </button>
      </header>

      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-zinc-500">time</th>
              {poll.days.map((d) => (
                <th key={d} className="px-2 py-1 font-medium">
                  {new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: perDay }, (_, slotIdx) => (
              <tr key={slotIdx}>
                <td className="px-2 py-1 text-zinc-500 font-mono">{slotLabel(slots, slotIdx)}</td>
                {poll.days.map((_d, dayIdx) => {
                  const i = dayIdx * perDay + slotIdx;
                  const c = cells[i] ?? '0';
                  const cons = consensus[i] || 0;
                  const heat = maxYes > 0 ? cons / maxYes : 0;
                  return (
                    <td key={dayIdx} className="px-0.5 py-0.5">
                      <button
                        type="button"
                        onClick={() => setCells((arr) => { const c2 = arr.slice(); c2[i] = cellNext(arr[i] as Cell); return c2; })}
                        className={`w-full rounded ${cellClass(c)} px-2 py-1.5 transition`}
                        title={`Cell ${slotLabel(slots, slotIdx)} · ${cons} ${cons === 1 ? 'person' : 'people'} available`}
                        style={c === '0' && heat > 0 ? { backgroundColor: `rgba(16, 185, 129, ${0.15 + heat * 0.55})` } : {}}
                      >
                        {c === '1' ? '✓' : c === '?' ? '?' : ''}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] text-zinc-500">
        Click a cell to cycle: <span className="inline-block rounded bg-zinc-200 px-1 dark:bg-zinc-800">empty</span>
        {' '}→ <span className="inline-block rounded bg-emerald-500 px-1 text-white">✓</span>
        {' '}→ <span className="inline-block rounded bg-amber-300 px-1 text-amber-900">?</span>. Background heat shows how many others picked each cell.
      </p>

      <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Submit your availability</h2>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. only by phone)"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !name.trim()}
          className="mt-3 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {submitting ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Submitting…</> : <><Send className="h-3.5 w-3.5" /> Submit</>}
        </button>
      </section>

      {responses.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium">Responses ({responses.length})</h2>
          <ul className="mt-2 space-y-1 text-xs">
            {responses.map((r) => (
              <li key={r.id} className="rounded border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <strong>{r.name}</strong>
                {r.note && <span className="ml-2 text-zinc-500">— {r.note}</span>}
                <span className="ml-2 text-zinc-400">{new Date(r.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
