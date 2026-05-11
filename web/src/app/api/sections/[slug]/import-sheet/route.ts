/**
 * One-shot pull: read every value from a user-supplied Google Sheet
 * and overlay them onto the section. Mode `replace` wipes existing
 * rows first; `merge` keeps them and appends/updates by `id` column
 * if present, else appends.
 *
 * Headers are taken from the sheet's first row. Columns the section
 * doesn't already know about are dropped to keep the schema honest.
 *
 *   POST /api/sections/<slug>/import-sheet
 *     { sheetIdOrUrl: "...", mode?: "replace"|"merge" }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getGoogleAccessToken } from '@/lib/google';

function extractSheetId(s: string): string | null {
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s.trim())) return s.trim();
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug } = await ctx.params;

  const sec = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { sheetIdOrUrl?: string; mode?: 'replace' | 'merge' };
  const id = extractSheetId(body.sheetIdOrUrl || '');
  if (!id) return NextResponse.json({ error: 'Invalid sheet id or URL' }, { status: 400 });
  const mode = body.mode === 'replace' ? 'replace' : 'merge';

  const token = await getGoogleAccessToken(userId);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:ZZ?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `Sheets ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const data = (await res.json()) as { values?: (string | number | boolean)[][] };
  const values = data.values || [];
  if (values.length < 1) return NextResponse.json({ error: 'Sheet is empty' }, { status: 400 });

  const sheetHeaders = values[0].map((h) => String(h || '').trim()).filter(Boolean);
  const sectionHeaders: string[] = ((sec.schema as { headers?: string[] }).headers) || [];
  const overlap = sheetHeaders.filter((h) => sectionHeaders.includes(h));
  if (overlap.length === 0) {
    return NextResponse.json({
      error: `No matching columns. Sheet has: ${sheetHeaders.join(', ')}. Section expects: ${sectionHeaders.join(', ')}.`,
    }, { status: 400 });
  }

  const incoming = values.slice(1).map((row) => {
    const obj: Record<string, unknown> = {};
    sheetHeaders.forEach((h, i) => {
      if (!sectionHeaders.includes(h)) return;
      const v = row[i];
      if (v != null && v !== '') obj[h] = v;
    });
    return obj;
  }).filter((o) => Object.keys(o).length > 0);

  if (mode === 'replace') {
    await db.update(schema.rows)
      .set({ deleted: true, updatedAt: new Date() })
      .where(and(eq(schema.rows.userId, userId), eq(schema.rows.sectionId, sec.id)));
  }

  let inserted = 0;
  let updated = 0;
  if (mode === 'merge' && sheetHeaders.includes('id')) {
    // Per-row id-keyed upsert. Build a quick lookup of existing ids.
    const existing = await db.query.rows.findMany({
      where: and(
        eq(schema.rows.userId, userId),
        eq(schema.rows.sectionId, sec.id),
        eq(schema.rows.deleted, false),
      ),
    });
    const byId = new Map<string, string>();
    for (const r of existing) {
      const rid = (r.data as Record<string, unknown>).id;
      if (typeof rid === 'string') byId.set(rid, r.id);
    }
    for (const obj of incoming) {
      const rid = typeof obj.id === 'string' ? obj.id : null;
      const existingId = rid ? byId.get(rid) : null;
      if (existingId) {
        await db.update(schema.rows)
          .set({ data: obj, updatedAt: new Date() })
          .where(eq(schema.rows.id, existingId));
        updated++;
      } else {
        await db.insert(schema.rows).values({ userId, sectionId: sec.id, data: obj });
        inserted++;
      }
    }
  } else {
    for (const obj of incoming) {
      await db.insert(schema.rows).values({ userId, sectionId: sec.id, data: obj });
      inserted++;
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    inserted,
    updated,
    dropped: sheetHeaders.filter((h) => !sectionHeaders.includes(h)),
  });
}
