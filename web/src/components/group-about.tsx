'use client';

/**
 * "About this group" dialog — opens from the three-dots overflow
 * on each group header. Adapts to the section preset:
 *
 *   youtube — progress donut, duration totals, completed-count,
 *             open-on-YouTube link when a list= id is discoverable.
 *   papers  — reading-time total, year distribution mini bar chart,
 *             top authors, recently added.
 *   notes   — word count total, recently edited.
 *   other   — falls back to the common "Recently added" section.
 *
 * All computation is local — no extra fetch — so the dialog opens
 * instantly. Watched-progress for YouTube reads the same
 * `minerva.v2.resume.<url>` keys that the player writes during
 * playback, so the % shown here matches the per-card bars.
 */
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X, ExternalLink, Clock, Eye, EyeOff, BookOpen, Users, Calendar, FileText,
} from 'lucide-react';
import { readingMinutes, formatReadingMinutes } from '@/lib/reading-time';

type Row = { id: string; data: Record<string, unknown>; updatedAt?: string; createdAt?: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: string | null | undefined;
  groupKey: string;
  rows: Row[];
};

export function GroupAboutDialog(props: Props) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(640px,94vw)] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <Dialog.Title className="truncate text-base font-semibold">{props.groupKey}</Dialog.Title>
              <p className="text-xs text-zinc-500">{props.rows.length} item{props.rows.length === 1 ? '' : 's'}</p>
            </div>
            <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Body preset={props.preset || ''} rows={props.rows} groupKey={props.groupKey} />
          <RecentlyAdded rows={props.rows} preset={props.preset || ''} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({ preset, rows, groupKey }: { preset: string; rows: Row[]; groupKey: string }) {
  if (preset === 'youtube') return <YoutubeBody rows={rows} groupKey={groupKey} />;
  if (preset === 'papers') return <PapersBody rows={rows} />;
  if (preset === 'notes') return <NotesBody rows={rows} />;
  return null;
}

// ──────────────────────────── YouTube ────────────────────────────

function YoutubeBody({ rows, groupKey }: { rows: Row[]; groupKey: string }) {
  // Re-read from localStorage on open so progress reflects any
  // playback that happened since this tab mounted.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onStorage = () => setTick((t) => t + 1);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  void tick;

  const stats = useMemo(() => {
    let listId = '';
    let totalSec = 0;
    let watchedSec = 0;
    let completed = 0;
    let withDuration = 0;
    for (const r of rows) {
      const data = r.data;
      const url = String(data.url || '');
      if (!listId) {
        const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (m) listId = m[1];
      }
      const durRaw = Number(data.duration || data.seconds || 0);
      const dur = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 0;
      if (dur > 0) {
        totalSec += dur;
        withDuration++;
      }
      try {
        const resume = typeof window !== 'undefined'
          ? localStorage.getItem('minerva.v2.resume.' + url)
          : null;
        if (resume != null) {
          const pos = Number(resume);
          if (Number.isFinite(pos) && pos > 0) {
            watchedSec += dur > 0 ? Math.min(pos, dur) : pos;
            if (dur > 0 && pos >= dur * 0.9) completed++;
          }
        }
      } catch { /* private mode / storage-disabled tolerate */ }
    }
    const pct = totalSec > 0 ? Math.min(100, Math.round((watchedSec / totalSec) * 100)) : 0;
    return {
      listId,
      totalSec,
      watchedSec,
      remainingSec: Math.max(0, totalSec - watchedSec),
      completed,
      pct,
      withDuration,
    };
  }, [rows]);

  const hasDurations = stats.withDuration > 0;

  return (
    <div className="space-y-4">
      {hasDurations ? (
        <div className="flex items-center gap-5 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ProgressDonut pct={stats.pct} />
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-zinc-500" />
              <span>Watched: <strong>{fmtDuration(stats.watchedSec)}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="h-3.5 w-3.5 text-zinc-500" />
              <span>Remaining: <strong>{fmtDuration(stats.remainingSec)}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-zinc-500" />
              <span>Total: <strong>{fmtDuration(stats.totalSec)}</strong></span>
            </div>
            <div className="text-xs text-zinc-500">
              {stats.completed} of {rows.length} video{rows.length === 1 ? '' : 's'} completed
            </div>
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-zinc-200 bg-zinc-50/60 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
          No duration data on these videos yet — progress is tracked but the totals can't be summed.
        </p>
      )}
      {stats.listId && (
        <a
          href={`https://www.youtube.com/playlist?list=${stats.listId}`}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="h-3 w-3" />
          Open “{groupKey}” on YouTube
        </a>
      )}
    </div>
  );
}

