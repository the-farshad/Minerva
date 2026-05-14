'use client';

import { useEffect, useState } from 'react';
import { Pencil, Check, X as XIcon, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { relativeTime, formatDateTime } from '@/lib/relative-time';

/**
 * Info pane for the preview modal. Renders row.data as a key/value
 * list with an Edit toggle. In edit mode every visible field becomes
 * an inline `<input>`; saving PATCHes the row and appends each
 * touched field to row.data._userEdited so the next
 * refresh-metadata leaves them alone.
 *
 * Hidden keys: leading-underscore (internal markers like
 * _userEdited, _metadataSource) and a small denylist of fields that
 * have their own UI surfaces (offline, notes, thumbnail, extracted).
 */

const HIDDEN_KEYS = new Set(['offline', 'notes', 'thumbnail', 'extracted']);

/** Fields that should always appear as editable slots even when the
 * row hasn't filled them in yet, so users can drop in a DOI / ISBN /
 * journal without going through "+ new field" each time. Edit mode
 * unions these with whatever else is already on the row. */
const SUGGESTED_FIELDS: Record<string, string[]> = {
  papers: ['title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'doi', 'isbn', 'publisher', 'url'],
  youtube: ['title', 'channel', 'duration', 'published', 'playlist', 'views', 'likes', 'description', 'url'],
};

function visible(data: Record<string, unknown>): [string, string][] {
  return Object.entries(data)
    .filter(([k, v]) => v != null && v !== '' && !k.startsWith('_') && !HIDDEN_KEYS.has(k))
    .map(([k, v]) => [k, String(v)]);
}

export function InfoPane({
  rowId, sectionSlug, data, onSaved, sectionPreset, createdAt, updatedAt,
}: {
  rowId: string;
  sectionSlug: string;
  data: Record<string, unknown>;
  /** Row timestamps — shown in the meta footer when provided. */
  createdAt?: string;
  updatedAt?: string;
  /** Drives which suggested fields appear as empty inputs in Edit
   * mode — e.g. `doi` / `isbn` for papers, `channel` / `duration`
   * for YouTube. */
  sectionPreset?: string | null;
  /** Called with the full merged data after a successful save so
   * the modal + parent rows cache stay in sync. */
  onSaved: (next: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      const next: Record<string, string> = {};
      // Suggested slots first (empty by default), then real values
      // — so the order is predictable AND empty fields don't trip
      // the diff in save() because they round-trip identically.
      const suggested = sectionPreset ? (SUGGESTED_FIELDS[sectionPreset] || []) : [];
      for (const k of suggested) next[k] = '';
      for (const [k, v] of visible(data)) next[k] = v;
      setDraft(next);
    }
  }, [editing, rowId, data, sectionPreset]);

  async function save() {
    setSaving(true);
    try {
      const original = Object.fromEntries(visible(data));
      const touched: string[] = [];
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(draft)) {
        const orig = String(original[k] ?? '');
        if (v !== orig) {
          patch[k] = v.length === 0 ? '' : v;
          touched.push(k);
        }
      }
      // Removed keys (visible in original, missing in draft).
      for (const k of Object.keys(original)) {
        if (!(k in draft)) {
          patch[k] = '';
          touched.push(k);
        }
      }
      if (!touched.length) {
        setEditing(false);
        setSaving(false);
        return;
      }
      const prevEdited = Array.isArray(data._userEdited) ? (data._userEdited as string[]) : [];
      const nextEdited = Array.from(new Set([...prevEdited, ...touched]));
      const body = { data: { ...patch, _userEdited: nextEdited } };
      const r = await fetch(`/api/sections/${sectionSlug}/rows/${rowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: string };
      if (!r.ok) throw new Error(j.error || `save: ${r.status}`);
      onSaved(j.data || { ...data, ...patch, _userEdited: nextEdited });
      toast.success(`${touched.length} field${touched.length === 1 ? '' : 's'} saved.`);
      setEditing(false);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const rows = editing ? Object.entries(draft) : visible(data);
  const editedSet = new Set(Array.isArray(data._userEdited) ? (data._userEdited as string[]) : []);

  return (
    <aside className="flex h-full w-72 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs font-semibold dark:border-zinc-800">
        Info
        <div className="flex items-center gap-1 text-[10px] font-normal">
          {!editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title="Edit fields"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-2 py-0.5 text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                <Check className="h-3 w-3" /> {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setNewKey(''); }}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <XIcon className="h-3 w-3" /> Cancel
              </button>
            </>
          )}
        </div>
      </div>
      <dl className="flex-1 space-y-2 overflow-auto p-3 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[5.5rem_1fr] items-start gap-2">
            <dt className="flex items-center gap-1 text-zinc-500">
              {k}
              {editedSet.has(k) && (
                <span title="You edited this — won't be overwritten by Refresh" className="text-amber-500">•</span>
              )}
            </dt>
            <dd className="break-words font-medium text-zinc-700 dark:text-zinc-200">
              {editing ? (
                <input
                  type="text"
                  value={v}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                  placeholder="(empty)"
                />
              ) : (
                String(v).slice(0, 600)
              )}
            </dd>
          </div>
        ))}
        {editing && (
          <div className="grid grid-cols-[5.5rem_1fr] items-start gap-2 pt-2">
            <dt className="text-zinc-500">
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="+ new field"
                className="w-full rounded border border-dashed border-zinc-300 bg-transparent px-1 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700"
              />
            </dt>
            <dd>
              <button
                type="button"
                onClick={() => {
                  const k = newKey.trim().toLowerCase().replace(/\s+/g, '_');
                  if (!k || k in draft) return;
                  setDraft((d) => ({ ...d, [k]: '' }));
                  setNewKey('');
                }}
                disabled={!newKey.trim()}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </dd>
          </div>
        )}
        {/* Meta footer — row timestamps. Relative ("3 days ago")
          * with the absolute date on hover. Only rendered when the
          * caller threaded the timestamps through. "Opened" comes
          * off data._accessedAt (set by the touch endpoint). */}
        {(() => {
          const accessedAt = typeof data._accessedAt === 'string' ? data._accessedAt : '';
          if (!createdAt && !updatedAt && !accessedAt) return null;
          return (
            <div className="mt-3 space-y-1 border-t border-zinc-200 pt-2 text-[10px] text-zinc-400 dark:border-zinc-800">
              {createdAt && (
                <div className="grid grid-cols-[5.5rem_1fr] gap-2" title={formatDateTime(createdAt)}>
                  <span className="text-zinc-500">Created</span>
                  <span>{relativeTime(createdAt)}</span>
                </div>
              )}
              {updatedAt && (
                <div className="grid grid-cols-[5.5rem_1fr] gap-2" title={formatDateTime(updatedAt)}>
                  <span className="text-zinc-500">Edited</span>
                  <span>{relativeTime(updatedAt)}</span>
                </div>
              )}
              {accessedAt && (
                <div className="grid grid-cols-[5.5rem_1fr] gap-2" title={formatDateTime(accessedAt)}>
                  <span className="text-zinc-500">Opened</span>
                  <span>{relativeTime(accessedAt)}</span>
                </div>
              )}
            </div>
          );
        })()}
      </dl>
    </aside>
  );
}
