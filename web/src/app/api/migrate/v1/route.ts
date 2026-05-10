/**
 * One-shot v1→v2 migration. Pulls the user's existing "Minerva"
 * spreadsheet from Drive, walks every tab, and writes equivalent
 * sections + rows into the v2 database.
 *
 *   POST /api/migrate/v1
 *
 * Idempotent on a per-section basis: if a section with the same
 * slug already exists in v2 (from an earlier migration or because
 * the user installed it manually), we *skip* it rather than
 * doubling rows. Use ?force=1 to wipe the existing v2 section
 * before re-importing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { findSpreadsheetByName, getSpreadsheet, getValues } from '@/lib/sheets';
import { PRESETS } from '@/lib/presets';

interface Result {
  spreadsheetId: string;
  sections: { slug: string; status: 'created' | 'updated' | 'skipped'; rows: number }[];
  total: number;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const force = req.nextUrl.searchParams.get('force') === '1';

  const sheet = await findSpreadsheetByName(userId, 'Minerva');
  if (!sheet) {
    return NextResponse.json({ error: 'No Minerva spreadsheet found in your Drive.' }, { status: 404 });
  }
  const meta = await getSpreadsheet(userId, sheet.id);
  const tabs = meta.sheets.map((s) => s.properties.title)
    .filter((t) => t && !t.startsWith('_'));

  // Pull _config first so we know which slugs are "real" sections
  // versus internal book-keeping. v1 lets users disable a section
  // by flipping its `enabled` cell to FALSE; we honor that.
  let configRows: Record<string, string>[] = [];
  try {
    const cfg = await getValues(userId, sheet.id, '_config!A:Z');
    const headers = cfg.values?.[0] || [];
    const rows = (cfg.values || []).slice(2);
    configRows = rows.map((r) => {
      const out: Record<string, string> = {};
      headers.forEach((h, i) => { out[h] = r[i] ?? ''; });
      return out;
    });
  } catch {
    // No _config tab — fall back to importing every visible tab.
  }

  const wanted: Record<string, string>[] = configRows.length
    ? configRows.filter((r) => r.enabled !== 'FALSE' && r.slug && r.tab)
    : tabs.map((t) => ({ slug: t, title: t, tab: t, icon: '', order: '0', defaultSort: '', defaultFilter: '' }));

  const result: Result = { spreadsheetId: sheet.id, sections: [], total: 0 };

  for (const cfg of wanted) {
    const slug = cfg.slug;
    const tab = cfg.tab || slug;

    let values: string[][];
    try {
      const v = await getValues(userId, sheet.id, `${tab}!A:Z`);
      values = v.values || [];
    } catch {
      result.sections.push({ slug, status: 'skipped', rows: 0 });
      continue;
    }
    if (values.length < 2) {
      result.sections.push({ slug, status: 'skipped', rows: 0 });
      continue;
    }
    const headers = values[0];
    const types = values[1] || [];
    const dataRows = values.slice(2);

    // Section row: reuse / re-enable / create.
    const existingSection = await db.query.sections.findFirst({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
    });
    if (existingSection && !force) {
      result.sections.push({
        slug, status: 'skipped',
        rows: 0,
      });
      continue;
    }

    const presetMatch = PRESETS.find((p) => p.slug === slug);
    const sectionPayload = {
      userId,
      slug,
      title: cfg.title || presetMatch?.title || slug,
      icon: cfg.icon || presetMatch?.icon,
      schema: { headers, types },
      defaultSort: cfg.defaultSort || presetMatch?.defaultSort,
      defaultFilter: cfg.defaultFilter || presetMatch?.defaultFilter,
      enabled: true,
      preset: presetMatch?.preset || null,
      order: Number(cfg.order) || 0,
    } as const;

    let sectionId: string;
    if (existingSection && force) {
      await db.delete(schema.rows).where(eq(schema.rows.sectionId, existingSection.id));
      await db.update(schema.sections)
        .set({ ...sectionPayload, updatedAt: new Date() })
        .where(eq(schema.sections.id, existingSection.id));
      sectionId = existingSection.id;
    } else {
      const [created] = await db.insert(schema.sections).values(sectionPayload).returning();
      sectionId = created.id;
    }

    // Row inserts — coerce each row's data into a JSON object keyed
    // by header. Skip rows where the id field is empty.
    const idField = pickIdField(headers);
    const inserts = dataRows
      .map((raw) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = raw[i] ?? ''; });
        return obj;
      })
      .filter((r) => idField ? r[idField] : true);

    if (inserts.length) {
      await db.insert(schema.rows).values(
        inserts.map((data) => ({ userId, sectionId, data })),
      );
    }
    result.sections.push({
      slug,
      status: existingSection ? 'updated' : 'created',
      rows: inserts.length,
    });
    result.total += inserts.length;
  }

  return NextResponse.json(result);
}

function pickIdField(headers: string[]) {
  for (const c of ['id', 'uid', 'slug']) {
    if (headers.includes(c)) return c;
  }
  return null;
}