function ProgressDonut({ pct, size = 88 }: { pct: number; size?: number }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${pct}% watched`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        className="text-zinc-200 dark:text-zinc-800" stroke="currentColor" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#3b82f6" strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle"
        className="fill-current text-[14px] font-semibold">
        {pct}%
      </text>
    </svg>
  );
}

// ──────────────────────────── Papers ─────────────────────────────

function PapersBody({ rows }: { rows: Row[] }) {
  const stats = useMemo(() => {
    let readMins = 0;
    const yearCounts = new Map<number, number>();
    const authorCounts = new Map<string, number>();
    for (const r of rows) {
      const data = r.data;
      const m = readingMinutes(data);
      if (m) readMins += m;
      const yr = Number(data.year);
      if (Number.isFinite(yr) && yr >= 1900 && yr <= 2100) {
        yearCounts.set(yr, (yearCounts.get(yr) ?? 0) + 1);
      }
      const authors = data.authors;
      const names = typeof authors === 'string'
        ? authors.split(/,\s*|;\s*/).map((s) => s.trim()).filter(Boolean)
        : Array.isArray(authors)
          ? authors.map((a) => (typeof a === 'string' ? a : (a as { name?: string }).name || '')).filter(Boolean)
          : [];
      for (const n of names) {
        authorCounts.set(n, (authorCounts.get(n) ?? 0) + 1);
      }
    }
    const yearsSorted = [...yearCounts.entries()].sort((a, b) => a[0] - b[0]);
    const topAuthors = [...authorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return { readMins, yearsSorted, topAuthors };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
            <BookOpen className="h-3 w-3" /> Reading time
          </div>
          <div className="text-base font-semibold">
            {stats.readMins > 0 ? `~${formatReadingMinutes(stats.readMins)}` : '—'}
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-500">summed across papers with a page or word count</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
            <Calendar className="h-3 w-3" /> Year range
          </div>
          <div className="text-base font-semibold">
            {stats.yearsSorted.length === 0
              ? '—'
              : stats.yearsSorted[0][0] === stats.yearsSorted[stats.yearsSorted.length - 1][0]
                ? String(stats.yearsSorted[0][0])
                : `${stats.yearsSorted[0][0]}–${stats.yearsSorted[stats.yearsSorted.length - 1][0]}`}
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-500">earliest to latest publication</p>
        </div>
      </div>
      {stats.yearsSorted.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Distribution by year</div>
          <YearMiniBars years={stats.yearsSorted} />
        </div>
      )}
      {stats.topAuthors.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
            <Users className="h-3 w-3" /> Top authors
          </div>
          <ul className="space-y-1 text-sm">
            {stats.topAuthors.map(([name, n]) => (
              <li key={name} className="flex items-center justify-between gap-3">
                <span className="truncate">{name}</span>
                <span className="text-xs text-zinc-500">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function YearMiniBars({ years }: { years: [number, number][] }) {
  const max = Math.max(...years.map(([, c]) => c));
  const W = 560;
  const H = 64;
  const bw = Math.max(6, Math.min(28, Math.floor(W / years.length) - 4));
  const gap = 4;
  const totalW = years.length * (bw + gap) - gap;
  return (
    <svg viewBox={`0 0 ${totalW} ${H}`} className="w-full" role="img" aria-label="Year distribution">
      {years.map(([y, c], i) => {
        const h = (c / max) * (H - 18);
        const x = i * (bw + gap);
        return (
          <g key={y}>
            <rect x={x} y={H - 16 - h} width={bw} height={h}
              className="fill-blue-500/70" rx={1.5} />
            <text x={x + bw / 2} y={H - 4} textAnchor="middle"
              className="fill-zinc-500 text-[8px]">{y}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ──────────────────────────── Notes ──────────────────────────────

function NotesBody({ rows }: { rows: Row[] }) {
  const stats = useMemo(() => {
    let words = 0;
    let withContent = 0;
    for (const r of rows) {
      const body = String(r.data.content || r.data.body || r.data.notes || '');
      if (!body.trim()) continue;
      withContent++;
      words += body.trim().split(/\s+/).length;
    }
    return { words, withContent };
  }, [rows]);

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
          <FileText className="h-3 w-3" /> Word count
        </div>
        <div className="text-base font-semibold">{stats.words.toLocaleString()}</div>
        <p className="mt-0.5 text-[11px] text-zinc-500">total across {stats.withContent} of {rows.length} note{rows.length === 1 ? '' : 's'}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
          <Clock className="h-3 w-3" /> Reading time
        </div>
        <div className="text-base font-semibold">
          {stats.words > 0 ? `~${formatReadingMinutes(Math.max(1, Math.round(stats.words / 180)))}` : '—'}
        </div>
        <p className="mt-0.5 text-[11px] text-zinc-500">at 180 words/min</p>
      </div>
    </div>
  );
}

// ──────────────────────────── Common ─────────────────────────────

function RecentlyAdded({ rows, preset }: { rows: Row[]; preset: string }) {
  const recent = useMemo(() => {
    return [...rows]
      .sort((a, b) => (b.createdAt || b.updatedAt || '').localeCompare(a.createdAt || a.updatedAt || ''))
      .slice(0, 5);
  }, [rows]);
  if (recent.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Recently added</div>
      <ul className="space-y-1 text-sm">
        {recent.map((r) => {
          const title = String(r.data.title || r.data.name || r.data.url || r.id);
          const when = r.createdAt || r.updatedAt;
          return (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span className="truncate">{title}</span>
              <span className="shrink-0 text-xs text-zinc-500">{when ? new Date(when).toLocaleDateString() : ''}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[10px] text-zinc-500">preset: {preset || 'generic'}</p>
    </div>
  );
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
