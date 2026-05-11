'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, Upload, Archive } from 'lucide-react';
import { appConfirm } from './confirm';

export function BackupCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function restore(file: File, mode: 'merge' | 'replace') {
    setBusy(true);
    toast.info(`Restoring (${mode})…`);
    try {
      const text = await file.text();
      const r = await fetch(`/api/backup/restore?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || String(r.status));
      toast.success(`Restored · ${j.sectionsCreated} new sections, ${j.rowsInserted} rows.`);
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      toast.error('Restore failed: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">Backup &amp; restore</strong>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Export every section + row + cross-device pref as one JSON. OAuth tokens
        and the Telegram bot token are intentionally excluded — re-link those by
        signing in.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href="/api/backup"
          download
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
        >
          <Download className="h-3 w-3" /> Download backup
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Upload className="h-3 w-3" /> Restore (merge)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const ok = await appConfirm('Restore in replace mode?', { body: 'Wipes existing rows in matching sections before importing.', dangerLabel: 'Replace' });
            if (!ok) return;
            const inp = fileRef.current;
            if (!inp) return;
            inp.dataset.mode = 'replace';
            inp.click();
          }}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950"
        >
          <Upload className="h-3 w-3" /> Restore (replace)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const mode = (fileRef.current?.dataset.mode === 'replace') ? 'replace' : 'merge';
            void restore(f, mode);
            if (fileRef.current) {
              fileRef.current.value = '';
              delete fileRef.current.dataset.mode;
            }
          }}
        />
      </div>
    </div>
  );
}
