'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { decodeShare, type SharePayload } from '@/lib/share';
import { ShareCard } from '@/components/share-card';

export function PublicShareView() {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = (location.hash || '').replace(/^#/, '').trim();
    if (!token) { setError('No payload in URL.'); return; }
    try { setPayload(decodeShare(token)); }
    catch { setError('Invalid or truncated share link.'); }
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      toast.success('Link copied.');
    } catch {
      toast.error('Copy failed.');
    }
  }

  if (error) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Invalid share link</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
        <p className="text-sm">
          <Link href="/share" className="underline">Create a new one</Link>
        </p>
      </div>
    );
  }
  if (!payload) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <ShareCard payload={payload} />
      <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          Shared via <Link href="/" className="underline">Minerva</Link>. The data lives in the URL itself — no server is involved.
        </span>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2.5 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Copy className="h-3 w-3" /> Copy link
        </button>
      </div>
    </div>
  );
}
