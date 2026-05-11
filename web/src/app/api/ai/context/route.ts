/**
 * Build a compact textual snapshot of the signed-in user's rows so
 * the client-side AI module can attach it to a system prompt. Lives
 * server-side because the rows live in Postgres — the client doesn't
 * have a copy. The output is throttled to a few hundred rows per
 * section to keep tokens cheap.
 *
 *   GET /api/ai/context?notes=1
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';

const SKIP_COLS = new Set(['offline', 'notes', '_updated', '_rowIndex']);

function rowToText(headers: string[], data: Record<string, unknown>): string {
  return headers
    .filter((h) => h && h.charAt(0) !== '_' && !SKIP_COLS.has(h))
    .map((h) => {
      const v = data[h];
      if (v == null || v === '') return '';
      return `${h}: ${String(v).replace(/\s+/g, ' ').slice(0, 240)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const includeNotes = req.nextUrl.searchParams.get('notes') === '1';

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
  });

  const parts: string[] = [];
  for (const s of sections) {
    const slug = (s.slug || '').toLowerCase();
    const isNotes = slug.includes('note');
    if (isNotes && !includeNotes) continue;
    const rows = await db.query.rows.findMany({
      where: and(
        eq(schema.rows.userId, userId),
        eq(schema.rows.sectionId, s.id),
        eq(schema.rows.deleted, false),
      ),
      orderBy: [desc(schema.rows.updatedAt)],
      limit: isNotes ? 40 : 80,
    });
    if (!rows.length) continue;
    const schemaCols = ((s.schema as { headers?: string[] } | null)?.headers) || [];
    parts.push(`### ${s.title} (${rows.length})`);
    for (const r of rows) {
      const line = rowToText(schemaCols, r.data as Record<string, unknown>);
      if (line) parts.push(line);
    }
  }

  return NextResponse.json({ text: parts.join('\n') });
}
