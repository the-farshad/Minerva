'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Paperclip, Pencil, Download, FilePlus, Printer } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown';
import { appPrompt } from './prompt';
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
  // Counted depth so re-entering a child element doesn't clear
  // the drag-over highlight (dragenter fires on every nested
  // node we cross; dragleave fires the same way going out).
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

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
      // For a single file, splice at the textarea caret (the natural
      // place a user expects an attachment to land). For multiple
      // files in one drop, the splice closure would capture stale
      // `value` between iterations and only the LAST upload would
      // survive — so we accumulate snippets locally and apply once.
      const snippets: string[] = [];
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
        snippets.push(isImage ? `![${file.name}](${url})\n` : `[${file.name}](${url})\n`);
      }
      if (list.length === 1) {
        spliceAtCaret(snippets[0]);
      } else {
        // Append the batch in order. Use the functional update form
        // implicitly via schedule(value+block) — value here is the
        // current state at the END of the synchronous handler, which
        // is stable because no React render has interleaved with the
        // awaits above (the textarea has been blurred by the file
        // picker / drop, so onChange can't have fired).
        const block = snippets.join('');
        const next = !value || value.endsWith('\n') ? value + block : value + '\n' + block;
        schedule(next);
      }
      toast.success(list.length === 1 ? 'File attached.' : `${list.length} files attached.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!e.dataTransfer.files?.length) return;
    void uploadFiles(e.dataTransfer.files);
  }
  function onDragEnter(e: React.DragEvent<HTMLElement>) {
    // Only react to drags that actually carry files — text/HTML
    // selections from the page itself shouldn't paint the drop
    // target.
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!dragging) setDragging(true);
  }
  function onDragLeave(e: React.DragEvent<HTMLElement>) {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
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
      className={`relative flex h-full ${paneWidth} flex-col border-l ${dragging ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-zinc-200 dark:border-zinc-800'} bg-white dark:bg-zinc-950`}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-blue-500/5 text-xs font-medium text-blue-700 dark:text-blue-300">
          Drop to upload + attach
        </div>
      )}
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
            onClick={async () => {
              const title = await appPrompt('New note section', {
                okLabel: 'Insert',
                placeholder: 'e.g. Today’s read',
              });
              const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
              const heading = title?.trim() ? `${stamp} — ${title.trim()}` : stamp;
              spliceAtCaret(`\n## ${heading}\n\n`);
            }}
            title="Insert a dated section heading — quick way to start a new note in this row"
            className="inline-flex items-center gap-1 rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
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
          <button
            type="button"
            onClick={() => {
              if (!value.trim()) {
                toast.info('Nothing to download — write something first.');
                return;
              }
              const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `notes-${rowId.slice(0, 8)}.md`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
            title="Download these notes as a Markdown file"
            className="inline-flex items-center gap-1 rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (!value.trim()) {
                toast.info('Nothing to print — write something first.');
                return;
              }
              // Open a clean popup window with the rendered markdown
              // and trigger window.print. The user picks "Save as PDF"
              // in the browser's print dialog — works on iOS, Mac,
              // Windows, Linux without any JS dep.
              const html = renderMarkdown(value);
              const popup = window.open('', '_blank', 'width=840,height=900');
              if (!popup) {
                toast.error('Pop-up blocked — allow pop-ups for Minerva to print notes.');
                return;
              }
              popup.document.write(`<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Note · ${rowId.slice(0, 8)}</title>
<style>
  body { font: 14px/1.6 Georgia, serif; max-width: 720px; margin: 2rem auto; padding: 0 1.5rem; color: #1f1f1f; }
  h1, h2, h3, h4 { font-family: -apple-system, system-ui, sans-serif; line-height: 1.25; }
  pre, code { font-family: ui-monospace, "JetBrains Mono", monospace; }
  pre { background: #f4f4f5; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  code { background: #f4f4f5; padding: 0 .25rem; border-radius: 3px; }
  blockquote { border-left: 3px solid #d4d4d8; margin: 1rem 0; padding-left: 1rem; color: #52525b; font-style: italic; }
  img { max-width: 100%; height: auto; }
  a { color: #1d4ed8; }
  hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2rem 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e4e4e7; padding: .35rem .6rem; text-align: left; }
  @media print { body { margin: 1rem; } }
</style>
</head><body>${html}</body></html>`);
              popup.document.close();
              popup.focus();
              setTimeout(() => popup.print(), 300);
            }}
            title="Open the rendered notes in a printable view — pick 'Save as PDF' in the print dialog"
            className="inline-flex items-center gap-1 rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Printer className="h-3.5 w-3.5" />
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
