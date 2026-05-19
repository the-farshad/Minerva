'use client';

/**
 * Recipient-side toggle for the inverse progress direction. When
 * checked, the OWNER of the share can see the recipient's watch
 * progress on every row in the shared scope. Independent from the
 * owner's `shareProgress` flag — both can be flipped on / off
 * without affecting the other.
 */
import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

export function ShareBackToggle({
  recipientId,
  initial,
}: {
  recipientId: string;
  initial: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function flip(next: boolean) {
    setBusy(true);
    setOn(next);
    try {
      const r = await fetch(`/api/shares/recipients/${recipientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientShareProgress: next }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `${r.status}`);
      }
      toast.success(next ? 'Owner can now see your progress.' : 'Owner can no longer see your progress.');
    } catch (e) {
      setOn(!next);
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => void flip(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
      />
      <span className="inline-flex items-center gap-1.5">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
          on ? <Eye className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" /> :
               <EyeOff className="h-3.5 w-3.5 text-zinc-400" />}
        Share my progress with the owner
      </span>
    </label>
  );
}
