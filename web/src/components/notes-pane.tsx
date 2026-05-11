'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

/** Markdown notes sidebar for the preview modal. Persists into the
 * row's `notes` column via the existing PATCH /rows/[id]. Debounced
 * save (1.2s) so every keystroke doesn't slam the server. */
export function NotesPane({
  sectionSlug,
  rowId,
  initial,
  onSaved,
}: {
  sectionSlug: string;
  rowId: string;
  initial: string;
  /** Notify the parent of a successful save so its local row state
   * doesn't drift out of sync with the server. Without this, the
   * parent's `rows` cache still holds the pre-edit notes and any
   * re-render trickles the stale value back down via `initial`,
   * wiping the textarea mid-edit. */
  onSaved?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle');
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only resync from `initial` when the row itself changes (the
  // pane was mounted for a different paper / video). Reacting to
  // every `initial` change clobbers the user's in-flight edits the
  // moment any parent re-render happens with a stale value.
  useEffect(() => { setValue(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rowId]);

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
      onSaved?.(next);
      setTimeout(() => setSaving('idle'), 1200);
    } catch (e) {
      setSaving('error');
      notify.error('Notes save failed: ' + (e as Error).message);
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
