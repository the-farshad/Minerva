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
  X, ExternalLink, Clock, Eye, EyeOff, BookOpen, Users, Calendar, FileText, Pencil,
} from 'lucide-react';
import { toast } from 'sonner';
import { readingMinutes, formatReadingMinutes } from '@/lib/reading-time';
import { appPrompt } from './prompt';

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

/** Where a manually-pasted playlist URL is remembered. Per-device
 *  (localStorage), keyed by the group name + the section preset
 *  prefix. Survives reloads + lets the user fix the case where the
 *  list= parameter wasn't preserved during import. */
const PLAYLIST_URL_KEY = (groupKey: string) => `minerva.v2.playlistUrl.${groupKey}`;
const PL_RE = /[?&]list=([A-Za-z0-9_-]+)/;

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

  // The user-saved playlist URL (or list=id) for this group, if
  // any. Read on mount and again after the storage event so a
  // change persists immediately across an open dialog.
  const [storedListId, setStoredListId] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAYLIST_URL_KEY(groupKey));
      if (!raw) { setStoredListId(null); return; }
      const m = raw.match(PL_RE);
      // Accept either a full YouTube URL or a bare list= id paste.
      setStoredListId(m ? m[1] : (/^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : null));
    } catch { setStoredListId(null); }
  }, [groupKey, tick]);

  const stats = useMemo(() => {
    // The manually-saved URL wins over per-row URL parsing — that's
    // the whole point of letting the user paste it.
    // Resolution order: manually-saved URL (storedListId) → any
    // row's `_playlistId` meta field (set by add-by-url on import)
    // → any row URL's list= param. First win sticks.
    let listId = storedListId ?? '';
    if (!listId) {
      for (const r of rows) {
        const data = r.data as Record<string, unknown>;
        if (typeof data._playlistId === 'string' && data._playlistId) {
          listId = data._playlistId;
          break;
        }
      }
    }
    let totalSec = 0;
    let watchedSec = 0;
    let completed = 0;
    let started = 0;
    let withDuration = 0;
    let lastWatchedTitle = '';
    let lastWatchedAt = 0;
    let avgDurSec = 0;
    for (const r of rows) {
      const data = r.data;
      const url = String(data.url || '');
      if (!listId) {
        const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (m) listId = m[1];
      }
      // Be generous about field names — YouTube imports have
      // landed under `duration`, `seconds`, `lengthSeconds`, and a
      // formatted `length` string ("12:34" / "1:02:34") at various
      // times. Accept any of them.
      const dur = parseDurationLike(
        data.duration ?? data.seconds ?? data.lengthSeconds ?? data.length ?? data.runtime,
      );
      if (dur > 0) {
        totalSec += dur;
        withDuration++;
      }
      try {
        const resume = typeof window !== 'undefined' && url
          ? localStorage.getItem('minerva.v2.resume.' + url)
          : null;
        if (resume != null) {
          const pos = Number(resume);
          if (Number.isFinite(pos) && pos > 0) {
            started++;
            watchedSec += dur > 0 ? Math.min(pos, dur) : pos;
            if (dur > 0 && pos >= dur * 0.9) completed++;
            // Sniff a last-modified timestamp out of resume time
            // metadata if the player wrote one — falls back to
            // any title we can find on this row.
            const title = String(data.title || data.name || '');
            if (title) {
              const accessed = typeof data._accessedAt === 'string' ? Date.parse(data._accessedAt) : 0;
              if (accessed > lastWatchedAt) {
                lastWatchedAt = accessed;
                lastWatchedTitle = title;
              }
            }
          }
        }
      } catch { /* private mode / storage-disabled tolerate */ }
    }
    avgDurSec = withDuration > 0 ? Math.round(totalSec / withDuration) : 0;
    const pct = totalSec > 0
      ? Math.min(100, Math.round((watchedSec / totalSec) * 100))
      // No duration anywhere — fall back to completion rate over
      // count so the donut still says something useful.
      : Math.round((started / Math.max(1, rows.length)) * 100);
    // "At this pace" estimate — extrapolate from the per-video
    // completion rate if we have any data. Cosmetic; rounded
    // aggressively so a flat day doesn't show "100 years left".
    let etaText = '';
    if (totalSec > 0 && watchedSec > 0 && watchedSec < totalSec) {
      const remainingSec = totalSec - watchedSec;
      const oneHourChunks = Math.ceil(remainingSec / 3600);
      if (oneHourChunks <= 1) etaText = '~1h left';
      else if (oneHourChunks <= 24) etaText = `~${oneHourChunks}h left`;
      else etaText = `~${Math.ceil(oneHourChunks / 8)} sessions left (8 h each)`;
    }
    return {
      listId,
      totalSec,
      watchedSec,
      remainingSec: Math.max(0, totalSec - watchedSec),
      completed,
      started,
      pct,
      withDuration,
      avgDurSec,
      lastWatchedTitle,
      etaText,
    };
  }, [rows, storedListId]);

  async function savePlaylistUrl() {
    const seed = storedListId ? `https://www.youtube.com/playlist?list=${storedListId}` : '';
    const input = await appPrompt('Playlist URL', {
      body: 'Paste the YouTube playlist URL (the one that starts with /playlist?list=…). You can also paste just the list= id.',
      initial: seed,
      placeholder: 'https://www.youtube.com/playlist?list=PL…',
      okLabel: 'Save',
    });
    if (input == null) return;
    const trimmed = input.trim();
    try {
      if (!trimmed) {
        localStorage.removeItem(PLAYLIST_URL_KEY(groupKey));
        setStoredListId(null);
        toast.success('Playlist URL cleared.');
        return;
      }
      const m = trimmed.match(PL_RE);
      const bareId = /^[A-Za-z0-9_-]{10,}$/.test(trimmed) ? trimmed : null;
      const id = m ? m[1] : bareId;
      if (!id) {
        toast.error("Didn't recognise that as a YouTube playlist URL or list= id.");
        return;
      }
      localStorage.setItem(PLAYLIST_URL_KEY(groupKey), trimmed);
      setStoredListId(id);
      toast.success('Playlist URL saved for this group.');
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
    }
  }

  const hasDurations = stats.withDuration > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-5 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <ProgressDonut pct={stats.pct} />
        <div className="space-y-1 text-sm">
          {hasDurations ? (
            <>
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
            </>
          ) : (
            <div className="text-xs text-zinc-500">
              No per-video duration stored on these rows yet — the percentage falls back to videos-started ÷ total. Run Refresh metadata from the three-dots to pull durations from YouTube.
            </div>
          )}
          <div className="text-xs text-zinc-500">
            {stats.completed} completed · {Math.max(0, stats.started - stats.completed)} in progress · {Math.max(0, rows.length - stats.started)} unstarted
          </div>
        </div>
      </div>

      {/* Secondary stat row — average length, ETA, link. Only the
       *  fields with real values show; the rest collapse. */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {stats.avgDurSec > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">
            <Clock className="h-3 w-3 text-zinc-500" />
            avg <strong>{fmtDuration(stats.avgDurSec)}</strong> / video
          </span>
        )}
        {stats.etaText && (
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">
            <EyeOff className="h-3 w-3 text-zinc-500" />
            {stats.etaText}
          </span>
        )}
        {stats.lastWatchedTitle && (
          <span className="inline-flex max-w-[280px] items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">
            <Eye className="h-3 w-3 text-zinc-500" />
            last watched: <span className="truncate">{stats.lastWatchedTitle}</span>
          </span>
        )}
      </div>

      {/* Original-playlist jump-link is the user's most asked-for
       *  shortcut here, so it gets its own emphasised row when a
       *  listId is discoverable on any row. */}
      {/* Playlist jump-link + "set / edit URL" affordance. The
       *  link goes to the canonical /playlist?list=… page whenever
       *  a listId is known — either parsed from a row's URL or
       *  saved by the user. The pencil button lets the user paste
       *  the real URL when the importer didn't preserve list= on
       *  the per-video URLs (the MIT-style case the user hit). */}
      <div className="flex flex-wrap items-stretch gap-2">
        {stats.listId ? (
          <a
            href={`https://www.youtube.com/playlist?list=${stats.listId}`}
            target="_blank"
            rel="noopener"
            className="inline-flex flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open “{groupKey}” on YouTube
            <span className="ml-auto text-[10px] text-zinc-500">youtube.com/playlist?list={stats.listId.slice(0, 12)}…</span>
          </a>
        ) : (
          <a
            href={`https://www.youtube.com/results?search_query=${encodeURIComponent(groupKey + ' playlist')}`}
            target="_blank"
            rel="noopener"
            className="inline-flex flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Search YouTube for “{groupKey}”
            <span className="ml-auto text-[10px] text-zinc-500">no list= id stored — paste one →</span>
          </a>
        )}
        <button
          type="button"
          onClick={() => void savePlaylistUrl()}
          title={storedListId ? 'Edit the playlist URL saved for this group' : 'Paste the playlist URL so the link goes to the real playlist instead of a YouTube search'}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          <Pencil className="h-3.5 w-3.5" />
          {storedListId ? 'Edit URL' : 'Set URL'}
        </button>
      </div>
    </div>
  );
}

/** Coerce a duration field into seconds, accepting any of:
 *  number, numeric string, "HH:MM:SS", "MM:SS", "12m", "1h 2m".
 *  Returns 0 for anything unrecognisable. */
function parseDurationLike(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v !== 'string') return 0;
  const s = v.trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  // HH:MM:SS / MM:SS
  if (/^\d{1,3}:\d{1,2}(:\d{1,2})?$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  // "1h 2m 3s" / "12m" — pick out any h/m/s with a leading number.
  let total = 0;
  const m = s.match(/(\d+)\s*h/i);
  if (m) total += Number(m[1]) * 3600;
  const mm = s.match(/(\d+)\s*m\b/i);
  if (mm) total += Number(mm[1]) * 60;
  const ss = s.match(/(\d+)\s*s\b/i);
  if (ss) total += Number(ss[1]);
  return total;
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

function RecentlyAdded({ rows }: { rows: Row[]; preset?: string }) {
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
