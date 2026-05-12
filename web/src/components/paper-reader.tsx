'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown';
import { readPref, writePref } from '@/lib/prefs';
import { notify } from '@/lib/notify';

/**
 * Reflowed text view of a paper. Pulls extracted markdown from
 * row.data.extracted (cached); on first open / Re-extract, hits
 * /api/helper/pdf/extract for the paper's PDF URL and PATCHes the
 * row with the result so subsequent opens are instant.
 *
 * The PDF.js canvas view is the source of truth for figures, math
 * and exact layout — Reader is a typography-first reading surface
 * for prose-heavy papers. Caller passes the row's id, the URL the
 * loader should hit (typically /api/pdf/<rowId>), the cached
 * `extracted` field if any, and an optional `theme` so the
 * existing sepia / dark toggle in the header carries through.
 */

const FONTS = {
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  sans:  { label: 'Sans',  stack: 'ui-sans-serif, system-ui, sans-serif' },
  hyper: { label: 'Hyperlegible', stack: '"Atkinson Hyperlegible", "Inter", system-ui, sans-serif' },
  mono:  { label: 'Mono',  stack: 'ui-monospace, "JetBrains Mono", monospace' },
} as const;
type FontKey = keyof typeof FONTS;

const SIZES = {
  sm: { label: 'S', px: 13 },
  md: { label: 'M', px: 15 },
  lg: { label: 'L', px: 17 },
  xl: { label: 'XL', px: 19 },
} as const;
type SizeKey = keyof typeof SIZES;

export function PaperReader({
  rowId, sectionSlug, extractUrl, cached, theme,
}: {
  rowId: string;
  sectionSlug: string;
  /** Same-origin URL the helper should fetch the PDF bytes from
   * — typically /api/pdf/<rowId>. */
  extractUrl: string;
  /** Previously-saved markdown from row.data.extracted, if any. */
  cached: string | null;
  theme: 'light' | 'sepia' | 'dark';
}) {
  const [text, setText] = useState<string | null>(cached);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [font, setFont] = useState<FontKey>(
    () => (readPref<string>('reader.font', 'serif') as FontKey) || 'serif',
  );
  const [size, setSize] = useState<SizeKey>(
    () => (readPref<string>('reader.size', 'md') as SizeKey) || 'md',
  );

  function changeFont(f: FontKey) { setFont(f); writePref('reader.font', f); }
  function changeSize(s: SizeKey) { setSize(s); writePref('reader.size', s); }

  async function extract(loud = true) {
    setLoading(true);
    setErr(null);
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const r = await fetch('/api/helper/pdf/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${origin}${extractUrl}` }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; content?: string; markdown?: string; text?: string;
      };
      if (!r.ok || j.ok === false) throw new Error(j.error || `pdf/extract: ${r.status}`);
      const md = j.markdown || j.content || j.text || '';
      if (!md.trim()) throw new Error('Loader returned an empty document.');
      setText(md);
      // Persist back to the row so subsequent opens skip the
      // 10–30 s loader pass. Best-effort — UI keeps the in-memory
      // copy regardless.
      try {
        await fetch(`/api/sections/${sectionSlug}/rows/${rowId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { extracted: md } }),
        });
      } catch { /* tolerate */ }
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      if (loud) notify.error(msg);
    } finally {
      setLoading(false);
    }
  }

  // Auto-extract on first open if no cached copy.
  useEffect(() => {
    if (!text && !loading && !err) void extract(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);

  const colors = theme === 'dark'
    ? { bg: '#1f1f1f', fg: '#e6e6e6' }
    : theme === 'sepia'
      ? { bg: '#f4ecd8', fg: '#5b4636' }
      : { bg: 'transparent', fg: 'inherit' };

  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text]);

  return (
    <div className="flex h-full w-full flex-col" style={{ backgroundColor: colors.bg, color: colors.fg }}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <strong className="mr-2">Reader</strong>
        <div className="inline-flex items-center rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {(Object.keys(FONTS) as FontKey[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => changeFont(f)}
              className={`rounded-full px-2 py-0.5 text-[10px] ${font === f ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
              style={{ fontFamily: FONTS[f].stack }}
              title={`${FONTS[f].label} font`}
            >
              {FONTS[f].label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {(Object.keys(SIZES) as SizeKey[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeSize(s)}
              className={`rounded-full px-2 py-0.5 text-[10px] ${size === s ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
              title={`${SIZES[s].label === 'S' ? 'Small' : SIZES[s].label === 'M' ? 'Medium' : SIZES[s].label === 'L' ? 'Large' : 'XL'} text`}
            >
              {SIZES[s].label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => extract(true)}
          disabled={loading}
          title="Re-extract from the PDF — useful after an annotation save changes the bytes"
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Re-extract
        </button>
      </div>
      <div
        className="flex-1 overflow-auto px-8 py-6"
        style={{ fontFamily: FONTS[font].stack, fontSize: SIZES[size].px, lineHeight: 1.65 }}
      >
        {loading && !text && (
          <div className="flex items-center gap-2 text-sm opacity-70">
            <Loader2 className="h-4 w-4 animate-spin" /> Extracting text from the PDF — this may take 10–30 s the first time.
          </div>
        )}
        {err && !text && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
            Couldn&rsquo;t extract: {err}
          </div>
        )}
        {text && (
          <article
            className="prose prose-base mx-auto max-w-3xl"
            style={{ color: colors.fg }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
