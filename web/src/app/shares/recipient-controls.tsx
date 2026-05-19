'use client';

/**
 * Owner-side popover on each recipient chip in /shares outgoing.
 * Change permission, toggle owner→recipient progress sharing,
 * or remove the recipient — without leaving the page.
 */
import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Trash2, MoreVertical } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

export function RecipientControls({
  shareId,
  recipientId,
  mode,
  shareProgress,
  onChanged,
}: {
  shareId: string;
  recipientId: string;
  mode: 'view' | 'edit';
  shareProgress: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function patch(body: { mode?: 'view' | 'edit'; shareProgress?: boolean }) {
    setBusy(true);
    try {
      const r = await fetch(`/api/shares/${shareId}/recipients/${recipientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `patch: ${r.status}`);
      }
      onChanged();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const r = await fetch(`/api/shares/${shareId}/recipients/${recipientId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`remove: ${r.status}`);
      toast.success('Recipient removed.');
      onChanged();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Recipient options"
          disabled={busy}
          className="rounded-full p-0.5 hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/20"
          aria-label="Recipient options"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[60] min-w-[12rem] overflow-hidden rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Permission</div>
          <DropdownMenu.Item
            onSelect={(e) => { e.preventDefault(); void patch({ mode: 'view' }); }}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Check className={`h-3 w-3 ${mode === 'view' ? '' : 'opacity-0'}`} /> View only
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(e) => { e.preventDefault(); void patch({ mode: 'edit' }); }}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Check className={`h-3 w-3 ${mode === 'edit' ? '' : 'opacity-0'}`} /> Can edit
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
          <DropdownMenu.Item
            onSelect={(e) => { e.preventDefault(); void patch({ shareProgress: !shareProgress }); }}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Check className={`h-3 w-3 ${shareProgress ? '' : 'opacity-0'}`} /> Share my progress
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
          <DropdownMenu.Item
            onSelect={(e) => { e.preventDefault(); void remove(); }}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3 w-3" /> Remove from this share
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
