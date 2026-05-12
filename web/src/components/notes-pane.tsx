'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Paperclip, Pencil } from 'lucide-react';
import { notify } from '@/lib/notify';
import { NotesPreview } from './notes-preview';
import { SketchModal } from './sketch-modal';
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);

  /** Splice a markdown snippet into the textarea at the caret. */
  function spliceAtCaret(snippet: string) {
    const ta = textareaRef.current;
    if (ta && document.activeElement === ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = value.slice(0, start) + snippet + value.slice(end);
      schedule(next);
      setTimeout(() => {
        ta.focus();
        const pos = start + snippet.length;
        ta.setSelectionRange(pos, pos);
      }, 0);
    } else {
      const next = (value.endsWith('\n') || !value) ? value + snippet : value + '\n' + snippet;
      schedule(next);
    }
  }

  /** Upload a file to the user's Drive and splice a markdown link
   * (or image embed when it's an image MIME) into the notes at
   * the current cursor position. Falls back to appending at the
   * end if the textarea isn't focused yet. */
  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append('file', file, file.name);
        fd.append('name', file.name);
        fd.append('kind', 'misc');
        const r = await fetch('/api/drive/upload', { method: 'POST', body: fd });
        const j = (await r.json().catch(() => ({}))) as { fileId?: string; error?: string };
        if (!r.ok || !j.fileId) throw new Error(j.error || `upload: ${r.status}`);
        const url = `/api/drive/file?id=${encodeURIComponent(j.fileId)}`;
        const isImage = /^image\//i.test(file.type);
        const snippet = isImage ? `![${file.name}](${url})\n` : `[${file.name}](${url})\n`;
        spliceAtCaret(snippet);
      }
      toast.success(list.length === 1 ? 'File attached.' : `${list.length} files attached.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void uploadFiles(e.dataTransfer.files);
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
    <aside
      className={`flex h-full ${paneWidth} flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950`}
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); }}
      />
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <strong>Notes</strong>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Attach a file (image, PDF, doc, anything) — uploaded to Drive and linked inline"
            className="inline-flex items-center gap-1 rounded-full p-1 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSketchOpen(true)}
            disabled={uploading}
            title="Open a pen-friendly sketch pad (iPad Pen / Surface Pen / Wacom pressure supported)"
            className="inline-flex items-center gap-1 rounded-full p-1 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
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
            {uploading ? 'Uploading…' : saving === 'pending' ? 'Saving…' : saving === 'saved' ? '✓ Saved' : saving === 'error' ? '⚠ retry' : ''}
          </span>
        </div>
      </div>
      <div className={`flex flex-1 overflow-hidden ${mode === 'split' ? 'divide-x divide-zinc-200 dark:divide-zinc-800' : ''}`}>
        {showEditor && (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => schedule(e.target.value)}
            onBlur={() => {
              if (t.current) { clearTimeout(t.current); t.current = null; }
              if (value !== initial) void save(value);
            }}
            placeholder={'Markdown — autosaves to row.notes.\nDrop files here to attach, or click the 📎.'}
            className="h-full flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs focus:outline-none"
          />
        )}
        {showPreview && (
          <div className="h-full flex-1 overflow-auto p-3">
            <NotesPreview content={value} />
          </div>
        )}
      </div>
      <SketchModal
        open={sketchOpen}
        onClose={() => setSketchOpen(false)}
        onSaved={(url, name) => spliceAtCaret(`![${name}](${url})\n`)}
      />
    </aside>
  );
}
