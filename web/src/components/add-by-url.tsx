'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { readNdjsonResult } from '@/lib/ndjson';
import { Link as LinkIcon, X } from 'lucide-react';

type Section = { slug: string; schema: { headers: string[]; types: string[] }; preset?: string | null };

function sectionKind(s: Section): 'youtube' | 'papers' | 'mixed' {
  if (s.preset === 'youtube' || s.slug === 'youtube') return 'youtube';
  if (s.preset === 'papers' || s.slug === 'papers') return 'papers';
  return 'mixed';
}
function placeholderFor(kind: 'youtube' | 'papers' | 'mixed') {
  if (kind === 'youtube') return 'YouTube video URL';
  if (kind === 'papers')  return 'arXiv 2401.12345 / DOI / PDF URL';
  return 'arXiv ID · DOI · YouTube URL · any URL';
}
function helpFor(kind: 'youtube' | 'papers' | 'mixed') {
  if (kind === 'youtube') return 'Paste a YouTube video URL — title, channel, and thumbnail auto-fill.';
  if (kind === 'papers')  return 'arXiv (2401.12345 or any arxiv URL) and DOI (10.xxxx/yyy via CrossRef). Title, authors, year, abstract, and the PDF link populate automatically.';
  return 'arXiv (2401.12345 or any arxiv URL), DOI (10.xxxx/yyy via CrossRef), or a single YouTube video URL.';
}

