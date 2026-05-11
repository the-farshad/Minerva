'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { naturalCompare, cn } from '@/lib/utils';
import { Plus, LayoutGrid, List, Trash2, Columns3, Calendar as CalendarIcon, FileSpreadsheet, Upload, FileUp } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { PreviewModal } from '@/components/preview-modal';
import { InlineCell, parseType } from '@/components/inline-cell';
import { AddByUrl } from '@/components/add-by-url';
import { appConfirm } from '@/components/confirm';
import { appPrompt } from '@/components/prompt';
import { GroupedGrid } from '@/components/grouped-grid';
import { KanbanView } from '@/components/kanban-view';
import { CalendarView } from '@/components/calendar-view';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string };
type Section = {
  id: string;
  slug: string;
  title: string;
  preset?: string | null;
  schema: { headers: string[]; types: string[] };
};

export function SectionView({
  section,
  initialRows,
}: {
  section: Section;
  initialRows: Row[];
}) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  // URL-keyed presets (youtube / papers) only show list + grid —
  // kanban needs a `status` column they don't carry and calendar
  // needs a due-date column they don't carry. Everything else gets
  // the full set.
  const isUrlKeyed = section.preset === 'youtube' || section.preset === 'papers';
  const availableModes = isUrlKeyed
    ? (['list', 'grid'] as const)
    : (['list', 'grid', 'kanban', 'calendar'] as const);
  const [mode, setMode] = useState<'list' | 'grid' | 'kanban' | 'calendar'>('grid');
  const [previewItem, setPreviewItem] = useState<{ url: string; title?: string; driveFileId?: string; originalFileId?: string; hostPath?: string; rowId?: string; sectionSlug?: string; notes?: string; data?: Record<string, unknown> } | null>(null);
  const qc = useQueryClient();

  const search = useSearchParams();
  // When a search hit deep-links into this section with `?row=<id>`,
  // auto-open the matching row's preview so the user lands on the
  // exact thing they searched for instead of having to scan a page.
  useEffect(() => {
    const wantedId = search?.get('row');
    if (!wantedId) return;
    const r = rows.find((x) => x.id === wantedId);
    if (r) openPreview(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function openPreview(r: Row) {
    const url = String(r.data.url || '');
    if (!url) return;
    const offline = String(r.data.offline || '');
    const drive = offline.match(/drive:([\w-]{20,})/);
    const host = offline.split(' · ').map((s) => s.trim()).find((s) => s.startsWith('host:'));
    setPreviewItem({
      url,
      title: String(r.data.title || r.data.name || ''),
      driveFileId: drive ? drive[1] : undefined,
      originalFileId: r.data.originalFileId ? String(r.data.originalFileId) : undefined,
      hostPath: host ? host.slice(5).trim() : undefined,
      rowId: r.id,
      sectionSlug: section.slug,
      notes: String(r.data.notes || ''),
      data: r.data,
    });
  }

  async function patchRow(rowId: string, patch: Record<string, unknown>) {
    const r = await fetch(`/api/sections/${section.slug}/rows/${rowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: patch }),
    });
    if (!r.ok) throw new Error(`save: ${r.status}`);
    const next = (await r.json()) as Row;
    setRows((rs) => rs.map((x) => (x.id === rowId ? next : x)));
  }
  async function deleteRow(rowId: string) {
    if (!(await appConfirm('Delete this row?', { dangerLabel: 'Delete' }))) return;
    const r = await fetch(`/api/sections/${section.slug}/rows/${rowId}`, { method: 'DELETE' });
    if (!r.ok) { notify.error(`Delete failed: ${r.status}`); return; }
    setRows((rs) => rs.filter((x) => x.id !== rowId));
    qc.invalidateQueries({ queryKey: ['rows', section.slug] });
  }

  const titleField = useMemo(() => {
    if (section.schema.headers.includes('title')) return 'title';
    if (section.schema.headers.includes('name')) return 'name';
    return null;
  }, [section.schema.headers]);

  const sorted = useMemo(() => {
    const out = rows.slice();
    if (titleField) {
      out.sort((a, b) =>
        naturalCompare(
          String(a.data[titleField] || ''),
          String(b.data[titleField] || ''),
        ),
      );
    }
    return out;
  }, [rows, titleField]);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{section.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-800">
            {(([
              ['list', List, 'List'],
              ['grid', LayoutGrid, 'Grid'],
              ['kanban', Columns3, 'Kanban'],
              ['calendar', CalendarIcon, 'Calendar'],
            ] as const).filter(([m]) => (availableModes as readonly string[]).includes(m))
            ).map(([m, Icon, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                  mode === m
                    ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
                )}
                title={`${label} view`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          <AddByUrl
            section={section}
            onAdded={(row) => setRows((rs) => [...rs, row])}
          />
          {section.preset === 'papers' && (
            <UploadPaperButton
              slug={section.slug}
              onAdded={(row) => setRows((rs) => [...rs, row])}
            />
          )}
          {/* URL-keyed presets only accept rows via Add-by-URL. Other
            * sections (tasks / notes / projects / habits / inbox /
            * bookmarks) get a quick-add input so the row lands with a
            * title already on it — no more blank-row dead weight. */}
          {section.preset !== 'youtube' && section.preset !== 'papers' && (
            <QuickAdd
              titleField={titleField}
              onCreate={async (title) => {
                const r = await fetch(`/api/sections/${section.slug}/rows`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ data: titleField ? { [titleField]: title } : { title } }),
                });
                if (!r.ok) { notify.error(`Add failed: ${r.status}`); return; }
                const row = (await r.json()) as Row;
                setRows((rs) => [...rs, row]);
                qc.invalidateQueries({ queryKey: ['rows', section.slug] });
              }}
            />
          )}
          <button
            type="button"
            onClick={async () => {
              toast.info('Exporting to Sheets…');
              try {
                const r = await fetch(`/api/sections/${section.slug}/export-sheet`, { method: 'POST' });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || String(r.status));
                toast.success(`Exported ${j.rows} rows.`, {
                  action: { label: 'Open', onClick: () => window.open(j.webViewLink, '_blank') },
                });
              } catch (e) {
                notify.error((e as Error).message);
              }
            }}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            title="One-way export to a new Google Sheet"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> Sheets
          </button>
          <button
            type="button"
            onClick={async () => {
              const input = await appPrompt('Import from Google Sheet', {
                body: 'Paste the Sheet URL or id. Rows merge by `id` when present, otherwise append.',
                placeholder: 'https://docs.google.com/spreadsheets/d/…',
                okLabel: 'Import',
              });
              if (!input) return;
              toast.info('Importing from Sheet…');
              try {
                const r = await fetch(`/api/sections/${section.slug}/import-sheet`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sheetIdOrUrl: input, mode: 'merge' }),
                });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || String(r.status));
                toast.success(`Imported · ${j.inserted} new, ${j.updated} updated.`);
                location.reload();
              } catch (e) {
                notify.error((e as Error).message);
              }
            }}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            title="Pull rows from a Google Sheet (merge by id, append otherwise)"
          >
            <Upload className="h-3.5 w-3.5" /> Import
          </button>
        </div>
      </header>

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Empty section. Click <strong>Add row</strong> to start.
        </p>
      ) : (() => {
        const eff = (availableModes as readonly string[]).includes(mode) ? mode : 'grid';
        if (eff === 'list')     return <Table section={section} rows={sorted} onOpen={openPreview} onPatch={patchRow} onDelete={deleteRow} />;
        if (eff === 'grid')     return <GroupedGrid section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} />;
        if (eff === 'kanban')   return <KanbanView section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} onPatch={patchRow} />;
        return <CalendarView section={section} rows={sorted} onOpen={openPreview} />;
      })()}
      <PreviewModal
        item={previewItem}
        onClose={() => setPreviewItem(null)}
        onNotesSaved={(rowId, notes) => {
          setRows((rs) => rs.map((x) => (
            x.id === rowId ? { ...x, data: { ...x.data, notes } } : x
          )));
        }}
      />
    </main>
  );
}

function Table({
  section, rows, onOpen, onPatch, onDelete,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onPatch: (rowId: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (rowId: string) => Promise<void>;
}) {
  const headers = section.schema.headers.filter((h) => !h.startsWith('_') && h !== 'id');
  const types = headers.map((_, i) => parseType(section.schema.types?.[section.schema.headers.indexOf(headers[i])] || 'text'));
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wider text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
            <th className="w-10 px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900">
              {headers.map((h, i) => (
                <td key={h} className="px-2 py-1 align-top">
                  {h === 'url' ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="Open preview"
                        onClick={(e) => { e.stopPropagation(); onOpen(r); }}
                        className="rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                      >
                        ▶
                      </button>
                      <InlineCell
                        value={r.data[h]}
                        type={types[i]}
                        onCommit={(next) => onPatch(r.id, { [h]: next })}
                      />
                    </div>
                  ) : (
                    <InlineCell
                      value={r.data[h]}
                      type={types[i]}
                      onCommit={(next) => onPatch(r.id, { [h]: next })}
                    />
                  )}
                </td>
              ))}
              <td className="px-2 py-1 align-top text-right">
                <button
                  type="button"
                  title="Delete row"
                  onClick={() => onDelete(r.id)}
                  className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UploadPaperButton({
  slug, onAdded,
}: {
  slug: string;
  onAdded: (row: Row) => void;
}) {
  const inputRef = useMemo(() => ({ current: null as HTMLInputElement | null }), []);
  const [busy, setBusy] = useState(false);
  async function pick() {
    if (!inputRef.current) return;
    inputRef.current.value = '';
    inputRef.current.click();
  }
  async function onFile(file: File) {
    if (!file) return;
    setBusy(true);
    toast.info('Uploading + extracting metadata…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/sections/${slug}/upload-paper`, { method: 'POST', body: fd });
      const text = await r.text();
      let j: { id?: string; data?: Record<string, unknown>; updatedAt?: string; extracted?: { title?: string }; error?: string } = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
      if (!r.ok) throw new Error(j.error || `upload: ${r.status}`);
      if (j.id && j.data && j.updatedAt) onAdded({ id: j.id, data: j.data, updatedAt: j.updatedAt });
      const got = j.extracted?.title ? ` · title: "${j.extracted.title}"` : '';
      toast.success('Uploaded.' + got);
    } catch (e) {
      notify.error('Upload failed: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
        title="Upload a PDF — metadata is auto-extracted from the file"
      >
        <FileUp className="h-3.5 w-3.5" /> Upload PDF
      </button>
      <input
        ref={(el) => { inputRef.current = el; }}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
      />
    </>
  );
}

function QuickAdd({
  titleField, onCreate,
}: {
  titleField: string | null;
  onCreate: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await onCreate(v);
      setValue('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="flex items-center gap-1"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={titleField ? `New ${titleField}…` : 'New row title…'}
        className="w-44 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50"
        title={titleField ? `Create with ${titleField} set` : 'Create row'}
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </button>
    </form>
  );
}

// Legacy flat grid — superseded by GroupedGrid. Kept for sections
// without a grouping column when we want a no-frills layout.
function _LegacyGrid({
  section, rows, onOpen, onDelete,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onDelete: (rowId: string) => Promise<void>;
}) {
  const titleField = section.schema.headers.includes('title')
    ? 'title'
    : section.schema.headers.includes('name')
    ? 'name'
    : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {rows.map((r) => (
        <div
          key={r.id}
          className="group relative rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <button
            type="button"
            onClick={() => onOpen(r)}
            className="block w-full text-left"
          >
            <div className="text-sm font-medium">
              {titleField ? String(r.data[titleField] ?? '(untitled)') : '(row)'}
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              {new Date(r.updatedAt).toLocaleDateString()}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDelete(r.id)}
            title="Delete row"
            className="absolute right-2 top-2 rounded-full p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
