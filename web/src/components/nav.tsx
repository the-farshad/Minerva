'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Home, Settings, LogOut, Share2, Calendar, Timer } from 'lucide-react';
import { signOutAction } from '@/app/actions';
import { SearchBar } from './search-bar';

const PRIMARY = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/schedule', label: 'Schedule', icon: Calendar },
];
const UTILITY = [
  { href: '/pomodoro', label: 'Pomodoro', icon: Timer },
  { href: '/share', label: 'Share', icon: Share2 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Nav({
  sections,
  email,
}: {
  sections: { slug: string; title: string; icon?: string | null }[];
  email?: string | null;
}) {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-white/70 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
      {PRIMARY.map((it) => (
        <NavLink key={it.href} href={it.href} active={path === it.href}>
          <it.icon className="h-4 w-4" /> {it.label}
        </NavLink>
      ))}
      <span className="mx-2 text-zinc-300 dark:text-zinc-700">·</span>
      {sections.map((s) => (
        <NavLink
          key={s.slug}
          href={`/s/${encodeURIComponent(s.slug)}`}
          active={path === `/s/${s.slug}`}
        >
          {s.title}
        </NavLink>
      ))}
      <span className="mx-2 text-zinc-300 dark:text-zinc-700">·</span>
      {UTILITY.map((it) => (
        <NavLink key={it.href} href={it.href} active={path?.startsWith(it.href) ?? false}>
          <it.icon className="h-4 w-4" /> {it.label}
        </NavLink>
      ))}
      <div className="ml-auto flex items-center gap-3">
        <SearchBar />
        {email && (
        <form action={signOutAction} className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">{email}</span>
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3 w-3" /> Sign out
          </button>
        </form>
        )}
      </div>
    </nav>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition',
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
      )}
    >
      {children}
    </Link>
  );
}
