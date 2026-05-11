'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { renderMarkdown } from '@/lib/markdown';
import { readPref, writePref } from '@/lib/prefs';

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
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>(
    () => (readPref<string>('notes.mode', 'edit') as 'edit' | 'split' | 'preview') || 'edit',
  );
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  function changeMode(next: 'edit' | 'split' | 'preview') {
    setMode(next);
    writePref('notes.mode', next);
  }

  // Only resync from `initial` when the row itself changes (the
  // pane was mounted for a different paper / video). Reacting to
  // every `initial` change clobbers the user's in-flight edits the
  // moment any parent re-render happens with a stale value.
  useEffect(() => { setValue(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rowId]);

  // Flush an in-flight edit on unmount. If the user closes the
  // preview modal mid-debounce (within the 1.2 s window after
  // their last keystroke), the textarea unmounts and the timer
  // never fires — the save would be lost. Refs read the latest
  // value/initial without re-running the effect on every keystroke.
  const valueRef = useRef(value);
  const initialOnMountRef = useRef(initial);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { initialOnMountRef.current = initial; }, [rowId, initial]);
  useEffect(() => {
    return () => {
      if (t.current) { clearTimeout(t.current); t.current = null; }
      if (valueRef.current !== initialOnMountRef.current) {
        void save(valueRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const paneWidth = mode === 'split' ? 'w-[36rem]' : 'w-80';
  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <aside className={`flex h-full ${paneWidth} flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950`}>
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <strong>Notes</strong>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
            {(['edit', 'split', 'preview'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => changeMode(m)}
                className={`rounded-full px-2 py-0.5 text-[10px] capitalize ${mode === m ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
                title={`Switch to ${m} mode`}
              >
                {m}
              </button>
            ))}
          </div>
          <span className="text-zinc-500">
            {saving === 'pending' ? 'Saving…' : saving === 'saved' ? '✓ Saved' : saving === 'error' ? '⚠ retry' : ''}
          </span>
        </div>
      </div>
      <div className={`flex flex-1 overflow-hidden ${mode === 'split' ? 'divide-x divide-zinc-200 dark:divide-zinc-800' : ''}`}>
        {showEditor && (
          <textarea
            value={value}
            onChange={(e) => schedule(e.target.value)}
            onBlur={() => {
              if (t.current) { clearTimeout(t.current); t.current = null; }
              if (value !== initial) void save(value);
            }}
            placeholder="Markdown — autosaves to row.notes"
            className="h-full flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs focus:outline-none"
          />
        )}
        {showPreview && (
          <div
            className="prose prose-sm h-full flex-1 overflow-auto p-3 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(value) || '<em class="text-zinc-500">Nothing yet — switch to Edit and start typing.</em>',
            }}
          />
        )}
      </div>
    </aside>
  );
}
