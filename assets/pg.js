/* Minerva — Postgres mirror adapter.
 *
 * The browser never talks to Postgres directly; minerva-services exposes
 * a tiny CRUD surface (/db/*) that fronts the database. This module is a
 * thin fetch wrapper plus a probe-and-cache for /db/health, so the rest
 * of the app can ask "is PG live?" without hitting the network on every
 * write.
 *
 * The base URL is reused from the existing yt-dlp server pref — the
 * services container hosts both endpoints, so wiring one URL configures
 * both. Empty / unset → mirror is off and every method becomes a no-op.
 */
(function () {
  'use strict';

  var STORE = 'minerva.config.v1';
  var PROBE_TTL_MS = 30 * 1000;

  var probeAt = 0;
  var probeOk = false;
  var probeConfigured = false;
  var probeInflight = null;

  function readBaseUrl() {
    try {
      var cfg = JSON.parse(localStorage.getItem(STORE)) || {};
      var raw = String(cfg.ytDlpServer || '').trim();
      if (!raw) return '';
      return raw.replace(/\/+$/, '');
    } catch (e) {
      return '';
    }
  }

  function configured() {
    return readBaseUrl() !== '';
  }

  async function probe(force) {
    var base = readBaseUrl();
    if (!base) {
      probeOk = false; probeConfigured = false; probeAt = Date.now();
      return { ok: false, configured: false };
    }
    if (!force && Date.now() - probeAt < PROBE_TTL_MS && probeAt !== 0) {
      return { ok: probeOk, configured: probeConfigured };
    }
    if (probeInflight) return probeInflight;
    probeInflight = (async function () {
      try {
        var resp = await fetch(base + '/db/health', { method: 'GET', cache: 'no-store' });
        if (!resp.ok) {
          probeOk = false; probeConfigured = false;
        } else {
          var json = await resp.json();
          probeOk = !!json.ok;
          probeConfigured = !!json.configured;
        }
      } catch (e) {
        probeOk = false; probeConfigured = false;
      }
      probeAt = Date.now();
      probeInflight = null;
      return { ok: probeOk, configured: probeConfigured };
    })();
    return probeInflight;
  }

  function cachedState() {
    return { ok: probeOk, configured: probeConfigured, at: probeAt };
  }

  // Best-effort: false when we know the mirror isn't reachable, true
  // when the last probe succeeded. Callers should treat this as a hint,
  // not a guarantee — the actual fetch may still fail and is allowed to.
  function isLive() {
    return probeOk && configured();
  }

  async function upsertRows(tab, rows) {
    if (!rows || !rows.length) return { ok: true, count: 0, skipped: true };
    if (!isLive()) return { ok: false, skipped: true };
    var base = readBaseUrl();
    var resp = await fetch(base + '/db/upsert/' + encodeURIComponent(tab), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: rows })
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('PG upsert ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async function deleteRows(tab, ids, opts) {
    opts = opts || {};
    if (!ids || !ids.length) return { ok: true, count: 0, skipped: true };
    if (!isLive()) return { ok: false, skipped: true };
    var base = readBaseUrl();
    var resp = await fetch(base + '/db/delete/' + encodeURIComponent(tab), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids, hard: !!opts.hard })
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('PG delete ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async function getRows(tab, since) {
    if (!isLive()) return null;
    var base = readBaseUrl();
    var url = base + '/db/rows/' + encodeURIComponent(tab);
    if (since) url += '?since=' + encodeURIComponent(since);
    var resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('PG rows ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async function stats() {
    if (!isLive()) return null;
    var base = readBaseUrl();
    var resp = await fetch(base + '/db/stats', { cache: 'no-store' });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('PG stats ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async function dump() {
    if (!isLive()) throw new Error('Postgres mirror is not reachable.');
    var base = readBaseUrl();
    var resp = await fetch(base + '/db/dump', { cache: 'no-store' });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('pg_dump ' + resp.status + ': ' + body);
    }
    return resp.blob();
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.pg = {
    configured: configured,
    probe: probe,
    cachedState: cachedState,
    isLive: isLive,
    upsertRows: upsertRows,
    deleteRows: deleteRows,
    getRows: getRows,
    stats: stats,
    dump: dump
  };
})();
