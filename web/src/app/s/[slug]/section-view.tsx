'use client';

import { useMemo, useState } from 'react';
import { naturalCompare, cn } from '@/lib/utils';
import { Plus, LayoutGrid, List, Trash2, Columns3, Calendar as CalendarIcon, FileSpreadsheet } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PreviewModal } from '@/components/preview-modal';
import { InlineCell, parseType } from '@/components/inline-cell';
import { AddByUrl } from '@/components/add-by-url';
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
  const [mode, setMode] = useState<'list' | 'grid' | 'kanban' | 'calendar'>('list');
  const [previewItem, setPreviewItem] = useState<{ url: string; title?: string; driveFileId?: string; hostPath?: string; rowId?: string; sectionSlug?: string; notes?: string } | null>(null);
  const qc = useQueryClient();

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
      hostPath: host ? host.slice(5).trim() : undefined,
      rowId: r.id,
      sectionSlug: section.slug,
      notes: String(r.data.notes || ''),
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
    if (!confirm('Delete this row?')) return;
    const r = await fetch(`/api/sections/${section.slug}/rows/${rowId}`, { method: 'DELETE' });
    if (!r.ok) { toast.error(`Delete failed: ${r.status}`); return; }
    setRows((rs) => rs.filter((x) => x.id !== rowId));
    qc.invalidateQueries({ queryKey: ['rows', section.slug] });
  }

  const createRow = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/sections/${section.slug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: {} }),
      });
      if (!r.ok) throw new Error(`add row: ${r.status}`);
      return (await r.json()) as Row;
    },
    onSuccess: (row) => {
      setRows((rs) => [...rs, row]);
      toast.success('Row added.');
      qc.invalidateQueries({ queryKey: ['rows', section.slug] });
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

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
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{section.title}</h1>
        <div className="flex flex-wrap items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-800">
          {([
            ['list', List, 'List'],
            ['grid', LayoutGrid, 'Grid'],
            ['kanban', Columns3, 'Kanban'],
            ['calendar', CalendarIcon, 'Calendar'],
          ] as const).map(([m, Icon, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                mode === m
                  ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                  : 'text-zinc-500',
              )}
              title={`${label} view`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
          <AddByUrl
            section={section}
            onAdded={(row) => setRows((rs) => [...rs, row])}
          />
          <button
            type="button"
            onClick={() => createRow.mutate()}
            disabled={createRow.isPending}
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            <Plus className="h-3.5 w-3.5" /> Add empty
          </button>
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
                toast.error((e as Error).message);
              }
            }}
            className="ml-1 inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            title="One-way export to a new Google Sheet"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> Sheets
          </button>
        </div>
      </header>

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Empty section. Click <strong>Add row</strong> to start.
        </p>
      ) : mode === 'list' ? (
        <Table section={section} rows={sorted} onOpen={openPreview} onPatch={patchRow} onDelete={deleteRow} />
      ) : mode === 'grid' ? (
        <GroupedGrid section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} />
      ) : mode === 'kanban' ? (
        <KanbanView section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} onPatch={patchRow} />
      ) : (
        <CalendarView section={section} rows={sorted} onOpen={openPreview} />
      )}
      <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
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
