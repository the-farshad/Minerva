'use client';

import { useMemo, useState } from 'react';
import { Plus, X, Filter, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { appConfirm } from './confirm';
import { appPrompt } from './prompt';
import { notify } from '@/lib/notify';

type Row = { id: string; data: Record<string, unknown>; updatedAt: string };

/**
 * Chip bar for the section's category column. Combines the
 * schema-defined options with every value actually used by a row,
 * so the user sees the full vocabulary even when the schema is
 * out of date. Clicking a chip toggles a filter; the parent uses
 * the selected list to hide non-matching groups. Add / remove
 * update the schema via PATCH /api/sections/<slug>.
 */
export function CategoryBar({
  sectionSlug,
  column,
  schemaOptions,
  rowValues,
  rows,
  selected,
  onSelectedChange,
  onSchemaChanged,
  onRowsRewritten,
}: {
  sectionSlug: string;
  /** Schema column we're managing — usually 'category'. */
  column: string;
  /** Options parsed from `multiselect(...)` in the schema. */
  schemaOptions: string[];
  /** Values currently in use across rows (deduped). */
  rowValues: string[];
  /** Live rows so the remove confirm can show how many will be
   * stripped vs orphan-deleted. */
  rows: Row[];
  /** Currently-active filter set. */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Called with the new option list after a PATCH. Parent passes
   * the result down on the next render — schema lives server-side. */
  onSchemaChanged: (next: string[]) => void;
  /** Called after a rewrite-tag so the parent can refetch / drop
   * deleted rows from local state. */
  onRowsRewritten?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // Union of schema options and used values, sorted for stability.
  const all = useMemo(() => {
    const set = new Set<string>();
    for (const v of schemaOptions) if (v.trim()) set.add(v.trim());
    for (const v of rowValues) if (v.trim()) set.add(v.trim());
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [schemaOptions, rowValues]);

  function toggle(cat: string) {
    const next = new Set(selected);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    onSelectedChange(next);
  }
  function clearAll() {
    onSelectedChange(new Set());
  }

  async function saveOptions(nextList: string[]) {
    setAdding(true);
    try {
      const r = await fetch(`/api/sections/${sectionSlug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setMultiselect: { column, options: nextList } }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `PATCH: ${r.status}`);
      onSchemaChanged(nextList);
      toast.success('Categories updated.');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function addCat() {
    const v = await appPrompt('Add category', { okLabel: 'Add', placeholder: 'e.g. method' });
    const name = (v || '').trim();
    if (!name) return;
    if (all.includes(name)) {
      toast.info('That category already exists.');
      return;
    }
    await saveOptions([...schemaOptions, name]);
  }

  /** Count how a given value is distributed across rows: how many
   * are multi-tagged (would just get this value stripped) vs how
   * many would orphan (only this value, candidates for deletion). */
  function tagBreakdown(cat: string): { multi: number; orphan: number } {
    let multi = 0;
    let orphan = 0;
    for (const r of rows) {
      const list = String(r.data[column] || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.includes(cat)) continue;
      if (list.length > 1) multi += 1; else orphan += 1;
    }
    return { multi, orphan };
  }

  async function renameCat(cat: string) {
    const next = await appPrompt(`Rename "${cat}"`, {
      okLabel: 'Rename',
      initial: cat,
    });
    const to = (next || '').trim();
    if (!to || to === cat) return;
    setAdding(true);
    try {
      const r = await fetch(`/api/sections/${sectionSlug}/rewrite-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column, from: cat, to }),
      });
      const j = (await r.json().catch(() => ({}))) as { rewrote?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `rewrite-tag: ${r.status}`);
      // Update the local schema list in step with the server-side rewrite.
      const nextOpts = schemaOptions.filter((c) => c !== cat);
      if (!nextOpts.includes(to)) nextOpts.push(to);
      onSchemaChanged(nextOpts);
      onRowsRewritten?.();
      toast.success(`Renamed "${cat}" → "${to}" on ${j.rewrote ?? 0} row${j.rewrote === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeCat(cat: string) {
    const { multi, orphan } = tagBreakdown(cat);
    const bodyLines: string[] = [];
    if (multi > 0) bodyLines.push(`${multi} row${multi === 1 ? '' : 's'} also have other categories — those keep their other tags.`);
    if (orphan > 0) bodyLines.push(`${orphan} row${orphan === 1 ? '' : 's'} have ONLY "${cat}" — those will be deleted entirely.`);
    if (bodyLines.length === 0) bodyLines.push('No rows are currently tagged with this category — only the picker entry goes away.');
    const ok = await appConfirm(`Remove the "${cat}" category?`, {
      body: bodyLines.join('\n'),
      dangerLabel: orphan > 0 ? `Remove + delete ${orphan}` : 'Remove',
    });
    if (!ok) return;
    setAdding(true);
    try {
      const r = await fetch(`/api/sections/${sectionSlug}/rewrite-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column, from: cat, to: null, deleteOrphaned: true }),
      });
      const j = (await r.json().catch(() => ({}))) as { rewrote?: number; deleted?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `rewrite-tag: ${r.status}`);
      onSchemaChanged(schemaOptions.filter((c) => c !== cat));
      onRowsRewritten?.();
      const bits: string[] = [];
      if (j.rewrote) bits.push(`stripped from ${j.rewrote}`);
      if (j.deleted) bits.push(`deleted ${j.deleted}`);
      toast.success(`Removed "${cat}" — ${bits.join(' · ') || 'nothing to do'}.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  if (all.length === 0) {
    return (
      <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
        <Filter className="h-3.5 w-3.5" /> No categories yet.
        <button
          type="button"
          onClick={addCat}
          disabled={adding}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
      <Filter className="h-3.5 w-3.5 text-zinc-500" />
      {all.map((cat) => {
        const isSelected = selected.has(cat);
        const isSchemaDefined = schemaOptions.includes(cat);
        return (
          <span
            key={cat}
            className={`group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
              isSelected
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
            }`}
          >
            <button
              type="button"
              onClick={() => toggle(cat)}
              className="text-inherit"
              title={isSelected ? `Hide "${cat}"` : `Filter to "${cat}"`}
            >
              {cat}
            </button>
            <button
              type="button"
              onClick={() => renameCat(cat)}
              title={`Rename "${cat}"`}
              className="opacity-0 transition group-hover:opacity-70 hover:!opacity-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => removeCat(cat)}
              title={`Remove "${cat}" everywhere`}
              className="opacity-0 transition group-hover:opacity-70 hover:!opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={addCat}
        disabled={adding}
        title="Add a new category"
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        <Plus className="h-3 w-3" />
      </button>
      {selected.size > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"
          title="Clear category filter"
        >
          <X className="h-3 w-3" /> clear filter
        </button>
      )}
    </div>
  );
}
