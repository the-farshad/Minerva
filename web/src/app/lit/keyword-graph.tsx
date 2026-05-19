'use client';

/**
 * Title-keyword co-occurrence network. For each visible paper,
 * tokenise the title into content words, then build a graph where
 * nodes are keywords and an edge weight is the count of papers in
 * which the two keywords co-occur. The user sees the "topic
 * landscape" of the result set at a glance — which words dominate,
 * which travel together.
 *
 * Uses title tokens rather than curated concept ids so it works on
 * every paper regardless of which backend (SS / OA / DBLP) returned
 * it. Stopwords + min-3-letter + min-2-occurrence pruning keeps the
 * graph readable. Capped at the top 40 keywords by frequency.
 */
import { useMemo, useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { FullscreenShell } from './fullscreen-shell';
import { GraphExportMenu, type ExportFontSize, type ExportTextColor, type ExportFontFamily } from './graph-export-menu';
import { useCropRegion } from './use-crop-region';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

type Paper = { title?: string };

const STOPWORDS = new Set([
  'the','of','and','a','an','in','on','for','to','with','from','by','at','as','is','are','was','were','be','been','being',
  'this','that','these','those','it','its','their','his','her','our','your','my','we','they','he','she','you','i','me','us','them',
  'but','or','not','no','so','if','when','where','what','who','why','how',
  'can','could','should','would','may','might','will','shall','must',
  'have','has','had','do','does','did','doing','done','get','got',
  'paper','study','studies','analysis','using','based','approach','approaches','method','methods','methodology','work','works','results','result','novel','new','via','toward','towards','across',
  'use','uses','used','using','show','shows','shown','present','presents','presented','propose','proposed','model','models',
  'between','within','through','over','under','about','into','onto','off','out','than','then','also','more','most','less','such',
  'one','two','three','first','second','third','single','multi','multiple','many','some','few',
  'large','small','high','low','better','best','good','well','same','different','similar','various','specific','general',
]);

const MAX_KEYWORDS = 40;
const MIN_KEYWORD_LEN = 4; // 3 was too noisy ("can", "use", etc. survive the stopword list at 3)
const MIN_OCCURRENCES = 2;

function keywordsOfTitle(t: string | undefined): string[] {
  if (!t) return [];
  return t.toLowerCase()
    .replace(/[^a-z0-9-\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= MIN_KEYWORD_LEN && !STOPWORDS.has(w));
}

type KwNode = {
  id: string;
  label: string;
  papers: number;
  x?: number; y?: number;
};

type KwLink = { source: string; target: string; weight: number };

export function KeywordGraph({ papers }: { papers: Paper[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  // Decouple the graph's background from the page theme so the
  // export looks the same on light or dark screens. Default light
  // because the typical export target is white. Toggled in the
  // toolbar below.
  /** Read the active page theme so the graph background matches
   *  by default. User can still override via the BG toggle. */
  const detectInitialBg = (): 'light' | 'dark' => {
    if (typeof document === 'undefined') return 'light';
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return 'dark';
    if (t === 'light' || t === 'sepia') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  };
  const [bgMode, setBgMode] = useState<'light' | 'dark'>(() => detectInitialBg());
  // Lifted export state so the toolbar instance and the
  // fullscreen-extras instance of the Export menu share one
  // source of truth.
  const [exportFontSize, setExportFontSize] = useState<ExportFontSize>('M');
  const [exportTextColor, setExportTextColor] = useState<ExportTextColor>('auto');
  const [exportFontFamily, setExportFontFamily] = useState<ExportFontFamily>('sans');
  // Node spacing — same pattern as author-graph: push into d3
  // force's link distance on change + reheat the sim.
  const [spacing, setSpacing] = useState<'tight' | 'normal' | 'loose'>('normal');
  const linkDistanceFor = (kind: 'tight' | 'normal' | 'loose') =>
    kind === 'tight' ? 18 : kind === 'loose' ? 80 : 36;
  useEffect(() => {
    const ref = graphRef.current as unknown as { d3Force?: (name: string) => { distance?: (n: number) => unknown } | undefined; d3ReheatSimulation?: () => void } | undefined;
    const link = ref?.d3Force?.('link');
    if (link && typeof link.distance === 'function') {
      link.distance(linkDistanceFor(spacing));
      ref?.d3ReheatSimulation?.();
    }
  }, [spacing]);

  const { nodes, links } = useMemo(() => {
    const wordPapers = new Map<string, number>();
    const edge = new Map<string, number>();
    for (const p of papers) {
      const words = [...new Set(keywordsOfTitle(p.title))];
      for (const w of words) wordPapers.set(w, (wordPapers.get(w) ?? 0) + 1);
      // Pairs (only when both words pass the per-paper threshold).
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) {
          const [a, b] = words[i] < words[j] ? [words[i], words[j]] : [words[j], words[i]];
          const k = `${a}||${b}`;
          edge.set(k, (edge.get(k) ?? 0) + 1);
        }
      }
    }
    // Drop singletons; we want recurring themes, not unique words.
    const surviving = [...wordPapers.entries()].filter(([, c]) => c >= MIN_OCCURRENCES);
    const topWords = surviving
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYWORDS);
    const kept = new Set(topWords.map(([w]) => w));
    const ns: KwNode[] = topWords.map(([w, c]) => ({ id: w, label: w, papers: c }));
    const ls: KwLink[] = [];
    for (const [k, w] of edge) {
      const [a, b] = k.split('||');
      if (kept.has(a) && kept.has(b) && w >= MIN_OCCURRENCES) {
        ls.push({ source: a, target: b, weight: w });
      }
    }
    return { nodes: ns, links: ls };
  }, [papers]);

  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        Not enough recurring keywords to build a co-occurrence graph — try a broader query or load more results.
      </p>
    );
  }

  const isDark = bgMode === 'dark';
  const nMax = Math.max(...nodes.map((n) => n.papers));
  function nodeRadius(n: KwNode): number {
    return 4 + Math.min(14, Math.sqrt(n.papers) * 3);
  }
  function nodeFill(n: KwNode): string {
    // Saturation grows with weight so frequent terms feel "heavier".
    const t = n.papers / nMax;
    return isDark
      ? `rgba(196,181,253,${0.35 + 0.6 * t})`
      : `rgba(91,33,182,${0.35 + 0.6 * t})`;
  }

  // Region-select crop. Force-graph-2D paints to a canvas, so the
  // SVG-based viewBox crop path doesn't apply — instead the hook's
  // getCanvasForExport returns a sub-canvas for PNG, and
  // getCroppedGraphData filters nodes by world-coord box for the
  // vector (SVG/PDF) path so the saved file matches the visible
  // selection regardless of format.
  const crop = useCropRegion();

  function canvasEl(): HTMLCanvasElement | null {
    return (containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null) ?? null;
  }

  // Single Export menu element shared between the inline toolbar
  // and the FullscreenShell extras slot. State lives at this
  // component so both instances stay in sync (without lifting we'd
  // see independent font / colour selections per instance).
  const exportMenuEl = (
    <GraphExportMenu
      filename="lit-keywords"
      source={{
        // Routed through crop.getCanvasForExport: returns a fresh
        // canvas containing only the selected region when a crop
        // is active, the live canvas otherwise. PNG export reads
        // this directly.
        canvasEl: () => crop.getCanvasForExport(canvasEl()),
        // Getter form so the vector path (SVG/PDF) can re-filter
        // graphData by the active crop rect at export time. World-
        // coord conversion goes through screen2GraphCoords on the
        // live force-graph ref so a panned/zoomed view crops to
        // exactly what the user sees, not the underlying world
        // bounding box.
        graphData: () => {
          const gd = {
            nodes: nodes.map((n) => ({
              id: n.id,
              label: n.label,
              x: n.x,
              y: n.y,
              size: nodeRadius(n),
              color: nodeFill(n),
              attrs: { papers: n.papers },
            })),
            links: links.map((l) => ({
              source: typeof l.source === 'object' && l.source !== null ? (l.source as { id: string }).id : (l.source as string),
              target: typeof l.target === 'object' && l.target !== null ? (l.target as { id: string }).id : (l.target as string),
              weight: l.weight,
            })),
          };
          const fg = graphRef.current as unknown as { screen2GraphCoords?: (x: number, y: number) => { x: number; y: number } } | undefined;
          const screen2World = fg?.screen2GraphCoords?.bind(fg);
          return crop.getCroppedGraphData(gd, screen2World) ?? gd;
        },
      }}
      bg={bgMode}
      onBgChange={setBgMode}
      fontSize={exportFontSize}
      onFontSizeChange={setExportFontSize}
      textColor={exportTextColor}
      onTextColorChange={setExportTextColor}
      fontFamily={exportFontFamily}
      onFontFamilyChange={setExportFontFamily}
    />
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Title-keyword co-occurrence — {nodes.length} keywords, {links.length} edges</span>
        <span className="text-zinc-300 dark:text-zinc-700">|</span>
        {exportMenuEl}
        {crop.cropButton}
        <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900" title="Node spacing — pushes nodes apart via d3 link distance.">
          {(['tight', 'normal', 'loose'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpacing(s)}
              className={`rounded-full px-2 py-0.5 transition ${
                spacing === s
                  ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => setBgMode('light')}
            title="Light background — for exports targeting white pages"
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              bgMode === 'light'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >BG ☀</button>
          <button
            type="button"
            onClick={() => setBgMode('dark')}
            title="Dark background — for slides / dark presentations"
            className={`rounded-full px-2 py-0.5 text-[11px] transition ${
              bgMode === 'dark'
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >BG ☾</button>
        </div>
      </div>
      <FullscreenShell extras={({ fullscreen }) => fullscreen ? exportMenuEl : null}>
        {({ width, height }) => (
          <div
            ref={crop.bodyRef}
            className={`relative h-full w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 ${crop.cropping ? 'cursor-crosshair select-none' : ''}`}
            style={{ backgroundColor: isDark ? '#0b0d10' : '#fafafa' }}
            onMouseDown={crop.onMouseDown}
            onMouseMove={crop.onMouseMove}
            onMouseUp={crop.onMouseUp}
            onMouseLeave={crop.onMouseUp}
          >
            <ForceGraph2D
              key={`bg-${bgMode}-${spacing}`}
              ref={graphRef as unknown as React.RefObject<ForceGraphMethods>}
              width={width}
              height={height}
              graphData={{ nodes, links }}
              backgroundColor={isDark ? '#0b0d10' : '#fafafa'}
              nodeRelSize={6}
              nodeCanvasObject={(raw, ctx, globalScale) => {
                const n = raw as KwNode;
                const r = nodeRadius(n);
                const x = n.x ?? 0; const y = n.y ?? 0;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = nodeFill(n);
                ctx.fill();
                if (globalScale > 0.7) {
                  ctx.fillStyle = isDark ? '#fafafa' : '#18181b';
                  const fontSize = (8 + Math.min(4, Math.log2(1 + n.papers))) / globalScale;
                  ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  ctx.fillText(n.label, x, y + r + 2 / globalScale);
                }
              }}
              linkColor={() => isDark ? 'rgba(196,181,253,0.25)' : 'rgba(91,33,182,0.25)'}
              linkWidth={(l) => {
                // Linear scaling so the line thickness reads as
                // the actual co-occurrence count, not a flattened
                // log of it.
                const w = (l as unknown as KwLink).weight || 1;
                return Math.max(0.6, Math.min(7, 0.5 + w * 0.6));
              }}
              cooldownTicks={120}
              minZoom={0.4}
              maxZoom={6}
            />
            {crop.decorations}
          </div>
        )}
      </FullscreenShell>
    </div>
  );
}
