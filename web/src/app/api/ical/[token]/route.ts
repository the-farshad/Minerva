/**
 * iCalendar feed of dated rows. Subscribed by URL — no session
 * cookie sent — so the token in the path is the only credential.
 *
 *   GET /api/ical/<token>.ics
 *
 * Each row with a `due` / `deadline` / `date` column produces a
 * VEVENT. All-day where the value is a bare yyyy-mm-dd; otherwise
 * timed using the literal datetime from the data.
 */
import { NextRequest } from 'next/server';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '@/db';
import { userIdFromFeedToken } from '@/lib/feed-token';

const DATE_KEYS = ['due', 'deadline', 'date', 'when', 'start'];

function escapeText(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function pad2(n: number) { return String(n).padStart(2, '0'); }
function fmtDate(d: Date) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

function pickDate(data: Record<string, unknown>): { value: string; allDay: boolean } | null {
  for (const k of DATE_KEYS) {
    const v = data[k];
    if (!v) continue;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, allDay: true };
    const d = new Date(s);
    if (!isNaN(d.getTime())) return { value: fmtDate(d), allDay: false };
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const raw = token.replace(/\.ics$/, '');
  const userId = await userIdFromFeedToken(raw);
  if (!userId) return new Response('Forbidden', { status: 403 });

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
  });
  const rows = await db.query.rows.findMany({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)),
    orderBy: [desc(schema.rows.updatedAt)],
  });
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const now = fmtDate(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Minerva//Feed//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Minerva',
  ];
  for (const r of rows) {
    const s = sectionById.get(r.sectionId);
    if (!s) continue;
    const data = r.data as Record<string, unknown>;
    const when = pickDate(data);
    if (!when) continue;
    const title = String(data.title || data.name || `${s.title} item`);
    const desc = String(data.notes || data.body || data.summary || '').slice(0, 1000);
    const uid = `${r.id}@minerva.thefarshad.com`;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${now}`);
    if (when.allDay) {
      const ymd = when.value.replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    } else {
      lines.push(`DTSTART:${when.value}`);
    }
    lines.push(`SUMMARY:${escapeText(`[${s.title}] ${title}`)}`);
    if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=120',
    },
  });
}
