'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Plus, Trash2, Loader2, CheckSquare, ListOrdered } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import type { PollKind } from '@/lib/poll';

/**
 * Compose a new poll. Three kinds are supported:
 *   - meeting: pick days + slot grid; participants mark availability
 *   - yesno: single question; participants answer yes/no/maybe
 *   - ranked: 2–20 options; participants drag to rank them
 * On submit, POST to /api/polls and redirect to /meet/<token>.
 */
export default function NewPollPage() {
  const r = useRouter();
  const [kind, setKind] = useState<PollKind>('meeting');
  const [title, setTitle] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [days, setDays] = useState<string[]>([today]);
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(17);
  const [slotMin, setSlotMin] = useState(30);
  const [location, setLocation] = useState('');
  const [mode, setMode] = useState<'group' | 'book'>('group');
  const [password, setPassword] = useState('');
  const [yesnoQuestion, setYesnoQuestion] = useState('');
  const [rankedOptions, setRankedOptions] = useState<string[]>(['', '']);
  const [saving, setSaving] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function addDay() {
    const last = days[days.length - 1] || today;
    const d = new Date(last);
    d.setDate(d.getDate() + 1);
    const next = d.toISOString().slice(0, 10);
    setDays([...days, next]);
  }

  type BuildErr = { _error: string };
  function isErr(x: Record<string, unknown> | BuildErr): x is BuildErr {
    return typeof (x as BuildErr)._error === 'string';
  }
  function buildBody(): Record<string, unknown> | BuildErr {
    const base = {
      title: title.trim(),
      location,
      password: password.trim() || undefined,
    };
    if (!base.title) return { _error: 'Title is required.' };
    if (kind === 'meeting') {
      return {
        ...base,
        kind: 'meeting',
        days,
        slots: { fromHour, toHour, slotMin, tz },
        mode,
      };
    }
    if (kind === 'yesno') {
      const q = yesnoQuestion.trim();
      if (!q) return { _error: 'Type the question for your yes/no poll.' };
      return { ...base, kind: 'yesno', days: [q], slots: {} };
    }
    // ranked
    const opts = rankedOptions.map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) return { _error: 'A ranked poll needs at least 2 options.' };
    if (opts.length > 20) return { _error: 'A ranked poll caps at 20 options.' };
    return { ...base, kind: 'ranked', days: opts, slots: {} };
  }

  async function submit() {
    const body = buildBody();
    if (isErr(body)) { notify.error(body._error); return; }
    setSaving(true);
    try {
      const r2 = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r2.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!r2.ok || !j.token) throw new Error(j.error || `create: ${r2.status}`);
      toast.success('Poll created.');
      r.push(`/meet/${j.token}`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const KIND_OPTS: { value: PollKind; title: string; desc: string; Icon: typeof CalendarDays }[] = [
    { value: 'meeting', title: 'Meeting time',  desc: 'Pick from a date × slot grid. Group or 1-to-1 booking.', Icon: CalendarDays },
    { value: 'yesno',   title: 'Yes / no',      desc: 'Single question, three answers (yes / no / maybe).',      Icon: CheckSquare },
    { value: 'ranked',  title: 'Ranked choice', desc: 'List 2–20 options; participants rank them. Borda count winner.', Icon: ListOrdered },
  ];

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center gap-2">
        <CalendarDays className="h-5 w-5" />
        <h1 className="text-lg font-semibold">New poll</h1>
      </header>

      <fieldset className="mb-5">
        <legend className="text-xs text-zinc-500">Kind</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {KIND_OPTS.map((opt) => {
            const active = kind === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setKind(opt.value)}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${active
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                  : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <opt.Icon className="h-3.5 w-3.5" /> {opt.title}
                </div>
                <div className={`mt-0.5 text-[10px] ${active ? 'opacity-80' : 'text-zinc-500'}`}>{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="block">
        <div className="text-xs text-zinc-500">Title</div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'meeting' ? 'e.g. Team sync' : kind === 'yesno' ? 'e.g. Should we adopt React 19?' : 'e.g. Best name for the new project'}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      {kind === 'meeting' && (
        <>
          <fieldset className="mt-5">
            <legend className="text-xs text-zinc-500">Mode</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {([
                { value: 'group', title: 'Group consensus', desc: 'Everyone marks availability. Heat-map shows the best slot. You finalize a winner.' },
                { value: 'book',  title: '1-to-1 booking',  desc: 'Calendly-style. Each participant claims one slot first-come-first-served.' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs ${mode === opt.value
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                    : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
                >
                  <div className="font-medium">{opt.title}</div>
                  <div className={`mt-0.5 text-[10px] ${mode === opt.value ? 'opacity-80' : 'text-zinc-500'}`}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </fieldset>

          <section className="mt-5">
            <div className="flex items-center justify-between">
              <div className="text-xs text-zinc-500">Days</div>
              <button
                type="button"
                onClick={addDay}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2.5 py-0.5 text-xs text-white dark:bg-white dark:text-zinc-900"
              >
                <Plus className="h-3 w-3" /> Add day
              </button>
            </div>
            <ul className="mt-2 space-y-1.5">
              {days.map((d, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    type="date"
                    value={d}
                    onChange={(e) => setDays(days.map((x, j) => (j === i ? e.target.value : x)))}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  {days.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setDays(days.filter((_, j) => j !== i))}
                      className="rounded-full p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      title="Remove this day"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-5 grid grid-cols-3 gap-3">
            <label className="block">
              <div className="text-xs text-zinc-500">From hour</div>
              <input
                type="number"
                min={0} max={23}
                value={fromHour}
                onChange={(e) => setFromHour(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="block">
              <div className="text-xs text-zinc-500">To hour</div>
              <input
                type="number"
                min={1} max={24}
                value={toHour}
                onChange={(e) => setToHour(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="block">
              <div className="text-xs text-zinc-500">Slot length</div>
              <select
                value={slotMin}
                onChange={(e) => setSlotMin(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
            </label>
          </section>

          <p className="mt-3 text-[11px] text-zinc-500">
            Timezone <span className="font-mono">{tz}</span> — participants pick from this grid in your local time.
          </p>
        </>
      )}

      {kind === 'yesno' && (
        <label className="mt-5 block">
          <div className="text-xs text-zinc-500">Question</div>
          <textarea
            value={yesnoQuestion}
            onChange={(e) => setYesnoQuestion(e.target.value)}
            placeholder="e.g. Should we move the team off-site next quarter?"
            rows={3}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-1 text-[10px] text-zinc-500">Participants answer yes / no / maybe — results render as a bar chart.</div>
        </label>
      )}

      {kind === 'ranked' && (
        <section className="mt-5">
          <div className="flex items-center justify-between">
            <div className="text-xs text-zinc-500">Options ({rankedOptions.length})</div>
            <button
              type="button"
              onClick={() => setRankedOptions([...rankedOptions, ''])}
              disabled={rankedOptions.length >= 20}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2.5 py-0.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              <Plus className="h-3 w-3" /> Add option
            </button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {rankedOptions.map((o, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-6 text-right text-xs text-zinc-400">{i + 1}.</span>
                <input
                  type="text"
                  value={o}
                  onChange={(e) => setRankedOptions(rankedOptions.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={`Option ${i + 1}`}
                  className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                {rankedOptions.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setRankedOptions(rankedOptions.filter((_, j) => j !== i))}
                    className="rounded-full p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                    title="Remove this option"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1 text-[10px] text-zinc-500">Each participant ranks every option. Winner is decided by Borda count (top rank wins more points).</div>
        </section>
      )}

      <label className="mt-5 block">
        <div className="text-xs text-zinc-500">Password <span className="text-zinc-400">(optional)</span></div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Leave empty for open access"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="mt-1 text-[10px] text-zinc-500">
          When set, anyone with the share link still has to type this password to see or vote. Stored as a SHA-256 digest — you can&rsquo;t recover it later, only replace it.
        </div>
      </label>

      <label className="mt-5 block">
        <div className="text-xs text-zinc-500">Location / platform link <span className="text-zinc-400">(optional)</span></div>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Zoom URL · Google Meet link · physical address · TBD"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !title.trim()}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating…</> : 'Create poll'}
        </button>
      </div>
    </main>
  );
}
