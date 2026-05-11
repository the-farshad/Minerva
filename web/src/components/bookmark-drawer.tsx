'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { Bookmark, Plus, X, Pencil } from 'lucide-react';

type B = {
  id: string;
  url: string;
  kind: 'video' | 'pdf';
  ref: number;
  label: string;
  note: string;
  createdAt: string;
};

function fmtVideoTime(s: number) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? String(h) + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
}

export function BookmarkDrawer({
  url,
  kind,
  currentRef,
  onJump,
}: {
  url: string;
  kind: 'video' | 'pdf';
  currentRef: () => number;
  onJump: (ref: number) => void;
}) {
  const [items, setItems] = useState<B[]>([]);
  const [editing, setEditing] = useState<B | null>(null);

  async function reload() {
    try {
      const r = await fetch('/api/bookmarks?url=' + encodeURIComponent(url));
      if (!r.ok) return;
      setItems((await r.json()) as B[]);
    } catch { /* tolerate */ }
  }
  useEffect(() => { setItems([]); void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [url]);

  async function addHere() {
    const ref = currentRef();
    const r = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, kind, ref, label: '', note: '' }),
    });
    if (!r.ok) { notify.error('Bookmark failed'); return; }
    const b = (await r.json()) as B;
    setItems((arr) => [...arr, b].sort((a, b) => a.ref - b.ref));
    setEditing(b);
  }
  async function remove(id: string) {
    const r = await fetch('/api/bookmarks/' + id, { method: 'DELETE' });
    if (!r.ok) { notify.error('Delete failed'); return; }
    setItems((arr) => arr.filter((x) => x.id !== id));
  }
  async function save(b: B) {
    const r = await fetch('/api/bookmarks/' + b.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: b.label, note: b.note }),
    });
    if (!r.ok) { notify.error('Save failed'); return; }
    setItems((arr) => arr.map((x) => (x.id === b.id ? b : x)));
    setEditing(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-zinc-200 bg-white/50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950/50">
      <button
        type="button"
        onClick={addHere}
        title={kind === 'video' ? 'Bookmark this moment' : 'Bookmark this page'}
        className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2 py-1 text-white dark:bg-white dark:text-zinc-900"
      >
        <Bookmark className="h-3 w-3" /> <Plus className="h-3 w-3" />
      </button>
      {items.map((b) => (
        <div
          key={b.id}
          className="group inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-white px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button
            type="button"
            onClick={() => onJump(b.ref)}
            title={b.note || b.label}
            className="text-xs"
          >
            {b.kind === 'video' ? fmtVideoTime(b.ref) : `p.${b.ref}`}
            {b.label && <span className="ml-1 text-zinc-500">· {b.label}</span>}
            {b.note && <span className="ml-1 text-amber-500">📝</span>}
          </button>
          <button
            type="button"
            onClick={() => setEditing(b)}
            title="Edit"
            className="rounded-full p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={() => remove(b.id)}
            title="Remove"
            className="rounded-full p-0.5 text-zinc-400 hover:text-red-600"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
      {editing && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-semibold">
              Bookmark · {editing.kind === 'video' ? fmtVideoTime(editing.ref) : `p.${editing.ref}`}
            </h3>
            <input
              type="text"
              value={editing.label}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              placeholder="Short label"
              className="mb-2 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <textarea
              value={editing.note}
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              placeholder="Markdown notes (Cmd/Ctrl-Enter to save)…"
              rows={6}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save(editing);
                }
              }}
              className="w-full resize-y rounded-md border border-zinc-300 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => save(editing)}
                className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
