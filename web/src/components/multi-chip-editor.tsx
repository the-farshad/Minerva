'use client';

import { useState, useRef, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Multi-select chip editor — opens a small popover with the
 * schema-defined options, picked-on-click. Free-form input adds
 * custom values that aren't in the schema. Returns a comma-joined
 * string on commit so the row's data stays string-shaped. */
export function MultiChipEditor({
  value,
  options,
  onCommit,
}: {
  value: string;
  options: string[];
  onCommit: (next: string) => Promise<void> | void;
}) {
  const initial = parse(value);
  const [picked, setPicked] = useState<string[]>(initial);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setPicked(parse(value)); }, [value]);

  function toggle(opt: string) {
    setPicked((p) => p.includes(opt) ? p.filter((x) => x !== opt) : [...p, opt]);
  }
  function addCustom() {
    const v = draft.trim();
    if (!v) return;
    if (!picked.includes(v)) setPicked((p) => [...p, v]);
    setDraft('');
    inputRef.current?.focus();
  }
  async function save() {
    const next = picked.join(', ');
    setOpen(false);
    if (next === parse(value).join(', ')) return;
    await onCommit(next);
  }

  const allOptions = Array.from(new Set([...options, ...initial]));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex w-full flex-wrap items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          {initial.length === 0 ? (
            <span className="text-xs text-zinc-400">—</span>
          ) : (
            initial.map((v) => (
              <span
                key={v}
                className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {v}
              </span>
            ))
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={() => save()}
          className="z-50 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex flex-wrap gap-1">
            {allOptions.length === 0 && (
              <span className="text-xs text-zinc-500">No predefined options. Type below to add one.</span>
            )}
            {allOptions.map((o) => (
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
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addCustom(); }
                else if (e.key === 'Escape') { e.preventDefault(); save(); }
              }}
              placeholder="Add custom…"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={addCustom}
              className="rounded-full bg-zinc-200 p-1 hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700"
              title="Add"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => save()}
              className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
              title="Done"
            >
              Done
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function parse(v: string | null | undefined): string[] {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
