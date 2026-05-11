'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** Markdown notes sidebar for the preview modal. Persists into the
 * row's `notes` column via the existing PATCH /rows/[id]. Debounced
 * save (1.2s) so every keystroke doesn't slam the server. */
export function NotesPane({
  sectionSlug,
  rowId,
  initial,
}: {
  sectionSlug: string;
  rowId: string;
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle');
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setValue(initial); }, [initial]);

  function schedule(next: string) {
    setValue(next);
    setSaving('pending');
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => save(next), 1200);
  }

  async function save(next: string) {
    try {
      const r = await fetch(`/api/sections/${sectionSlug}/rows/${rowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { notes: next } }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch (e) {
      setSaving('error');
      toast.error('Notes save failed: ' + (e as Error).message);
    }
  }

  return (
    <aside className="flex h-full w-80 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <strong>Notes</strong>
        <span className="text-zinc-500">
          {saving === 'pending' ? 'Saving…' : saving === 'saved' ? '✓ Saved' : saving === 'error' ? '⚠ retry' : ''}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => schedule(e.target.value)}
        onBlur={() => {
          if (t.current) { clearTimeout(t.current); t.current = null; }
          if (value !== initial) void save(value);
        }}
        placeholder="Markdown — autosaves to row.notes"
        className="h-full w-full flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs focus:outline-none"
      />
    </aside>
  );
}
