'use client';

import { useState, useMemo, useEffect } from 'react';
import { Trash2, GripVertical, ChevronDown, ChevronRight, Cloud, HardDrive, Server, Save, Info } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { toast } from 'sonner';
import { appConfirm } from './confirm';
import { appPrompt } from './prompt';
import { appPickMany } from './multi-picker';
import { naturalCompare, cn } from '@/lib/utils';
import { readPref, writePref, type GroupSort, type SectionGroupSort } from '@/lib/prefs';
import { GroupNotes } from './group-notes';

export type Row = { id: string; data: Record<string, unknown>; updatedAt: string };

function OfflineBadges({ marker }: { marker: string }) {
  const has = (p: string) => marker.split(' · ').some((s) => s.trim().startsWith(p));
  const hasDrive = has('drive:');
  const hasLocal = has('local:');
  const hasHost = has('host:');
  if (!hasDrive && !hasLocal && !hasHost) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-zinc-400">
      {hasDrive && <Cloud className="h-3 w-3" aria-label="On Drive" />}
      {hasLocal && <HardDrive className="h-3 w-3" aria-label="On local mirror" />}
      {hasHost && <Server className="h-3 w-3" aria-label="On helper" />}
    </div>
  );
}

type Section = {
  id: string;
  slug: string;
  title: string;
  preset?: string | null;
  schema: { headers: string[]; types: string[] };
};

const GROUP_COL = (headers: string[]): string | null => {
  if (headers.includes('playlist')) return 'playlist';
  if (headers.includes('category')) return 'category';
  if (headers.includes('kind')) return 'kind';
  return null;
};
const TITLE_FIELD = (headers: string[]): string | null => {
  if (headers.includes('title')) return 'title';
  if (headers.includes('name')) return 'name';
  return null;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function newestStamp(rs: Row[]) {
  let max = '';
  for (const r of rs) { if (r.updatedAt > max) max = r.updatedAt; }
  return max;
}
function sortRows(rs: Row[], sort: GroupSort, title: string | null): Row[] {
  const out = rs.slice();
  if (sort === 'title-asc' && title) out.sort((a, b) => collator.compare(String(a.data[title] || ''), String(b.data[title] || '')));
  else if (sort === 'title-desc' && title) out.sort((a, b) => collator.compare(String(b.data[title] || ''), String(a.data[title] || '')));
  else if (sort === 'newest') out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  else if (sort === 'oldest') out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return out;
}
function applyManualOrder(rs: Row[], ids: string[]): Row[] {
  if (!ids.length) return rs;
  const byId = new Map(rs.map((r) => [r.id, r] as const));
  const used = new Set<string>();
  const out: Row[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r && !used.has(id)) { out.push(r); used.add(id); }
  }
  for (const r of rs) if (!used.has(r.id)) out.push(r);
  return out;
}

