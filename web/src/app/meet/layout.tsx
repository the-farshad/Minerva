import { auth } from '@/auth';
import { db, schema } from '@/db';
import { and, asc, eq } from 'drizzle-orm';
import { Nav } from '@/components/nav';

/** Shared layout for every /meet route — the index, the
 *  composer, and the public participant view. Renders the top
 *  Nav above {children} so polls don't feel like a side
 *  silo. /meet/[token] is intentionally open to anonymous
 *  participants; the Nav fetch is gated so the signed-out path
 *  still serves the page (just without a top nav). */
export default async function MeetLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  let sections: { slug: string; title: string; icon: string | null }[] = [];
  let email: string | null = null;
  if (session?.user) {
    const userId = (session.user as { id: string }).id;
    email = session.user.email ?? null;
    const rows = await db.query.sections.findMany({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
      orderBy: [asc(schema.sections.order)],
    });
    sections = rows.map((s) => ({ slug: s.slug, title: s.title, icon: s.icon ?? null }));
  }
  return (
    <>
      {session?.user && <Nav sections={sections} email={email} />}
      {children}
    </>
  );
}
