'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';

type Pending = { title: string; body?: string; dangerLabel?: string; resolve: (ok: boolean) => void };

let externalSet: ((p: Pending | null) => void) | null = null;

/** In-app replacement for `window.confirm`. Returns a promise that
 * resolves true / false. The host `<ConfirmHost />` lives in Providers
 * so any client component can call it. No browser dialogs. */
export function appConfirm(title: string, opts?: { body?: string; dangerLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (externalSet) {
      externalSet({ title, body: opts?.body, dangerLabel: opts?.dangerLabel, resolve });
    } else {
      // Fallback: synchronous false if the host somehow isn't mounted.
      resolve(false);
    }
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    externalSet = setPending;
    return () => { externalSet = null; };
  }, []);

  function answer(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <Dialog.Root open={!!pending} onOpenChange={(o) => { if (!o) answer(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="flex-1">
              <Dialog.Title className="text-sm font-semibold">{pending?.title}</Dialog.Title>
              {pending?.body && (
                <Dialog.Description className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {pending.body}
                </Dialog.Description>
              )}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(false)}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
            >
              {pending?.dangerLabel || 'Confirm'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
