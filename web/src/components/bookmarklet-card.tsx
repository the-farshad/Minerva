'use client';

import { useEffect, useState } from 'react';
import { Bookmark, Copy } from 'lucide-react';
import { toast } from 'sonner';

export function BookmarkletCard() {
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/feeds');
        if (!r.ok) return;
        const j = (await r.json()) as { inbox: string };
        setEndpoint(j.inbox);
      } catch { /* tolerate */ }
    })();
  }, []);

  const snippet = endpoint
    ? `javascript:(function(){fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:location.href,title:document.title})}).then(r=>{if(r.ok){alert('Saved to Minerva Inbox.')}else{alert('Failed: '+r.status)}}).catch(e=>alert('Failed: '+e))})();`
    : '';

  async function copy() {
    if (!snippet) return;
    try { await navigator.clipboard.writeText(snippet); toast.success('Bookmarklet copied.'); }
    catch { toast.error('Copy failed — drag the link to your bookmarks bar instead.'); }
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <Bookmark className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">Bookmarklet</strong>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Drag this link to your bookmarks bar. Clicking it on any page saves the URL to your
        Minerva <strong>Inbox</strong> section (auto-created on first use).
      </p>
      {snippet && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* The anchor's href IS the bookmarklet, so users can drag it. */}
          <a
            href={snippet}
            onClick={(e) => e.preventDefault()}
            className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
          >
            ⭐ Save to Minerva
          </a>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <Copy className="h-3 w-3" /> Copy source
          </button>
        </div>
      )}
    </div>
  );
}
