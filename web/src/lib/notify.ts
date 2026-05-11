/**
 * Toast helpers — wrap Sonner so every error message gets a built-in
 * `Copy` action and stays on screen long enough to actually read.
 * Call sites use `notify.error(msg)` instead of `toast.error(msg)`.
 */
'use client';

import { toast } from 'sonner';

function doCopy(s: string) {
  try { void navigator.clipboard.writeText(s); }
  catch { /* tolerate */ }
}

export const notify = {
  error(msg: string) {
    toast.error(msg, {
      duration: 10_000,
      action: { label: 'Copy', onClick: () => doCopy(msg) },
    });
  },
  info(msg: string) { toast.info(msg); },
  success(msg: string) { toast.success(msg); },
};
