/**
 * Owner-side detailed view of a single recipient's progress on a
 * share. /shared-by-me/<shareRecipientId> resolves the recipient,
 * confirms the parent share is owned by the current user, requires
 * recipientShareProgress=true (otherwise the recipient hasn't
 * agreed to expose their progress), and renders the shared rows
 * with the recipient's watch_progress alongside.
 *
 * Mirrors /shared-with-me but reversed: the recipient sees the
 * owner's progress when shareProgress is on; the owner sees the
 * recipient's progress when recipientShareProgress is on.
 */
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Recipient progress — Minerva' };

type RawRow = { id: string; data: unknown; createdAt: Date | string };

export default async function SharedByMePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;
  const { id } = await params;

  const rec = await db.query.shareRecipients.findFirst({
    where: eq(schema.shareRecipients.id, id),
  });
  if (!rec) notFound();

  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, rec.shareId), isNull(schema.shares.revokedAt)),
  });
  if (!share || share.ownerUserId !== userId) notFound();

  // Recipient must have agreed to expose their progress.
  if (!rec.recipientShareProgress || !rec.recipientUserId) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
          <Link href="/shares" className="text-xs text-zinc-500 hover:underline">← back to /shares</Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Recipient progress</h1>
        </header>
        <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This recipient hasn&apos;t agreed to share their progress with you. They can flip &quot;Share my progress with the owner&quot; on their /shared-with-me page if they want to.
        </p>
      </main>
    );
  }

  const recipient = await db.query.users.findFirst({
    where: eq(schema.users.id, rec.recipientUserId),
    columns: { username: true, name: true },
  });

  let scopeTitle = 'Shared';
  let rows: RawRow[] = [];

  if (share.scope === 'section') {
    const sec = await db.query.sections.findFirst({ where: eq(schema.sections.id, share.targetId) });
    if (!sec) notFound();
    scopeTitle = sec.title;
    rows = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sec.id) });
  } else if (share.scope === 'group') {
    const [sectionId, ...rest] = share.targetId.split(':');
    const groupKey = rest.join(':');
    const sec = await db.query.sections.findFirst({ where: eq(schema.sections.id, sectionId) });
    if (!sec) notFound();
    scopeTitle = `${groupKey} · ${sec.title}`;
    const all = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sec.id) });
    const groupCol = sec.preset === 'youtube' ? 'playlist' : 'category';
    rows = all.filter((r) => {
      const data = r.data as Record<string, unknown>;
      const v = data[groupCol];
      const vs = typeof v === 'string' ? v.split(/,\s*/) : [];
      return vs.includes(groupKey);
    });
  } else if (share.scope === 'row') {
    const row = await db.query.rows.findFirst({ where: eq(schema.rows.id, share.targetId) });
    if (!row) notFound();
    rows = [row];
    scopeTitle = String((row.data as Record<string, unknown>).title || (row.data as Record<string, unknown>).name || 'Shared item');
  } else {
    notFound();
  }

  const wp = rows.length === 0 ? [] : await db
    .select({
      rowId: schema.watchProgress.rowId,
      positionSec: schema.watchProgress.positionSec,
      durationSec: schema.watchProgress.durationSec,
      updatedAt: schema.watchProgress.updatedAt,
    })
    .from(schema.watchProgress)
    .where(and(
      eq(schema.watchProgress.userId, rec.recipientUserId),
      inArray(schema.watchProgress.rowId, rows.map((r) => r.id)),
    ));
  const progress = new Map(wp.map((p) => [p.rowId, p]));

  // Roll-up: completed (≥90% of duration when known) vs started
  // vs unstarted. Lets the header show "watched 12 / 22" at a
  // glance without per-row math in the head.
  let completed = 0;
  let started = 0;
  for (const r of rows) {
    const p = progress.get(r.id);
    if (!p) continue;
    started++;
    if (p.durationSec && p.positionSec >= p.durationSec * 0.9) completed++;
  }
  const handle = recipient?.username ? `@${recipient.username}` : (recipient?.name || 'recipient');

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <Link href="/shares" className="text-xs text-zinc-500 hover:underline">← back to /shares</Link>
        <p className="mt-2 text-[11px] uppercase tracking-wide text-zinc-500">
          {handle} on your share · {rec.mode}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{scopeTitle}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {completed} completed · {Math.max(0, started - completed)} in progress · {Math.max(0, rows.length - started)} unstarted
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nothing in the shared scope.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const data = r.data as Record<string, unknown>;
            const title = String(data.title || data.name || data.url || '(untitled)');
            const url = typeof data.url === 'string' ? data.url : '';
            const p = progress.get(r.id);
            const pct = p && p.durationSec ? Math.min(100, Math.round((p.positionSec / p.durationSec) * 100)) : null;
            return (
              <li key={r.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener" className="text-sm font-medium hover:underline">{title}</a>
                  ) : (
                    <span className="text-sm font-medium">{title}</span>
                  )}
                </div>
                {p ? (
                  <div className="mt-1 flex items-center gap-2">
                    {pct != null ? (
                      <>
                        <span className="inline-flex h-1.5 w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                          <span className="bg-blue-500" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="text-[11px] text-zinc-500">{pct}% · {Math.floor(p.positionSec / 60)}m / {Math.floor((p.durationSec ?? 0) / 60)}m</span>
                      </>
                    ) : (
                      <span className="text-[11px] text-zinc-500">{Math.floor(p.positionSec / 60)}m watched</span>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-zinc-400">Unstarted</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
