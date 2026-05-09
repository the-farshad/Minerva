import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { Nav } from '@/components/nav';

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: (s, { asc }) => [asc(s.order)],
  });

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
            : `You have ${sections.length} section${sections.length === 1 ? '' : 's'} configured.`}
        </p>
        {sections.length > 0 && (
          <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`/s/${encodeURIComponent(s.slug)}`}
                  className="block rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                >
                  <div className="text-sm font-medium">{s.title}</div>
                  <div className="mt-1 text-xs text-zinc-500">/{s.slug}</div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
