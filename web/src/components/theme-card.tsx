'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, BookOpen, Terminal, Type } from 'lucide-react';
import { readPref, writePref } from '@/lib/prefs';

type Theme = 'system' | 'light' | 'dark' | 'sepia' | 'vt323';
type Font = 'system' | 'serif' | 'mono' | 'vt323';

const THEMES: { v: Theme; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { v: 'system', label: 'System', Icon: Sun },
  { v: 'light',  label: 'Light',  Icon: Sun },
  { v: 'dark',   label: 'Dark',   Icon: Moon },
  { v: 'sepia',  label: 'Sepia',  Icon: BookOpen },
  { v: 'vt323',  label: 'VT323',  Icon: Terminal },
];

const FONTS: { v: Font; label: string }[] = [
  { v: 'system', label: 'System (Inter)' },
  { v: 'serif',  label: 'Serif' },
  { v: 'mono',   label: 'Monospace' },
  { v: 'vt323',  label: 'VT323' },
];

export function applyTheme(t: Theme) {
  if (typeof document === 'undefined') return;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
export function applyFont(f: Font) {
  if (typeof document === 'undefined') return;
  if (f === 'system') document.documentElement.removeAttribute('data-font');
  else document.documentElement.setAttribute('data-font', f);
}

export function ThemeCard() {
  const [theme, setTheme] = useState<Theme>('system');
  const [font, setFont] = useState<Font>('system');

  useEffect(() => {
    const t = readPref<Theme>('theme', 'system');
    setTheme(t);
    applyTheme(t);
    const f = readPref<Font>('font', 'system');
    setFont(f);
    applyFont(f);
  }, []);

  function pickTheme(t: Theme) {
    setTheme(t);
    writePref('theme', t === 'system' ? '' : t);
    applyTheme(t);
  }
  function pickFont(f: Font) {
    setFont(f);
    writePref('font', f === 'system' ? '' : f);
    applyFont(f);
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <strong className="text-sm">Theme</strong>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Per-device. <code>System</code> follows your OS preference.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => pickTheme(t.v)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${theme === t.v ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800'}`}
          >
            <t.Icon className="h-3 w-3" /> {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Type className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">Font</strong>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {FONTS.map((f) => (
          <button
            key={f.v}
            type="button"
            onClick={() => pickFont(f.v)}
            className={`rounded-full border px-2.5 py-1 text-xs ${font === f.v ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Boot-time applier — runs once at mount in <Providers> so theme + font
 * persist across navigations without a flash. */
export function ThemeBoot() {
  useEffect(() => {
    const t = readPref<Theme>('theme', 'system');
    applyTheme(t);
    const f = readPref<Font>('font', 'system');
    applyFont(f);
  }, []);
  return null;
}
