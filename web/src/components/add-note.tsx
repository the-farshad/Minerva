'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { Plus, X, FileText, Type, Pencil, Loader2 } from 'lucide-react';

type Section = { slug: string };
type NoteType = 'text' | 'md' | 'sketch';

/** Notes-preset row creator. Lets the user pick the note type
 *  BEFORE the row is created so opening the new note jumps
 *  straight to the right editor — text vs markdown vs sketch
 *  canvas. Generic AddByUrl doesn't fit because notes aren't
 *  URL-keyed. */
export function AddNote({
  section, onAdded,
}: {
  section: Section;
  onAdded: (row: { id: string; data: Record<string, unknown>; updatedAt: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<NoteType>('md');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const TYPES: { v: NoteType; label: string; desc: string; Icon: typeof FileText }[] = [
    { v: 'text',   label: 'Text',     desc: 'Plain text — no markdown rendering.',   Icon: Type },
    { v: 'md',     label: 'Markdown', desc: 'Markdown with split / preview modes.',  Icon: FileText },
    { v: 'sketch', label: 'Sketch',   desc: 'Pen-pressure canvas, saves as PNG.',    Icon: Pencil },
  ];

  async function submit() {
    const t = title.trim();
    if (!t) { notify.error('Type a title first.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/sections/${section.slug}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { title: t, type, content: '' } }),
      });
      if (!r.ok) throw new Error(`add: ${r.status}`);
      const next = (await r.json()) as { id: string; data: Record<string, unknown>; updatedAt: string };
      onAdded(next);
      toast.success(`Added ${type === 'sketch' ? 'sketch' : type === 'text' ? 'text note' : 'markdown note'}.`);
      setOpen(false);
      setTitle('');
      setType('md');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          <Plus className="h-3 w-3" /> Add note
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[24rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-sm font-medium">New note</Dialog.Title>
            <Dialog.Close className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="text-xs text-zinc-500">Type</div>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {TYPES.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setType(t.v)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs transition ${type === t.v
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                  : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
                title={t.desc}
              >
                <t.Icon className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>

          <label className="mt-4 block">
            <div className="text-xs text-zinc-500">Title</div>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
              placeholder={type === 'sketch' ? 'e.g. Lecture diagram' : type === 'text' ? 'e.g. Daily log' : 'e.g. Project notes'}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close className="rounded-md px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !title.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {busy ? <><Loader2 className="h-3 w-3 animate-spin" /> Creating…</> : 'Create'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
