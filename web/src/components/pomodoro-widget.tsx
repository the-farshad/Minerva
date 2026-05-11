'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Play, Pause, RotateCcw, Timer } from 'lucide-react';

const WORK = 25 * 60;

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Tiny home-page pomodoro. The full /pomodoro page handles
 * phase transitions + notifications; this widget is just a quick
 * 25-minute focus block. */
export function PomodoroWidget() {
  const [remaining, setRemaining] = useState(WORK);
  const [running, setRunning] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      return;
    }
    tickRef.current = setInterval(() => {
      setRemaining((s) => (s <= 1 ? (setRunning(false), WORK) : s - 1));
    }, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [running]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">Focus block</strong>
        <Link href="/pomodoro" className="ml-auto text-xs text-zinc-500 underline-offset-2 hover:underline">
          Full timer
        </Link>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="font-mono text-3xl tabular-nums">{fmt(remaining)}</span>
        <button
          type="button"
          onClick={() => setRunning((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          {running ? <><Pause className="h-3 w-3" /> Pause</> : <><Play className="h-3 w-3" /> Start</>}
        </button>
        <button
          type="button"
          onClick={() => { setRunning(false); setRemaining(WORK); }}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>
    </div>
  );
}
