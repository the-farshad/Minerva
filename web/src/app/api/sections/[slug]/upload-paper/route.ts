/**
 * Upload a PDF and create a Papers row in one round-trip.
 *
 *   POST /api/sections/<slug>/upload-paper   (multipart: file)
 *
 * Flow:
 *   1. Stream the PDF bytes to the user's Drive in `papers/`.
 *   2. Pull whatever metadata is embedded in the PDF header
 *      (Title / Author / CreationDate). PDF metadata is plain ASCII
 *      in the first few KB so a tiny regex is enough — no extra
 *      dependency.
 *   3. Insert a row with the extracted title (falling back to the
 *      filename), authors, year, and offline=drive:<fileId>.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { uploadToMinervaDrive, DRIVE_SUBFOLDERS } from '@/lib/drive';

function decodePdfString(raw: string): string {
  // PDF strings can be `(literal)` or `<hex>`. Cover both, decode
  // backslash escapes in literals.
  if (raw.startsWith('<') && raw.endsWith('>')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    let s = '';
    for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return s.replace(/^﻿/, '');
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    return raw.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  }
  return raw;
}

function extractPdfMeta(buf: Uint8Array): { title?: string; authors?: string; year?: string; doi?: string } {
  // Scan a wider 256 KB window now that we're hunting for a DOI
  // in the page text in addition to the Info dictionary at the
  // start. DOIs typically appear on page 1 (header / footer /
  // citation block) which is comfortably inside that window for
  // an academic paper.
  const slice = buf.slice(0, Math.min(buf.length, 256 * 1024));
  const text = new TextDecoder('latin1').decode(slice);
  const out: { title?: string; authors?: string; year?: string; doi?: string } = {};
  const matchField = (key: string): string | null => {
    const re = new RegExp(`/${key}\\s*(\\(([^)]*)\\)|<([0-9A-Fa-f\\s]+)>)`);
    const m = text.match(re);
    if (!m) return null;
    return decodePdfString(m[1]).trim();
  };
  const title = matchField('Title');
  const author = matchField('Author');
  const created = matchField('CreationDate');
  if (title) out.title = title;
  if (author) out.authors = author;
  if (created) {
    const ym = created.match(/D:?(\d{4})/);
    if (ym) out.year = ym[1];
  }
  // DOI: try the PDF's metadata first ( /doi (…) is a common
  // non-standard Info entry), then fall back to a content scan.
  // The content regex is intentionally conservative — DOIs use a
  // restricted character set so we strip trailing punctuation
  // that the surrounding sentence usually drags along.
  const metaDoi = matchField('doi');
  if (metaDoi) {
    out.doi = metaDoi.replace(/^doi:\s*/i, '').trim();
  } else {
    const m = text.match(/\b(?:doi[:\s]*)?(10\.\d{4,9}\/[^\s<>"'(){}[\]]+)/i);
    if (m) {
      out.doi = m[1].replace(/[.,;:)\]]+$/, '').trim();
    }
  }
  return out;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as { id: string }).id;
    const { slug } = await ctx.params;

    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    const name = (file as File).name?.replace(/\.pdf$/i, '').replace(/[_\-]+/g, ' ').trim() || 'paper';

    const ab = await file.arrayBuffer();
    const meta = extractPdfMeta(new Uint8Array(ab));

    const up = await uploadToMinervaDrive(
      userId, ab,
      (meta.title || name).replace(/[^\w.\- ]+/g, '_').slice(0, 100) + '.pdf',
      'application/pdf',
      DRIVE_SUBFOLDERS.paper,
    );

    const allowed = new Set(((sec.schema as { headers?: string[] }).headers) || []);
    const data: Record<string, unknown> = {};
    const set = (k: string, v: string | undefined) => {
      if (v && allowed.has(k)) data[k] = v;
    };
    set('title', meta.title || name);
    set('authors', meta.authors);
    set('year', meta.year);
    set('doi', meta.doi);
    if (allowed.has('offline')) data.offline = `drive:${up.id}`;
    if (allowed.has('url')) data.url = `https://drive.google.com/file/d/${up.id}/view`;

    const [row] = await db.insert(schema.rows).values({
      userId, sectionId: sec.id, data,
    }).returning();

    return NextResponse.json({
      id: row.id,
      data: row.data,
      updatedAt: row.updatedAt.toISOString(),
      fileId: up.id,
      extracted: meta,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
