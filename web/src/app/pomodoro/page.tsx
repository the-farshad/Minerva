import type { Metadata } from 'next';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { PomodoroView } from './pomodoro-view';

export const metadata: Metadata = { title: 'Pomodoro' };

export default async function PomodoroPage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;
  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });
  return (
    <>
      <Nav sections={sections} email={session.user.email} />
      <PomodoroView />
    </>
  );
}
