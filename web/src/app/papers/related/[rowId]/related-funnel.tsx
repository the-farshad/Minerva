'use client';

import { useEffect, useMemo, useRef } from 'react';
// CSS for the lib — the bare SVG it emits is structurally invisible
// without these. Imported here so they ride with the dynamic chunk
// the FunnelView component lives in (no global cost when nobody
// opens the Funnel view).
import 'funnel-graph-js-xl/dist/css/main.min.css';
import 'funnel-graph-js-xl/dist/css/theme.min.css';

/** funnel-graph-js-xl is a vanilla-DOM SVG renderer — it instantiates
 *  against a container element and mutates it. We import it
 *  dynamically inside an effect so the lib never executes during SSR
 *  (it touches `document` on construct). */

type Paper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  year?: number;
  venue?: string;
  openAccessPdf?: { url?: string };
};

function paperKey(p: Paper): string {
  return p.paperId || p.externalIds?.DOI || p.externalIds?.ArXiv || p.title || '';
}

export function RelatedFunnel({
  papers,
  added,
  yearFrom,
  yearTo,
  pdfOnly,
  venueFilter,
}: {
  papers: Paper[];
  added: Set<string>;
  yearFrom: string;
  yearTo: string;
  pdfOnly: boolean;
  venueFilter: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /** Each stage shows the count of papers surviving the filters
   *  applied up to that point — a literal narrowing pipeline. We
   *  always include the "All" and "In your library" bookends so the
   *  funnel reads as a journey from "what the provider returned" to
   *  "what you've actually saved." */
  const { labels, values, colors } = useMemo(() => {
    const yFrom = yearFrom ? Number(yearFrom) : null;
    const yTo = yearTo ? Number(yearTo) : null;
    const venue = venueFilter.trim().toLowerCase();

    const total = papers.length;
    const afterYear = yFrom == null && yTo == null
      ? total
      : papers.filter((p) => {
          const y = p.year || 0;
          if (yFrom != null && y < yFrom) return false;
          if (yTo != null && y > yTo) return false;
          return true;
        }).length;
    const afterPdf = !pdfOnly
      ? afterYear
      : papers.filter((p) => {
          const y = p.year || 0;
          if (yFrom != null && y < yFrom) return false;
          if (yTo != null && y > yTo) return false;
          return !!p.openAccessPdf?.url;
        }).length;
    const afterVenue = !venue
      ? afterPdf
      : papers.filter((p) => {
          const y = p.year || 0;
          if (yFrom != null && y < yFrom) return false;
          if (yTo != null && y > yTo) return false;
          if (pdfOnly && !p.openAccessPdf?.url) return false;
          return (p.venue || '').toLowerCase() === venue;
        }).length;
    const inLibrary = papers.filter((p) => added.has(paperKey(p))).length;

    /** Build the stages list dynamically — skip filter stages that
     *  aren't currently active so the funnel doesn't show four
     *  identical bars when the user hasn't filtered anything. The
     *  "All candidates" and "In your library" stages always show. */
    const stages: { label: string; value: number; color: string }[] = [
      { label: 'All candidates', value: total, color: '#1e40af' },
    ];
    if (yFrom != null || yTo != null) {
      const range = yFrom != null && yTo != null
        ? `${yFrom}–${yTo}`
        : yFrom != null ? `≥ ${yFrom}` : `≤ ${yTo}`;
      stages.push({ label: `After year (${range})`, value: afterYear, color: '#2563eb' });
    }
    if (pdfOnly) stages.push({ label: 'After PDF-only', value: afterPdf, color: '#3b82f6' });
    if (venue) stages.push({ label: `After venue (${venueFilter})`, value: afterVenue, color: '#60a5fa' });
    stages.push({ label: 'In your library', value: inLibrary, color: '#16a34a' });

    // funnel-graph-js-xl requires strictly non-increasing values to
    // render a proper funnel — clamp downward so a "growing" tier
    // never makes the SVG draw inverted.
    let prev = stages[0].value;
    for (const s of stages) {
      if (s.value > prev) s.value = prev;
      prev = s.value;
    }

    return {
      labels: stages.map((s) => s.label),
      values: stages.map((s) => s.value),
      colors: stages.map((s) => s.color),
    };
  }, [papers, added, yearFrom, yearTo, pdfOnly, venueFilter]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    // Clear any previous render before re-instantiating; the lib's
    // .update() helper is finicky about colour-array changes so a
    // full rebuild on every prop change is simpler.
    el.innerHTML = '';
    (async () => {
      const { default: FunnelGraph } = await import('funnel-graph-js-xl');
      if (cancelled) return;
      const graph = new FunnelGraph({
        container: el,
        gradientDirection: 'horizontal',
        direction: 'horizontal',
        displayPercent: true,
        data: { labels, values, colors },
      });
      graph.draw();
    })();
    return () => { cancelled = true; };
  }, [labels, values, colors]);

  if (papers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Nothing to funnel — wait for the recommendations to load.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div ref={ref} className="funnel-host w-full" />
      <p className="mt-3 text-[11px] text-zinc-500">
        Filter pipeline: how many of the {papers.length} candidates survive each
        filter you have active, ending at how many you have already added to
        your library.
      </p>
    </div>
  );
}
