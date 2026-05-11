'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

type Pending = {
  title: string;
  body?: string;
  placeholder?: string;
  initial?: string;
  okLabel?: string;
  resolve: (value: string | null) => void;
};

let externalSet: ((p: Pending | null) => void) | null = null;

/** In-app replacement for `window.prompt`. Resolves to the typed
 * string, or `null` if cancelled. Host lives in Providers. */
export function appPrompt(title: string, opts?: { body?: string; placeholder?: string; initial?: string; okLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    if (externalSet) {
      externalSet({
        title,
        body: opts?.body,
        placeholder: opts?.placeholder,
        initial: opts?.initial,
        okLabel: opts?.okLabel,
        resolve,
      });
    } else {
      resolve(null);
    }
  });
}

export function PromptHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    externalSet = (p) => {
      setPending(p);
      setValue(p?.initial ?? '');
      if (p) setTimeout(() => inputRef.current?.focus(), 50);
    };
    return () => { externalSet = null; };
  }, []);

  function answer(v: string | null) {
    pending?.resolve(v);
    setPending(null);
  }

  return (
    <Dialog.Root open={!!pending} onOpenChange={(o) => { if (!o) answer(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <Dialog.Title className="text-sm font-semibold">{pending?.title}</Dialog.Title>
          {pending?.body && (
            <Dialog.Description className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {pending.body}
            </Dialog.Description>
          )}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); answer(value); }
              if (e.key === 'Escape') { e.preventDefault(); answer(null); }
            }}
            placeholder={pending?.placeholder}
            className="mt-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(null)}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => answer(value)}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-zinc-900"
            >
              {pending?.okLabel || 'OK'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