export function AddByUrl({
  section,
  onAdded,
}: {
  section: Section;
  onAdded: (row: { id: string; data: Record<string, unknown>; updatedAt: string }) => void;
}) {
  const kind = sectionKind(section);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  type LookupItem = Record<string, string> & { position?: number };
  type LookupSingle = LookupItem & { kind?: string };
  type LookupPlaylist = { kind: 'playlist'; playlistId: string; playlistName?: string; items: LookupItem[] };
  type LookupResult = LookupSingle | LookupPlaylist;
  function isPlaylist(p: LookupResult): p is LookupPlaylist {
    return p && (p as LookupPlaylist).kind === 'playlist'
      && Array.isArray((p as LookupPlaylist).items);
  }
  const [preview, setPreview] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup() {
    if (!url.trim()) return;
    setBusy(true);
    setPreview(null);
    try {
      const r = await fetch('/api/import/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!r.ok) throw new Error(`Lookup failed: ${r.status}`);
      setPreview((await r.json()) as LookupResult);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Nothing to add yet');
      const allowed = new Set(section.schema.headers);

      // Look up existing URLs in this section so re-adding a video,
      // playlist, or paper doesn't pile up duplicate rows.
      const existing = await fetch(`/api/sections/${section.slug}/rows`).then((r) => r.json()).catch(() => ({ rows: [] }));
      const existingUrls = new Set<string>(
        (existing.rows || [])
          .map((er: { data: Record<string, unknown> }) => String(er.data.url || ''))
          .filter(Boolean),
      );

      // Playlist branch: fan out into N rows, one per video. Use the
      // scraped playlist NAME (not the bare id) so the column is
      // readable. Dedup by URL: a re-add only inserts new videos.
      if (isPlaylist(preview)) {
        const created: { id: string; data: Record<string, unknown>; updatedAt: string }[] = [];
        let skipped = 0;
        const playlistLabel = preview.playlistName || preview.playlistId;
        for (const item of preview.items) {
          if (existingUrls.has(item.url)) { skipped++; continue; }
          const data: Record<string, unknown> = {};
          if (allowed.has('playlist')) data.playlist = playlistLabel;
          for (const [k, v] of Object.entries(item)) {
            if (v == null || v === '' || k === 'playlist' || k === 'position') continue;
            if (allowed.has(k)) data[k] = v;
          }
          // Preserve the video's place in the playlist as a meta
          // field (underscore-prefixed → hidden from the column
          // grid) so the section can sort rows back into playlist
          // order regardless of when each row was created.
          if (typeof item.position === 'number') data._playlistPos = item.position;
          const r = await fetch(`/api/sections/${section.slug}/rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
          });
          if (!r.ok) throw new Error(`Add row failed: ${r.status}`);
          created.push(await r.json());
        }
        return { many: created, skipped, playlistLabel };
      }

      // Single row branch.
      const data: Record<string, unknown> = {};
      Object.entries(preview as LookupItem).forEach(([k, v]) => {
        if (v == null || v === '') return;
        if (allowed.has(k)) data[k] = v;
      });
      if (Object.keys(data).length === 0) data.url = url.trim();
      const targetUrl = String(data.url || url.trim());
      if (targetUrl && existingUrls.has(targetUrl)) {
        return { duplicate: true, one: null };
      }
      const r = await fetch(`/api/sections/${section.slug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error(`add: ${r.status}`);
      const created = (await r.json()) as { id: string; data: Record<string, unknown>; updatedAt: string };

      // Auto-mirror papers to the user's Drive on add so the preview
      // opens straight onto the annotated viewer rather than a
      // "Mirroring…" placeholder. Loud on failure now — silent
      // failures looked like the auto-save wasn't running at all.
      if (section.preset === 'papers' && created?.id) {
        (async () => {
          try {
            const r = await fetch(`/api/sections/${section.slug}/rows/${created.id}/save-offline`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'paper' }),
            });
            await readNdjsonResult(r);
          } catch (e) {
            notify.error(`Paper auto-save to Drive failed: ${(e as Error).message}`);
          }
        })();
      }
      // Auto-enrich metadata on add. The server's refresh-metadata
      // route knows how to dispatch based on the URL shape: YouTube
      // (needs API key — 409s silently if absent), arxiv, DOI. We
      // fire-and-forget; on success the row's local state is
      // patched so the new title / channel / duration shows up
      // without a reload.
      if (created?.id) {
        (async () => {
          try {
            const mr = await fetch(`/api/sections/${section.slug}/rows/${created.id}/refresh-metadata`, { method: 'POST' });
            if (!mr.ok) return; // 409 (no API key, no matching source) — silent
            const mj = (await mr.json().catch(() => ({}))) as { data?: Record<string, unknown> };
            if (mj.data) {
              // Forward the merged row.data so the parent's row cache
              // picks up the freshly-fetched title/thumbnail/etc.
              onAdded({ id: created.id, data: mj.data, updatedAt: new Date().toISOString() });
            }
          } catch { /* tolerate */ }
        })();
      }
      return { one: created };
    },
    onSuccess: (out) => {
      const o = out as { many?: { id: string; data: Record<string, unknown>; updatedAt: string }[]; skipped?: number; playlistLabel?: string; duplicate?: boolean; one?: { id: string; data: Record<string, unknown>; updatedAt: string } | null };
      if (o.many && o.many.length > 0) {
        o.many.forEach(onAdded);
        const sk = o.skipped || 0;
        toast.success(`Added ${o.many.length} new videos${sk ? ` · skipped ${sk} duplicate${sk === 1 ? '' : 's'}` : ''}${o.playlistLabel ? ` to "${o.playlistLabel}"` : ''}.`);
      } else if (o.many && o.many.length === 0 && (o.skipped || 0) > 0) {
        toast.info(`Already imported — ${o.skipped} duplicate${o.skipped === 1 ? '' : 's'} skipped.`);
      } else if (o.duplicate) {
        toast.info('Already in this section — not added again.');
      } else if (o.one) {
        onAdded(o.one);
        toast.success('Added.');
      }
      setOpen(false);
      setUrl('');
      setPreview(null);
    },
    onError: (e: Error) => notify.error(`Add failed: ${e.message}`),
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          <LinkIcon className="h-3.5 w-3.5" /> Add by URL
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Add by URL</Dialog.Title>
            <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <p className="mb-3 text-xs text-zinc-500">{helpFor(kind)}</p>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void lookup(); }}
            placeholder={placeholderFor(kind)}
            autoFocus
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={lookup}
              disabled={busy || !url.trim()}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {busy ? 'Looking up…' : 'Look up'}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={!preview || create.isPending}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50"
            >
              {create.isPending
                ? 'Adding…'
                : preview && isPlaylist(preview)
                ? `Add ${preview.items.length} videos`
                : 'Add to ' + section.slug}
            </button>
          </div>
          {preview && isPlaylist(preview) ? (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 text-zinc-600 dark:text-zinc-400">
                Playlist with <strong>{preview.items.length} video{preview.items.length === 1 ? '' : 's'}</strong>:
              </p>
              <ul className="space-y-1">
                {preview.items.slice(0, 30).map((it, i) => (
                  <li key={i} className="line-clamp-1">{it.title}</li>
                ))}
                {preview.items.length > 30 && (
                  <li className="text-zinc-500">…and {preview.items.length - 30} more</li>
                )}
              </ul>
            </div>
          ) : preview ? (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              {Object.entries(preview as Record<string, string>).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
                  <span className="text-zinc-500">{k}</span>
                  <span className="break-words">{String(v).slice(0, 400)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
