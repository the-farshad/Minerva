'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { naturalCompare, cn } from '@/lib/utils';
import { Plus, LayoutGrid, List, Trash2, Columns3, Calendar as CalendarIcon, FileSpreadsheet, Upload, FileUp } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useServerEvents } from '@/hooks/use-server-events';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { PreviewModal } from '@/components/preview-modal';
import { InlineCell, parseType } from '@/components/inline-cell';
import { AddByUrl } from '@/components/add-by-url';
import { AddNote } from '@/components/add-note';
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
  // Curated per-preset — Tasks is Kanban-only by design, Notes
  // gets Kanban + Calendar (and the default Grid for browsing
  // freeform notes), media presets stick to List + Grid because
  // their rows aren't really board-shaped.
  const availableModes: readonly ('list' | 'grid' | 'kanban' | 'calendar')[] =
    section.preset === 'tasks'   ? (['kanban'] as const) :
    section.preset === 'notes'   ? (['grid'] as const) :
    isUrlKeyed                   ? (['list', 'grid'] as const) :
                                   (['list', 'grid', 'kanban', 'calendar'] as const);
  // Preset-aware default view mode. Tasks naturally read as a
  // Kanban board (drag-between-columns by status), so opening a
  // /s/tasks section to the same grey grid every other preset uses
  // felt like the preset "did nothing".
  const [mode, setMode] = useState<'list' | 'grid' | 'kanban' | 'calendar'>(
    section.preset === 'tasks' ? 'kanban' : 'grid',
  );
  const [previewItem, setPreviewItem] = useState<{ url: string; title?: string; driveFileId?: string; originalFileId?: string; hostPath?: string; rowId?: string; sectionSlug?: string; sectionPreset?: string | null; notes?: string; data?: Record<string, unknown> } | null>(null);
  const qc = useQueryClient();
  const router = useRouter();

  // Server-pushed updates patch the local rows array directly so
  // open modals, mid-edit drafts and scroll position aren't lost
  // to a router.refresh(). Other-tab / other-device mutations
  // propagate through this same path within ~1 RTT.
  useServerEvents((event) => {
    if (event.kind === 'row.created' && event.sectionSlug === section.slug) {
      setRows((rs) => rs.some((x) => x.id === event.rowId)
        ? rs
        : [{ id: event.rowId, data: event.data, updatedAt: new Date().toISOString() }, ...rs]);
    } else if (event.kind === 'row.updated' && event.sectionSlug === section.slug) {
      setRows((rs) => rs.map((r) => r.id === event.rowId
        ? { id: r.id, data: event.data, updatedAt: new Date().toISOString() }
        : r));
    } else if (event.kind === 'row.deleted' && event.sectionSlug === section.slug) {
      setRows((rs) => rs.filter((r) => r.id !== event.rowId));
    }
  });

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
    // Notes rows have no `url` — they ARE the content. Allow open
    // regardless; the modal's notes-preset branch renders the
    // markdown editor without needing an iframe target.
    if (!url && section.preset !== 'notes') return;
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
      sectionPreset: section.preset,
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
  async function createRow(data: Record<string, unknown>): Promise<Row | null> {
    try {
      const r = await fetch(`/api/sections/${section.slug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error(`add: ${r.status}`);
      const next = (await r.json()) as Row;
      // Dedupe: the SSE `row.created` event for the same insert
      // can arrive before the HTTP response on a fast LAN, which
      // would otherwise mount the row twice and "fix itself" on
      // the next refresh — exactly what the user reported.
      setRows((rs) => rs.some((x) => x.id === next.id) ? rs : [next, ...rs]);
      qc.invalidateQueries({ queryKey: ['rows', section.slug] });
      return next;
    } catch (e) {
      notify.error((e as Error).message);
      return null;
    }
  }
  // ---- Kanban column management ---------------------------------
  // Resolves which schema column carries the status enum — same
  // pickStatusField logic as the Kanban view itself but inlined
  // here since the View doesn't expose it.
  function pickStatusField(): string | null {
    for (const c of ['status', 'state', 'stage', 'column']) {
      if (section.schema.headers.includes(c)) return c;
    }
    return null;
  }
  function statusFieldOptions(field: string): string[] {
    const idx = section.schema.headers.indexOf(field);
    if (idx < 0) return [];
    const m = String(section.schema.types?.[idx] || '').match(/^select\(([^)]*)\)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  }

  async function addColumn(name: string) {
    const field = pickStatusField();
    if (!field) { notify.error('No status column on this section.'); return; }
    const current = statusFieldOptions(field);
    if (current.includes(name)) { notify.error(`Column "${name}" already exists.`); return; }
    const next = [...current, name];
    const r = await fetch(`/api/sections/${section.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setSelect: { column: field, options: next } }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `setSelect: ${r.status}`);
    }
    toast.success(`Added column "${name}".`);
    router.refresh();
  }
  async function renameColumn(from: string, to: string) {
    const field = pickStatusField();
    if (!field) { notify.error('No status column on this section.'); return; }
    // rewrite-tag handles both the schema's select(...) options AND
    // every row's `status` value in a single round-trip.
    const r = await fetch(`/api/sections/${section.slug}/rewrite-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: field, from, to }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `rename: ${r.status}`);
    }
    const j = (await r.json()) as { rewrote: number };
    toast.success(`Renamed — ${j.rewrote} card${j.rewrote === 1 ? '' : 's'} updated.`);
    router.refresh();
  }
  async function deleteColumn(col: string, moveTo: string | null) {
    const field = pickStatusField();
    if (!field) { notify.error('No status column on this section.'); return; }
    const r = await fetch(`/api/sections/${section.slug}/rewrite-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: field, from: col, to: moveTo, deleteOrphaned: false }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `delete: ${r.status}`);
    }
    const j = (await r.json()) as { rewrote: number };
    toast.success(moveTo
      ? `Column removed — ${j.rewrote} card${j.rewrote === 1 ? '' : 's'} moved to "${moveTo}".`
      : `Column removed — ${j.rewrote} card${j.rewrote === 1 ? '' : 's'} untagged.`);
    router.refresh();
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

  const effectivePreset = section.preset;

  // ---- Drag-and-drop file uploads --------------------------------
  // Works on every section preset. The Papers / YouTube branches
  // route to specialized endpoints that auto-extract metadata
  // (PDF title/authors/year, video duration/thumbnail). For
  // everything else, the file streams to Drive and a row is
  // created with whichever shape best fits the preset:
  //   - Notes: image MIME → type='sketch' + content=<url>;
  //     other MIME → type='md' + content='[name](url)'
  //   - Tasks + other: { title=<filename>, attachments=<url> }
  //     (with status=first-column for Tasks so it lands in
  //     the leftmost Kanban lane).
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  function isFileDrag(e: React.DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }
  function onDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!dragging) setDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  /** Upload a single file via the specialized Papers / YouTube
   *  endpoint when the MIME matches; fall through to a generic
   *  Drive upload + create-row for everything else. Returns the
   *  new row so the caller can splice it into local state. */
  async function uploadOne(file: File): Promise<Row | null> {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const isVideo = /\.(mp4|mkv|mov|webm|avi)$/i.test(file.name) || /^video\//i.test(file.type);
    const isImage = /^image\//i.test(file.type);

    // Specialized routes — Papers / YouTube where the matching file
    // type also matches the preset; richer metadata than the
    // generic path can produce.
    if (effectivePreset === 'papers' && isPdf) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await fetch(`/api/sections/${section.slug}/upload-paper`, { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string; id?: string; data?: Record<string, unknown>; updatedAt?: string };
      if (!r.ok || !j.id || !j.data || !j.updatedAt) throw new Error(j.error || `upload-paper: ${r.status}`);
      return { id: j.id, data: j.data, updatedAt: j.updatedAt };
    }
    if (effectivePreset === 'youtube' && isVideo) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await fetch(`/api/sections/${section.slug}/upload-video`, { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string; id?: string; data?: Record<string, unknown>; updatedAt?: string };
      if (!r.ok || !j.id || !j.data || !j.updatedAt) throw new Error(j.error || `upload-video: ${r.status}`);
      return { id: j.id, data: j.data, updatedAt: j.updatedAt };
    }

    // Notes preset: text-bearing files become rows with their
    // content extracted inline — no Drive round-trip needed. Capped
    // at 200 KB inline so a pasted log file doesn't bloat the row.
    // Larger files fall through to the generic Drive+link path.
    if (effectivePreset === 'notes' && !isImage) {
      const bareName = file.name.replace(/\.[^.]+$/, '');
      const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
      const INLINE_MAX = 200_000;
      const inline = async (type: 'text' | 'md', content: string): Promise<Row | null> => {
        if (content.length > INLINE_MAX) return null;
        return createRow({ title: bareName, type, content });
      };
      try {
        if (ext === 'txt' || file.type === 'text/plain') {
          const text = await file.text();
          const row = await inline('text', text);
          if (row) return row;
        } else if (ext === 'md' || ext === 'markdown' || file.type === 'text/markdown') {
          const text = await file.text();
          const row = await inline('md', text);
          if (row) return row;
        } else if (ext === 'docx') {
          // Dynamic import keeps the ~600 KB mammoth bundle out of
          // the initial page load; we only pull it in when the user
          // actually drops a Word doc on a notes section.
          const { default: mammoth } = await import('mammoth/mammoth.browser');
          const ab = await file.arrayBuffer();
          const result = await mammoth.convertToMarkdown({ arrayBuffer: ab });
          const md = result.value || '';
          const row = await inline('md', md);
          if (row) return row;
        }
      } catch (err) {
        notify.error(`Couldn't inline ${file.name}: ${(err as Error).message} — uploading as a link instead.`);
      }
      // Fall through to the generic Drive-upload path below for
      // anything else (oversize text, mammoth parse failure, .doc
      // legacy format, .rtf, …).
    }

    // Generic path — stream to Drive, then create a row whose
    // shape fits the preset.
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('name', file.name);
    fd.append('kind', 'misc');
    const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
    const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
    if (!r.ok || !j.fileId) throw new Error(j.error || `upload: ${r.status}`);
    const url = `/api/drive/file?id=${encodeURIComponent(j.fileId)}`;
    const headers = section.schema.headers;
    const bareName = file.name.replace(/\.[^.]+$/, '');

    let data: Record<string, unknown>;
    if (effectivePreset === 'notes') {
      data = isImage
        ? { title: bareName, type: 'sketch', content: url }
        : { title: bareName, type: 'md', content: `[${file.name}](${url})\n` };
    } else if (effectivePreset === 'tasks') {
      // Drop into the leftmost Kanban column so the new card is
      // immediately visible rather than tucked at the end.
      const statusIdx = headers.indexOf('status');
      const types = section.schema.types || [];
      const m = statusIdx >= 0 ? String(types[statusIdx] || '').match(/^select\(([^)]*)\)/) : null;
      const firstStatus = m ? m[1].split(',')[0].trim() : '';
      data = { title: bareName, attachments: url, ...(firstStatus ? { status: firstStatus } : {}) };
    } else {
      data = { title: bareName, attachments: url };
      // If the schema has no `attachments` header but does have
      // `url`, populate that instead so the row's link affordances
      // can find the file.
      if (!headers.includes('attachments') && headers.includes('url')) {
        data = { title: bareName, url };
      }
    }
    return createRow(data);
  }

  async function onDrop(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;

    setUploading(files.length);
    toast.info(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    let done = 0, failed = 0;
    for (const file of files) {
      try {
        const row = await uploadOne(file);
        if (!row) throw new Error('create-row failed');
        // createRow already prepends; uploadOne's specialized
        // branches return a fresh row that's NOT yet in setRows
        // (they bypassed createRow). Patch both shapes by ensuring
        // the row is present without duplicating.
        setRows((rs) => rs.some((x) => x.id === row.id) ? rs : [row, ...rs]);
        done++;
      } catch (err) {
        failed++;
        notify.error(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(0);
    toast.success(`Uploaded ${done}${failed ? ` · ${failed} failed` : ''}.`);
    qc.invalidateQueries({ queryKey: ['rows', section.slug] });
    router.refresh();
  }

  return (
    <main
      // Tasks board uses the full viewport so a many-column
      // Kanban can stretch wide before falling back to horizontal
      // scroll. Every other preset keeps the centred reading
      // width that suits row-list / grid layouts.
      className={cn(
        'w-full px-3 py-6 sm:px-6 sm:py-8',
        section.preset !== 'tasks' && 'mx-auto max-w-6xl',
      )}
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-blue-500 bg-white px-8 py-6 text-center shadow-xl dark:bg-zinc-900">
            <FileUp className="mx-auto h-10 w-10 text-blue-500" />
            <p className="mt-3 text-sm font-medium">Drop to upload</p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {effectivePreset === 'papers' ? 'PDFs get parsed for title / authors / year'
                : effectivePreset === 'youtube' ? 'Videos get duration + thumbnail'
                : effectivePreset === 'notes' ? 'Image → sketch · txt/md/docx → text content inline · other → linked'
                : effectivePreset === 'tasks' ? 'New card with the file attached'
                : 'New row with the file attached'} · uploads to your Drive
            </p>
          </div>
        </div>
      )}
      {uploading > 0 && (
        <div className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <Upload className="h-3.5 w-3.5 animate-pulse text-blue-500" />
          Uploading {uploading} file{uploading === 1 ? '' : 's'}…
        </div>
      )}
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
          {section.preset === 'notes' ? (
            <AddNote
              section={section}
              rows={rows}
              onAdded={(row) => setRows((rs) => rs.some((x) => x.id === row.id) ? rs : [row, ...rs])}
            />
          ) : (
            <AddByUrl
              section={section}
              onAdded={(row) => setRows((rs) => {
                const idx = rs.findIndex((x) => x.id === row.id);
                if (idx >= 0) {
                  const next = rs.slice();
                  next[idx] = row;
                  return next;
                }
                return [...rs, row];
              })}
            />
          )}
          {section.preset === 'papers' && (
            <UploadPaperButton
              slug={section.slug}
              onAdded={(row) => setRows((rs) => {
              const idx = rs.findIndex((x) => x.id === row.id);
              if (idx >= 0) {
                const next = rs.slice();
                next[idx] = row;
                return next;
              }
              return [...rs, row];
            })}
            />
          )}
          {/* URL-keyed presets (youtube / papers) only accept rows
            * via Add-by-URL. Notes has its own typed-creation
            * dialog. Tasks has per-column "+ Add card" inline
            * composers in the Kanban view so a header-level quick
            * add would create rows in a no-status bucket and just
            * add confusion. Everything else gets a quick-add input
            * so the row lands with a title already on it. */}
          {section.preset !== 'youtube' && section.preset !== 'papers' && section.preset !== 'notes' && section.preset !== 'tasks' && (
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
                setRows((rs) => rs.some((x) => x.id === row.id) ? rs : [...rs, row]);
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
                qc.invalidateQueries({ queryKey: ['rows', section.slug] });
                router.refresh();
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

      {(() => {
        const eff = (availableModes as readonly string[]).includes(mode) ? mode : 'grid';
        // Kanban (Tasks) renders even on an empty board — the
        // columns ARE the affordance for adding the first card.
        // Every other mode keeps the empty-state placeholder.
        if (sorted.length === 0 && eff !== 'kanban') {
          return (
            <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
              Empty section. Click <strong>Add</strong> to start.
            </p>
          );
        }
        if (eff === 'list')     return <Table section={section} rows={sorted} onOpen={openPreview} onPatch={patchRow} onDelete={deleteRow} />;
        if (eff === 'grid')     return <GroupedGrid section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} onRowUpdated={(row) => setRows((rs) => rs.map((x) => (x.id === row.id ? row : x)))} />;
        if (eff === 'kanban')   return <KanbanView section={section} rows={sorted} onOpen={openPreview} onDelete={deleteRow} onPatch={patchRow} onCreate={createRow} onAddColumn={addColumn} onRenameColumn={renameColumn} onDeleteColumn={deleteColumn} />;
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
        onRowDataChanged={(rowId, data) => {
          setRows((rs) => rs.map((x) => (
            x.id === rowId ? { ...x, data, updatedAt: new Date().toISOString() } : x
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
  // Pick which columns to hide on narrow screens — title (or name)
  // always wins, then the second column shows from sm:, the rest
  // from md:. Without this every column scrolled horizontally
  // simultaneously, which on a phone reads as a one-column row of
  // truncated cells. The full table is still reachable via
  // horizontal scroll for users who want every column.
  const colVisibility = (idx: number, name: string): string =>
    name === 'title' || name === 'name' || idx === 0
      ? ''
      : idx === 1
        ? 'hidden sm:table-cell'
        : 'hidden md:table-cell';
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wider text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {headers.map((h, i) => (
              <th key={h} className={`px-3 py-2 font-medium ${colVisibility(i, h)}`}>{h}</th>
            ))}
            <th className="w-10 px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900">
              {headers.map((h, i) => (
                <td key={h} className={`px-2 py-1 align-top ${colVisibility(i, h)}`}>
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