export function GroupedGrid({
  section,
  rows,
  onOpen,
  onDelete,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onDelete: (rowId: string) => Promise<void>;
}) {
  const groupCol = GROUP_COL(section.schema.headers);
  const titleField = TITLE_FIELD(section.schema.headers);

  const [sectionSort, setSectionSort] = useState<SectionGroupSort>('default');
  const [groupSort, setGroupSort] = useState<Record<string, GroupSort>>({});
  const [groupOrder, setGroupOrder] = useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);

  // Restore prefs.
  useEffect(() => {
    setSectionSort(readPref<SectionGroupSort>(`sectiongrouporder.${section.slug}`, 'default'));
    setGroupSort(readPref(`groupsort.${section.slug}`, {}));
    setGroupOrder(readPref(`grouporder.${section.slug}`, {}));
    setCollapsed(new Set(readPref<string[]>(`collapsed.${section.slug}`, [])));
  }, [section.slug]);

  const groups = useMemo(() => {
    const byKey = new Map<string, Row[]>();
    const order: string[] = [];
    for (const r of rows) {
      const raw = groupCol ? String(r.data[groupCol] || '').split(',')[0].trim() : '';
      const key = raw || '(uncategorised)';
      if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
      byKey.get(key)!.push(r);
    }
    if (sectionSort !== 'default') {
      order.sort((a, b) => {
        if (sectionSort === 'name-asc')  return collator.compare(a, b);
        if (sectionSort === 'name-desc') return collator.compare(b, a);
        if (sectionSort === 'newest')    return newestStamp(byKey.get(b)!).localeCompare(newestStamp(byKey.get(a)!));
        if (sectionSort === 'oldest')    return newestStamp(byKey.get(a)!).localeCompare(newestStamp(byKey.get(b)!));
        return 0;
      });
    }
    return order.map((k) => ({ key: k, rows: byKey.get(k)! }));
  }, [rows, groupCol, sectionSort]);

  function toggleCollapsed(k: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      writePref(`collapsed.${section.slug}`, [...next]);
      return next;
    });
  }
  function setGroupSortAt(k: string, v: GroupSort) {
    setGroupSort((prev) => {
      const next = { ...prev };
      if (v === 'default') delete next[k]; else next[k] = v;
      writePref(`groupsort.${section.slug}`, next);
      return next;
    });
  }
  function setSectionSortAndSave(v: SectionGroupSort) {
    setSectionSort(v);
    writePref(`sectiongrouporder.${section.slug}`, v === 'default' ? '' : v);
  }
  function persistOrder(k: string, ids: string[]) {
    setGroupOrder((prev) => {
      const next = { ...prev, [k]: ids };
      writePref(`grouporder.${section.slug}`, next);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {groupCol && (
        <header className="flex items-center gap-3 text-xs">
          <span className="text-zinc-500">Sort {groupCol}s:</span>
          <select
            value={sectionSort}
            onChange={(e) => setSectionSortAndSave(e.target.value as SectionGroupSort)}
            className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="default">Default</option>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </header>
      )}

      {groups.map(({ key, rows: groupRows }) => {
        const sort = groupSort[key] || 'default';
        const manual = sort === 'default' ? (groupOrder[key] || []) : [];
        const sorted = applyManualOrder(sortRows(groupRows, sort, titleField), manual);
        const isCollapsed = collapsed.has(key);
        return (
          <section key={key}>
            <header className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => toggleCollapsed(key)}
                className="inline-flex items-center gap-1 text-sm font-medium"
              >
                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                {groupCol ? key : section.title}
                <span className="text-xs font-normal text-zinc-500">· {groupRows.length}</span>
              </button>
              {groupCol && (
                <>
                  <select
                    value={sort}
                    onChange={(e) => setGroupSortAt(key, e.target.value as GroupSort)}
                    className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    title={`Sort items in "${key}"`}
                  >
                    <option value="default">Default</option>
                    <option value="title-asc">Title A–Z</option>
                    <option value="title-desc">Title Z–A</option>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                  <GroupNotes sectionSlug={section.slug} groupKey={key} />
                  {(section.preset === 'youtube' || section.preset === 'papers') && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await appConfirm(
                            `Save all ${groupRows.length} items in "${key}" offline?`,
                            { body: 'Downloads each item to your Drive in the background.' },
                          );
                          if (!ok) return;
                          const kind = section.preset === 'youtube' ? 'video' : 'paper';
                          toast.info(`Saving ${groupRows.length} items offline…`);
                          let done = 0, failed = 0;
                          await Promise.all(groupRows.map(async (gr) => {
                            try {
                              const resp = await fetch(`/api/sections/${section.slug}/rows/${gr.id}/save-offline`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ kind }),
                              });
                              if (resp.ok) done++; else failed++;
                            } catch { failed++; }
                          }));
                          toast.success(`Saved ${done}${failed ? ` · ${failed} failed` : ''}.`);
                        }}
                        className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        title={`Save every item in "${key}" offline`}
                      >
                        Save all offline
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await appConfirm(
                            `Delete all ${groupRows.length} items in "${key}"?`,
                            { body: 'This cannot be undone.', dangerLabel: 'Delete all' },
                          );
                          if (!ok) return;
                          // Server-side one-shot delete by group field —
                          // no per-row round-trips, no per-row confirms.
                          // groupCol is the column the grid is currently
                          // grouped on (playlist for YouTube, category for
                          // Papers, kind for anything else with a kind col).
                          try {
                            const resp = await fetch(`/api/sections/${section.slug}/rows/bulk-delete`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ field: groupCol, value: key }),
                            });
                            const j = await resp.json().catch(() => ({}));
                            if (!resp.ok) throw new Error(j.error || String(resp.status));
                            toast.success(`Deleted ${j.deleted ?? groupRows.length} items.`);
                            location.reload();
                          } catch (e) {
                            toast.error('Delete failed: ' + (e as Error).message);
                          }
                        }}
                        className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950"
                        title={`Delete every item in "${key}"`}
                      >
                        Delete all
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          // Pull the category column's schema-defined
                          // options so the picker offers them as chips,
                          // then let the user add custom values too.
                          const headers = section.schema.headers;
                          const catIdx = headers.indexOf('category');
                          const raw = catIdx >= 0 ? String(section.schema.types?.[catIdx] || '') : '';
                          const m = raw.match(/^multiselect\(([^)]*)\)/);
                          const options = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                          const next = await appPickMany(`Categories for "${key}"`, options, {
                            body: 'Pick one or more — applies to every item in this group.',
                          });
                          if (next === null) return;
                          await Promise.all(groupRows.map((gr) =>
                            fetch(`/api/sections/${section.slug}/rows/${gr.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ data: { category: next.join(', ') } }),
                            }).catch(() => undefined),
                          ));
                          toast.success(`Set category on ${groupRows.length} items.`);
                          location.reload();
                        }}
                        className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        title={`Set category for every item in "${key}"`}
                      >
                        Set category
                      </button>
                    </>
                  )}
                </>
              )}
            </header>
            {!isCollapsed && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                {sorted.map((r) => (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={() => setDraggedId(r.id)}
                    onDragEnd={() => setDraggedId(null)}
                    onDragOver={(e) => { if (draggedId && draggedId !== r.id) e.preventDefault(); }}
                    onDrop={(e) => {
                      if (!draggedId || draggedId === r.id) return;
                      e.preventDefault();
                      const ids = sorted.map((x) => x.id);
                      const fromIdx = ids.indexOf(draggedId);
                      const toIdx = ids.indexOf(r.id);
                      if (fromIdx < 0 || toIdx < 0) return;
                      ids.splice(fromIdx, 1);
                      ids.splice(toIdx, 0, draggedId);
                      // Switching to manual order pins this group to "default" so the
                      // next render respects our writeback.
                      setGroupSortAt(key, 'default');
                      persistOrder(key, ids);
                    }}
                    className={cn(
                      'group relative cursor-grab rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700',
                      draggedId === r.id && 'opacity-40',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(r)}
                      className="block w-full text-left"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1 text-sm font-medium">
                          {titleField ? String(r.data[titleField] ?? '(untitled)') : '(row)'}
                        </div>
                        <OfflineBadges marker={String(r.data.offline || '')} />
                      </div>
                      <div className="mt-1.5 line-clamp-1 text-xs text-zinc-500">
                        {String(r.data.channel || r.data.authors || r.data.url || new Date(r.updatedAt).toLocaleDateString())}
                      </div>
                    </button>
                    {(section.preset === 'youtube' || section.preset === 'papers') && typeof r.data.url === 'string' && r.data.url ? (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const kind = section.preset === 'youtube' ? 'video' : 'paper';
                          toast.info(kind === 'video' ? 'Downloading + uploading to Drive…' : 'Mirroring PDF to Drive…');
                          try {
                            const resp = await fetch(`/api/sections/${section.slug}/rows/${r.id}/save-offline`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ kind }),
                            });
                            const text = await resp.text();
                            let j: { error?: string; skipped?: boolean } = {};
                            try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
                            if (!resp.ok) throw new Error(j.error || `save-offline: ${resp.status}`);
                            toast.success(j.skipped ? 'Already offline.' : 'Saved to Drive.');
                          } catch (err) {
                            toast.error((err as Error).message);
                          }
                        }}
                        title="Download offline copy"
                        className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100 dark:bg-white dark:text-zinc-900"
                      >
                        <Save className="h-2.5 w-2.5" /> Save offline
                      </button>
                    ) : null}
                    <Popover.Root>
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          title="Info"
                          className="absolute right-7 top-1 rounded-full p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          side="bottom"
                          align="end"
                          sideOffset={4}
                          className="z-50 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <dl className="space-y-2 text-xs">
                            {Object.entries(r.data)
                              .filter(([k, v]) =>
                                v != null && v !== '' &&
                                !k.startsWith('_') &&
                                !['offline', 'notes', 'thumbnail'].includes(k))
                              .map(([k, v]) => (
                                <div key={k} className="grid grid-cols-[5rem_1fr] gap-2">
                                  <dt className="text-zinc-500">{k}</dt>
                                  <dd className="break-words font-medium text-zinc-700 dark:text-zinc-200">
                                    {String(v).slice(0, 600)}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                    <button
                      type="button"
                      onClick={() => onDelete(r.id)}
                      title="Delete row"
                      className="absolute right-1 top-1 rounded-full p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <GripVertical className="pointer-events-none absolute left-1 top-1 h-3.5 w-3.5 text-zinc-300 opacity-0 transition group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
