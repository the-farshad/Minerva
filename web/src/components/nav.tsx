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

export function Nav({
  sections,
  email,
}: {
  sections: { slug: string; title: string; icon?: string | null }[];
  email?: string | null;
}) {
  const path = usePathname();
  return (
    <nav className="border-b border-zinc-200 bg-white/70 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
      {/* Row 1: primary + utility nav, search, sign-out. Wraps on
        * narrow screens but stays compact. */}
      <div className="flex flex-wrap items-center gap-1 px-3 py-2 sm:px-4 sm:py-3">
        {PRIMARY.map((it) => (
          <NavLink key={it.href} href={it.href} active={path === it.href}>
            <it.icon className="h-4 w-4" />
            <span className="hidden sm:inline">{it.label}</span>
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
      </div>
      {/* Row 2: section list as a horizontally-scrollable strip on
        * narrow screens; on wide screens it sits inline as a single
        * line and overflows-scroll only if the user has a lot of
        * sections. Keeps the order stable across viewports. */}
      {sections.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-zinc-100 px-3 py-1.5 dark:border-zinc-900 sm:px-4">
          {sections.map((s) => (
            <NavLink
              key={s.slug}
              href={`/s/${encodeURIComponent(s.slug)}`}
              active={path === `/s/${s.slug}`}
            >
              <SectionIcon hint={s.icon || s.slug} className="h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap">{s.title}</span>
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      // 36px tap target on mobile via min-height; on desktop the
      // visual height stays the same but the inline-flex centres
      // the content within it. Padding bumped slightly so icons
      // don't crowd at small screens.
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
