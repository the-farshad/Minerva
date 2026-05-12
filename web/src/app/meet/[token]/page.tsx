'use client';

import { useEffect, useMemo, useState, use } from 'react';
import Link from 'next/link';
import { Loader2, Copy, Send, Calendar, MapPin, CheckCircle2, Pencil, ArrowLeft, Lock } from 'lucide-react';
import { appPrompt } from '@/components/prompt';
import { appConfirm } from '@/components/confirm';
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
  // Password the participant typed in this session — kept in state
  // (NOT localStorage) so a closed tab forgets it. Sent via the
  // `x-poll-password` header / body field so the server can verify
  // and serve the real payload.
  const [pollPassword, setPollPassword] = useState('');
  const [passwordRequired, setPasswordRequired] = useState(false);

  async function load(supplied?: string) {
    try {
      const pw = supplied !== undefined ? supplied : pollPassword;
      const r = await fetch(`/api/polls/${encodeURIComponent(token)}${pw ? `?p=${encodeURIComponent(pw)}` : ''}`);
      const j = (await r.json().catch(() => ({}))) as { poll?: Poll; responses?: PollResponse[]; error?: string; passwordRequired?: boolean };
      if (r.status === 401 && j.passwordRequired) {
        setPasswordRequired(true);
        setPoll(j.poll || null);
        return;
      }
      if (!r.ok || !j.poll) throw new Error(j.error || `load: ${r.status}`);
      setPasswordRequired(false);
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

  /** For 1-to-1 booking mode: which cell each previous response
   * claimed, keyed by cell index → claimant name. Drives the
   * "taken by X" rendering in the grid. */
  const claimedBy = useMemo(() => {
    const out = new Map<number, string>();
    if (!poll || poll.mode !== 'book') return out;
    for (const r of responses) {
      for (let i = 0; i < r.bits.length; i++) {
        if (r.bits[i] === '1') { out.set(i, r.name); break; }
      }
    }
    return out;
  }, [responses, poll]);

  async function submit() {
    if (!poll) return;
    if (!name.trim()) { notify.error('Enter your name first.'); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/polls/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), bits: cells.join(''), note, password: pollPassword || undefined }),
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
  if (passwordRequired) {
    return (
      <main className="mx-auto max-w-md px-4 py-12 text-sm">
        <Link href="/meet" className="mb-4 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          <ArrowLeft className="h-3 w-3" /> Back to polls
        </Link>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Lock className="h-4 w-4 text-amber-500" /> Password required
          </div>
          <p className="mt-2 text-xs text-zinc-500">{poll?.title || 'This poll'} is password-protected. Ask the organizer for it.</p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); void load(pollPassword); }}
          >
            <input
              type="password"
              autoFocus
              value={pollPassword}
              onChange={(e) => setPollPassword(e.target.value)}
              placeholder="Poll password"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="submit"
              disabled={!pollPassword}
              className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              Unlock
            </button>
          </form>
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

  // Final slot — set by the organizer via the Finalize button. We
  // parse it to surface a "Confirmed" banner at the top.
  const finalSlotMatch = poll.finalSlot ? /^(\d+):(\d+)$/.exec(poll.finalSlot) : null;
  const finalDay = finalSlotMatch ? Number(finalSlotMatch[1]) : -1;
  const finalSlotIdx = finalSlotMatch ? Number(finalSlotMatch[2]) : -1;

  async function patchPoll(patch: Record<string, unknown>) {
    try {
      const r = await fetch(`/api/polls/${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `patch: ${r.status}`);
      await load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  async function finalize(dayIdx: number, slotIdx: number) {
    if (!poll) return;
    const dayLabel = new Date(poll.days[dayIdx]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const ok = await appConfirm(`Lock in ${dayLabel} at ${slotLabel(slots, slotIdx)}?`, {
      body: 'Everyone with the share link will see this as the confirmed slot. You can change it later via the same button.',
    });
    if (!ok) return;
    await patchPoll({ finalSlot: `${dayIdx}:${slotIdx}` });
    toast.success('Slot finalized.');
  }
  async function clearFinal() {
    const ok = await appConfirm('Clear the finalized slot?', { body: 'The poll goes back to gathering responses.' });
    if (!ok) return;
    await patchPoll({ finalSlot: null });
    toast.success('Final slot cleared.');
  }
  async function editLocation() {
    if (!poll) return;
    const next = await appPrompt('Meeting location', {
      okLabel: 'Save',
      initial: poll.location || '',
      placeholder: 'Zoom URL · Meet link · address · TBD',
    });
    if (next == null) return;
    await patchPoll({ location: next });
    toast.success('Location updated.');
  }
  async function editTitle() {
    if (!poll) return;
    const next = await appPrompt('Poll title', { okLabel: 'Save', initial: poll.title });
    if (next == null) return;
    if (!next.trim()) { notify.error('Title cannot be empty.'); return; }
    await patchPoll({ title: next.trim() });
    toast.success('Title updated.');
  }
  async function editPassword() {
    if (!poll) return;
    const next = await appPrompt(
      poll.passwordSet ? 'Change or clear the password' : 'Set a poll password',
      {
        okLabel: 'Save',
        placeholder: poll.passwordSet ? '••••• (empty = remove)' : 'New password',
      },
    );
    if (next == null) return;
    await patchPoll({ password: next.trim() ? next.trim() : null });
    toast.success(next.trim() ? 'Password updated.' : 'Password cleared.');
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/meet" className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft className="h-3 w-3" /> Back to polls
      </Link>
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Calendar className="h-5 w-5" />
        <h1 className="text-lg font-semibold">{poll.title}</h1>
        <button
          type="button"
          onClick={editTitle}
          title="Rename this poll"
          className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs text-zinc-500">{slots.tz}</span>
        <button
          type="button"
          onClick={editPassword}
          title={poll.passwordSet ? 'Password is set — click to change or clear' : 'Set a password so the share link needs unlocking'}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${poll.passwordSet ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'border border-zinc-200 text-zinc-500 dark:border-zinc-700'}`}
        >
          <Lock className="h-3 w-3" /> {poll.passwordSet ? 'Password set' : 'No password'}
        </button>
        <button
          type="button"
          onClick={() => { try { void navigator.clipboard.writeText(shareUrl); toast.success('Share link copied.'); } catch { /* tolerate */ } }}
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Copy className="h-3.5 w-3.5" /> Copy share link
        </button>
      </header>

      {finalSlotMatch && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <strong>Confirmed:</strong>
          <span>
            {new Date(poll.days[finalDay]).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} at {slotLabel(slots, finalSlotIdx)} ({slots.tz})
          </span>
          <button
            type="button"
            onClick={clearFinal}
            className="ml-auto rounded-full p-1 text-xs hover:bg-emerald-100 dark:hover:bg-emerald-900"
            title="Clear (back to gathering responses)"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <MapPin className="h-4 w-4 shrink-0 text-zinc-500" />
        {poll.location ? (
          /^https?:\/\//i.test(poll.location) ? (
            <a href={poll.location} target="_blank" rel="noopener" className="break-all text-blue-600 underline dark:text-blue-400">{poll.location}</a>
          ) : (
            <span className="break-all">{poll.location}</span>
          )
        ) : (
          <span className="text-zinc-500">No location set yet.</span>
        )}
        <button
          type="button"
          onClick={editLocation}
          className="ml-auto rounded-full p-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Edit location (organizer only — requires sign-in)"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>

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
                  const taker = claimedBy.get(i);
                  if (poll.mode === 'book') {
                    return (
                      <td key={dayIdx} className="px-0.5 py-0.5">
                        <button
                          type="button"
                          disabled={!!taker}
                          onClick={() => setCells((arr) => {
                            // Single-pick: clear every other cell first.
                            const c2 = arr.map(() => '0' as Cell);
                            c2[i] = arr[i] === '1' ? '0' : '1';
                            return c2;
                          })}
                          className={`relative w-full rounded px-2 py-1.5 text-xs transition ${
                            taker
                              ? 'cursor-not-allowed bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500'
                              : c === '1'
                                ? 'bg-emerald-500 text-white'
                                : 'bg-zinc-100 text-zinc-500 hover:bg-emerald-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-emerald-900/50'
                          } ${finalDay === dayIdx && finalSlotIdx === slotIdx ? 'ring-2 ring-emerald-600' : ''}`}
                          title={taker
                            ? `Taken by ${taker}`
                            : c === '1'
                              ? 'Your pick — click to clear'
                              : 'Click to claim this slot'}
                        >
                          {taker ? '×' : c === '1' ? '✓' : ''}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={dayIdx} className="px-0.5 py-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) {
                            void finalize(dayIdx, slotIdx);
                          } else {
                            setCells((arr) => { const c2 = arr.slice(); c2[i] = cellNext(arr[i] as Cell); return c2; });
                          }
                        }}
                        className={`relative w-full rounded ${cellClass(c)} px-2 py-1.5 transition ${finalDay === dayIdx && finalSlotIdx === slotIdx ? 'ring-2 ring-emerald-600' : ''}`}
                        title={`Cell ${slotLabel(slots, slotIdx)} · ${cons} ${cons === 1 ? 'person' : 'people'} available · ⌘/Ctrl-click to finalize`}
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
        Organizer: <kbd className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">⌘/Ctrl-click</kbd> any cell to lock it in as the final slot.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            if (!consensus.length) return;
            let bestIdx = 0;
            let best = consensus[0];
            for (let i = 1; i < consensus.length; i++) {
              if (consensus[i] > best) { best = consensus[i]; bestIdx = i; }
            }
            if (best <= 0) {
              notify.error('No responses yet — nothing to pick from.');
              return;
            }
            void finalize(Math.floor(bestIdx / perDay), bestIdx % perDay);
          }}
          className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Finalize top consensus
        </button>
      </div>

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
