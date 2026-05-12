'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

/**
 * Compose a new meeting poll. Pick a list of days + a slot range,
 * POST to /api/polls, then redirect to the participant view at
 * /meet/<token> so the organizer can grab the share link.
 */
export default function NewPollPage() {
  const r = useRouter();
  const [title, setTitle] = useState('Meeting');
  const today = new Date().toISOString().slice(0, 10);
  const [days, setDays] = useState<string[]>([today]);
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(17);
  const [slotMin, setSlotMin] = useState(30);
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function addDay() {
    const last = days[days.length - 1] || today;
    const d = new Date(last);
    d.setDate(d.getDate() + 1);
    const next = d.toISOString().slice(0, 10);
    setDays([...days, next]);
  }

  async function submit() {
    setSaving(true);
    try {
      const r2 = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          days,
          slots: { fromHour, toHour, slotMin, tz },
          location,
        }),
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

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center gap-2">
        <CalendarDays className="h-5 w-5" />
        <h1 className="text-lg font-semibold">New meeting poll</h1>
      </header>

      <label className="block">
        <div className="text-xs text-zinc-500">Title</div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

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

      <label className="mt-5 block">
        <div className="text-xs text-zinc-500">Location / platform link <span className="text-zinc-400">(optional)</span></div>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Zoom URL · Google Meet link · physical address · TBD"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="mt-1 text-[10px] text-zinc-500">Shown verbatim to every participant — paste a URL, address, or whatever they need to plan around.</div>
      </label>

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !title.trim() || days.length === 0 || fromHour >= toHour}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating…</> : 'Create poll'}
        </button>
      </div>
    </main>
  );
}
