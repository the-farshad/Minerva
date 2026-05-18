/**
 * Public-link recipient landing page. Anyone with the token can
 * view the shared content read-only — no authentication required.
 *
 * Scope coverage:
 *   - section : every row in the section
 *   - group   : every row in <section> whose group key matches
 *   - row     : single row
 *
 * Revoked shares (shares.revokedAt set) 404 — the link is dead.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Shared — Minerva' };

type RawRow = { id: string; data: unknown; createdAt: Date | string };

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const rec = await db.query.shareRecipients.findFirst({
    where: eq(schema.shareRecipients.publicToken, token),
  });
  if (!rec) notFound();

  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, rec.shareId), isNull(schema.shares.revokedAt)),
  });
  if (!share) notFound();

  const owner = await db.query.users.findFirst({
    where: eq(schema.users.id, share.ownerUserId),
    columns: { username: true, name: true, image: true },
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
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">
          Shared by {owner?.username ? <>@{owner.username}</> : (owner?.name || 'a Minerva user')}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {rows.length} item{rows.length === 1 ? '' : 's'} · view-only · public link
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nothing to show — the share is empty.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <SharedRow key={r.id} row={r} />
          ))}
        </ul>
      )}

      <footer className="mt-12 text-center text-xs text-zinc-400">
        <Link href="/lit" className="hover:underline">/lit</Link>
        {' · '}
        <Link href="/" className="hover:underline">Minerva home</Link>
      </footer>
    </main>
  );
}

function SharedRow({ row }: { row: RawRow }) {
  const data = row.data as Record<string, unknown>;
  const title = String(data.title || data.name || data.url || '(untitled)');
  const url = typeof data.url === 'string' ? data.url : '';
  const authors = typeof data.authors === 'string' ? data.authors : '';
  const year = data.year;
  const venue = typeof data.venue === 'string' ? data.venue : '';
  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {url ? (
          <a href={url} target="_blank" rel="noopener" className="text-sm font-medium hover:underline">{title}</a>
        ) : (
          <span className="text-sm font-medium">{title}</span>
        )}
        {year != null && <span className="text-xs text-zinc-500">{String(year)}</span>}
      </div>
      {authors && <p className="mt-0.5 truncate text-xs text-zinc-500">{authors}</p>}
      {venue && <p className="text-[11px] text-zinc-400">{venue}</p>}
    </li>
  );
}
