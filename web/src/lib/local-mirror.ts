/**
 * Local-disk file mirror via the File System Access API.
 * Chromium / Edge only — Firefox lacks `showDirectoryPicker`.
 *
 * Stores the user-picked DirectoryHandle in IndexedDB so the
 * picker only fires once per browser. Reads from / writes to
 * <handle>/videos/<playlist>/<name>.mp4 etc.
 */

const DB_NAME = 'minerva-v2-fs';
const STORE = 'kv';
const KEY = 'mirror.dir';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result as T | null);
    tx.onerror = () => reject(tx.error);
  });
}
async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface FileSystemDirectoryHandleX extends FileSystemDirectoryHandle {
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
}

export const localMirror = {
  supported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  },
  async handle(): Promise<FileSystemDirectoryHandleX | null> {
    if (!this.supported()) return null;
    try { return (await kvGet<FileSystemDirectoryHandleX>(KEY)) || null; }
    catch { return null; }
  },
  async pick(): Promise<FileSystemDirectoryHandleX | null> {
    if (!this.supported()) return null;
    const pickFn = (window as unknown as { showDirectoryPicker: (opts?: { mode: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandleX> }).showDirectoryPicker;
    const handle = await pickFn({ mode: 'readwrite' });
    await kvSet(KEY, handle);
    return handle;
  },
  async clear(): Promise<void> {
    await kvSet(KEY, null);
  },
  async ensurePermission(h: FileSystemDirectoryHandleX, mode: 'read' | 'readwrite' = 'readwrite'): Promise<boolean> {
    try {
      const q = await h.queryPermission?.({ mode });
      if (q === 'granted') return true;
      const r = await h.requestPermission?.({ mode });
      return r === 'granted';
    } catch { return false; }
  },
  /** Write bytes to <handle>/<kind>/<name>; `name` may contain
   * forward-slash separators which create intermediate directories. */
  async save(kind: string, name: string, bytes: Blob): Promise<string | null> {
    const h = await this.handle();
    if (!h) return null;
    if (!(await this.ensurePermission(h, 'readwrite'))) return null;
    try {
      let dir = await h.getDirectoryHandle(kind, { create: true });
      const parts = name.split('/').filter(Boolean);
      const leaf = parts.pop()!;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(leaf, { create: true });
      const w = await (fh as FileSystemFileHandle & { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
      // Cast to FileSystemWriteChunkType to satisfy TS — Blob is
      // one of the accepted shapes.
      await w.write(bytes as unknown as FileSystemWriteChunkType);
      await w.close();
      return `local:${kind}/${parts.length ? parts.join('/') + '/' : ''}${leaf}`;
    } catch { return null; }
  },
  async read(marker: string): Promise<File | null> {
    const rel = marker.replace(/^local:/, '');
    const h = await this.handle();
    if (!h) return null;
    if (!(await this.ensurePermission(h, 'read'))) return null;
    try {
      const parts = rel.split('/').filter(Boolean);
      if (!parts.length) return null;
      const leaf = parts.pop()!;
      let dir = h;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
      const fh = await dir.getFileHandle(leaf, { create: false });
      return await fh.getFile();
    } catch { return null; }
  },
};
