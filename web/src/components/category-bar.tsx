'use client';

import { useMemo, useState } from 'react';
import { Plus, X, Filter } from 'lucide-react';
import { toast } from 'sonner';
import { appConfirm } from './confirm';
import { appPrompt } from './prompt';
import { notify } from '@/lib/notify';

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
  selected,
  onSelectedChange,
  onSchemaChanged,
}: {
  sectionSlug: string;
  /** Schema column we're managing — usually 'category'. */
  column: string;
  /** Options parsed from `multiselect(...)` in the schema. */
  schemaOptions: string[];
  /** Values currently in use across rows (deduped). */
  rowValues: string[];
  /** Currently-active filter set. */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Called with the new option list after a PATCH. Parent passes
   * the result down on the next render — schema lives server-side. */
  onSchemaChanged: (next: string[]) => void;
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
  async function removeCat(cat: string) {
    const ok = await appConfirm(`Remove the "${cat}" category?`, {
      body: 'Rows tagged with this category keep their tag — only the picker option goes away.',
      dangerLabel: 'Remove',
    });
    if (!ok) return;
    await saveOptions(schemaOptions.filter((c) => c !== cat));
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
            {isSchemaDefined && (
              <button
                type="button"
                onClick={() => removeCat(cat)}
                title={`Remove "${cat}" from the picker`}
                className="opacity-0 transition group-hover:opacity-70 hover:!opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
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
