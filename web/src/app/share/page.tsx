import type { Metadata } from 'next';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { ShareComposer } from './share-composer';

export const metadata: Metadata = { title: 'Quick share' };

export default async function SharePage() {
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
      <main className="mx-auto w-full max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Quick share</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Type a note, question, or poll. Press <strong>Copy link</strong> and you get a public URL
          anyone can open — no Minerva account needed. The card&rsquo;s contents live <em>inside the URL itself</em>,
          so Minerva never stores it and rotating the URL revokes it.
        </p>
        <ShareComposer />
      </main>
    </>
  );
}
