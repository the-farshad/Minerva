'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import Link from 'next/link';

type Hit = {
  id: string;
  sectionSlug: string;
  sectionTitle: string;
  data: Record<string, unknown>;
  updatedAt: string;
};

export function SearchBar() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function schedule(v: string) {
    setQ(v);
    if (t.current) clearTimeout(t.current);
    if (!v.trim()) { setHits([]); return; }
    t.current = setTimeout(() => run(v), 200);
  }
  async function run(query: string) {
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(query));
      if (!r.ok) return;
      const j = (await r.json()) as { rows: Hit[] };
      setHits(j.rows || []);
    } catch { /* tolerate */ }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={q}
          onChange={(e) => schedule(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search…"
          className="w-48 rounded-full border border-zinc-200 bg-white py-1 pl-7 pr-3 text-xs focus:w-64 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      {open && (q || hits.length > 0) && (
        <div className="absolute right-0 top-full z-50 mt-2 w-96 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          {hits.length === 0 ? (
            <div className="px-4 py-3 text-xs text-zinc-500">
              {q ? 'No matches.' : 'Type to search.'}
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {hits.map((h) => {
                const title = String(h.data.title || h.data.name || h.id);
                return (
                  <li key={h.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <Link
                      href={`/s/${encodeURIComponent(h.sectionSlug)}?row=${encodeURIComponent(h.id)}`}
                      onClick={() => setOpen(false)}
                      className="block px-3 py-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <div className="line-clamp-1 font-medium">{title}</div>
                      <div className="text-zinc-500">/{h.sectionSlug}</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
