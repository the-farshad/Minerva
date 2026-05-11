'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

type Phase = 'work' | 'short' | 'long';

const PRESETS: Record<Phase, number> = {
  work: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function PomodoroView() {
  const [phase, setPhase] = useState<Phase>('work');
  const [remaining, setRemaining] = useState(PRESETS.work);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      return;
    }
    tickRef.current = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) {
          if (tickRef.current) clearInterval(tickRef.current);
          setRunning(false);
          if (phase === 'work') {
            setCompleted((c) => c + 1);
            const nextPhase: Phase = (completed + 1) % 4 === 0 ? 'long' : 'short';
            setPhase(nextPhase);
            setRemaining(PRESETS[nextPhase]);
            try {
              new Notification('Pomodoro', { body: 'Time for a break.' });
            } catch { /* permissions */ }
          } else {
            setPhase('work');
            setRemaining(PRESETS.work);
            try {
              new Notification('Pomodoro', { body: 'Back to work.' });
            } catch { /* permissions */ }
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [running, phase, completed]);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  function setPhaseAndReset(p: Phase) {
    setRunning(false);
    setPhase(p);
    setRemaining(PRESETS[p]);
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Pomodoro</h1>
      <p className="mt-2 text-sm text-zinc-500">
        25 / 5 / 15 — every 4th break is a long one.
      </p>

      <div className="mt-8 flex justify-center gap-2 text-xs">
        {(['work', 'short', 'long'] as Phase[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPhaseAndReset(p)}
            className={`rounded-full border px-3 py-1 ${phase === p ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-zinc-200 dark:border-zinc-800'}`}
          >
            {p === 'work' ? 'Focus' : p === 'short' ? 'Short break' : 'Long break'}
          </button>
        ))}
      </div>

      <div className="mt-8 font-mono text-7xl tabular-nums tracking-tight">
        {fmt(remaining)}
      </div>

      <div className="mt-6 flex justify-center gap-2">
        <button
          type="button"
          onClick={() => setRunning((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-zinc-900"
        >
          {running
            ? <><Pause className="h-4 w-4" /> Pause</>
            : <><Play className="h-4 w-4" /> Start</>}
        </button>
        <button
          type="button"
          onClick={() => { setRunning(false); setRemaining(PRESETS[phase]); }}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
        >
          <RotateCcw className="h-4 w-4" /> Reset
        </button>
      </div>

      <p className="mt-6 text-xs text-zinc-500">
        Completed focus blocks today: <strong>{completed}</strong>
      </p>
    </main>
  );
}
