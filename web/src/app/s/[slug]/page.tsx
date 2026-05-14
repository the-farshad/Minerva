import { auth } from '@/auth';
import { redirect, notFound } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { SectionView } from './section-view';

export default async function SectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;
  const { slug } = await params;

  const allSections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });
  const section = allSections.find((s) => s.slug === slug);
  if (!section) notFound();

  // Polls live at /meet directly — the old `meets` section was a
  // thin iframe wrapper around the same data. Redirect any legacy
  // section that still claims that slug / preset so users land on
  // the canonical surface in one hop.
  if (section.slug === 'meets' || section.preset === 'meetings') {
    redirect('/meet');
  }

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, section.id),
      eq(schema.rows.deleted, false),
    ),
    orderBy: [asc(schema.rows.createdAt)],
  });

  return (
    <>
      <Nav sections={allSections} email={session.user.email} />
      <SectionView
        section={{
          id: section.id,
          slug: section.slug,
          title: section.title,
          preset: section.preset,
          schema: section.schema as { headers: string[]; types: string[] },
        }}
        initialRows={rows.map((r) => ({
          id: r.id,
          data: r.data as Record<string, unknown>,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }))}
      />
    </>
  );
}
