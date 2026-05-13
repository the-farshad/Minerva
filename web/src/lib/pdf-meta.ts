/**
 * Server-side PDF metadata extraction. Pulls Title / Author /
 * CreationDate from the PDF's Info dictionary plus a DOI from
 * either the Info entry or the page text. Shared between the
 * paper-upload route (first-write) and the refresh-metadata
 * route (backfill for papers added before DOI extraction landed).
 *
 * Pure parsing — no Drive / network access here. Caller passes a
 * Uint8Array of the PDF bytes (full or truncated to the first
 * ~256 KB; the DOI is almost always on page 1).
 */

function decodePdfString(raw: string): string {
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

export type PdfMeta = { title?: string; authors?: string; year?: string; doi?: string; pages?: number };

export function extractPdfMeta(buf: Uint8Array): PdfMeta {
  const slice = buf.slice(0, Math.min(buf.length, 256 * 1024));
  const text = new TextDecoder('latin1').decode(slice);
  const out: PdfMeta = {};
  // Page count: `/Type /Pages ... /Count N` is the authoritative
  // value in the catalog. The catalog usually sits near the END of
  // the file, so scan both the leading slice and a trailing slice.
  // Fallback: count `/Type /Page ` (singular Page only) — works on
  // small PDFs and on linearised PDFs where /Pages is near the top.
  const trailerSlice = buf.length > 64 * 1024 ? new TextDecoder('latin1').decode(buf.slice(buf.length - 64 * 1024)) : '';
  const countRe = /\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/;
  const cm = trailerSlice.match(countRe) || text.match(countRe);
  if (cm) {
    const n = Number(cm[1]);
    if (Number.isFinite(n) && n > 0 && n < 100_000) out.pages = n;
  } else {
    const matches = text.match(/\/Type\s*\/Page\b(?!s)/g);
    if (matches && matches.length > 0 && matches.length < 100_000) out.pages = matches.length;
  }
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
  const metaDoi = matchField('doi');
  if (metaDoi) {
    out.doi = metaDoi.replace(/^doi:\s*/i, '').trim();
  } else {
    const m = text.match(/\b(?:doi[:\s]*)?(10\.\d{4,9}\/[^\s<>"'(){}[\]]+)/i);
    if (m) out.doi = m[1].replace(/[.,;:)\]]+$/, '').trim();
  }
  return out;
}
