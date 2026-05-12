'use client';

import { useMemo, useRef, useState } from 'react';
import { Trash2, Plus, MoreVertical, Calendar as CalIcon, CheckSquare, Square, Paperclip, StickyNote, GripVertical } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { appConfirm } from './confirm';
import { readPref, writePref } from '@/lib/prefs';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string };
type Section = { slug: string; schema: { headers: string[]; types: string[] } };

const STATUS_CANDIDATES = ['status', 'state', 'stage', 'column'];

function pickStatusField(headers: string[]): string | null {
  for (const c of STATUS_CANDIDATES) if (headers.includes(c)) return c;
  return null;
}
function titleFieldFor(headers: string[]): string | null {
  if (headers.includes('title')) return 'title';
  if (headers.includes('name')) return 'name';
  return null;
}

/** Pull the schema-declared options out of a `select(a,b,c)` /
 * `multiselect(a,b,c)` type string. Falls back to whatever values
 * actually appear in rows when the type isn't enum-shaped. */
function schemaOptions(section: Section, field: string): string[] {
  const idx = section.schema.headers.indexOf(field);
  if (idx < 0) return [];
  const t = String(section.schema.types?.[idx] || '');
  const m = t.match(/^(?:multi)?select\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

type Priority = 'low' | 'med' | 'high' | null;
function readPriority(v: unknown): Priority {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low' || s === 'med' || s === 'high') return s;
  return null;
}
function readDue(v: unknown): { iso: string; label: string; overdue: boolean } | null {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = d < today;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const label = d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: '2-digit', month: 'short', day: 'numeric' });
  return { iso: d.toISOString(), label, overdue };
}
function readTags(v: unknown): string[] {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
type Subtask = { id: string; label: string; done: boolean };
function readSubtasks(v: unknown): Subtask[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'object' && x ? { id: String((x as Subtask).id), label: String((x as Subtask).label || ''), done: !!(x as Subtask).done } : null))
    .filter(Boolean) as Subtask[];
}

const PRIORITY_BAND: Record<NonNullable<Priority>, string> = {
  low:  'border-l-emerald-400',
  med:  'border-l-amber-400',
  high: 'border-l-red-500',
};

/** Trello-style Kanban. Groups rows into columns by their
 * status (or schema-equivalent). Each card shows due / priority /
 * tags chips, a count of subtasks, and a 3-dots overflow with
 * subtasks / paperclip / notes / delete. Drag-and-drop reorders
 * within a column AND moves between columns; per-column ordering
 * is persisted client-side under `kanban.order.<slug>.<col>`.
 */
