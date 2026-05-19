'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Pending = {
  title: string;
  body?: string;
  options: string[];
  initial?: string[];
  resolve: (value: string[] | null) => void;
};

let externalSet: ((p: Pending | null) => void) | null = null;

/** Imperative multi-select chip picker — opens a modal that lets
 * the user toggle the schema-defined options, type custom ones,
 * and resolves to the array of picked values. Returns `null` on
 * cancel. Used by bulk operations like "Set category for entire
 * playlist" where the inline-cell editor isn't available. */
export function appPickMany(
  title: string,
  options: string[],
  opts?: { body?: string; initial?: string[] },
): Promise<string[] | null> {
  return new Promise((resolve) => {
    if (externalSet) externalSet({ title, options, initial: opts?.initial, body: opts?.body, resolve });
    else resolve(null);
  });
}

export function MultiPickerHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    externalSet = (p) => {
      setPending(p);
      setPicked(p?.initial ?? []);
      setDraft('');
      if (p) setTimeout(() => inputRef.current?.focus(), 50);
    };
    return () => { externalSet = null; };
  }, []);

  function answer(v: string[] | null) {
    pending?.resolve(v);
    setPending(null);
  }
  function toggle(o: string) {
    setPicked((p) => p.includes(o) ? p.filter((x) => x !== o) : [...p, o]);
  }

  // Sorted union of all known options + every currently-picked
  // value, so picks made via the draft input stay visible as
  // selected chips even when they don't match the filter below.
  const allOptions = pending
    ? Array.from(new Set([...pending.options, ...(pending.initial || []), ...picked]))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    : [];

  // Live-filter the option chip list by the input draft so the
  // user can search "alg" and see "Algorithms" highlighted. Empty
  // draft → show everything. Substring match, case-insensitive.
  const draftLower = draft.trim().toLowerCase();
  const filtered = draftLower
    ? allOptions.filter((o) => o.toLowerCase().includes(draftLower))
    : allOptions;
  const exactMatchExists = draftLower
    ? allOptions.some((o) => o.toLowerCase() === draftLower)
    : true;

  function commitDraft() {
    const v = draft.trim();
    if (!v) return;
    // If the input matches exactly an existing option, treat
    // Enter as "toggle that one"; otherwise add it as a new
    // custom value. This is the common "click suggestion vs.
    // press Enter to add new" pattern.
    const exact = allOptions.find((o) => o.toLowerCase() === v.toLowerCase());
    if (exact) {
      if (!picked.includes(exact)) setPicked((p) => [...p, exact]);
    } else if (!picked.includes(v)) {
      setPicked((p) => [...p, v]);
    }
    setDraft('');
    inputRef.current?.focus();
  }

  return (
    <Dialog.Root open={!!pending} onOpenChange={(o) => { if (!o) answer(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(500px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <Dialog.Title className="text-sm font-semibold">{pending?.title}</Dialog.Title>
          {pending?.body && (
            <Dialog.Description className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {pending.body}
            </Dialog.Description>
          )}
          {/* Search / add input first so typing immediately
            *  filters the chip list below (and Enter adds the
            *  draft as a new option when no match exists). */}
          <div className="mt-3 flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitDraft(); }
                else if (e.key === 'Escape') {
                  // Clear filter first; second Escape cancels.
                  if (draft) { e.preventDefault(); setDraft(''); }
                  else { e.preventDefault(); answer(null); }
                }
              }}
              placeholder={allOptions.length > 0 ? 'Search or add…' : 'Type to add…'}
              className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={commitDraft}
              disabled={!draft.trim()}
              className="rounded-full bg-zinc-200 p-1 hover:bg-zinc-300 disabled:opacity-40 dark:bg-zinc-800 dark:hover:bg-zinc-700"
              title={draft.trim() && !exactMatchExists ? `Add "${draft.trim()}"` : 'Add'}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          {/* Fixed height window for the chip list so the dialog
            *  stays the same size while the user types. Filtering
            *  used to shrink the box from "lots of chips" to "one
            *  match", which made the modal pop / jump under the
            *  cursor — disorienting even though the filter worked.
            *  `h-64 overflow-y-auto` always reserves 16rem and
            *  scrolls inside when the chip list is longer. */}
          <div className="mt-3 flex h-64 flex-wrap content-start gap-1.5 overflow-y-auto rounded-md border border-zinc-100 p-2 dark:border-zinc-800">
            {allOptions.length === 0 ? (
              <span className="text-xs text-zinc-500">No options yet — type above to add one.</span>
            ) : filtered.length === 0 ? (
              <span className="text-xs text-zinc-500">
                No matches. Press Enter to add &ldquo;{draft.trim()}&rdquo;.
              </span>
            ) : (
              filtered.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => toggle(o)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-xs transition',
                    picked.includes(o)
                      ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300',
                  )}
                >
                  {o}
                </button>
              ))
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(null)}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <X className="mr-1 inline h-3 w-3" /> Cancel
            </button>
            <button
              type="button"
              onClick={() => answer(picked)}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
            >
              Apply
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
