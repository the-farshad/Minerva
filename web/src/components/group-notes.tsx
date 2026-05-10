'use client';

import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { StickyNote, X } from 'lucide-react';
import { readPref, writePref } from '@/lib/prefs';

/** Per-(section, group) markdown notes. Stored client-side for now;
 * a future build will mirror to PG so notes survive a fresh device. */
export function GroupNotes({ sectionSlug, groupKey }: { sectionSlug: string; groupKey: string }) {
  const storageKey = `groupnotes.${sectionSlug}.${groupKey}`;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    const v = readPref<string>(storageKey, '');
    setValue(v);
    setHasContent(!!v.trim());
  }, [storageKey]);

  function save(next: string) {
    writePref(storageKey, next);
    setHasContent(!!next.trim());
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          title={hasContent ? `Notes for "${groupKey}"` : `Add notes for "${groupKey}"`}
          className={`relative inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 ${hasContent ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'}`}
        >
          <StickyNote className="h-3.5 w-3.5" />
          {hasContent && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Notes — {groupKey}</Dialog.Title>
            <Dialog.Close className="rounded-full p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={12}
            placeholder="Markdown notes for this group. Cmd/Ctrl-Enter to save."
            className="w-full resize-y rounded-md border border-zinc-300 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save(value);
              }
            }}
            autoFocus
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => save(value)}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
