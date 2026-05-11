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
