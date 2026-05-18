'use client';

/**
 * Author profile card. Rendered above the candidates pane when the
 * user is in author-hub mode (clicked an author name or did an
 * `author:` keyword search). Surfaces the OpenAlex profile data
 * the candidates list doesn't show: h-index, total citations, top
 * fields, current affiliations, active years.
 */
import type { ReactNode } from 'react';

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

export function AuthorProfile({ profile }: { profile: AuthorProfileData }) {
  return (
    <div className="mb-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
            {profile.institutions.map((i) => (
              <span key={i.name} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">
                {i.name}
                {i.country ? <span className="text-zinc-400"> · {i.country}</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}
      {profile.topConcepts.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Top fields</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {profile.topConcepts.map((c) => (
              <span key={c.name} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">
                {c.name}
                <span className="text-zinc-400"> {Math.round(c.score * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
