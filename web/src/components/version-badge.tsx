'use client';

import { VERSION, BUILD_SHA, buildTimeShort } from '@/lib/version';

/** Small chip displayed in the Nav. Click to copy the full
 * commit SHA — useful when reporting a bug. */
export function VersionBadge() {
  const time = buildTimeShort();
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            `v${VERSION} · ${BUILD_SHA}${time ? ` · ${time} UTC` : ''}`,
          );
        } catch { /* tolerate */ }
      }}
      title={`Build: ${BUILD_SHA}${time ? ` · ${time} UTC` : ''}\nClick to copy`}
      className="rounded-full border border-zinc-200 px-2 py-0.5 font-mono text-[10px] text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
    >
      v{VERSION}·{BUILD_SHA}
    </button>
  );
}
