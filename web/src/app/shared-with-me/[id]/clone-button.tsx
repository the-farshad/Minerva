'use client';

/**
 * Client button that POSTs the shared content into a fresh section
 * in the recipient's own library. On success it redirects to the
 * new /s/<slug> so the user lands on their own copy.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

export function CloneButton({ recipientId }: { recipientId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function clone() {
    setBusy(true);
    try {
      const r = await fetch(`/api/shares/recipients/${recipientId}/clone`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; slug?: string; rowCount?: number };
      if (!r.ok) throw new Error(j.error || `clone: ${r.status}`);
      toast.success(`Cloned ${j.rowCount ?? 0} item${j.rowCount === 1 ? '' : 's'} into your library.`);
      if (j.slug) router.push(`/s/${j.slug}`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void clone()}
      disabled={busy}
      title="Make an independent copy of this share in your own library — the recipient version stays separate."
      className="mt-3 inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition disabled:opacity-50 dark:bg-white dark:text-zinc-900"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
      Clone to my library
    </button>
  );
}
