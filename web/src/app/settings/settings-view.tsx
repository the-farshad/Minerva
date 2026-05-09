'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Check } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Preset = { slug: string; title: string; icon: string };
type Existing = { slug: string; title: string };

export function SettingsView({
  email,
  sections,
  presets,
}: {
  email: string;
  sections: Existing[];
  presets: Preset[];
}) {
  const [taken, setTaken] = useState(new Set(sections.map((s) => s.slug)));
  const qc = useQueryClient();
  const router = useRouter();

  const addPreset = useMutation({
    mutationFn: async (slug: string) => {
      const r = await fetch('/api/sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: slug }),
      });
      if (!r.ok) throw new Error(`add preset: ${r.status}`);
      return slug;
    },
    onSuccess: (slug) => {
      setTaken((t) => new Set(t).add(slug));
      toast.success('Section added.');
      qc.invalidateQueries({ queryKey: ['sections'] });
      router.refresh();
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Account</h2>
        <p className="mt-2 text-sm">
          Signed in as <strong>{email}</strong>.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Add a section</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Pick from the gallery to install a preset. Each section gets its own page in the nav.
        </p>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {presets.map((p) => {
            const installed = taken.has(p.slug);
            return (
              <li
                key={p.slug}
                className="flex items-start justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div>
                  <div className="text-sm font-medium">{p.title}</div>
                  <div className="text-xs text-zinc-500">/{p.slug}</div>
                </div>
                {installed ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    <Check className="h-3 w-3" /> Added
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => addPreset.mutate(p.slug)}
                    disabled={addPreset.isPending}
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Sign out</h2>
        <form action="/api/auth/signout" method="post" className="mt-3">
          <button
            type="submit"
            className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Sign out of Minerva
          </button>
        </form>
      </section>
    </main>
  );
}
