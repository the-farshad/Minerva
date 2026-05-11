/**
 * Server-side Drive helpers. Every call resolves the user's
 * access token via getGoogleAccessToken — we never trust a token
 * passed in from the browser.
 */
import { getGoogleAccessToken } from './google';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MINERVA_FOLDER = 'Minerva offline';

/** Subfolder names under "Minerva offline" so videos and papers
 * don't share a flat namespace. The save-offline route picks
 * which one based on the row kind. */
export const DRIVE_SUBFOLDERS = {
  video: 'videos',
  paper: 'papers',
  misc:  'misc',
} as const;

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
  return ensureFolder(userId, MINERVA_FOLDER, null);
}

/** Find / create a named folder under an optional parent. Returns
 * the folder's fileId. Used to nest `videos/` and `papers/` under
 * the top-level Minerva folder. */
export async function ensureFolder(
  userId: string,
  name: string,
  parentId: string | null,
): Promise<string> {
  const token = await getGoogleAccessToken(userId);
  const parts = [
    `name='${name.replace(/'/g, "\\'")}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ];
  if (parentId) parts.push(`'${parentId}' in parents`);
  const url = new URL(`${DRIVE}/files`);
  url.searchParams.set('q', parts.join(' and '));
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('spaces', 'drive');
  const found = (await authedJson(token, url.toString())) as { files: { id: string }[] };
  if (found.files && found.files[0]) return found.files[0].id;
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];
  const created = (await authedJson(token, `${DRIVE}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })) as { id: string };
  return created.id;
}

/** Upload a Blob / ArrayBuffer to the user's Drive. If `subfolder`
 * is given, the bytes land in `Minerva offline/<subfolder>/`; null
 * keeps them in the top-level Minerva folder. Uses the resumable
 * upload API so multi-GB videos don't blow the request body size. */
export async function uploadToMinervaDrive(
  userId: string,
  bytes: ArrayBuffer,
  filename: string,
  mime: string,
  subfolder: string | null = null,
): Promise<{ id: string }> {
  const token = await getGoogleAccessToken(userId);
  const root = await ensureMinervaFolder(userId);
  const parent = subfolder ? await ensureFolder(userId, subfolder, root) : root;
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
