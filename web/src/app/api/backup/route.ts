/**
 * Full data export — sections + rows + client prefs as JSON.
 * Token-carrying state (Google OAuth credentials, feed token,
 * Telegram bot token) is intentionally excluded; a backup file
 * is supposed to be safe to share with the user's own backup
 * tools.
 *
 *   GET /api/backup        → application/json (download)
 */
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const [sections, rows, bookmarks, prefsRow] = await Promise.all([
    db.query.sections.findMany({ where: eq(schema.sections.userId, userId) }),
    db.query.rows.findMany({ where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)) }),
    db.query.bookmarks.findMany({ where: eq(schema.bookmarks.userId, userId) }),
    db.query.userPrefs.findFirst({ where: eq(schema.userPrefs.userId, userId) }),
  ]);

  const prefsData = (prefsRow?.data as Record<string, unknown>) || {};
  const safePrefs = (prefsData.client as Record<string, unknown>) || {};

  const out = {
    minerva: 'backup',
    version: 2,
    exported: new Date().toISOString(),
    sections: sections.map((s) => ({
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      order: s.order,
      schema: s.schema,
      preset: s.preset,
      defaultSort: s.defaultSort,
      defaultFilter: s.defaultFilter,
      enabled: s.enabled,
    })),
    rows: rows.map((r) => {
      const sec = sections.find((s) => s.id === r.sectionId);
      return {
        sectionSlug: sec?.slug,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
    bookmarks: bookmarks.map((b) => ({
      url: b.url,
      kind: b.kind,
      ref: b.ref,
      label: b.label,
      note: b.note,
      createdAt: b.createdAt.toISOString(),
    })),
    prefs: safePrefs,
  };

  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="minerva-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
