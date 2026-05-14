'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { decodeShare, decodeShareEncrypted, isEncryptedShare, type SharePayload } from '@/lib/share';
import { ShareCard } from '@/components/share-card';

export function PublicShareView() {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set to the raw token when the share is code-protected and not
   *  yet unlocked — drives the access-code prompt. */
  const [lockedToken, setLockedToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    const token = (location.hash || '').replace(/^#/, '').trim();
    if (!token) { setError('No payload in URL.'); return; }
    if (isEncryptedShare(token)) { setLockedToken(token); return; }
    try { setPayload(decodeShare(token)); }
    catch { setError('Invalid or truncated share link.'); }
  }, []);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!lockedToken || !code.trim()) return;
    setUnlocking(true);
    try {
      const p = await decodeShareEncrypted(lockedToken, code.trim());
      setPayload(p);
      setLockedToken(null);
    } catch {
      // AES-GCM auth-tag mismatch on a wrong code, or a corrupt
      // token — can't tell which apart, so phrase it for the
      // common case.
      notify.error('Wrong code, or the link is corrupted.');
    } finally {
      setUnlocking(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      toast.success('Link copied.');
    } catch {
      notify.error('Copy failed.');
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

  if (lockedToken) {
    return (
      <form onSubmit={unlock} className="space-y-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Lock className="h-5 w-5" /> Code-protected share
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This share is encrypted. Enter the access code the sender gave you — it is
          checked entirely in your browser; nothing is sent to any server.
        </p>
        <input
          type="text"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          className="w-full max-w-xs rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div>
          <button
            type="submit"
            disabled={!code.trim() || unlocking}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>
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
