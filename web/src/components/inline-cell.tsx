'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { MultiChipEditor } from './multi-chip-editor';
import { SketchEditor } from './sketch-editor';

/**
 * Tiny inline editor — click a cell, edit, blur or Enter to commit,
 * Esc to cancel. Handles common type hints (text / longtext / date /
 * number / link / select / multiselect / check / markdown). Keeps the
 * rendered display when not editing so we don't trade UI density for
 * an edit affordance.
 */
export type CellType =
  | 'text' | 'longtext' | 'markdown'
  | 'date' | 'datetime' | 'number'
  | 'link' | 'check' | 'sketch'
  | { kind: 'select'; options: string[] }
  | { kind: 'multiselect'; options: string[] };

export function parseType(raw: string): CellType {
  const m = raw && raw.trim();
  if (!m) return 'text';
  if (m.startsWith('select(')) {
    return { kind: 'select', options: m.slice(7, -1).split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (m.startsWith('multiselect(')) {
    return { kind: 'multiselect', options: m.slice(12, -1).split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (['text', 'longtext', 'markdown', 'date', 'datetime', 'number', 'link', 'check', 'sketch'].includes(m)) {
    return m as CellType;
  }
  return 'text';
}

export function InlineCell({
  value,
  type,
  onCommit,
  className,
}: {
  value: unknown;
  type: CellType;
  onCommit: (next: string) => Promise<void> | void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stringify(value));
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  useEffect(() => { setDraft(stringify(value)); }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current instanceof HTMLInputElement && inputRef.current.type !== 'checkbox') {
        inputRef.current.select?.();
      }
    }
  }, [editing]);

  // Multiselect uses a chip popover instead of an inline input —
  // entering "edit mode" doesn't apply.
  if (typeof type === 'object' && type.kind === 'multiselect') {
    return (
      <MultiChipEditor
        value={stringify(value)}
        options={type.options}
        onCommit={onCommit}
      />
    );
  }
  if (type === 'sketch') {
    return <SketchEditor value={stringify(value)} onCommit={onCommit} />;
  }

  async function commit(next: string) {
    setEditing(false);
    if (next === stringify(value)) return;
    try { await onCommit(next); } catch { setDraft(stringify(value)); }
  }

  function cancel() {
    setEditing(false);
    setDraft(stringify(value));
  }

  if (editing) {
    if (type === 'longtext' || type === 'markdown') {
      return (
        <textarea
          ref={(el) => { inputRef.current = el; }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(draft); }
          }}
          className="w-full resize-y rounded-md border border-zinc-300 bg-white p-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          rows={4}
        />
      );
    }
    if (typeof type === 'object' && type.kind === 'select') {
      return (
        <select
          ref={(el) => { inputRef.current = el; }}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => commit(draft)}
          className="w-full rounded-md border border-zinc-300 bg-white p-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value=""></option>
          {type.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (type === 'check') {
      return (
        <input
          type="checkbox"
          checked={truthy(draft)}
          onChange={(e) => commit(e.target.checked ? 'TRUE' : 'FALSE')}
          autoFocus
        />
      );
    }
    return (
      <input
        ref={(el) => { inputRef.current = el; }}
        type={inputType(type)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        className="w-full rounded-md border border-zinc-300 bg-white p-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
    );
  }

  // Display mode.
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={cn(
        'min-h-[1.4rem] w-full cursor-text rounded px-1 py-0.5 text-left text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
        type === 'check' && 'flex items-center',
        className,
      )}
    >
      {renderDisplay(value, type)}
    </button>
  );
}

function inputType(t: CellType) {
  if (t === 'date') return 'date';
  if (t === 'datetime') return 'datetime-local';
  if (t === 'number') return 'number';
  if (t === 'link') return 'url';
  return 'text';
}

function stringify(v: unknown) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function truthy(v: string) {
  if (!v) return false;
  return v === 'TRUE' || v === 'true' || v === '1' || v === 'on';
}

function renderDisplay(v: unknown, t: CellType): React.ReactNode {
  const s = stringify(v);
  if (t === 'check') return <span>{truthy(s) ? '✓' : ''}</span>;
  if (t === 'link' && s) {
    return (
      <a
        href={s}
        target="_blank"
        rel="noopener"
        onClick={(e) => e.stopPropagation()}
        className="text-blue-600 underline-offset-2 hover:underline"
      >
        {hostnameOf(s)}
      </a>
    );
  }
  if (!s) return <span className="text-zinc-400">—</span>;
  return <span className="line-clamp-2 whitespace-pre-wrap break-words">{s}</span>;
}

function hostnameOf(s: string) {
  try { return new URL(s).hostname.replace(/^www\./, ''); }
  catch { return s; }
}
