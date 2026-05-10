/**
 * Server-side Drive helpers. Every call resolves the user's
 * access token via getGoogleAccessToken — we never trust a token
 * passed in from the browser.
 */
import { getGoogleAccessToken } from './google';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MINERVA_FOLDER = 'Minerva offline';

async function authedJson(token: string, url: string, init?: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Drive ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

/** Find the "Minerva offline" folder under the user's drive.file
 * scope; create it on first use. Returns the folder's fileId. */
export async function ensureMinervaFolder(userId: string): Promise<string> {
  const token = await getGoogleAccessToken(userId);
  const q = `name='${MINERVA_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = new URL(`${DRIVE}/files`);
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('spaces', 'drive');
  const found = (await authedJson(token, url.toString())) as { files: { id: string }[] };
  if (found.files && found.files[0]) return found.files[0].id;
  const created = (await authedJson(token, `${DRIVE}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: MINERVA_FOLDER,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })) as { id: string };
  return created.id;
}

/** Upload a Blob / ArrayBuffer to the user's Drive in the Minerva
 * folder. Uses the resumable upload API so multi-GB videos don't
 * blow the request body size. */
export async function uploadToMinervaDrive(
  userId: string,
  bytes: ArrayBuffer,
  filename: string,
  mime: string,
): Promise<{ id: string }> {
  const token = await getGoogleAccessToken(userId);
  const parent = await ensureMinervaFolder(userId);
  const init = await fetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(bytes.byteLength),
    },
    body: JSON.stringify({ name: filename, parents: [parent] }),
  });
  if (!init.ok) {
    const txt = await init.text().catch(() => '');
    throw new Error(`Drive resumable init ${init.status}: ${txt.slice(0, 200)}`);
  }
  const session = init.headers.get('Location');
  if (!session) throw new Error('Drive resumable init returned no session URL.');
  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
  if (!put.ok) {
    const txt = await put.text().catch(() => '');
    throw new Error(`Drive upload PUT ${put.status}: ${txt.slice(0, 200)}`);
  }
  return (await put.json()) as { id: string };
}
