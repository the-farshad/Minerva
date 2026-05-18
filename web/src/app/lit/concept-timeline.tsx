'use client';

/**
 * Compact sparkline of an OpenAlex concept's yearly publication
 * volume. Rendered above the candidates pane when a keyword search
 * resolves to a known concept; gives a "is this topic growing?"
 * answer at a glance.
 *
 * Pure inline SVG, theme-aware via fill-zinc-* utilities.
 */
import { useMemo } from 'react';

export type ConceptTimelinePoint = { year: number; count: number };

export function ConceptTimeline({
  conceptName,
  worksCount,
  counts,
}: {
  conceptName: string;
  worksCount: number;
  counts: ConceptTimelinePoint[];
}) {
  const trimmed = useMemo(() => {
    // Drop very old years that aren't telling us anything; keep
    // everything from the year of the first non-trivial count
    // (≥ 1% of the peak) onward.
    if (counts.length === 0) return counts;
    const peak = Math.max(...counts.map((c) => c.count));
    const threshold = Math.max(1, Math.floor(peak * 0.01));
    const startIdx = counts.findIndex((c) => c.count >= threshold);
    return startIdx <= 0 ? counts : counts.slice(startIdx);
  }, [counts]);

  if (trimmed.length === 0) return null;

  const W = 720;
  const H = 80;
  const PAD = { t: 10, r: 8, b: 18, l: 28 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const yearMin = trimmed[0].year;
  const yearMax = trimmed[trimmed.length - 1].year;
  const peak = Math.max(...trimmed.map((c) => c.count));

  function xFor(year: number): number {
    if (yearMax === yearMin) return PAD.l + innerW / 2;
    return PAD.l + ((year - yearMin) / (yearMax - yearMin)) * innerW;
  }
  function yFor(count: number): number {
    return PAD.t + innerH - (count / peak) * innerH;
  }

  // Build the area-under-curve polygon (closed at the baseline).
  const linePts = trimmed.map((c) => `${xFor(c.year)},${yFor(c.count)}`).join(' ');
  const areaPts = `${PAD.l},${PAD.t + innerH} ${linePts} ${PAD.l + innerW},${PAD.t + innerH}`;

  function fmt(n: number) {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  }

  // Pick ~5 x-tick years.
  const span = Math.max(1, yearMax - yearMin);
  const step = span <= 8 ? 2 : span <= 20 ? 5 : 10;
  const xTicks: number[] = [];
  for (let y = Math.ceil(yearMin / step) * step; y <= yearMax; y += step) xTicks.push(y);

  return (
    <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{conceptName}</span>
        <span className="text-zinc-500">{fmt(worksCount)} total works · {trimmed[0].year}–{trimmed[trimmed.length - 1].year}</span>
        <span className="text-zinc-400">— activity over time</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${conceptName} activity over time`}>
        <polygon
          points={areaPts}
          className="fill-zinc-700/15 dark:fill-zinc-300/20"
        />
        <polyline
          points={linePts}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-zinc-700 dark:text-zinc-300"
        />
        {xTicks.map((y) => (
          <g key={`x-${y}`}>
            <line
              x1={xFor(y)} x2={xFor(y)}
              y1={PAD.t + innerH} y2={PAD.t + innerH + 2}
              stroke="currentColor" strokeWidth={0.5}
              className="text-zinc-400"
            />
            <text x={xFor(y)} y={H - 4} textAnchor="middle" className="fill-zinc-500 text-[9px]">
              {y}
            </text>
          </g>
        ))}
        <text x={PAD.l - 4} y={PAD.t + 6} textAnchor="end" className="fill-zinc-400 text-[9px]">
          {fmt(peak)}
        </text>
        <text x={PAD.l - 4} y={PAD.t + innerH} textAnchor="end" className="fill-zinc-400 text-[9px]">
          0
        </text>
      </svg>
    </div>
  );
}
