/**
 * Thin Sheets / Drive wrapper using the user's OAuth access token.
 * Server-side only.
 */
import { getGoogleAccessToken } from './google';

const SHEETS = 'https://sheets.googleapis.com/v4';
const DRIVE = 'https://www.googleapis.com/drive/v3';

async function authedFetch(token: string, url: string, init?: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Google API ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

export async function findSpreadsheetByName(userId: string, name: string) {
  const token = await getGoogleAccessToken(userId);
  const url = new URL(`${DRIVE}/files`);
  url.searchParams.set('q', `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  url.searchParams.set('fields', 'files(id,name,modifiedTime)');
  url.searchParams.set('spaces', 'drive');
  const j = (await authedFetch(token, url.toString())) as { files: { id: string; name: string }[] };
  return j.files?.[0] || null;
}

export async function getSpreadsheet(userId: string, spreadsheetId: string) {
  const token = await getGoogleAccessToken(userId);
  return authedFetch(token, `${SHEETS}/spreadsheets/${spreadsheetId}?includeGridData=false`) as Promise<{
    sheets: { properties: { title: string; sheetId: number } }[];
  }>;
}

export async function getValues(userId: string, spreadsheetId: string, range: string) {
  const token = await getGoogleAccessToken(userId);
  return authedFetch(token, `${SHEETS}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`) as Promise<{
    values?: string[][];
  }>;
}
