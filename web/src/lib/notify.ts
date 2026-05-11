/**
 * Toast helpers — wrap Sonner so every error message gets a built-in
 * `Copy` action and stays on screen long enough to actually read.
 * Call sites use `notify.error(msg)` instead of `toast.error(msg)`.
 */
'use client';

import { createElement } from 'react';
import { toast } from 'sonner';

function doCopy(s: string) {
  try {
    void navigator.clipboard.writeText(s);
    toast.success('Copied to clipboard');
  } catch { /* tolerate */ }
}

export const notify = {
  error(msg: string) {
    // Wrap the message in a span with an onClick so a single
    // click anywhere on the toast body copies the full text. The
    // earlier design required hitting a 40-px "Copy" action button
    // — impossible when an iframe (Drive preview, YouTube embed)
    // takes up most of the screen and eats every imprecise click.
    // The explicit Copy action is still rendered as a visual cue.
    toast.error(
      createElement(
        'span',
        {
          role: 'button',
          tabIndex: 0,
          onClick: () => doCopy(msg),
          className: 'cursor-copy block',
          title: 'Click to copy the full error',
        },
        msg,
      ),
      {
        duration: 15_000,
        action: { label: 'Copy', onClick: () => doCopy(msg) },
      },
    );
  },
  info(msg: string) { toast.info(msg); },
  success(msg: string) { toast.success(msg); },
};
