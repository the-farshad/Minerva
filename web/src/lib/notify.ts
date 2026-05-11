/**
 * Toast helpers — wrap Sonner so every error message is a single,
 * click-anywhere-to-copy panel. Call sites use `notify.error(msg)`.
 */
'use client';

import type { MouseEvent } from 'react';
import { createElement } from 'react';
import { toast } from 'sonner';

function doCopy(s: string) {
  try {
    void navigator.clipboard.writeText(s);
    toast.success('Copied to clipboard');
  } catch { /* tolerate */ }
}

export const notify = {
  /** Open a click-to-copy error toast. We bypass `toast.error()`
   * because Sonner v2 wraps the message inside its own clickable
   * shell and on some surfaces (modals over iframes, narrow grids)
   * the click never makes it to the message span. `toast.custom`
   * gives us a single owning element where we can mount our own
   * click handler at the root. */
  error(msg: string) {
    toast.custom((id) => createElement(
      'div',
      {
        role: 'button',
        tabIndex: 0,
        title: 'Click anywhere to copy this error',
        onClick: (e: MouseEvent<HTMLDivElement>) => {
          e.stopPropagation();
          doCopy(msg);
          toast.dismiss(id);
        },
        className: [
          'pointer-events-auto cursor-copy select-text',
          'max-w-md rounded-lg border shadow-lg p-3 text-sm',
          'border-red-300 bg-red-50 text-red-900',
          'dark:border-red-700 dark:bg-red-950 dark:text-red-100',
        ].join(' '),
      },
      createElement('div', { className: 'break-words' }, msg),
      createElement(
        'div',
        { className: 'mt-2 text-[10px] opacity-70' },
        'Click anywhere on this banner to copy. Tap again to dismiss.',
      ),
    ), { duration: 15_000 });
  },
  info(msg: string) { toast.info(msg); },
  success(msg: string) { toast.success(msg); },
};