export function KanbanView({
  section, rows, onOpen, onDelete, onPatch, onCreate,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onDelete: (rowId: string) => Promise<void>;
  onPatch: (rowId: string, patch: Record<string, unknown>) => Promise<void>;
  /** Create a row from a partial data object. Returning the new row
   * lets us update local state without a hard refresh. */
  onCreate: (data: Record<string, unknown>) => Promise<Row | null>;
}) {
  const statusField = useMemo(() => pickStatusField(section.schema.headers), [section.schema.headers]);
  const titleField = useMemo(() => titleFieldFor(section.schema.headers), [section.schema.headers]);

  // Canonical column order — schema's select(...) options first
  // (so "Backlog → Doing → Done" reads in the right direction),
  // then any extra values rows are actually using.
  const orderedColumns = useMemo(() => {
    if (!statusField) return ['All'];
    const canonical = schemaOptions(section, statusField);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of canonical) { if (!seen.has(c)) { out.push(c); seen.add(c); } }
    for (const r of rows) {
      const v = String(r.data[statusField] || '').trim() || '—';
      if (!seen.has(v)) { out.push(v); seen.add(v); }
    }
    return out;
  }, [rows, statusField, section]);

  // Per-column manual order — client-side prefs, keyed by section
  // slug + column name. Drag-to-reorder writes the new id list.
  const [order, setOrder] = useState<Record<string, string[]>>(() => readPref(`kanban.order.${section.slug}`, {}));
  function saveOrder(next: Record<string, string[]>) {
    setOrder(next);
    writePref(`kanban.order.${section.slug}`, next);
  }

  const columns = useMemo(() => {
    const byCol = new Map<string, Row[]>();
    for (const c of orderedColumns) byCol.set(c, []);
    for (const r of rows) {
      const v = statusField ? (String(r.data[statusField] || '').trim() || '—') : 'All';
      if (!byCol.has(v)) byCol.set(v, []);
      byCol.get(v)!.push(r);
    }
    // Apply the manual id order on top.
    for (const [col, items] of byCol) {
      const ids = order[col] || [];
      const idIdx = new Map(ids.map((id, i) => [id, i] as const));
      items.sort((a, b) => {
        const ai = idIdx.has(a.id) ? idIdx.get(a.id)! : 1e9;
        const bi = idIdx.has(b.id) ? idIdx.get(b.id)! : 1e9;
        if (ai !== bi) return ai - bi;
        return a.updatedAt < b.updatedAt ? 1 : -1; // newest-first as fallback
      });
    }
    return Array.from(byCol.entries());
  }, [rows, orderedColumns, statusField, order]);

  const draggedId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<{ col: string; before: string | null } | null>(null);

  function onDragStart(e: React.DragEvent, rowId: string) {
    draggedId.current = rowId;
    e.dataTransfer.setData('text/plain', rowId);
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragEnd() {
    draggedId.current = null;
    setDragOver(null);
  }
  function onDragOverCol(e: React.DragEvent, col: string, beforeId: string | null) {
    e.preventDefault();
    setDragOver((cur) => (cur?.col === col && cur.before === beforeId ? cur : { col, before: beforeId }));
  }
  async function onDropCol(e: React.DragEvent, col: string) {
    e.preventDefault();
    const rowId = draggedId.current || e.dataTransfer.getData('text/plain');
    if (!rowId) return;
    const targetBefore = dragOver?.col === col ? dragOver.before : null;
    setDragOver(null);
    draggedId.current = null;

    // Compute the new ordered id list for the target column.
    const previous = columns.find(([c]) => c === col)?.[1].map((r) => r.id) || [];
    const dragRow = rows.find((r) => r.id === rowId);
    const prevCol = dragRow && statusField ? (String(dragRow.data[statusField] || '').trim() || '—') : col;
    const filtered = previous.filter((id) => id !== rowId);
    const insertAt = targetBefore === null ? filtered.length : filtered.indexOf(targetBefore);
    const next = filtered.slice(0, Math.max(0, insertAt));
    next.push(rowId);
    if (targetBefore !== null && insertAt >= 0) next.push(...filtered.slice(insertAt));

    const nextOrder = { ...order, [col]: next };
    if (prevCol !== col) {
      nextOrder[prevCol] = (order[prevCol] || []).filter((id) => id !== rowId);
    }
    saveOrder(nextOrder);

    if (statusField && prevCol !== col) {
      try { await onPatch(rowId, { [statusField]: col === '—' ? '' : col }); }
      catch { /* parent surfaces toast */ }
    }
  }

  async function addCard(col: string) {
    if (!statusField || !titleField) {
      notify.error('This section needs `title` + `status` columns to add cards.');
      return;
    }
    const data: Record<string, unknown> = { [titleField]: 'New task', [statusField]: col === '—' ? '' : col };
    try {
      const created = await onCreate(data);
      if (!created) throw new Error('add failed');
      toast.success('Card added.');
    } catch (e) {
      notify.error((e as Error).message);
    }
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
          onDragOver={(e) => onDragOverCol(e, col, null)}
          onDrop={(e) => onDropCol(e, col)}
          className={`w-72 shrink-0 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/50 ${dragOver?.col === col ? 'ring-2 ring-blue-500/40' : ''}`}
        >
          <header className="mb-2 flex items-center justify-between px-2 text-xs">
            <strong className="uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{col}</strong>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">{items.length}</span>
              <button
                type="button"
                onClick={() => addCard(col)}
                title={`Add card to "${col}"`}
                className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>
          <ul className="space-y-2">
            {items.map((r) => (
              <KanbanCard
                key={r.id}
                row={r}
                titleField={titleField}
                section={section}
                onOpen={() => onOpen(r)}
                onDelete={() => onDelete(r.id)}
                onPatch={(patch) => onPatch(r.id, patch)}
                onDragStart={(e) => onDragStart(e, r.id)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => onDragOverCol(e, col, r.id)}
                highlightBefore={dragOver?.col === col && dragOver.before === r.id}
              />
            ))}
            {items.length === 0 && (
              <li className="rounded-md border border-dashed border-zinc-300 p-3 text-center text-[11px] text-zinc-400 dark:border-zinc-700">
                Drop a card here
              </li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

function KanbanCard({
  row, titleField, section, onOpen, onDelete, onPatch, onDragStart, onDragEnd, onDragOver, highlightBefore,
}: {
  row: Row;
  titleField: string | null;
  section: Section;
  onOpen: () => void;
  onDelete: () => Promise<void>;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  highlightBefore: boolean;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const title = titleField ? String(row.data[titleField] ?? '') : '';
  const priority = readPriority(row.data.priority);
  const due = readDue(row.data.due);
  const tags = readTags(row.data.tags);
  const subtasks = readSubtasks(row.data.subtasks);
  const subDone = subtasks.filter((s) => s.done).length;
  const subTotal = subtasks.length;
  const attachments = String(row.data.attachments || '').split(/\s+|,/).filter((s) => /^https?:\/\/|\/api\/drive\/file/.test(s));
  const [subOpen, setSubOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function commitTitle(next: string) {
    setEditingTitle(false);
    if (!titleField) return;
    const t = next.trim();
    if (!t || t === title) return;
    await onPatch({ [titleField]: t });
  }
  async function setStatus(next: string) {
    const sf = pickStatusField(section.schema.headers);
    if (!sf) return;
    await onPatch({ [sf]: next });
  }
  async function setPriority(next: NonNullable<Priority>) {
    await onPatch({ priority: next });
  }
  async function toggleSubtask(id: string) {
    const next = subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s));
    await onPatch({ subtasks: next });
  }
  async function addSubtask(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const next: Subtask[] = [...subtasks, { id: crypto.randomUUID(), label: trimmed, done: false }];
    await onPatch({ subtasks: next });
  }
  async function removeSubtask(id: string) {
    const next = subtasks.filter((s) => s.id !== id);
    await onPatch({ subtasks: next });
  }
  async function uploadFiles(files: FileList) {
    const list = Array.from(files);
    if (!list.length) return;
    toast.info(`Uploading ${list.length} file${list.length === 1 ? '' : 's'}…`);
    const urls: string[] = [];
    for (const file of list) {
      try {
        const fd = new FormData();
        fd.append('file', file, file.name);
        fd.append('name', file.name);
        fd.append('kind', 'misc');
        const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
        const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
        if (!r.ok || !j.fileId) throw new Error(j.error || `upload: ${r.status}`);
        urls.push(`/api/drive/file?id=${encodeURIComponent(j.fileId)}`);
      } catch (e) {
        notify.error(`${file.name}: ${(e as Error).message}`);
      }
    }
    if (urls.length === 0) return;
    const existing = String(row.data.attachments || '').trim();
    const next = (existing ? existing + '\n' : '') + urls.join('\n');
    await onPatch({ attachments: next });
    toast.success(`Attached ${urls.length} file${urls.length === 1 ? '' : 's'}.`);
  }

  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className={`group relative cursor-grab rounded-md border border-l-4 ${priority ? PRIORITY_BAND[priority] : 'border-l-zinc-200 dark:border-l-zinc-700'} border-zinc-200 bg-white p-2 text-sm shadow-sm hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 ${highlightBefore ? 'mt-3 border-t-2 border-t-blue-500' : ''}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); }}
      />
      <GripVertical className="absolute left-1 top-2 hidden h-3 w-3 text-zinc-300 group-hover:block" />
      <div className="absolute right-1 top-1 z-10" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="rounded-full p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Actions"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end" sideOffset={4}
              className="z-50 min-w-[10rem] rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); onOpen(); }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <StickyNote className="h-3.5 w-3.5" /> Open notes
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); fileInputRef.current?.click(); }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Paperclip className="h-3.5 w-3.5" /> Attach files
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); setSubOpen((v) => !v); }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <CheckSquare className="h-3.5 w-3.5" /> Subtasks ({subDone}/{subTotal})
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  Priority
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="z-50 rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
                    {(['low', 'med', 'high'] as const).map((p) => (
                      <DropdownMenu.Item
                        key={p}
                        onSelect={(e) => { e.preventDefault(); void setPriority(p); }}
                        className="cursor-pointer rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        {p}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
              <DropdownMenu.Item
                onSelect={async (e) => {
                  e.preventDefault();
                  const ok = await appConfirm('Delete this task?', { dangerLabel: 'Delete' });
                  if (ok) void onDelete();
                }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-red-600 outline-none hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="pl-3">
        {editingTitle ? (
          <input
            autoFocus
            defaultValue={title}
            onBlur={(e) => void commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitTitle((e.target as HTMLInputElement).value); }
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="w-full rounded border border-zinc-300 bg-white px-1 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditingTitle(true); }}
            className="block w-full text-left line-clamp-3 text-sm font-medium hover:underline"
            title="Click to rename"
          >
            {title || '(untitled)'}
          </button>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
          {due && (
            <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 ${due.overdue ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}`}>
              <CalIcon className="h-2.5 w-2.5" /> {due.label}
            </span>
          )}
          {priority && (
            <span className={`rounded-full px-1.5 py-0.5 ${priority === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : priority === 'med' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'}`}>
              {priority}
            </span>
          )}
          {subTotal > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSubOpen((v) => !v); }}
              className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              title={`${subDone} of ${subTotal} subtasks done`}
            >
              <CheckSquare className="h-2.5 w-2.5" /> {subDone}/{subTotal}
            </button>
          )}
          {attachments.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <Paperclip className="h-2.5 w-2.5" /> {attachments.length}
            </span>
          )}
          {tags.slice(0, 3).map((t) => (
            <span key={t} className="rounded-full bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{t}</span>
          ))}
        </div>
        {subOpen && (
          <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800" onClick={(e) => e.stopPropagation()}>
            {subtasks.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={s.done}
                  onChange={() => void toggleSubtask(s.id)}
                  className="h-3 w-3"
                />
                {s.done ? <span className="text-zinc-400 line-through">{s.label}</span> : <span>{s.label}</span>}
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); void removeSubtask(s.id); }}
                  className="ml-auto hidden text-zinc-400 hover:text-red-500 group-hover:inline"
                  title="Remove subtask"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </label>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (e.currentTarget.elements.namedItem('label') as HTMLInputElement);
                void addSubtask(input.value);
                input.value = '';
              }}
              className="flex items-center gap-1"
            >
              <Square className="h-3 w-3 text-zinc-400" />
              <input
                name="label"
                placeholder="Add subtask + Enter"
                className="flex-1 rounded border-0 bg-transparent text-[11px] placeholder-zinc-400 focus:outline-none focus:ring-0"
              />
            </form>
          </div>
        )}
      </div>
    </li>
  );
}
