'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2, GripVertical, ChevronDown, ChevronRight, Cloud, HardDrive, Server, Save, Info, MoreVertical, X, RefreshCw, Quote, Download, Tags, Pencil, Upload, Network, ExternalLink, BookOpen } from 'lucide-react';
import { readingMinutes, formatReadingMinutes, MINUTES_PER_PAGE, WORDS_PER_MINUTE } from '@/lib/reading-time';
import { relativeTime, formatDateTime } from '@/lib/relative-time';
import type { Row } from '@/lib/row';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { readNdjsonResult } from '@/lib/ndjson';
import { appConfirm } from './confirm';
import { appPrompt } from './prompt';
import { CITATION_FORMATS } from '@/lib/citations';
import { CategoryBar } from './category-bar';
import { computeWatched } from '@/lib/watched';
import { appPickMany } from './multi-picker';
import { naturalCompare, cn } from '@/lib/utils';
import { readPref, writePref, type GroupSort, type SectionGroupSort } from '@/lib/prefs';
import { GroupNotes } from './group-notes';

export type { Row } from '@/lib/row';

function OfflineBadges({ marker }: { marker: string }) {
  const has = (p: string) => marker.split(' · ').some((s) => s.trim().startsWith(p));
  const hasDrive = has('drive:');
  const hasLocal = has('local:');
  const hasHost = has('host:');
  if (!hasDrive && !hasLocal && !hasHost) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-zinc-400">
      {hasDrive && <Cloud className="h-3 w-3" aria-label="On Drive" />}
      {hasLocal && <HardDrive className="h-3 w-3" aria-label="On local mirror" />}
      {hasHost && <Server className="h-3 w-3" aria-label="On helper" />}
    </span>
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
  onRowUpdated,
}: {
  section: Section;
  rows: Row[];
  onOpen: (r: Row) => void;
  onDelete: (rowId: string) => Promise<void>;
  /** Called when a group-level bulk action mutates a row (e.g.
   * bulk metadata refresh) so the parent's cache replaces it
   * in-place instead of waiting for a full refetch. */
  onRowUpdated?: (row: Row) => void;
}) {
  const router = useRouter();
  const groupCol = GROUP_COL(section.schema.headers);
  const titleField = TITLE_FIELD(section.schema.headers);

  const [sectionSort, setSectionSort] = useState<SectionGroupSort>('default');
  const [groupSort, setGroupSort] = useState<Record<string, GroupSort>>({});
  const [groupOrder, setGroupOrder] = useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  // Shared <input type=file> for the per-group "Upload videos"
  // buttons. The target playlist comes from `uploadTarget` which
  // the button sets right before triggering the file picker.
  const videoFileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const [uploadingTo, setUploadingTo] = useState<string | null>(null);
  // The schema's `multiselect(...)` options for this column — updated
  // in-place when the user clicks Add/Remove in the CategoryBar.
  const [catOptions, setCatOptions] = useState<string[]>(() => {
    if (!groupCol || groupCol !== 'category') return [];
    const idx = section.schema.headers.indexOf('category');
    const raw = idx >= 0 ? String(section.schema.types?.[idx] || '') : '';
    const m = raw.match(/^multiselect\(([^)]*)\)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  });

  // Restore prefs.
  useEffect(() => {
    setSectionSort(readPref<SectionGroupSort>(`sectiongrouporder.${section.slug}`, 'default'));
    setGroupSort(readPref(`groupsort.${section.slug}`, {}));
    setGroupOrder(readPref(`grouporder.${section.slug}`, {}));
    setCollapsed(new Set(readPref<string[]>(`collapsed.${section.slug}`, [])));
    setSelectedCats(new Set(readPref<string[]>(`catfilter.${section.slug}`, [])));
  }, [section.slug]);

  // All category values actually used across rows — pulled out
  // separately so the CategoryBar can show user-defined values that
  // aren't yet in the schema.
  const usedCats = useMemo(() => {
    if (groupCol !== 'category') return [] as string[];
    const set = new Set<string>();
    for (const r of rows) {
      const raw = String(r.data.category || '');
      for (const v of raw.split(',').map((s) => s.trim()).filter(Boolean)) set.add(v);
    }
    return Array.from(set);
  }, [rows, groupCol]);

  // Only `multiselect(...)` columns get the comma-split-into-N-
  // groups treatment. Single-valued columns like `playlist`
  // (where a YouTube playlist literally named "Workout, Cardio"
  // is one real playlist) keep the whole value as the group key.
  // Without this guard, a row tagged with such a name showed up
  // in TWO groups pointing to the same record, and bulk-deleting
  // either group wiped the underlying row from both.
  const groupColIsMulti = useMemo(() => {
    if (!groupCol) return false;
    // `category` is conceptually always multi-value — a video can
    // belong to several comma-separated categories — so it always
    // comma-splits, regardless of whether the schema type-hint
    // happens to say `multiselect(...)`. Without this, a row tagged
    // "News, Tech" became its own group key and never grouped with
    // plain "News" — i.e. "category does not group them".
    if (groupCol === 'category') return true;
    const idx = section.schema.headers.indexOf(groupCol);
    if (idx < 0) return false;
    return /^multiselect\(/.test(String(section.schema.types?.[idx] || ''));
  }, [groupCol, section.schema]);

  const groups = useMemo(() => {
    const byKey = new Map<string, Row[]>();
    const order: string[] = [];
    for (const r of rows) {
      const raw = groupCol ? String(r.data[groupCol] || '').trim() : '';
      const keys = raw
        ? (groupColIsMulti
            ? raw.split(',').map((s) => s.trim()).filter(Boolean)
            : [raw])
        : ['(uncategorised)'];
      for (const key of (keys.length ? keys : ['(uncategorised)'])) {
        if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
        byKey.get(key)!.push(r);
      }
    }
    // Within each group, restore playlist order when the rows carry
    // a `_playlistPos` (set on import). Videos then stay in the
    // playlist's own order regardless of when each row was created
    // or re-imported. Rows without a position keep their relative
    // order and sort after the positioned ones.
    const posOf = (r: Row) =>
      typeof r.data._playlistPos === 'number' ? (r.data._playlistPos as number) : Number.POSITIVE_INFINITY;
    for (const arr of byKey.values()) {
      if (arr.some((r) => typeof r.data._playlistPos === 'number')) {
        arr.sort((a, b) => posOf(a) - posOf(b));
      }
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
    const filtered = selectedCats.size === 0
      ? order
      : order.filter((k) => selectedCats.has(k));
    return filtered.map((k) => ({ key: k, rows: byKey.get(k)! }));
  }, [rows, groupCol, sectionSort, selectedCats]);

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
      {section.preset === 'youtube' && (
        <input
          ref={videoFileRef}
          type="file"
          accept="video/*,.mp4,.mkv,.mov,.webm"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            const target = uploadTarget.current;
            const playlist = target && target !== '(uncategorised)' && groupCol === 'playlist' ? target : '';
            setUploadingTo(target);
            toast.info(`Uploading ${files.length} video${files.length === 1 ? '' : 's'}${playlist ? ` to "${playlist}"` : ''}…`);
            let done = 0, failed = 0;
            for (const file of files) {
              try {
                const fd = new FormData();
                fd.append('file', file, file.name);
                if (playlist) fd.append('playlist', playlist);
                const r = await fetch(`/api/sections/${section.slug}/upload-video`, { method: 'POST', body: fd });
                const j = (await r.json().catch(() => ({}))) as { error?: string; id?: string; data?: Record<string, unknown>; updatedAt?: string };
                if (!r.ok) throw new Error(j.error || `upload-video: ${r.status}`);
                if (j.id && j.data && j.updatedAt && onRowUpdated) {
                  onRowUpdated({ id: j.id, data: j.data, updatedAt: j.updatedAt });
                }
                done++;
              } catch (err) {
                failed++;
                notify.error(`${file.name}: ${(err as Error).message}`);
              }
            }
            toast.success(`Uploaded ${done}${failed ? ` · ${failed} failed` : ''}.`);
            setUploadingTo(null);
            uploadTarget.current = null;
            if (videoFileRef.current) videoFileRef.current.value = '';
            // The freshly-uploaded rows aren't in the parent's
            // cache for the "new" branch (only attach has
            // onRowUpdated path); reload to surface them.
            router.refresh();
          }}
        />
      )}
      {groupCol === 'category' && (
        <CategoryBar
          sectionSlug={section.slug}
          column="category"
          schemaOptions={catOptions}
          rowValues={usedCats}
          rows={rows}
          selected={selectedCats}
          onSelectedChange={(next) => {
            setSelectedCats(next);
            writePref(`catfilter.${section.slug}`, [...next]);
          }}
          onSchemaChanged={(nextList) => setCatOptions(nextList)}
          onRowsRewritten={() => {
            // The server rewrote rows in place — easiest sync is a
            // full reload of the section page so the local cache
            // picks up the deletes and the renamed values.
            router.refresh();
          }}
        />
      )}
      {section.preset === 'youtube' && (
        <div className="-mt-1 mb-3 flex flex-col items-center gap-1 text-zinc-500">
          <span className="text-[10px] uppercase tracking-wide">Section total</span>
          <PlaylistProgress rows={rows} size="wide" />
        </div>
      )}
      {section.preset === 'papers' && (
        <div className="-mt-1 mb-3 flex flex-col items-center gap-1 text-zinc-500">
          <span className="text-[10px] uppercase tracking-wide">Section total</span>
          <ReadingTimeTotal rows={rows} size="wide" />
          <BackfillPagesButton section={section} rows={rows} />
        </div>
      )}
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
              {/* Name on the left — double-click to edit (or the
                * old pencil-button equivalent via dblclick on the
                * name itself). All the controls below get pushed
                * to the right via ml-auto. */}
              {groupCol && key !== '(uncategorised)' ? (
                <GroupNameEditor
                  name={key}
                  count={groupRows.length}
                  isCollapsed={isCollapsed}
                  onToggle={() => toggleCollapsed(key)}
                  onRename={async (to) => {
                    try {
                      const r = await fetch(`/api/sections/${section.slug}/rewrite-tag`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ column: groupCol, from: key, to }),
                      });
                      const j = (await r.json().catch(() => ({}))) as { rewrote?: number; error?: string };
                      if (!r.ok) throw new Error(j.error || `rewrite-tag: ${r.status}`);
                      toast.success(`Renamed "${key}" → "${to}" on ${j.rewrote ?? 0} row${j.rewrote === 1 ? '' : 's'}.`);
                      router.refresh();
                    } catch (e) {
                      notify.error((e as Error).message);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleCollapsed(key)}
                  className="inline-flex items-center gap-1 text-sm font-medium"
                >
                  {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {groupCol ? key : section.title}
                  <span className="text-xs font-normal text-zinc-500">· {groupRows.length}</span>
                </button>
              )}
              {section.preset === 'youtube' && (
                <div className="ml-2"><PlaylistProgress rows={groupRows} /></div>
              )}
              {section.preset === 'papers' && (
                <div className="ml-2"><ReadingTimeTotal rows={groupRows} /></div>
              )}
              {section.preset === 'youtube' && (() => {
                /* Find the first YouTube playlist URL in this group
                 * (rows have data.url like
                 * `https://youtube.com/watch?v=…&list=PL…`). If any
                 * row carries one, surface a small clickable link to
                 * the playlist itself — quick jump to the canonical
                 * YouTube view without leaving the group context.
                 * Skipped when no row has `list=` in its URL. */
                const PL_RE = /[?&]list=([A-Za-z0-9_-]+)/;
                let listId = '';
                for (const gr of groupRows) {
                  const url = String((gr.data as Record<string, unknown>).url || '');
                  const m = url.match(PL_RE);
                  if (m) { listId = m[1]; break; }
                }
                if (!listId) return null;
                return (
                  <a
                    href={`https://www.youtube.com/playlist?list=${listId}`}
                    target="_blank"
                    rel="noopener"
                    title="Open this playlist on YouTube"
                    className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                );
              })()}
              <div className="ml-auto flex flex-wrap items-center gap-1">
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
                      {section.preset === 'youtube' && (
                        <button
                          type="button"
                          onClick={() => {
                            uploadTarget.current = key;
                            videoFileRef.current?.click();
                          }}
                          disabled={uploadingTo === key}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title={key !== '(uncategorised)' && groupCol === 'playlist'
                            ? `Upload local MP4s to the "${key}" playlist`
                            : 'Upload local MP4s'}
                        >
                          <Upload className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {(section.preset === 'youtube' || section.preset === 'papers') && (
                        <button
                          type="button"
                          onClick={async () => {
                            toast.info(`Refreshing metadata for ${groupRows.length} items…`);
                            let done = 0, failed = 0, skipped = 0;
                            await Promise.all(groupRows.map(async (gr) => {
                              try {
                                const resp = await fetch(`/api/sections/${section.slug}/rows/${gr.id}/refresh-metadata`, { method: 'POST' });
                                if (resp.status === 409) { skipped++; return; }
                                const j = (await resp.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: string };
                                if (!resp.ok) throw new Error(j.error || `refresh-metadata: ${resp.status}`);
                                if (j.data && onRowUpdated) {
                                  onRowUpdated({ id: gr.id, data: j.data, updatedAt: new Date().toISOString() });
                                }
                                done++;
                              } catch { failed++; }
                            }));
                            const parts: string[] = [];
                            if (done) parts.push(`refreshed ${done}`);
                            if (skipped) parts.push(`${skipped} skipped (no source)`);
                            if (failed) parts.push(`${failed} failed`);
                            toast.success(parts.join(' · ') || 'Nothing to refresh.');
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title={`Refresh metadata for every item in "${key}" via YouTube / arxiv / CrossRef`}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {section.preset === 'papers' && (
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button
                              type="button"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                              title={`Copy citations for every paper in "${key}"`}
                            >
                              <Quote className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              align="start"
                              sideOffset={4}
                              className="z-[60] min-w-[10rem] overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
                            >
                              {CITATION_FORMATS.map((f) => (
                                <DropdownMenu.Item
                                  key={f.id}
                                  onSelect={() => {
                                    const blocks = groupRows
                                      .map((r) => f.render(r.data as Record<string, unknown>))
                                      .filter((s) => s.trim().length > 0);
                                    if (!blocks.length) {
                                      notify.error('No paper in this group has citation metadata.');
                                      return;
                                    }
                                    const sep = f.id === 'bibtex' ? '\n\n' : '\n\n';
                                    const text = blocks.join(sep);
                                    try {
                                      void navigator.clipboard.writeText(text);
                                      toast.success(`${blocks.length} ${f.label} citation${blocks.length === 1 ? '' : 's'} copied`);
                                    } catch {
                                      notify.error('Clipboard blocked. First citation:\n' + blocks[0]);
                                    }
                                  }}
                                  className="cursor-pointer px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                                >
                                  {f.label}
                                </DropdownMenu.Item>
                              ))}
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          // Filter out rows that already have a Drive
                          // copy so a re-run on a half-finished playlist
                          // doesn't re-download what's already there.
                          // The server's save-offline also short-circuits
                          // with `skipped:true` for these, but skipping
                          // them here avoids the round-trip and gives an
                          // honest count in the confirm dialog.
                          const pending = groupRows.filter((gr) => !/drive:[\w-]{20,}/.test(String((gr.data as Record<string, unknown>).offline || '')));
                          const already = groupRows.length - pending.length;
                          if (pending.length === 0) {
                            toast.info(`All ${groupRows.length} items in "${key}" are already offline — nothing to do.`);
                            return;
                          }
                          const ok = await appConfirm(
                            `Save ${pending.length} new item${pending.length === 1 ? '' : 's'} in "${key}" offline?`,
                            { body: already > 0
                              ? `${already} of ${groupRows.length} already have an offline copy and will be skipped.`
                              : 'Downloads each item to your Drive in the background.' },
                          );
                          if (!ok) return;
                          const kind = section.preset === 'youtube' ? 'video' : 'paper';
                          toast.info(`Saving ${pending.length} item${pending.length === 1 ? '' : 's'} offline…`);
                          let done = 0, failed = 0;
                          // Serialize the saves: yt-dlp + the helper +
                          // Drive throttle hard when N parallel video
                          // downloads hit them at once (the user
                          // reported one-by-one works but full-playlist
                          // parallel breaks). Sequential with a 500 ms
                          // inter-task gap is slower but reliable; the
                          // background toast lets the user keep working.
                          // A "progress" toast every 5 completions
                          // shows movement on long playlists.
                          for (let i = 0; i < pending.length; i++) {
                            const gr = pending[i];
                            try {
                              const resp = await fetch(`/api/sections/${section.slug}/rows/${gr.id}/save-offline`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ kind }),
                              });
                              await readNdjsonResult(resp);
                              done++;
                            } catch { failed++; }
                            if (i + 1 < pending.length) {
                              if ((done + failed) % 5 === 0) {
                                toast.info(`Saved ${done + failed}/${pending.length}…`);
                              }
                              await new Promise((r) => setTimeout(r, 500));
                            }
                          }
                          toast.success(`Saved ${done}${failed ? ` · ${failed} failed` : ''}${already > 0 ? ` · ${already} already offline` : ''}.`);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                        title={`Save every item in "${key}" offline`}
                      >
                        <Download className="h-3.5 w-3.5" />
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
                            const j = (await resp.json().catch(() => ({}))) as { error?: string; deleted?: number; untagged?: number };
                            if (!resp.ok) throw new Error(j.error || String(resp.status));
                            // Surface both numbers — a multi-category row
                            // dropped out of THIS group but stays alive in
                            // its other ones, which matters for the user
                            // to trust the action.
                            const del = j.deleted ?? groupRows.length;
                            const untag = j.untagged ?? 0;
                            const msg = untag > 0
                              ? `Deleted ${del} · removed "${key}" from ${untag} multi-tagged item${untag === 1 ? '' : 's'}.`
                              : `Deleted ${del} items.`;
                            toast.success(msg);
                            router.refresh();
                          } catch (e) {
                            notify.error('Delete failed: ' + (e as Error).message);
                          }
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                        title={`Delete every item in "${key}"`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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
                          router.refresh();
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                        title={`Set category for every item in "${key}"`}
                      >
                        <Tags className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </>
              )}
              </div>
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
                      {/* Title only; offline-state badges live next
                        * to the three-dots overflow menu so the
                        * corner cluster reads as a single control
                        * group. */}
                      <div className="flex items-start gap-1.5 pr-12">
                        <div className="flex-1 text-sm font-medium">
                          {titleField ? String(r.data[titleField] ?? '(untitled)') : '(row)'}
                        </div>
                        {section.preset === 'notes' && <NotesTypeBadge type={String(r.data.type || 'md')} />}
                      </div>
                      <div className="mt-1.5 line-clamp-1 text-xs text-zinc-500">
                        {String(r.data.channel || r.data.authors || r.data.url || new Date(r.updatedAt).toLocaleDateString())}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-400">
                        <span title={`Last edited ${formatDateTime(r.updatedAt)}`}>
                          edited {relativeTime(r.updatedAt)}
                        </span>
                        {section.preset === 'papers' && typeof (r.data as Record<string, unknown>).citationCount === 'number' && (() => {
                          const cc = (r.data as Record<string, number>).citationCount;
                          if (cc <= 0) return null;
                          return (
                            <span
                              title={`Cited ${cc.toLocaleString()} times (Semantic Scholar)`}
                              className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              {cc >= 1000 ? `${(cc / 1000).toFixed(cc >= 10000 ? 0 : 1)}k` : cc} cites
                            </span>
                          );
                        })()}
                      </div>
                    </button>
                    {section.preset === 'youtube' && <WatchedBar row={r} />}
                    {section.preset === 'papers' && <PaperReadingBadge row={r} />}
                    {Boolean((r.data as Record<string, unknown>)._queued) && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300" title="A local worker is downloading this video">
                        <Cloud className="h-3 w-3" />
                        Downloading on worker…
                      </div>
                    )}
                    {/* Single overflow menu — three dots always
                      * visible in the corner. Inside: Info (opens a
                      * popover with full metadata), Save offline (for
                      * YT/Papers rows only), Delete. Replaces three
                      * separate icons that cluttered the card. */}
                    <CardActions
                      row={r}
                      section={section}
                      onDelete={onDelete}
                      onRowUpdated={onRowUpdated}
                    />
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

/** Per-card overflow menu — single three-dot button that opens a
 * dropdown with Info / Save offline / Delete. Info itself opens a
 * second popover with the row's metadata; everything else fires
 * inline. */
/** Thin progress bar under each YouTube card: filled to the
 * watched fraction of the video's total duration. Stays hidden
 * when we don't know the duration (row hasn't been enriched by
 * the YT API yet OR yt-dlp metadata is missing). */
function WatchedBar({ row }: { row: Row }) {
  const { duration, watched, pct } = computeWatched(row);
  if (!pct || !duration || watched <= 0) return null;
  const filled = Math.max(0, Math.min(1, pct));
  return (
    <div
      className="progress-track mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
      title={`${Math.floor(watched / 60)} min watched of ${Math.floor(duration / 60)} (${Math.round(filled * 100)}%)`}
    >
      <div
        className={`progress-fill h-full ${filled >= 0.95 ? 'bg-emerald-500' : filled >= 0.5 ? 'bg-amber-500' : 'bg-blue-500'}`}
        style={{ width: `${filled * 100}%` }}
      />
    </div>
  );
}

/** Aggregate progress across a playlist group — sums duration and
 * watched seconds across all videos, renders one bar + a "x of y"
 * caption. Hidden when no row carries a duration. */
/** Double-click-to-edit group name. Renders the name as plain
 *  text; on dblclick swaps in a borderless input with only a
 *  bottom border — the iOS-Notes "lined" look — so it reads as
 *  something you can write into. Enter / blur commits via the
 *  same rewrite-tag endpoint the old pencil-icon button used;
 *  Escape discards. */
function GroupNameEditor({
  name, onRename, isCollapsed, onToggle, count,
}: {
  name: string;
  onRename: (next: string) => void | Promise<void>;
  isCollapsed: boolean;
  onToggle: () => void;
  count: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);
  const cancelled = useRef(false);

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1">
        <button type="button" onClick={onToggle} className="text-zinc-500" tabIndex={-1}>
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            setEditing(false);
            if (cancelled.current) { cancelled.current = false; setDraft(name); return; }
            const t = draft.trim();
            if (t && t !== name) void onRename(t);
            else setDraft(name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { cancelled.current = true; (e.target as HTMLInputElement).blur(); }
          }}
          className="border-0 border-b border-dashed border-zinc-400 bg-transparent px-0.5 py-0 text-sm font-medium focus:border-zinc-900 focus:outline-none focus:ring-0 dark:border-zinc-500 dark:focus:border-zinc-100"
          style={{ minWidth: '6ch', width: `${Math.max(8, draft.length + 1)}ch` }}
        />
        <span className="text-xs font-normal text-zinc-500">· {count}</span>
      </div>
    );
  }
  return (
    <div
      className="group inline-flex items-center gap-1"
      onDoubleClick={() => setEditing(true)}
      title="Double-click to rename"
    >
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-sm font-medium"
      >
        {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        <span className="group-hover:underline group-hover:underline-offset-2 group-hover:decoration-zinc-300 dark:group-hover:decoration-zinc-700">
          {name}
        </span>
        <span className="text-xs font-normal text-zinc-500">· {count}</span>
      </button>
    </div>
  );
}

function PlaylistProgress({ rows, size = 'chip' }: { rows: Row[]; size?: 'chip' | 'wide' }) {
  let totalDur = 0;
  let totalWatched = 0;
  let known = 0;
  for (const r of rows) {
    const w = computeWatched(r);
    if (w.duration && w.duration > 0) {
      totalDur += w.duration;
      totalWatched += w.watched;
      known += 1;
    }
  }
  if (known === 0 || totalDur === 0) return null;
  const pct = Math.max(0, Math.min(1, totalWatched / totalDur));
  const mm = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  };
  const fill = pct >= 0.95 ? 'bg-emerald-500' : pct >= 0.5 ? 'bg-amber-500' : 'bg-blue-500';
  // Two presentations from the same data: an inline chip (per
  // group header) and a wider strip used for the section total.
  if (size === 'wide') {
    return (
      <div className="flex w-full max-w-md flex-col gap-1.5 text-xs text-zinc-600 dark:text-zinc-400" title={`${known} of ${rows.length} videos have durations`}>
        <div className="flex items-center justify-between">
          <span className="font-medium tracking-wide">{mm(totalWatched)} watched</span>
          <span className="font-mono text-[10px] text-zinc-500">of {mm(totalDur)} · {Math.round(pct * 100)}%</span>
        </div>
        <div className="progress-track h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className={`progress-fill h-full ${fill} transition-[width] duration-300`} style={{ width: `${pct * 100}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500" title={`${known} of ${rows.length} videos have durations`}>
      <div className="progress-track h-1 w-24 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={`progress-fill h-full ${fill}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span>{mm(totalWatched)} / {mm(totalDur)}</span>
    </div>
  );
}

/** Per-card reading-time badge for the Papers preset. Shows "~12 min"
 *  when the row has a page count or word count we can estimate from;
 *  silently hides when neither is available (older rows pre-dating
 *  the page-count extraction, or rows without a Drive mirror). */
function PaperReadingBadge({ row }: { row: Row }) {
  const mins = readingMinutes(row.data as Record<string, unknown>);
  if (!mins) return null;
  return (
    <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-zinc-500" title={`Estimated reading time at ${MINUTES_PER_PAGE} min/page (or ${WORDS_PER_MINUTE} wpm when word count is known)`}>
      <BookOpen className="h-3 w-3" />
      ~{formatReadingMinutes(mins)}
    </div>
  );
}

/** Total reading time across a set of papers — wide variant for the
 *  section header, chip variant for the per-group header. Mirrors the
 *  PlaylistProgress duration/watched layout so the two presets read
 *  alike. Rows without an estimate are counted in the "of N" tail but
 *  don't add minutes. */
function ReadingTimeTotal({ rows, size = 'chip' }: { rows: Row[]; size?: 'chip' | 'wide' }) {
  let mins = 0;
  let known = 0;
  for (const r of rows) {
    const m = readingMinutes(r.data as Record<string, unknown>);
    if (m) { mins += m; known += 1; }
  }
  if (known === 0) return null;
  const summary = formatReadingMinutes(mins);
  if (size === 'wide') {
    return (
      <div className="flex w-full max-w-md flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400" title={`${known} of ${rows.length} papers have an estimate`}>
        <div className="flex items-center justify-between">
          <span className="font-medium tracking-wide">~{summary} to read</span>
          <span className="font-mono text-[10px] text-zinc-500">{known} / {rows.length} estimated</span>
        </div>
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" title={`Total reading time across ${known} estimated paper${known === 1 ? '' : 's'}`}>
      <BookOpen className="h-3 w-3" />
      ~{summary}
    </div>
  );
}

/** "Backfill page counts" button for the Papers section. Page-count
 *  extraction only runs going forward (on upload / save-offline);
 *  papers mirrored before that landed have no estimate. This calls
 *  the backfill endpoint in a loop until `remaining` hits 0 — the
 *  endpoint caps each call at 25 PDFs so a big library doesn't blow
 *  the request timeout. Only shown when there's actually something
 *  to backfill (≥1 paper with a Drive copy but no page count). */
function BackfillPagesButton({ section, rows }: { section: Section; rows: Row[] }) {
  const [busy, setBusy] = useState(false);
  const pending = rows.filter((r) => {
    const d = r.data as Record<string, unknown>;
    return !d.pages && /drive:[\w-]{20,}/.test(String(d.offline || ''));
  }).length;
  if (pending === 0 && !busy) return null;
  async function run() {
    setBusy(true);
    let updated = 0;
    try {
      // Loop until the server reports no rows remaining. Each call
      // processes ≤25; a small library finishes in one round-trip.
      for (let guard = 0; guard < 40; guard++) {
        const r = await fetch(`/api/sections/${section.slug}/backfill-pages`, { method: 'POST' });
        if (!r.ok) throw new Error(`backfill: ${r.status}`);
        const j = (await r.json()) as { updated: number; remaining: number };
        updated += j.updated;
        if (j.remaining <= 0) break;
      }
      toast.success(`Backfilled page counts for ${updated} paper${updated === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      title="Extract PDF page counts for papers that don't have a reading-time estimate yet"
    >
      {busy
        ? <><RefreshCw className="h-3 w-3 animate-spin" /> Backfilling…</>
        : <><RefreshCw className="h-3 w-3" /> Backfill {pending} reading estimate{pending === 1 ? '' : 's'}</>}
    </button>
  );
}

/** Small uppercase chip in the card corner identifying a Notes row's
 * content type. Drives nothing — purely informational so users can
 * spot sketches and plain-text notes at a glance among Markdown ones. */
function NotesTypeBadge({ type }: { type: string }) {
  const t = (type === 'text' || type === 'md' || type === 'sketch') ? type : 'md';
  const label = t === 'md' ? 'MD' : t === 'sketch' ? 'SKETCH' : 'TEXT';
  const tone = t === 'md'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
    : t === 'sketch'
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  return (
    <span
      title={`Note type: ${t}`}
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

function CardActions({
  row, section, onDelete, onRowUpdated,
}: {
  row: Row;
  section: Section;
  onDelete: (rowId: string) => Promise<void>;
  /** Forward a successful PATCH back to the parent so the row's
   * category chips, group placement, etc. refresh without a full
   * page reload. */
  onRowUpdated?: (row: Row) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const isOffliable = (section.preset === 'youtube' || section.preset === 'papers')
    && typeof row.data.url === 'string' && !!row.data.url;
  const kind = section.preset === 'youtube' ? 'video' : 'paper';
  // Categorisable when the section schema declares a `category`
  // column with a multiselect type. Pulls the picker vocabulary
  // from the same place the bulk-set group action uses.
  const catIdx = section.schema.headers.indexOf('category');
  const catTypeRaw = catIdx >= 0 ? String(section.schema.types?.[catIdx] || '') : '';
  const catMatch = catTypeRaw.match(/^multiselect\(([^)]*)\)/);
  const isCategorisable = !!catMatch;
  const catOptions = catMatch ? catMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

  async function setCategory() {
    const currentRaw = String(row.data.category || '');
    const initial = currentRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const next = await appPickMany('Category', catOptions, {
      body: `Pick one or more for "${String(row.data.title || row.data.name || row.id).slice(0, 60)}".`,
      initial,
    });
    if (next === null) return; // cancelled
    const value = next.join(', ');
    try {
      const r = await fetch(`/api/sections/${section.slug}/rows/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { category: value } }),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; data?: Record<string, unknown>; updatedAt?: string; error?: string };
      if (!r.ok) throw new Error(j.error || `PATCH: ${r.status}`);
      toast.success(next.length === 0 ? 'Category cleared.' : `Category set: ${value}.`);
      if (j.id && j.data && j.updatedAt && onRowUpdated) {
        onRowUpdated({ id: j.id, data: j.data, updatedAt: j.updatedAt });
      }
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function saveOffline() {
    toast.info(kind === 'video' ? 'Downloading + uploading to Drive…' : 'Mirroring PDF to Drive…');
    try {
      const resp = await fetch(`/api/sections/${section.slug}/rows/${row.id}/save-offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const j = await readNdjsonResult<{ skipped?: boolean }>(resp);
      toast.success(j.skipped ? 'Already offline.' : 'Saved to Drive.');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  const hasOfflineCopy = /drive:[\w-]{20,}/.test(String(row.data.offline || ''));

  async function removeOffline() {
    const ok = await appConfirm('Remove the offline copy from this row?', {
      body: "The Drive blob will be deleted (frees space + Drive quota). The row stays — you can Save offline again later. This won't touch the original YouTube / arxiv URL.",
      dangerLabel: 'Remove',
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/sections/${section.slug}/rows/${row.id}/remove-offline`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { deleted?: number; error?: string; id?: string; data?: Record<string, unknown>; updatedAt?: string };
      if (!r.ok) throw new Error(j.error || `remove-offline: ${r.status}`);
      toast.success(`Removed offline copy${j.deleted ? ` (deleted ${j.deleted} Drive file${j.deleted === 1 ? '' : 's'})` : ''}.`);
      if (j.id && j.data && j.updatedAt && onRowUpdated) {
        onRowUpdated({ id: j.id, data: j.data, updatedAt: j.updatedAt });
      }
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  const localUploadRef = useRef<HTMLInputElement>(null);
  async function uploadLocal(file: File) {
    toast.info(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('rowId', row.id);
      const r = await fetch(`/api/sections/${section.slug}/upload-video`, { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string; id?: string; data?: Record<string, unknown>; updatedAt?: string };
      if (!r.ok) throw new Error(j.error || `upload-video: ${r.status}`);
      toast.success('Local copy attached to this row.');
      if (j.id && j.data && j.updatedAt && onRowUpdated) {
        onRowUpdated({ id: j.id, data: j.data, updatedAt: j.updatedAt });
      }
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      if (localUploadRef.current) localUploadRef.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={localUploadRef}
        type="file"
        accept="video/*,.mp4,.mkv,.mov,.webm"
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadLocal(f);
        }}
      />
      <div
        className="absolute right-1 top-1 flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <OfflineBadges marker={String(row.data.offline || '')} />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              title="Actions"
              className="rounded-full p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-[10rem] rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); setInfoOpen(true); }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Info className="h-3.5 w-3.5" /> Info
              </DropdownMenu.Item>
              {section.preset === 'papers' && (
                <DropdownMenu.Item asChild>
                  <Link
                    href={`/papers/related/${row.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Network className="h-3.5 w-3.5" /> Related papers
                  </Link>
                </DropdownMenu.Item>
              )}
              {isOffliable && (
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); void saveOffline(); }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Save className="h-3.5 w-3.5" /> Save offline
                </DropdownMenu.Item>
              )}
              {kind === 'video' && (
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); localUploadRef.current?.click(); }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Upload className="h-3.5 w-3.5" /> Upload local MP4
                </DropdownMenu.Item>
              )}
              {hasOfflineCopy && (
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); void removeOffline(); }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-red-600 outline-none hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  <Cloud className="h-3.5 w-3.5" /> Remove offline copy
                </DropdownMenu.Item>
              )}
              {isCategorisable && (
                <DropdownMenu.Item
                  onSelect={(e) => { e.preventDefault(); void setCategory(); }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Tags className="h-3.5 w-3.5" /> Set category
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
              <DropdownMenu.Item
                onSelect={(e) => { e.preventDefault(); void onDelete(row.id); }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-red-600 outline-none hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {/* Info dialog — modal so it actually shows up regardless of
        * scroll position / overflow clipping that broke the earlier
        * Popover.Anchor version. */}
      <Dialog.Root open={infoOpen} onOpenChange={setInfoOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold">Info</Dialog.Title>
              <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <dl className="max-h-[60vh] space-y-2 overflow-auto text-xs">
              {Object.entries(row.data)
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
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
