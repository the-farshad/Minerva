import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { SettingsView } from './settings-view';
import { PRESETS } from '@/lib/presets';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;

  const navSections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });
  // Settings shows every section (enabled or not) so the user can
  // re-enable a previously hidden one without losing its rows.
  const ownedSections = await db.query.sections.findMany({
    where: eq(schema.sections.userId, userId),
    orderBy: [asc(schema.sections.order)],
  });

  return (
    <>
      <Nav sections={navSections} email={session.user.email} />
      <SettingsView
        email={session.user.email || ''}
        sections={ownedSections.map((s) => ({ slug: s.slug, title: s.title, enabled: s.enabled }))}
        presets={PRESETS.map((p) => ({ slug: p.slug, title: p.title, icon: p.icon }))}
      />
    </>
  );
}
