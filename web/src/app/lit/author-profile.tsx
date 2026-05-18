'use client';

/**
 * Author profile card. Rendered above the candidates pane when the
 * user is in author-hub mode (clicked an author name or did an
 * `author:` keyword search). Surfaces the OpenAlex profile data
 * the candidates list doesn't show: h-index, total citations, top
 * fields, current affiliations, active years.
 */
import { useEffect, useState, type ReactNode } from 'react';

export type AuthorProfileData = {
  id: string;
  name: string;
  worksCount: number;
  citedByCount: number;
  hIndex: number | null;
  i10Index: number | null;
  topConcepts: { name: string; score: number }[];
  institutions: { name: string; country: string; type: string }[];
  yearMin: number | null;
  yearMax: number | null;
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

export function AuthorProfile({
  profile,
  onAffiliationClick,
  onConceptClick,
}: {
  profile: AuthorProfileData;
  onAffiliationClick?: (name: string) => void;
  onConceptClick?: (name: string) => void;
}) {
  // Best-effort author portrait via Wikidata. Most working
  // researchers don't have a Wikidata entry so the common case
  // is no image and we simply don't render the avatar slot.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    void fetch(`/api/authors/image?q=${encodeURIComponent(profile.name)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!cancelled && j && typeof j.url === 'string') setImageUrl(j.url);
      })
      .catch(() => { /* tolerate */ });
    return () => { cancelled = true; };
  }, [profile.name]);

  return (
    <div className="mb-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={profile.name}
            className="h-14 w-14 shrink-0 rounded-md border border-zinc-200 object-cover dark:border-zinc-800"
            referrerPolicy="no-referrer"
            onError={(e) => {
              // Hide broken-image icons silently when the
              // commons file moved / was deleted.
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        )}
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{profile.name}</h2>
        {profile.yearMin && profile.yearMax && (
          <span className="text-xs text-zinc-500">{profile.yearMin}–{profile.yearMax}</span>
        )}
        <a
          href={`https://openalex.org/${profile.id}`}
          target="_blank" rel="noopener"
          className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          OpenAlex →
        </a>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Works" value={fmt(profile.worksCount)} />
        <Stat label="Cited by" value={fmt(profile.citedByCount)} />
        <Stat label="h-index" value={profile.hIndex ?? '—'} />
        <Stat label="i10-index" value={profile.i10Index ?? '—'} />
      </div>
      {profile.institutions.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Last known affiliations</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {profile.institutions.map((i) => {
              const inner = (
                <>
                  {i.name}
                  {i.country ? <span className="text-zinc-400"> · {i.country}</span> : null}
                </>
              );
              if (!onAffiliationClick) {
                return (
                  <span key={i.name} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">{inner}</span>
                );
              }
              return (
                <button
                  key={i.name}
                  type="button"
                  onClick={() => onAffiliationClick(i.name)}
                  title={`Find papers from ${i.name}`}
                  className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] transition hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {profile.topConcepts.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Top fields</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {profile.topConcepts.map((c) => {
              const inner = (
                <>
                  {c.name}
                  <span className="text-zinc-400"> {Math.round(c.score * 100)}%</span>
                </>
              );
              if (!onConceptClick) {
                return (
                  <span key={c.name} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">{inner}</span>
                );
              }
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => onConceptClick(c.name)}
                  title={`Search papers about ${c.name}`}
                  className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] transition hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
