'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderPlus, X } from 'lucide-react';
import { localMirror } from '@/lib/local-mirror';

export function LocalMirrorCard() {
  const [supported, setSupported] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);

  useEffect(() => {
    setSupported(localMirror.supported());
    void refresh();
  }, []);

  async function refresh() {
    const h = await localMirror.handle();
    setFolderName(h?.name ?? null);
  }
  async function pick() {
    try {
      const h = await localMirror.pick();
      if (h) {
        toast.success(`Mirror folder set: ${h.name}`);
        setFolderName(h.name);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      toast.error('Pick failed: ' + (e as Error).message);
    }
  }
  async function clear() {
    await localMirror.clear();
    setFolderName(null);
    toast.success('Mirror folder cleared.');
  }

  if (!supported) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <strong className="text-sm">Local-disk mirror</strong>
        <p className="mt-1 text-xs text-zinc-500">
          Requires Chrome / Edge (uses the File System Access API). Firefox doesn&rsquo;t ship it.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <strong className="text-sm">Local-disk mirror</strong>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Pick a folder on this computer. Downloads also write a copy here.
      </p>
      <p className="mt-2 text-xs">
        {folderName
          ? <>Mirroring to <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{folderName}</code></>
          : <span className="text-zinc-500">No folder picked yet.</span>}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={pick}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          <FolderPlus className="h-3 w-3" /> {folderName ? 'Change folder' : 'Pick folder'}
        </button>
        {folderName && (
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <X className="h-3 w-3" /> Unset
          </button>
        )}
      </div>
    </div>
  );
}
