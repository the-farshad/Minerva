/**
 * Restore from a backup JSON. Sections matched by slug — existing
 * sections are kept; missing ones created. Rows in `mode=replace`
 * wipe the section first; otherwise they're appended.
 *
 *   POST /api/backup/restore
 *     Body: the JSON produced by GET /api/backup.
 *     Query: ?mode=replace | merge   (default: merge)
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

type BackupSection = {
  slug: string; title: string; icon?: string | null; order?: number;
  schema: { headers?: string[]; types?: string[] };
  preset?: string | null; defaultSort?: string | null;
  defaultFilter?: string | null; enabled?: boolean;
};
type BackupRow = { sectionSlug?: string; data: Record<string, unknown> };
type Backup = { minerva?: string; sections?: BackupSection[]; rows?: BackupRow[]; prefs?: Record<string, unknown> };

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const mode = req.nextUrl.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
  const body = (await req.json().catch(() => null)) as Backup | null;
  if (!body || body.minerva !== 'backup') {
    return NextResponse.json({ error: 'Not a Minerva backup file.' }, { status: 400 });
  }

  // Sections — match-by-slug, create-if-missing.
  const existing = await db.query.sections.findMany({ where: eq(schema.sections.userId, userId) });
  const slugToId = new Map(existing.map((s) => [s.slug, s.id]));
  let sectionsCreated = 0;
  for (const s of body.sections || []) {
    if (!s.slug) continue;
    if (!slugToId.has(s.slug)) {
      const [created] = await db.insert(schema.sections).values({
        userId,
        slug: s.slug,
        title: s.title || s.slug,
        icon: s.icon || null,
        order: typeof s.order === 'number' ? s.order : 0,
        schema: s.schema || { headers: [], types: [] },
        preset: s.preset || null,
        defaultSort: s.defaultSort || null,
        defaultFilter: s.defaultFilter || null,
        enabled: s.enabled !== false,
      }).returning();
      slugToId.set(s.slug, created.id);
      sectionsCreated++;
    }
  }

  // Rows.
  let rowsInserted = 0;
  const bySectionSlug: Record<string, BackupRow[]> = {};
  for (const r of body.rows || []) {
    const sl = r.sectionSlug;
    if (!sl) continue;
    (bySectionSlug[sl] ??= []).push(r);
  }
  for (const [slug, list] of Object.entries(bySectionSlug)) {
    const sectionId = slugToId.get(slug);
    if (!sectionId) continue;
    if (mode === 'replace') {
      await db.update(schema.rows)
        .set({ deleted: true, updatedAt: new Date() })
        .where(and(eq(schema.rows.userId, userId), eq(schema.rows.sectionId, sectionId)));
    }
    for (const r of list) {
      await db.insert(schema.rows).values({
        userId,
        sectionId,
        data: r.data || {},
      });
      rowsInserted++;
    }
  }

  // Prefs — merged shallowly under data.client.
  if (body.prefs && typeof body.prefs === 'object') {
    const row = await db.query.userPrefs.findFirst({
      where: eq(schema.userPrefs.userId, userId),
    });
    const data = (row?.data as Record<string, unknown>) || {};
    const client = (data.client as Record<string, unknown>) || {};
    const nextClient = { ...client, ...body.prefs };
    const nextData = { ...data, client: nextClient };
    if (row) {
      await db.update(schema.userPrefs)
        .set({ data: nextData, updatedAt: new Date() })
        .where(eq(schema.userPrefs.userId, userId));
    } else {
      await db.insert(schema.userPrefs).values({ userId, data: nextData });
    }
  }

  return NextResponse.json({ ok: true, mode, sectionsCreated, rowsInserted });
}
