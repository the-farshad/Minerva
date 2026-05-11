/**
 * One-shot export of a section's rows into a fresh Google Sheet on
 * the user's Drive. One-way only — edits in the sheet don't flow
 * back; we picked this scope explicitly to keep the merge logic
 * out of scope for v2's first release.
 *
 *   POST /api/sections/<slug>/export-sheet
 *     → { fileId, webViewLink }
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';
import { getGoogleAccessToken } from '@/lib/google';

export async function POST(
  _req: Request,
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

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.deleted, false),
    ),
    orderBy: [desc(schema.rows.updatedAt)],
  });

  const headers = ((sec.schema as { headers?: string[] }).headers) || [];
  const matrix: (string | number | boolean)[][] = [headers.slice()];
  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    matrix.push(headers.map((h) => {
      const v = data[h];
      if (v == null) return '';
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      return JSON.stringify(v);
    }));
  }

  const token = await getGoogleAccessToken(userId);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const title = `Minerva · ${sec.title} · ${stamp}`;

  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { title } }),
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    return NextResponse.json({ error: `Sheets create ${createRes.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const sheet = (await createRes.json()) as { spreadsheetId: string; spreadsheetUrl: string };

  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/Sheet1!A1:append?valueInputOption=RAW`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: matrix }),
    },
  );
  if (!writeRes.ok) {
    const t = await writeRes.text();
    return NextResponse.json({ error: `Sheets append ${writeRes.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }

  return NextResponse.json({
    fileId: sheet.spreadsheetId,
    webViewLink: sheet.spreadsheetUrl,
    rows: rows.length,
  });
}
