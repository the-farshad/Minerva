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

/** Sanitise an arbitrary string (user-entered category /
 *  playlist name) so it's safe to use as a Drive folder name.
 *  Drive doesn't allow `/` or `\` in display names without
 *  awkward escaping, and trims surrounding whitespace. We also
 *  collapse runs of weird chars so a name like "AI / ML 2024:
 *  notes" becomes "AI _ ML 2024_ notes" which still reads fine.
 *  Returns null for empty / whitespace-only input. */
export function sanitizeForDriveFolder(s: string): string | null {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || null;
}

/** For Papers preset rows, build the array of folder segments
 *  that uploadToMinervaDrive should land the file in. Currently:
 *    - `[papers]`            for rows with no category
 *    - `[papers, <category>]` for rows with one or more cats,
 *      using the first comma-separated tag (Option B from the
 *      design discussion: primary category folder, no shortcuts).
 *  Keeping the logic in one place so upload-paper and save-
 *  offline can't drift out of sync. */
export function paperFolderSegments(data: { category?: unknown }): string[] {
  const raw = String((data?.category as unknown) || '').trim();
  if (!raw) return [DRIVE_SUBFOLDERS.paper];
  const first = raw.split(',')[0].trim();
  const safe = sanitizeForDriveFolder(first);
  return safe ? [DRIVE_SUBFOLDERS.paper, safe] : [DRIVE_SUBFOLDERS.paper];
}

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

/** Delete a Drive file by id. Quiet — returns true on 200/204,
 * false on 404 (already gone) or any other error. Used when a row
 * with a `drive:<fileId>` offline marker is removed so the user's
 * Drive doesn't accumulate orphan blobs. */
export async function deleteDriveFile(userId: string, fileId: string): Promise<boolean> {
  try {
    const token = await getGoogleAccessToken(userId);
    const r = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
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
  /** Either a single sub-folder name (legacy: lands at
   *  `Minerva offline/<subfolder>/`) or an array of names that
   *  build a nested path top-down (`Minerva offline/<a>/<b>/<c>/`).
   *  Each segment is created on demand via ensureFolder; nulls /
   *  empties in the array are skipped silently. */
  subfolder: string | string[] | null = null,
): Promise<{ id: string }> {
  const token = await getGoogleAccessToken(userId);
  const root = await ensureMinervaFolder(userId);
  const segments = Array.isArray(subfolder)
    ? subfolder.map((s) => String(s || '').trim()).filter(Boolean)
    : subfolder ? [String(subfolder).trim()].filter(Boolean) : [];
  let parent = root;
  for (const seg of segments) {
    parent = await ensureFolder(userId, seg, parent);
  }
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

/** Overwrite an existing Drive file's bytes in place. Same fileId,
 * same name, same parents — just new media. Used by the annotation
 * round-trip so the SPA never accumulates orphan "v1, v2, v3" copies
 * of the same paper. */
export async function updateDriveFileMedia(
  userId: string,
  fileId: string,
  bytes: ArrayBuffer,
  mime: string,
): Promise<{ id: string }> {
  const token = await getGoogleAccessToken(userId);
  const r = await fetch(
    `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Drive media PATCH ${r.status}: ${txt.slice(0, 200)}`);
  }
  return (await r.json()) as { id: string };
}

/** Server-side copy of an existing Drive file (no bytes round-trip
 * through us). Used to snapshot the pristine PDF as `<title>.original.pdf`
 * the first time a user annotates, so the working copy can be reset
 * later without re-downloading anything. */
export async function copyDriveFile(
  userId: string,
  fileId: string,
  newName: string,
  parentId: string | null = null,
): Promise<{ id: string }> {
  const token = await getGoogleAccessToken(userId);
  const body: Record<string, unknown> = { name: newName };
  if (parentId) body.parents = [parentId];
  const r = await fetch(
    `${DRIVE}/files/${encodeURIComponent(fileId)}/copy?fields=id`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Drive copy ${r.status}: ${txt.slice(0, 200)}`);
  }
  return (await r.json()) as { id: string };
}

/** Stream a Drive file's bytes server-side. Returns the full
 * ArrayBuffer + mime — small for PDFs, ok to buffer. */
export async function fetchDriveFileBytes(
  userId: string,
  fileId: string,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const token = await getGoogleAccessToken(userId);
  const r = await fetch(
    `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Drive download ${r.status}: ${txt.slice(0, 200)}`);
  }
  return {
    bytes: await r.arrayBuffer(),
    mime: r.headers.get('Content-Type') || 'application/octet-stream',
  };
}
