/**
 * Quick-share payload codec. Travels in the URL fragment so the
 * server never sees it — anyone with the link sees the same card
 * the author saw. base64url over UTF-8 JSON, same shape as v1.
 *
 * Soft limit: ~2 KB; browsers tolerate longer URLs but link shorteners
 * and chat clients often truncate them.
 */

export type SharePayload = {
  kind: 'note' | 'question' | 'poll';
  title?: string;
  body?: string;
  choices?: string[];
};

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '===='.slice(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeShare(payload: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return b64urlFromBytes(bytes);
}
export function decodeShare(token: string): SharePayload {
  const bytes = bytesFromB64url(token);
  return JSON.parse(new TextDecoder().decode(bytes)) as SharePayload;
}

export function shareUrl(payload: SharePayload): string {
  if (typeof window === 'undefined') return '';
  return `${location.origin}/p#${encodeShare(payload)}`;
}

/* --- Optional access-code (encrypted) share ------------------------
 * A code-protected share encrypts the payload with AES-GCM under a
 * key derived from the code (PBKDF2). The code never leaves the
 * sharer's / viewer's browser and the server still never sees the
 * payload — same zero-backend model as the plain share, just with
 * the bytes scrambled. Encrypted tokens carry an `enc1_` prefix so
 * the viewer knows to prompt for the code.
 */

const ENC_PREFIX = 'enc1_';
const PBKDF2_ITERATIONS = 150_000;

export function isEncryptedShare(token: string): boolean {
  return token.startsWith(ENC_PREFIX);
}

// `as BufferSource` on the crypto args: a Uint8Array IS a valid
// BufferSource at runtime, but TS's lib.dom now distinguishes
// Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike> (the
// latter is what `.slice()` and a plain `Uint8Array` param yield),
// and crypto.subtle rejects the looser type. The casts are inert.
async function deriveShareKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(code) as BufferSource, 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a payload under `code`. Token layout (after the prefix):
 *  base64url( salt[16] || iv[12] || ciphertext ). */
export async function encodeShareEncrypted(payload: SharePayload, code: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveShareKey(code, salt);
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource,
  ));
  const blob = new Uint8Array(salt.length + iv.length + ct.length);
  blob.set(salt, 0);
  blob.set(iv, salt.length);
  blob.set(ct, salt.length + iv.length);
  return ENC_PREFIX + b64urlFromBytes(blob);
}

/** Decrypt an `enc1_` token with `code`. Throws on a wrong code
 *  (AES-GCM auth-tag mismatch) or a malformed token. */
export async function decodeShareEncrypted(token: string, code: string): Promise<SharePayload> {
  const blob = bytesFromB64url(token.slice(ENC_PREFIX.length));
  if (blob.length < 28) throw new Error('truncated share');
  const salt = blob.slice(0, 16);
  const iv = blob.slice(16, 28);
  const ct = blob.slice(28);
  const key = await deriveShareKey(code, salt);
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(data)) as SharePayload;
}

/** Build a code-protected /p URL. Async because key derivation is. */
export async function shareUrlEncrypted(payload: SharePayload, code: string): Promise<string> {
  if (typeof window === 'undefined') return '';
  return `${location.origin}/p#${await encodeShareEncrypted(payload, code)}`;
}
