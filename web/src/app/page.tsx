import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { PomodoroWidget } from '@/components/pomodoro-widget';
import { SectionIcon } from '@/components/section-icon';

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });

  // Pull every active row across the user's sections — small N
  // for a personal app, no need for a fancier query.
  const rows = await db.query.rows.findMany({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)),
    orderBy: [asc(schema.rows.updatedAt)],
  });

  const today = isoToday();
  const sectionBy: Record<string, typeof sections[number]> = {};
  sections.forEach((s) => { sectionBy[s.id] = s; });

  type Hit = { id: string; sectionSlug: string; sectionTitle: string; title: string; due: string };
  const dueToday: Hit[] = [];
  const overdue: Hit[] = [];
  rows.forEach((r) => {
    const s = sectionBy[r.sectionId]; if (!s) return;
    const data = r.data as Record<string, unknown>;
    const due = (data.due || data.deadline || '') as string;
    if (!due) return;
    const status = String(data.status || '').toLowerCase();
    if (status === 'done' || data.completed === true || data.completed === 'TRUE') return;
    const head: Hit = {
      id: r.id,
      sectionSlug: s.slug,
      sectionTitle: s.title,
      title: String(data.title || data.name || r.id),
      due: String(due).slice(0, 10),
    };
    if (head.due < today) overdue.push(head);
    else if (head.due === today) dueToday.push(head);
  });
  overdue.sort((a, b) => a.due.localeCompare(b.due));

  return (
    <>
      <Nav sections={sections} email={session.user.email} />
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">
          Welcome back{session.user.name ? `, ${session.user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
          {sections.length === 0
            ? 'Get started by adding a section in Settings.'
            : `${overdue.length + dueToday.length} item${(overdue.length + dueToday.length) === 1 ? '' : 's'} need your attention.`}
        </p>

        <div className="mt-6">
          <PomodoroWidget />
        </div>

        {(overdue.length + dueToday.length) > 0 && (
          <section className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
            {overdue.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                  Overdue · {overdue.length}
                </h2>
                <ul className="space-y-1.5">
                  {overdue.map((h) => (
                    <li key={h.id}>
                      <a
                        href={`/s/${encodeURIComponent(h.sectionSlug)}`}
                        className="flex items-baseline justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                      >
                        <span className="line-clamp-1">{h.title}</span>
                        <span className="shrink-0 text-xs text-red-600">{h.due}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dueToday.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
                  Today · {dueToday.length}
                </h2>
                <ul className="space-y-1.5">
                  {dueToday.map((h) => (
                    <li key={h.id}>
                      <a
                        href={`/s/${encodeURIComponent(h.sectionSlug)}`}
                        className="flex items-baseline justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                      >
                        <span className="line-clamp-1">{h.title}</span>
                        <span className="shrink-0 text-xs text-zinc-500">/{h.sectionSlug}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {sections.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Sections</h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/s/${encodeURIComponent(s.slug)}`}
                    className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                  >
                    <SectionIcon hint={s.icon || s.slug} className="h-5 w-5 text-zinc-500" />
                    <div>
                      <div className="text-sm font-medium">{s.title}</div>
                      <div className="mt-1 text-xs text-zinc-500">/{s.slug}</div>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
