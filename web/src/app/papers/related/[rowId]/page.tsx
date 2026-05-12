import { auth } from '@/auth';
import { redirect, notFound } from 'next/navigation';
import { db, schema } from '@/db';
import { and, asc, eq } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { RelatedView } from './related-view';
import { resolvePaperRef } from '@/lib/paper-ref';

export const metadata = { title: 'Related papers' };

/** Per-row "connected papers" page. Renders the seed paper at the
 *  top and a searchable / one-click-add list of related papers
 *  pulled from Semantic Scholar's recommendations API. */
export default async function RelatedPapersPage({ params }: { params: Promise<{ rowId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;
  const { rowId } = await params;

  const row = await db.query.rows.findFirst({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.id, rowId),
      eq(schema.rows.deleted, false),
    ),
  });
  if (!row) notFound();

  const section = await db.query.sections.findFirst({
    where: eq(schema.sections.id, row.sectionId),
  });
  if (!section) notFound();

  const navSections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });

  const data = row.data as Record<string, unknown>;
  const seedRef = resolvePaperRef(data);

  return (
    <>
      <Nav
        sections={navSections.map((s) => ({ slug: s.slug, title: s.title, icon: s.icon ?? null }))}
        email={session.user.email ?? null}
      />
      <RelatedView
        sectionSlug={section.slug}
        rowId={rowId}
        seedRef={seedRef}
        seedTitle={String(data.title || '(untitled)')}
        seedAuthors={String(data.authors || '')}
        seedYear={String(data.year || '')}
      />
    </>
  );
}
