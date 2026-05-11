'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Check, Eye, EyeOff, Trash2, ChevronUp, ChevronDown, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOutAction } from '@/app/actions';
import { LocalMirrorCard } from '@/components/local-mirror-card';
import { AiCard } from '@/components/ai-card';
import { ThemeCard } from '@/components/theme-card';
import { FeedsCard } from '@/components/feeds-card';
import { BookmarkletCard } from '@/components/bookmarklet-card';
import { TelegramCard } from '@/components/telegram-card';
import { BackupCard } from '@/components/backup-card';
import { appConfirm } from '@/components/confirm';
import { appPrompt } from '@/components/prompt';
import { SectionIcon } from '@/components/section-icon';

type Preset = { slug: string; title: string; icon: string };
type Existing = { slug: string; title: string; enabled: boolean };

export function SettingsView({
  email,
  sections,
  presets,
}: {
  email: string;
  sections: Existing[];
  presets: Preset[];
}) {
  const [own, setOwn] = useState<Existing[]>(sections);
  const taken = new Set(own.map((s) => s.slug));
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
      return (await r.json()) as Existing;
    },
    onSuccess: (created) => {
      setOwn((s) => {
        const exists = s.find((x) => x.slug === created.slug);
        return exists
          ? s.map((x) => (x.slug === created.slug ? { ...x, enabled: true } : x))
          : [...s, { slug: created.slug, title: created.title, enabled: true }];
      });
      toast.success('Section added.');
      qc.invalidateQueries({ queryKey: ['sections'] });
      router.refresh();
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  async function toggleEnabled(slug: string, enabled: boolean) {
    const prev = own;
    setOwn((s) => s.map((x) => (x.slug === slug ? { ...x, enabled } : x)));
    try {
      const r = await fetch(`/api/sections/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error(String(r.status));
      router.refresh();
    } catch (e) {
      setOwn(prev);
      toast.error(`Update failed: ${(e as Error).message}`);
    }
  }

  async function rename(slug: string) {
    const cur = own.find((x) => x.slug === slug)?.title || '';
    const next = await appPrompt(`Rename section`, { initial: cur, okLabel: 'Rename' });
    if (!next || next.trim() === cur) return;
    const prev = own;
    setOwn((s) => s.map((x) => (x.slug === slug ? { ...x, title: next.trim() } : x)));
    try {
      const r = await fetch(`/api/sections/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next.trim() }),
      });
      if (!r.ok) throw new Error(String(r.status));
      router.refresh();
    } catch (e) {
      setOwn(prev);
      toast.error(`Rename failed: ${(e as Error).message}`);
    }
  }

  async function move(slug: string, dir: -1 | 1) {
    const idx = own.findIndex((x) => x.slug === slug);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= own.length) return;
    const swapped = own.slice();
    [swapped[idx], swapped[j]] = [swapped[j], swapped[idx]];
    const prev = own;
    setOwn(swapped);
    try {
      // Persist via two PATCHes — set `order` to the new index for both.
      await Promise.all([
        fetch(`/api/sections/${encodeURIComponent(swapped[idx].slug)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: idx }),
        }),
        fetch(`/api/sections/${encodeURIComponent(swapped[j].slug)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: j }),
        }),
      ]);
      router.refresh();
    } catch (e) {
      setOwn(prev);
      toast.error(`Reorder failed: ${(e as Error).message}`);
    }
  }

  async function purge(slug: string) {
    const ok = await appConfirm(`Delete section "${slug}"?`, { body: 'This deletes the section and all its rows. Cannot be undone.', dangerLabel: 'Delete section' });
    if (!ok) return;
    const prev = own;
    setOwn((s) => s.filter((x) => x.slug !== slug));
    try {
      const r = await fetch(`/api/sections/${encodeURIComponent(slug)}?purge=1`, { method: 'DELETE' });
      if (!r.ok) throw new Error(String(r.status));
      toast.success('Section deleted.');
      router.refresh();
    } catch (e) {
      setOwn(prev);
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Account</h2>
        <p className="mt-2 text-sm">
          Signed in as <strong>{email}</strong>.
        </p>
        <LocalMirrorCard />
        <AiCard />
        <ThemeCard />
        <FeedsCard />
        <BookmarkletCard />
        <TelegramCard />
        <BackupCard />
      </section>

      {own.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your sections</h2>
          <ul className="mt-3 divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {own.map((s) => (
              <li key={s.slug} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2">
                  <SectionIcon hint={s.slug} className="h-4 w-4 text-zinc-500" />
                  <div>
                    <div className="text-sm font-medium">{s.title}</div>
                    <div className="text-xs text-zinc-500">/{s.slug} · {s.enabled ? 'visible' : 'hidden'}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => move(s.slug, -1)}
                    className="rounded-full border border-zinc-200 p-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    title="Move up"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(s.slug, 1)}
                    className="rounded-full border border-zinc-200 p-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    title="Move down"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => rename(s.slug)}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3" /> Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleEnabled(s.slug, !s.enabled)}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    title={s.enabled ? 'Hide from nav' : 'Show in nav'}
                  >
                    {s.enabled
                      ? <><EyeOff className="h-3 w-3" /> Disable</>
                      : <><Eye className="h-3 w-3" /> Enable</>}
                  </button>
                  <button
                    type="button"
                    onClick={() => purge(s.slug)}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950"
                    title="Delete section and all its rows"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Add a section</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Pick a preset to install. Each section gets its own page in the nav.
        </p>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {presets.map((p) => {
            const installed = taken.has(p.slug);
            return (
              <li
                key={p.slug}
                className="flex items-start justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-start gap-2">
                  <SectionIcon hint={p.icon || p.slug} className="h-4 w-4 text-zinc-500" />
                  <div>
                    <div className="text-sm font-medium">{p.title}</div>
                    <div className="text-xs text-zinc-500">/{p.slug}</div>
                  </div>
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
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50"
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
        <form action={signOutAction} className="mt-3">
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
