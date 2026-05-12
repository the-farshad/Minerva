import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc, desc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { ScheduleView } from './schedule-view';

export const metadata = { title: 'Schedule' };

export default async function SchedulePage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;

  // Match the section ordering Home/Settings/section pages use so
  // the top-nav doesn't reshuffle when navigating to Schedule.
  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });
  const rows = await db.query.rows.findMany({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)),
    orderBy: [desc(schema.rows.updatedAt)],
  });

  const sectionBy: Record<string, { slug: string; title: string }> = {};
  for (const s of sections) sectionBy[s.id] = { slug: s.slug, title: s.title };

  const flat = rows
    .map((r) => {
      const s = sectionBy[r.sectionId];
      if (!s) return null;
      return {
        id: r.id,
        data: r.data as Record<string, unknown>,
        updatedAt: r.updatedAt.toISOString(),
        sectionSlug: s.slug,
        sectionTitle: s.title,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <>
      <Nav sections={sections} email={session.user.email} />
      <ScheduleView rows={flat} />
    </>
  );
}
