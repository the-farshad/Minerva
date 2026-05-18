/**
 * Authenticated recipient view of an accepted share.
 *
 * /shared-with-me/<shareRecipientId> resolves the recipient row,
 * checks it belongs to the current user, then renders the shared
 * section / group / single row read-only. Mirrors the rendering
 * of /share/<token> but gated by Auth.js — for public-link
 * recipients the token route is the public face.
 */
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Shared with me — Minerva' };

type RawRow = { id: string; data: unknown; createdAt: Date | string };

export default async function SharedWithMePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;
  const { id } = await params;

  const rec = await db.query.shareRecipients.findFirst({
    where: and(
      eq(schema.shareRecipients.id, id),
      eq(schema.shareRecipients.recipientUserId, userId),
    ),
  });
  if (!rec || !rec.acceptedAt || rec.declinedAt) notFound();

  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, rec.shareId), isNull(schema.shares.revokedAt)),
  });
  if (!share) notFound();

  const owner = await db.query.users.findFirst({
    where: eq(schema.users.id, share.ownerUserId),
    columns: { username: true, name: true },
  });

  let title = 'Shared';
  let preset: string | null = null;
  let rows: RawRow[] = [];
  let groupKey: string | null = null;

  if (share.scope === 'section') {
    const sec = await db.query.sections.findFirst({ where: eq(schema.sections.id, share.targetId) });
    if (!sec) notFound();
    title = sec.title;
    preset = sec.preset;
    rows = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sec.id) });
  } else if (share.scope === 'group') {
    const [sectionId, ...rest] = share.targetId.split(':');
    groupKey = rest.join(':');
    const sec = await db.query.sections.findFirst({ where: eq(schema.sections.id, sectionId) });
    if (!sec) notFound();
    title = `${groupKey} · ${sec.title}`;
    preset = sec.preset;
    const all = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sec.id) });
    const groupCol = preset === 'youtube' ? 'playlist' : 'category';
    rows = all.filter((r) => {
      const data = r.data as Record<string, unknown>;
      const v = data[groupCol];
      const vs = typeof v === 'string' ? v.split(/,\s*/) : [];
      return vs.includes(groupKey!);
    });
  } else if (share.scope === 'row') {
    const row = await db.query.rows.findFirst({ where: eq(schema.rows.id, share.targetId) });
    if (!row) notFound();
    rows = [row];
    title = String((row.data as Record<string, unknown>).title || (row.data as Record<string, unknown>).name || 'Shared item');
  } else {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <Link href="/shares" className="text-xs text-zinc-500 hover:underline">← back to /shares</Link>
        <p className="mt-2 text-[11px] uppercase tracking-wide text-zinc-500">
          Shared by {owner?.username ? <>@{owner.username}</> : (owner?.name || 'a Minerva user')} · {rec.mode}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {rows.length} item{rows.length === 1 ? '' : 's'} · read-only
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nothing to show — the share is empty.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const data = r.data as Record<string, unknown>;
            const t = String(data.title || data.name || data.url || '(untitled)');
            const url = typeof data.url === 'string' ? data.url : '';
            const authors = typeof data.authors === 'string' ? data.authors : '';
            const year = data.year;
            const venue = typeof data.venue === 'string' ? data.venue : '';
            return (
              <li key={r.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener" className="text-sm font-medium hover:underline">{t}</a>
                  ) : (
                    <span className="text-sm font-medium">{t}</span>
                  )}
                  {year != null && <span className="text-xs text-zinc-500">{String(year)}</span>}
                </div>
                {authors && <p className="mt-0.5 truncate text-xs text-zinc-500">{authors}</p>}
                {venue && <p className="text-[11px] text-zinc-400">{venue}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
