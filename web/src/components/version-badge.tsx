'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { VERSION, BUILD_SHA, buildTimeShort } from '@/lib/version';

/** Small chip in the Nav. Click → copy the version string to
 * clipboard (handy when reporting a bug — gives me exactly which
 * build you're on). Brief inline "copied!" flash + toast for
 * unambiguous feedback. */
export function VersionBadge() {
  const time = buildTimeShort();
  const text = `v${VERSION} · ${BUILD_SHA}${time ? ` · ${time} UTC` : ''}`;
  const [flash, setFlash] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
      toast.success(`Copied: ${text}`);
    } catch {
      notify.error('Copy failed — your browser blocked clipboard access.');
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`${text}\nClick to copy`}
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition ${
        flash
          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          : 'border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800'
      }`}
    >
      {flash ? 'copied!' : `v${VERSION}·${BUILD_SHA}`}
    </button>
  );
}
