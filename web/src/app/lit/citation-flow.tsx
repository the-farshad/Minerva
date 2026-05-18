'use client';

/**
 * Citation-flow Sankey. Three-column layout:
 *
 *   refs years   →   seed paper   →   citers years
 *
 * Each band's height is proportional to the count of papers in
 * that year bucket. Bezier ribbons connect every bucket to the
 * seed (left side) and the seed to every bucket (right side).
 *
 * Pure inline SVG, theme-aware via fill-zinc-* classes the
 * sepia/vt323 overrides already cover.
 */
import { useMemo, useState } from 'react';
import { ChartShell } from './chart-shell';

type Paper = {
  year?: number | string;
};

export type CitationFlowInput = {
  seedYear?: number | null;
  refs: Paper[];     // papers the seed cites (older)
  citers: Paper[];   // papers that cite the seed (newer)
};

function asYear(p: Paper): number | null {
  if (typeof p.year === 'number') return p.year;
  const n = Number(p.year);
  return Number.isFinite(n) && n >= 1900 ? n : null;
}

/** Pick a bucket size that gives ~6 bands. */
function bucketSize(span: number): number {
  if (span <= 5) return 1;
  if (span <= 12) return 2;
  if (span <= 30) return 5;
  return 10;
}

function bucketize(papers: Paper[], size: number): { key: string; lo: number; hi: number; count: number }[] {
  const years = papers.map(asYear).filter((y): y is number => y !== null);
  if (years.length === 0) return [];
  const min = Math.floor(Math.min(...years) / size) * size;
  const max = Math.floor(Math.max(...years) / size) * size;
  const buckets = new Map<number, number>();
  for (const y of years) {
    const k = Math.floor(y / size) * size;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const out: { key: string; lo: number; hi: number; count: number }[] = [];
  for (let b = min; b <= max; b += size) {
    const c = buckets.get(b) ?? 0;
    if (c === 0) continue;
    const lo = b;
    const hi = b + size - 1;
    out.push({ key: size === 1 ? `${lo}` : `${lo}–${hi}`, lo, hi, count: c });
  }
  return out;
}

export function CitationFlow({ flow }: { flow: CitationFlowInput }) {
  const [hover, setHover] = useState<null | { x: number; y: number; label: string }>(null);

  const refsBuckets = useMemo(() => {
    if (flow.refs.length === 0) return [];
    const ys = flow.refs.map(asYear).filter((y): y is number => y !== null);
    if (ys.length === 0) return [];
    const span = Math.max(...ys) - Math.min(...ys) + 1;
    return bucketize(flow.refs, bucketSize(span));
  }, [flow.refs]);

  const citersBuckets = useMemo(() => {
    if (flow.citers.length === 0) return [];
    const ys = flow.citers.map(asYear).filter((y): y is number => y !== null);
    if (ys.length === 0) return [];
    const span = Math.max(...ys) - Math.min(...ys) + 1;
    return bucketize(flow.citers, bucketSize(span));
  }, [flow.citers]);

  if (refsBuckets.length === 0 && citersBuckets.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        Not enough year data on the references or citers to draw a flow.
      </p>
    );
  }

  const W = 720;
  const H = 320;
  const PAD = { t: 16, b: 24, l: 10, r: 10 };
  const innerH = H - PAD.t - PAD.b;
  const colW = 90;
  const xRefs = PAD.l;
  const xSeed = (W - colW) / 2;
  const xCiters = W - colW - PAD.r;
  const seedH = Math.min(innerH * 0.8, 140);
  const seedY = PAD.t + (innerH - seedH) / 2;

  // Total counts on each side normalise to the seed band's height
  // so the ribbons land flush regardless of which side dominates.
  const refsTotal = refsBuckets.reduce((s, b) => s + b.count, 0);
  const citersTotal = citersBuckets.reduce((s, b) => s + b.count, 0);
  const gap = 4;

  // Stacked layout for both wings — y offsets accumulate so a
  // band's bottom is the next band's top, with a small gap.
  function layoutColumn(buckets: typeof refsBuckets, total: number): { y: number; h: number; key: string; count: number }[] {
    if (total === 0) return [];
    const totalGap = gap * Math.max(0, buckets.length - 1);
    const available = innerH - totalGap;
    let y = PAD.t;
    return buckets.map((b) => {
      const h = Math.max(6, (b.count / total) * available);
      const row = { y, h, key: b.key, count: b.count };
      y += h + gap;
      return row;
    });
  }
  const refsLayout = layoutColumn(refsBuckets, refsTotal);
  const citersLayout = layoutColumn(citersBuckets, citersTotal);

  // Anchor each band's flow on the seed at a y proportional to its
  // own share of the wing total. That keeps the ribbon angles
  // visually balanced even when one bucket is huge.
  function seedAnchor(bucketY: number, bucketH: number, total: number, wingTotal: number): { y0: number; y1: number } {
    if (wingTotal === 0) return { y0: seedY, y1: seedY + seedH };
    const offset = ((bucketY + bucketH / 2 - PAD.t) / innerH) * seedH;
    const half = (bucketH / innerH) * seedH / 2;
    return { y0: seedY + Math.max(0, offset - half), y1: seedY + Math.min(seedH, offset + half) };
    // Note: `total` arg unused for now; kept for future per-flow
    // weight tweaks if the simple-proportional layout reads off.
  }

  function ribbon(sx0: number, sy0: number, sy1: number, tx: number, ty0: number, ty1: number, midPull: number = 0.5): string {
    // Two cubic Bezier curves on top + bottom, line on the right
    // edge, then back along the bottom curve. midPull controls how
    // far the control points project sideways from each endpoint.
    const cx1 = sx0 + (tx - sx0) * midPull;
    const cx2 = sx0 + (tx - sx0) * (1 - midPull);
    return [
      `M ${sx0} ${sy0}`,
      `C ${cx1} ${sy0} ${cx2} ${ty0} ${tx} ${ty0}`,
      `L ${tx} ${ty1}`,
      `C ${cx2} ${ty1} ${cx1} ${sy1} ${sx0} ${sy1}`,
      'Z',
    ].join(' ');
  }

  return (
    <ChartShell filename="lit-citation-flow" summary="Citation flow · references → seed → citers">
      {(svgRef) => (
    <div className="relative w-full">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block w-full text-zinc-900 dark:text-zinc-100" role="img" aria-label="Citation flow">
        {/* Left wing: refs ribbons */}
        {refsLayout.map((b) => {
          const a = seedAnchor(b.y, b.h, b.count, refsTotal);
          return (
            <path
              key={`r-${b.key}`}
              d={ribbon(xRefs + colW, b.y, b.y + b.h, xSeed, a.y0, a.y1)}
              className="fill-zinc-500/30 transition hover:fill-zinc-700/45 dark:fill-zinc-300/25 dark:hover:fill-zinc-100/45"
              onMouseEnter={() => setHover({ x: (xRefs + colW + xSeed) / 2, y: (b.y + b.h / 2 + (a.y0 + a.y1) / 2) / 2, label: `${b.count} ref${b.count === 1 ? '' : 's'} · ${b.key}` })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {/* Right wing: citers ribbons */}
        {citersLayout.map((b) => {
          const a = seedAnchor(b.y, b.h, b.count, citersTotal);
          return (
            <path
              key={`c-${b.key}`}
              d={ribbon(xSeed + colW, a.y0, a.y1, xCiters, b.y, b.y + b.h)}
              className="fill-amber-500/30 transition hover:fill-amber-600/45 dark:fill-amber-400/30 dark:hover:fill-amber-300/45"
              onMouseEnter={() => setHover({ x: (xSeed + colW + xCiters) / 2, y: (b.y + b.h / 2 + (a.y0 + a.y1) / 2) / 2, label: `${b.count} citer${b.count === 1 ? '' : 's'} · ${b.key}` })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {/* Left column bands */}
        {refsLayout.map((b) => (
          <g key={`rb-${b.key}`}>
            <rect x={xRefs} y={b.y} width={colW} height={b.h}
              className="fill-zinc-700 dark:fill-zinc-300" rx={2} />
            <text x={xRefs + colW / 2} y={b.y + b.h / 2}
              textAnchor="middle" dominantBaseline="middle"
              className="pointer-events-none fill-white text-[10px] dark:fill-zinc-900">
              {b.h >= 16 ? `${b.key} · ${b.count}` : b.key}
            </text>
          </g>
        ))}
        {/* Seed */}
        <rect x={xSeed} y={seedY} width={colW} height={seedH}
          className="fill-blue-700 dark:fill-blue-400" rx={2} />
        <text x={xSeed + colW / 2} y={seedY + seedH / 2}
          textAnchor="middle" dominantBaseline="middle"
          className="pointer-events-none fill-white text-[11px] font-medium dark:fill-zinc-900">
          {flow.seedYear ? `Seed · ${flow.seedYear}` : 'Seed'}
        </text>
        {/* Right column bands */}
        {citersLayout.map((b) => (
          <g key={`cb-${b.key}`}>
            <rect x={xCiters} y={b.y} width={colW} height={b.h}
              className="fill-amber-700 dark:fill-amber-400" rx={2} />
            <text x={xCiters + colW / 2} y={b.y + b.h / 2}
              textAnchor="middle" dominantBaseline="middle"
              className="pointer-events-none fill-white text-[10px] dark:fill-zinc-900">
              {b.h >= 16 ? `${b.key} · ${b.count}` : b.key}
            </text>
          </g>
        ))}
        {/* Axis labels */}
        <text x={xRefs + colW / 2} y={H - 6} textAnchor="middle" className="fill-zinc-400 text-[10px]">References</text>
        <text x={xSeed + colW / 2} y={H - 6} textAnchor="middle" className="fill-zinc-400 text-[10px]">Seed</text>
        <text x={xCiters + colW / 2} y={H - 6} textAnchor="middle" className="fill-zinc-400 text-[10px]">Citers</text>
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(-50%, calc(-100% - 10px))' }}
        >
          {hover.label}
        </div>
      )}
    </div>
      )}
    </ChartShell>
  );
}
