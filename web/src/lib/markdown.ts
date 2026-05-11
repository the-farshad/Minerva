/**
 * Minimal, intentionally-limited markdown → HTML renderer.
 *
 * Supports: headings (#–######), unordered/ordered lists, paragraphs,
 * bold (**x**, __x__), italic (*x*, _x_), inline code (`x`), code
 * blocks (```), and links (`[t](url)`). Everything else is escaped.
 *
 * Output is wrapped in a sanitised string suitable for React's
 * dangerouslySetInnerHTML — only the safe subset above is ever
 * inserted; the rest is HTML-escaped first.
 */

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s: string): string {
  let out = esc(s);
  // links — must run before bold/italic so the URL isn't mangled.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => {
    const safeUrl = /^(https?:|mailto:|\/)/.test(u) ? u : '#';
    return `<a href="${safeUrl}" target="_blank" rel="noopener" class="text-blue-600 underline-offset-2 hover:underline">${t}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, '<code class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
  return out;
}

export function renderMarkdown(src: string): string {
  if (!src) return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="mt-3 text-sm font-semibold">${inline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="ml-5 list-disc space-y-0.5">${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="ml-5 list-decimal space-y-0.5">${items.join('')}</ol>`);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    // Plain paragraph — collapse consecutive non-blank lines.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|```)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
