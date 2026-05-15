'use client';

/**
 * Density heatmap for the connected-graph legs in /lit. Same axes as
 * the timeline chart — publication year on x, log(cites + 1) on y —
 * but binned into a 2-D grid and shaded by paper count. Reveals
 * where a paper's neighbourhood is concentrated: the dense band of
 * 2018-2023 high-cite landmarks vs the sparse trickle of recent
 * preprints, etc.
 *
 * Pure SVG, no chart lib, theme-aware via `fill-zinc-*` utilities
 * (the per-theme overrides in globals.css handle sepia / vt323).
 */
import { useMemo, useState } from 'react';

type Paper = {
  paperId?: string;
  title?: string;
  year?: string | number;
  citationCount?: number;
};

function yearOf(p: Paper): number | null {
  if (typeof p.year === 'number') return p.year;
  const n = Number(p.year);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function citesOf(p: Paper): number {
  return typeof p.citationCount === 'number' && p.citationCount > 0 ? p.citationCount : 0;
}

const X_BINS = 24;
const Y_BINS = 12;

export function DensityChart({ papers }: { papers: Paper[] }) {
  const datable = useMemo(
    () => papers
      .map((p) => ({ p, y: yearOf(p), c: citesOf(p) }))
      .filter((d): d is { p: Paper; y: number; c: number } => d.y !== null),
    [papers],
  );
  const [hover, setHover] = useState<null | { i: number; j: number; count: number; cx: number; cy: number }>(null);

  if (datable.length === 0) {
    return (
      <p className="rounded-md border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        No publication-year data for this list — can&apos;t build a density map.
      </p>
    );
  }

  const yMin = Math.min(...datable.map((d) => d.y));
  const yMax = Math.max(...datable.map((d) => d.y));
  const cites = datable.map((d) => d.c).filter((n) => n > 0);
  const cMax = cites.length > 0 ? Math.max(...cites) : 1;
  const logMax = Math.log10(cMax + 1);

  // Bin the dataset. Each cell carries the count of papers landing
  // in it. Empty cells are omitted from rendering so a sparse dataset
  // shows blank space rather than a solid sheet of near-zero values.
  const grid = useMemo(() => {
    const counts: number[][] = Array.from({ length: X_BINS }, () => new Array(Y_BINS).fill(0) as number[]);
    const yearSpan = yMax === yMin ? 1 : yMax - yMin;
    for (const d of datable) {
      const xi = Math.min(X_BINS - 1, Math.max(0, Math.floor(((d.y - yMin) / yearSpan) * X_BINS)));
      const yiRaw = logMax <= 0
        ? Y_BINS - 1
        : Math.floor((Math.log10(d.c + 1) / logMax) * Y_BINS);
      const yi = Math.min(Y_BINS - 1, Math.max(0, yiRaw));
      counts[xi][yi] += 1;
    }
    let max = 0;
    for (let i = 0; i < X_BINS; i++) for (let j = 0; j < Y_BINS; j++) if (counts[i][j] > max) max = counts[i][j];
    return { counts, max };
  }, [datable, yMin, yMax, logMax]);

  const W = 720;
  const H = 320;
  const PAD = { t: 16, r: 14, b: 28, l: 44 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const cellW = innerW / X_BINS;
  const cellH = innerH / Y_BINS;

  // X tick labels — same step picker as the timeline so axes stay
  // visually consistent when toggling between the two views.
  const span = Math.max(1, yMax - yMin);
  const step = span <= 4 ? 1 : span <= 10 ? 2 : span <= 25 ? 5 : 10;
  const xTicks: number[] = [];
  for (let y = Math.ceil(yMin / step) * step; y <= yMax; y += step) xTicks.push(y);
  if (xTicks.length === 0) xTicks.push(yMin);
  function xLabelPos(year: number): number {
    if (yMax === yMin) return PAD.l + innerW / 2;
    return PAD.l + ((year - yMin) / (yMax - yMin)) * innerW;
  }
  // Y ticks at log decades.
  const yTicks: number[] = [0];
  for (let pow = 1; Math.pow(10, pow - 1) <= cMax; pow++) yTicks.push(Math.pow(10, pow));
  function yLabelPos(c: number): number {
    if (logMax <= 0) return PAD.t + innerH;
    return PAD.t + innerH - (Math.log10(Math.max(0, c) + 1) / logMax) * innerH;
  }

  function yearRangeOf(i: number): [number, number] {
    const w = (yMax - yMin) / X_BINS || 1;
    return [Math.round(yMin + i * w), Math.round(yMin + (i + 1) * w)];
  }
  function citeRangeOf(j: number): [number, number] {
    const cAt = (k: number) => Math.round(Math.pow(10, (k / Y_BINS) * logMax) - 1);
    return [Math.max(0, cAt(j)), Math.max(0, cAt(j + 1))];
  }

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full text-zinc-900 dark:text-zinc-100" role="img" aria-label="Density heatmap">
        {xTicks.map((y) => (
          <text key={`x-${y}`} x={xLabelPos(y)} y={H - 10} textAnchor="middle" className="fill-zinc-500 text-[10px]">
            {y}
          </text>
        ))}
        {yTicks.map((c) => (
          <text key={`y-${c}`} x={PAD.l - 6} y={yLabelPos(c) + 3} textAnchor="end" className="fill-zinc-500 text-[10px]">
            {c === 0 ? '0' : c >= 1000 ? `${c / 1000}k` : c}
          </text>
        ))}
        <text x={PAD.l + innerW / 2} y={H - 24} textAnchor="middle" className="fill-zinc-400 text-[10px]">
          Publication year
        </text>
        <text
          x={12} y={PAD.t + innerH / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${PAD.t + innerH / 2})`}
          className="fill-zinc-400 text-[10px]"
        >
          Citations (log)
        </text>

        {/* Cells — opacity scales with relative density (count/max). */}
        {grid.counts.map((col, i) =>
          col.map((count, j) => {
            if (count === 0) return null;
            const x = PAD.l + i * cellW;
            const y = PAD.t + innerH - (j + 1) * cellH;
            const op = 0.15 + 0.85 * (count / grid.max);
            return (
              <rect
                key={`c-${i}-${j}`}
                x={x} y={y}
                width={cellW - 0.5} height={cellH - 0.5}
                className="cursor-default fill-zinc-700 dark:fill-zinc-300"
                fillOpacity={op}
                onMouseEnter={() => setHover({ i, j, count, cx: x + cellW / 2, cy: y + cellH / 2 })}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${count} paper${count === 1 ? '' : 's'}`}</title>
              </rect>
            );
          }),
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
          style={{
            left: `${(hover.cx / W) * 100}%`,
            top: `${(hover.cy / H) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {hover.count} paper{hover.count === 1 ? '' : 's'}
          </div>
          <div className="mt-0.5 text-zinc-500">
            {yearRangeOf(hover.i).join('–')}
            {' · '}
            {(() => {
              const [lo, hi] = citeRangeOf(hover.j);
              return `${lo}–${hi} cites`;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
