'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string; sectionSlug?: string };
type Section = { schema: { headers: string[] } };

const DATE_CANDIDATES = ['due', 'deadline', 'date', 'when', 'start'];

function pickDateField(headers: string[]): string | null {
  for (const c of DATE_CANDIDATES) if (headers.includes(c)) return c;
  return null;
}

function defaultGetDate(r: Row): string | null {
  for (const k of DATE_CANDIDATES) {
    const v = r.data[k];
    if (v) return String(v).slice(0, 10);
  }
  return null;
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarView({
  section, rows, onOpen, getDate,
}: {
  section?: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  getDate?: (r: Row) => string | null;
}) {
  const dateField = useMemo(
    () => (section ? pickDateField(section.schema.headers) : 'any'),
    [section],
  );
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const byDay = useMemo(() => {
    const out: Record<string, Row[]> = {};
    if (!dateField) return out;
    const pick = getDate ?? ((r: Row) => {
      const v = section ? r.data[dateField as string] : null;
      if (v) return String(v).slice(0, 10);
      return defaultGetDate(r);
    });
    for (const r of rows) {
      const day = pick(r);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      (out[day] ??= []).push(r);
    }
    return out;
  }, [rows, dateField, getDate, section]);

  if (!dateField) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Calendar needs a <code>due</code> / <code>deadline</code> / <code>date</code> column.
      </p>
    );
  }

  const monthStart = cursor;
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()));

  const days: Date[] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }
  const todayKey = ymd(new Date());
  const monthLabel = monthStart.toLocaleString(undefined, { year: 'numeric', month: 'long' });

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCursor((c) => addMonths(c, -1))}
          className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <strong className="text-sm">{monthLabel}</strong>
        <button
          type="button"
          onClick={() => setCursor((c) => addMonths(c, 1))}
          className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setCursor(startOfMonth(new Date()))}
          className="ml-auto rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Today
        </button>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        {DOW.map((d) => (
          <div key={d} className="border-b border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const items = byDay[key] || [];
          const inMonth = d.getMonth() === monthStart.getMonth();
          const isToday = key === todayKey;
          return (
            <div
              key={key}
              className={`min-h-24 border-b border-r border-zinc-200 p-1.5 align-top dark:border-zinc-800 ${inMonth ? 'bg-white dark:bg-zinc-950' : 'bg-zinc-50 dark:bg-zinc-900/50'}`}
            >
              <div className={`text-xs ${isToday ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 font-semibold text-white dark:bg-white dark:text-zinc-900' : inMonth ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-400'}`}>
                {d.getDate()}
              </div>
              <ul className="mt-1 space-y-1">
                {items.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(r)}
                      className="block w-full truncate rounded bg-zinc-100 px-1.5 py-0.5 text-left text-[11px] hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                      title={String(r.data.title || r.data.name || r.id)}
                    >
                      {String(r.data.title || r.data.name || r.id)}
                    </button>
                  </li>
                ))}
                {items.length > 4 && (
                  <li className="px-1.5 text-[10px] text-zinc-500">+{items.length - 4} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
