/**
 * Read an NDJSON streaming response and return the final
 * `{type:'done', …}` payload, throwing on the first `{type:'error'}`
 * line. Heartbeats are discarded. Optional `onProgress` callback
 * receives every non-final line (heartbeat, progress, …) so callers
 * that want to surface "still downloading…" UI can.
 *
 * If the response body isn't NDJSON at all — typical case is a
 * Cloudflare edge-timeout HTML page sneaking in front of us — we
 * detect the leading `<!DOCTYPE` / `<html` and surface a friendly
 * timeout message instead of letting the JSON parser blow up on
 * `<`.
 */
export async function readNdjsonResult<T extends Record<string, unknown> = Record<string, unknown>>(
  resp: Response,
  onProgress?: (msg: Record<string, unknown>) => void,
): Promise<T> {
  const ct = resp.headers.get('Content-Type') || '';
  if (!resp.body || !/ndjson|json|text/i.test(ct)) {
    const txt = await resp.text().catch(() => '');
    if (/<!doctype html|<html/i.test(txt)) {
      throw new Error(
        `Edge timeout (${resp.status}). The download is probably still finishing on the server — wait ~1 min and retry; if a Drive copy landed, the row's offline badge will switch over automatically.`,
      );
    }
    throw new Error(txt.trim().slice(0, 400) || `HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let final: Record<string, unknown> | null = null;
  let firstChunkInspected = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    if (!firstChunkInspected) {
      firstChunkInspected = true;
      if (/^\s*<(?:!doctype|html)/i.test(chunk)) {
        throw new Error(
          `Edge timeout (${resp.status}). The download is probably still finishing on the server — wait ~1 min and retry; if a Drive copy landed, the row's offline badge will switch over automatically.`,
        );
      }
    }
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); }
      catch { continue; }
      if (obj.type === 'done' || obj.type === 'error') {
        final = obj;
      } else if (onProgress) {
        onProgress(obj);
      }
    }
  }
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer);
      if (obj.type === 'done' || obj.type === 'error') final = obj;
    } catch { /* incomplete tail — drop */ }
  }
  if (!final) {
    throw new Error('Stream ended without a final result.');
  }
  if (final.type === 'error') {
    throw new Error(String(final.error || 'save-offline failed'));
  }
  return final as T;
}
