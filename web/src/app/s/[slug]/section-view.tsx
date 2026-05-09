'use client';

import { useMemo, useState } from 'react';
import { naturalCompare, cn } from '@/lib/utils';
import { Plus, LayoutGrid, List } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PreviewModal } from '@/components/preview-modal';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string };
type Section = {
  id: string;
  slug: string;
  title: string;
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
  const [mode, setMode] = useState<'list' | 'grid'>('list');
  const [previewItem, setPreviewItem] = useState<{ url: string; title?: string; driveFileId?: string; hostPath?: string } | null>(null);
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
    });
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
        <div className="flex items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setMode('list')}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
              mode === 'list'
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500',
            )}
            title="List view"
          >
            <List className="h-3.5 w-3.5" /> List
          </button>
          <button
            type="button"
            onClick={() => setMode('grid')}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
              mode === 'grid'
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500',
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Grid
          </button>
          <button
            type="button"
            onClick={() => createRow.mutate()}
            disabled={createRow.isPending}
            className="ml-2 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            <Plus className="h-3.5 w-3.5" /> Add row
          </button>
        </div>
      </header>

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Empty section. Click <strong>Add row</strong> to start.
        </p>
      ) : mode === 'list' ? (
        <Table section={section} rows={sorted} onOpen={openPreview} />
      ) : (
        <Grid section={section} rows={sorted} onOpen={openPreview} />
      )}
      <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
    </main>
  );
}

function Table({ section, rows, onOpen }: { section: Section; rows: Row[]; onOpen: (r: Row) => void }) {
  const headers = section.schema.headers.filter((h) => !h.startsWith('_') && h !== 'id');
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wider text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
              onClick={() => onOpen(r)}
            >
              {headers.map((h) => (
                <td key={h} className="px-3 py-2">
                  {String(r.data[h] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Grid({ section, rows, onOpen }: { section: Section; rows: Row[]; onOpen: (r: Row) => void }) {
  const titleField = section.schema.headers.includes('title')
    ? 'title'
    : section.schema.headers.includes('name')
    ? 'name'
    : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r)}
          className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div className="text-sm font-medium">
            {titleField ? String(r.data[titleField] ?? '(untitled)') : '(row)'}
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            {new Date(r.updatedAt).toLocaleDateString()}
          </div>
        </button>
      ))}
    </div>
  );
}
