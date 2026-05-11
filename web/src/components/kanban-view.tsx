'use client';

import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string };
type Section = { slug: string; schema: { headers: string[]; types: string[] } };

const STATUS_CANDIDATES = ['status', 'state', 'stage', 'column'];

function pickStatusField(headers: string[]): string | null {
  for (const c of STATUS_CANDIDATES) if (headers.includes(c)) return c;
  return null;
}

/**
 * Kanban view — groups rows into columns by their `status` (or
 * fallback) value. Status changes are handled by dragging a card
 * onto a different column; the drop fires the supplied onMove.
 */
export function KanbanView({
  section, rows, onOpen, onDelete, onPatch,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onDelete: (rowId: string) => Promise<void>;
  onPatch: (rowId: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const statusField = useMemo(() => pickStatusField(section.schema.headers), [section.schema.headers]);
  const titleField = useMemo(() => {
    if (section.schema.headers.includes('title')) return 'title';
    if (section.schema.headers.includes('name')) return 'name';
    return null;
  }, [section.schema.headers]);

  const columns = useMemo(() => {
    const seen = new Map<string, Row[]>();
    if (!statusField) {
      seen.set('All', rows.slice());
      return Array.from(seen.entries());
    }
    for (const r of rows) {
      const v = String(r.data[statusField] || '').trim() || '—';
      const arr = seen.get(v) ?? [];
      arr.push(r);
      seen.set(v, arr);
    }
    return Array.from(seen.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, statusField]);

  function onDrop(e: React.DragEvent, col: string) {
    e.preventDefault();
    const rowId = e.dataTransfer.getData('text/plain');
    if (!rowId || !statusField) return;
    void onPatch(rowId, { [statusField]: col });
  }

  if (!statusField) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Kanban needs a <code>status</code> (or <code>state</code> / <code>stage</code>) column. Edit the schema in Settings.
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map(([col, items]) => (
        <div
          key={col}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => onDrop(e, col)}
          className="w-72 shrink-0 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/50"
        >
          <div className="mb-2 flex items-baseline justify-between px-2 text-xs">
            <strong className="uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{col}</strong>
            <span className="text-zinc-500">{items.length}</span>
          </div>
          <ul className="space-y-2">
            {items.map((r) => (
              <li
                key={r.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}
                className="group relative cursor-grab rounded-md border border-zinc-200 bg-white p-2 text-sm shadow-sm hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="block w-full text-left"
                >
                  <div className="line-clamp-2 text-sm font-medium">
                    {titleField ? String(r.data[titleField] ?? '(untitled)') : r.id}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  className="absolute right-1 top-1 rounded-full p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                  title="Delete row"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
