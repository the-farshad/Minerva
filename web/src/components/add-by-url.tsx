'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
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
      setPreview(await r.json());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Nothing to add yet');
      // Drop any keys the section doesn't have a column for; the
      // row's data is schemaless JSONB but keeping it clean makes
      // the table renderable.
      const allowed = new Set(section.schema.headers);
      const data: Record<string, unknown> = {};
      Object.entries(preview).forEach(([k, v]) => {
        if (v == null || v === '') return;
        if (allowed.has(k)) data[k] = v;
      });
      if (Object.keys(data).length === 0) data.url = url.trim();
      const r = await fetch(`/api/sections/${section.slug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error(`add: ${r.status}`);
      return (await r.json()) as { id: string; data: Record<string, unknown>; updatedAt: string };
    },
    onSuccess: (row) => {
      onAdded(row);
      toast.success('Added.');
      setOpen(false);
      setUrl('');
      setPreview(null);
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
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
              className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {create.isPending ? 'Adding…' : 'Add to ' + section.slug}
            </button>
          </div>
          {preview && (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              {Object.entries(preview).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
                  <span className="text-zinc-500">{k}</span>
                  <span className="break-words">{String(v).slice(0, 400)}</span>
                </div>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
