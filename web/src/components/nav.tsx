'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Home, Settings, LogOut, Share2, Calendar, Timer, Network } from 'lucide-react';
import { signOutAction } from '@/app/actions';
import { SearchBar } from './search-bar';
import { VersionBadge } from './version-badge';
import { SectionIcon } from './section-icon';

const PRIMARY = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/schedule', label: 'Schedule', icon: Calendar },
  { href: '/graph', label: 'Graph', icon: Network },
];
const UTILITY = [
  { href: '/pomodoro', label: 'Pomodoro', icon: Timer },
  { href: '/share', label: 'Share', icon: Share2 },
  { href: '/meet', label: 'Polls', icon: Calendar },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** Top nav. One single flex-wrap row containing primary +
 *  sections + utility + search + sign-out. On wide viewports it
 *  reads as one line; on narrower ones it wraps cleanly. Mobile
 *  collapses Home/Schedule/Graph/Pomodoro/Share/Polls/Settings
 *  labels to icons-only to save horizontal space; section titles
 *  always show because no synonymous icon exists. */
export function Nav({
  sections,
  email,
}: {
  sections: { slug: string; title: string; icon?: string | null }[];
  email?: string | null;
}) {
  const path = usePathname();
  // Hide any legacy 'meets' / 'meetings' section row — the iframe
  // wrapper was removed; the canonical surface is /meet (already
  // in UTILITY above). Defensive: keeps the nav clean even if a
  // user's PG still has the row.
  const visibleSections = sections.filter((s) => s.slug !== 'meets');
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-white/70 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70 sm:px-4 sm:py-3">
      {PRIMARY.map((it) => (
        <NavLink key={it.href} href={it.href} active={path === it.href}>
          <it.icon className="h-4 w-4" />
          <span className="hidden sm:inline">{it.label}</span>
        </NavLink>
      ))}
      <span className="mx-1 hidden text-zinc-300 dark:text-zinc-700 sm:inline sm:mx-2">·</span>
      {visibleSections.map((s) => (
        <NavLink
          key={s.slug}
          href={`/s/${encodeURIComponent(s.slug)}`}
          active={path === `/s/${s.slug}`}
        >
          <SectionIcon hint={s.icon || s.slug} className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{s.title}</span>
        </NavLink>
      ))}
      <span className="mx-1 hidden text-zinc-300 dark:text-zinc-700 sm:inline sm:mx-2">·</span>
      {UTILITY.map((it) => (
        <NavLink key={it.href} href={it.href} active={path?.startsWith(it.href) ?? false}>
          <it.icon className="h-4 w-4" />
          <span className="hidden sm:inline">{it.label}</span>
        </NavLink>
      ))}
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <VersionBadge />
        <SearchBar />
        {email && (
          <form action={signOutAction} className="flex items-center gap-2">
            <span className="hidden text-xs text-zinc-500 md:inline">{email}</span>
            <button
              type="submit"
              title="Sign out"
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 p-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 sm:px-2.5 sm:py-1"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
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
      // 36 px tap target on mobile via min-height; on desktop the
      // visual height stays the same but the inline-flex centres
      // content vertically within it.
      className={cn(
        'inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm transition',
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
      )}
    >
      {children}
    </Link>
  );
}
