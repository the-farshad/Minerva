'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, RefreshCw, Rss, Calendar } from 'lucide-react';

type Feeds = { token: string; ical: string; rss: string; inbox: string };

export function FeedsCard() {
  const [feeds, setFeeds] = useState<Feeds | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const r = await fetch('/api/feeds');
      if (!r.ok) throw new Error(String(r.status));
      setFeeds(await r.json());
    } catch (e) {
      toast.error('Could not load feeds: ' + (e as Error).message);
    }
  }
  async function rotate() {
    if (busy) return;
    if (!confirm('Rotate the feed token? Old subscription URLs will stop working.')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/feeds/rotate', { method: 'POST' });
      if (!r.ok) throw new Error(String(r.status));
      setFeeds(await r.json());
      toast.success('Token rotated.');
    } catch (e) {
      toast.error('Rotate failed: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(s: string) {
    try { await navigator.clipboard.writeText(s); toast.success('Copied.'); }
    catch { toast.error('Copy failed.'); }
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <strong className="text-sm">Feeds</strong>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Subscribe in your calendar / RSS reader. The token in the URL is the only credential — treat it like a password.
      </p>
      {feeds && (
        <div className="mt-3 space-y-2 text-xs">
          <FeedRow Icon={Calendar} label="iCal" url={feeds.ical} onCopy={() => copy(feeds.ical)} />
          <FeedRow Icon={Rss} label="RSS" url={feeds.rss} onCopy={() => copy(feeds.rss)} />
        </div>
      )}
      <div className="mt-3">
        <button
          type="button"
          onClick={rotate}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" /> Rotate token
        </button>
      </div>
    </div>
  );
}

function FeedRow({
  Icon, label, url, onCopy,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  url: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 text-zinc-500" />
      <span className="w-12 font-medium">{label}</span>
      <input
        readOnly
        value={url}
        onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
        className="flex-1 truncate rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-800"
      />
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center rounded-full border border-zinc-200 p-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        title="Copy URL"
      >
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}
