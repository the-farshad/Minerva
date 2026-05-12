'use client';

import { useEffect, useState } from 'react';
import { renderMarkdown } from '@/lib/markdown';
import { FileText, FileType2, FileIcon, Loader2 } from 'lucide-react';

/**
 * Notes renderer with rich previews for attached files. Walks the
 * markdown-rendered HTML, finds `<a>` tags whose href is one of our
 * Drive-streamed file URLs (`/api/drive/file?id=…`), and replaces
 * them with:
 *
 *   - Images        →  `<img>` (already handled by markdown's
 *                       `![…](…)` syntax, but a plain link to an
 *                       image still gets upgraded here).
 *   - PDF           →  embedded iframe (height capped at 70vh).
 *   - .txt/.md/csv  →  fetched and inlined (markdown rendered
 *                       recursively).
 *   - Everything    →  a styled download chip.
 */

type Block =
  | { kind: 'html'; html: string }
  | { kind: 'attach'; url: string; name: string };

function splitIntoBlocks(html: string): Block[] {
  // We can't run a full HTML parser in the client without DOM access,
  // so do a small regex split that pulls out `<a class=... href=DRIVE_URL>
  // name </a>` AND `<img src=DRIVE_URL …>` shapes. Anything else stays
  // as `html`.
  const out: Block[] = [];
  let last = 0;
  const re = /<a\s+href="(\/api\/drive\/file\?id=[^"]+)"[^>]*>([\s\S]*?)<\/a>|<img\s+src="(\/api\/drive\/file\?id=[^"]+)"[^>]*alt="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) out.push({ kind: 'html', html: html.slice(last, m.index) });
    const url = m[1] || m[3];
    const name = (m[2] || m[4] || '').replace(/<[^>]+>/g, '').trim() || 'file';
    out.push({ kind: 'attach', url, name });
    last = re.lastIndex;
  }
  if (last < html.length) out.push({ kind: 'html', html: html.slice(last) });
  return out;
}

function classify(name: string): 'image' | 'pdf' | 'text' | 'markdown' | 'docx' | 'other' {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['txt', 'csv', 'tsv', 'json', 'yml', 'yaml', 'log'].includes(ext)) return 'text';
  if (['docx', 'doc'].includes(ext)) return 'docx';
  return 'other';
}

function FileChip({ url, name, icon }: { url: string; name: string; icon: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      className="my-2 inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      {icon}<span className="break-all">{name}</span>
    </a>
  );
}

function InlineText({ url, name, asMarkdown }: { url: string; name: string; asMarkdown: boolean }) {
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        const text = await r.text();
        if (!cancelled) setBody(text);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (err) return (
    <div className="my-2 rounded border border-red-300 bg-red-50 p-2 text-[10px] text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
      Failed to load <span className="font-mono">{name}</span> ({err}). <a href={url} className="underline">Download</a>.
    </div>
  );
  if (body == null) return (
    <div className="my-2 flex items-center gap-2 text-[10px] text-zinc-500">
      <Loader2 className="h-3 w-3 animate-spin" /> Loading {name}…
    </div>
  );
  return (
    <div className="my-2 rounded border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-zinc-500">
        <FileType2 className="h-3 w-3" /> {name}
      </div>
      {asMarkdown ? (
        <div
          className="prose prose-sm max-w-none text-xs"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{body}</pre>
      )}
    </div>
  );
}

function PdfInline({ url, name }: { url: string; name: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 px-2 py-1 text-[10px] text-zinc-500 dark:border-zinc-800">
        <span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" /> {name}</span>
        <a href={url} target="_blank" rel="noopener" className="underline">Open</a>
      </div>
      <iframe src={url} title={name} className="h-[70vh] w-full border-0 bg-white" />
    </div>
  );
}

function Attachment({ url, name }: { url: string; name: string }) {
  const kind = classify(name);
  if (kind === 'image') {
    return <img src={url} alt={name} className="my-2 max-h-80 rounded" loading="lazy" />;
  }
  if (kind === 'pdf') return <PdfInline url={url} name={name} />;
  if (kind === 'text') return <InlineText url={url} name={name} asMarkdown={false} />;
  if (kind === 'markdown') return <InlineText url={url} name={name} asMarkdown={true} />;
  if (kind === 'docx') {
    return (
      <FileChip
        url={url}
        name={`${name} (open in word — inline preview not yet supported)`}
        icon={<FileText className="h-3 w-3" />}
      />
    );
  }
  return <FileChip url={url} name={name} icon={<FileIcon className="h-3 w-3" />} />;
}

export function NotesPreview({ content, empty }: { content: string; empty?: string }) {
  if (!content.trim()) {
    return (
      <em className="text-zinc-500">{empty || 'Nothing yet — switch to Edit and start typing.'}</em>
    );
  }
  const html = renderMarkdown(content);
  const blocks = splitIntoBlocks(html);
  return (
    <div className="prose prose-sm max-w-none text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">
      {blocks.map((b, i) => b.kind === 'html'
        ? <span key={i} dangerouslySetInnerHTML={{ __html: b.html }} />
        : <Attachment key={i} url={b.url} name={b.name} />
      )}
    </div>
  );
}
