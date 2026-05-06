/* Minerva — sync engine.
 *
 * Pulls the user's spreadsheet into the local IndexedDB store. Phase 2 only
 * implements pull (read-only mirror). Phase 3 will add push (CRUD writes
 * mark rows dirty, sync flushes them back to Sheets).
 *
 * Pull strategy: read full tab values, replace local rows for that tab.
 * Phase 3 will refine this to merge rather than replace, so locally-dirty
 * rows survive a remote pull.
 *
 * The list of tabs to sync starts from the seeded set. Once `_config` is
 * present locally, subsequent syncs add any extra tabs declared there.
 */
(function () {
  'use strict';

  var SEED_TABS = ['_config', '_prefs', '_log', 'goals', 'tasks', 'projects', 'notes', 'habits', 'habit_log'];

  // Identify which column should serve as a row's stable id, given the
  // tab's headers. Falls back to a synthesized id from row index.
  function pickIdField(headers) {
    if (headers.indexOf('id') >= 0) return 'id';
    if (headers.indexOf('slug') >= 0) return 'slug';   // _config
    if (headers.indexOf('key') >= 0) return 'key';     // _prefs
    return null;                                         // _log etc. — synthesize
  }

  // Best-effort seed from the Postgres mirror when the local IDB has
  // nothing for a tab yet. Lets a fresh device with the helper running
  // show data instantly while a Sheets pull races in the background;
  // also covers the "Sheets is down / not signed in" edge so the user
  // is never left looking at an empty section if PG has the rows.
  async function maybeSeedFromPg(tab) {
    if (!Minerva.pg || typeof Minerva.pg.isLive !== 'function' || !Minerva.pg.isLive()) {
      return 0;
    }
    var existing = await Minerva.db.countTab(tab);
    if (existing > 0) return 0;
    try {
      var resp = await Minerva.pg.getRows(tab);
      var rows = (resp && resp.rows) || [];
      if (!rows.length) return 0;
      // Annotate with the internal markers IDB readers expect — the
      // /db/rows endpoint already injects id, _rowIndex, _deleted.
      var out = rows.map(function (r) {
        return Object.assign({ _dirty: 0, _localOnly: 0 }, r);
      });
      await Minerva.db.upsertRows(tab, out);
      return out.length;
    } catch (e) {
      console.warn('[Minerva pg-seed]', tab, (e && e.message) || e);
      return 0;
    }
  }

  async function pullTab(token, ssId, tab) {
    // Cheap read-through: if the user just cleared IDB or is on a
    // fresh device with the helper running, populate from PG before
    // we even hit Sheets. The Sheets pull below still wins as the
    // source of truth — this just prevents an empty render in the
    // meantime.
    try { await maybeSeedFromPg(tab); } catch (e) { /* non-fatal */ }
    var resp = await Minerva.sheets.getValues(token, ssId, tab + '!A:Z');
    var values = (resp && resp.values) || [];

    // Preserve any locally-dirty rows so the user's pending edits survive a pull.
    var localDirty = await Minerva.db.getDirtyRows(tab);
    var dirtyById = {};
    localDirty.forEach(function (r) { dirtyById[r.id] = r; });

    if (values.length === 0) {
      await Minerva.db.setMeta(tab, { headers: [], types: [], lastPulledAt: Date.now() });
      await Minerva.db.clearTab(tab);
      if (localDirty.length) await Minerva.db.upsertRows(tab, localDirty);
      return { tab: tab, count: localDirty.length };
    }

    var headers = values[0];
    var types = values[1] || [];
    var existingMeta = (await Minerva.db.getMeta(tab)) || {};
    await Minerva.db.setMeta(tab, {
      headers: headers,
      types: types,
      lastPulledAt: Date.now(),
      sheetId: existingMeta.sheetId  // preserved across pulls; set in pullAll
    });

    var idField = pickIdField(headers);

    var dataRows = values.slice(2);
    var serverRows = [];
    for (var i = 0; i < dataRows.length; i++) {
      var raw = dataRows[i] || [];
      var obj = { _rowIndex: i + 3, _dirty: 0, _deleted: 0, _localOnly: 0 };
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (raw[j] != null) ? raw[j] : '';
      }
      var id = idField ? obj[idField] : (tab + ':' + (i + 3));
      if (!id) continue;
      obj.id = id;
      // Self-heal long-standing _config corruption: a previous version of
      // upsertRow overwrote each row's `tab` column with the storage tab
      // name, then push wrote that bad value up to the user's sheet. So
      // many users now have rows in `_config` where the `tab` column
      // literally reads "_config" instead of the slug. If we see that
      // pattern, restore tab=slug and mark the row dirty so the next
      // push repairs the sheet permanently.
      if (tab === '_config' && obj.tab === '_config' && obj.slug && obj.slug !== '_config') {
        obj.tab = obj.slug;
        obj._dirty = 1;
      }
      if (dirtyById[id]) continue;   // skip; local dirty wins
      serverRows.push(obj);
    }

    await Minerva.db.clearTab(tab);
    if (serverRows.length) await Minerva.db.upsertRows(tab, serverRows);
    if (localDirty.length) await Minerva.db.upsertRows(tab, localDirty);

    return { tab: tab, count: serverRows.length + localDirty.length };
  }

  // After we've pulled `_config`, we know the user's full set of section tabs.
  async function tabsToSync() {
    var configRows = await Minerva.db.getAllRows('_config');
    var fromConfig = configRows
      .map(function (r) { return r.tab; })
      .filter(Boolean);
    var all = SEED_TABS.slice();
    for (var i = 0; i < fromConfig.length; i++) {
      if (all.indexOf(fromConfig[i]) < 0) all.push(fromConfig[i]);
    }
    return all;
  }

  // Cache the numeric sheetId of every tab in meta. deleteDimension needs it.
  async function refreshSheetIds(token, ssId) {
    var ss = await Minerva.sheets.getSpreadsheet(token, ssId);
    var sheets = (ss && ss.sheets) || [];
    for (var i = 0; i < sheets.length; i++) {
      var p = sheets[i].properties || {};
      await Minerva.db.setMeta(p.title, { sheetId: p.sheetId });
    }
  }

  // Pull `_config` first (so we know all section tabs), then pull everything.
  async function pullAll(token, ssId, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var results = [];

    try { await refreshSheetIds(token, ssId); } catch (e) { /* non-fatal */ }

    try {
      var meta = await pullTab(token, ssId, '_config');
      results.push(meta);
      onProgress({ stage: '_config', done: 1, total: 1 });
    } catch (e) {
      results.push({ tab: '_config', error: (e && e.message) || String(e) });
    }

    var tabs = await tabsToSync();
    var rest = tabs.filter(function (t) { return t !== '_config'; });

    for (var i = 0; i < rest.length; i++) {
      var t = rest[i];
      try {
        var r = await pullTab(token, ssId, t);
        results.push(r);
      } catch (e) {
        results.push({ tab: t, error: (e && e.message) || String(e) });
      }
      onProgress({ stage: t, done: i + 2, total: rest.length + 1 });
    }

    return results;
  }

  // ---- push -----------------------------------------------------------

  function rowToValues(row, headers) {
    return headers.map(function (h) {
      var v = row[h];
      if (v == null) return '';
      // booleans come from check editors as 'TRUE'/'FALSE' strings already
      return String(v);
    });
  }

  // The drawing editor writes the literal string 'pending' into a row's
  // drawing cell after save and before the upload completes. flushPending
  // normally replaces it with the Drive fileId. If the local drawing
  // record is gone before flushPending runs, the sentinel survives — and
  // we must not push 'pending' to Sheets as a real value.
  function hasPendingSketch(row) {
    if (!row) return false;
    for (var k in row) {
      if (!row.hasOwnProperty(k)) continue;
      if (k.charAt(0) === '_') continue;
      if (row[k] === 'pending') return true;
    }
    return false;
  }

  async function pushTab(token, ssId, tab) {
    var dirty = await Minerva.db.getDirtyRows(tab);
    if (!dirty.length) return { tab: tab, pushed: 0 };

    var meta = await Minerva.db.getMeta(tab);
    var headers = (meta && meta.headers) || [];
    var sheetId = meta && meta.sheetId;
    var anyDelete = false;

    // Track rows that successfully reached Sheets so we can mirror them to
    // the Postgres adapter after the Sheets batch is done. Mirror failures
    // are non-fatal: PG is optional; Sheets remains the source of truth.
    var pgUpsertRows = [];
    var pgDeleteIds = [];

    // Group dirty rows by operation so deletes can be sorted before
    // execution. Multi-row deletes that hit Sheets one-by-one in the
    // original (ascending) order corrupt the sheet because each
    // deleteDimension shifts the rows below it up by one — the next
    // _rowIndex was captured before that shift, so the second delete
    // hits the wrong row. Run deletes from the bottom up, in a single
    // batchUpdate, so every index in the request is still valid when
    // the server applies it (server processes in array order, top to
    // bottom; descending start indices stay correct because nothing
    // below the current target moves).
    var deletes = [];
    var upserts = [];
    for (var di = 0; di < dirty.length; di++) {
      var dr = dirty[di];
      if (dr._deleted) deletes.push(dr); else upserts.push(dr);
    }
    deletes.sort(function (a, b) { return (b._rowIndex || 0) - (a._rowIndex || 0); });

    // First: drop any deletes that never made it to the sheet
    // (purely local rows). They're the cheap case — no API call.
    var sheetDeletes = [];
    for (var ddi = 0; ddi < deletes.length; ddi++) {
      var ddrow = deletes[ddi];
      if (ddrow._localOnly || !ddrow._rowIndex) {
        await Minerva.db.deleteRow(tab, ddrow.id);
        if (ddrow.id) pgDeleteIds.push(ddrow.id);
      } else if (sheetId != null) {
        sheetDeletes.push(ddrow);
      }
    }
    if (sheetDeletes.length && sheetId != null) {
      var requests = sheetDeletes.map(function (r) {
        return {
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: r._rowIndex - 1,
              endIndex: r._rowIndex
            }
          }
        };
      });
      await Minerva.sheets.batchUpdate(token, ssId, requests);
      for (var sdi = 0; sdi < sheetDeletes.length; sdi++) {
        await Minerva.db.deleteRow(tab, sheetDeletes[sdi].id);
        if (sheetDeletes[sdi].id) pgDeleteIds.push(sheetDeletes[sdi].id);
      }
      anyDelete = true;
    }

    // Now run the upserts (creates + edits). Deletes already done.
    for (var ui = 0; ui < upserts.length; ui++) {
      var row = upserts[ui];

      // Flush any pending drawings for this row first — the multipart upload
      // produces fileIds that need to land in row cells before we PUT the
      // row's values to Sheets. If a drawing's upload fails, leave the row
      // dirty and skip it for now; the next push retries.
      if (Minerva.draw && Minerva.draw.flushPending) {
        try {
          await Minerva.draw.flushPending(tab, row.id, token);
          // Re-read the row in case flushPending wrote a fileId into a cell.
          var refreshed = await Minerva.db.getRow(tab, row.id);
          if (refreshed) row = refreshed;
        } catch (e) {
          console.warn('[Minerva draw] flushPending', tab, row.id, (e && e.message) || e);
          continue;
        }
      }

      // Guard against the 'pending' sentinel landing in the spreadsheet.
      // If a drawing record was wiped locally (cleared cache, restored on
      // a different device) the cell still reads 'pending' but flushPending
      // had nothing to upload. Skip the row rather than committing the bad
      // sentinel — user can re-edit the sketch to recover.
      if (hasPendingSketch(row)) {
        console.warn('[Minerva draw] row carries pending sentinel with no local drawing; skipping push', tab, row.id);
        continue;
      }

      if (row._localOnly) {
        var values = rowToValues(row, headers);
        var resp = await Minerva.sheets.appendValues(token, ssId, tab + '!A:Z', [values]);
        var range = (resp.updates || {}).updatedRange || '';
        var m = range.match(/![A-Z]+(\d+)/);
        var rowIndex = m ? parseInt(m[1], 10) : null;
        row._localOnly = 0;
        row._dirty = 0;
        if (rowIndex) row._rowIndex = rowIndex;
        await Minerva.db.upsertRow(tab, row);
        pgUpsertRows.push(row);
        continue;
      }

      if (row._rowIndex) {
        var values2 = rowToValues(row, headers);
        await Minerva.sheets.updateValues(token, ssId, tab + '!A' + row._rowIndex, [values2]);
        row._dirty = 0;
        await Minerva.db.upsertRow(tab, row);
        pgUpsertRows.push(row);
      }
    }

    if (Minerva.pg && (pgUpsertRows.length || pgDeleteIds.length)) {
      try {
        if (pgUpsertRows.length) await Minerva.pg.upsertRows(tab, pgUpsertRows);
        if (pgDeleteIds.length) await Minerva.pg.deleteRows(tab, pgDeleteIds);
      } catch (e) {
        console.warn('[Minerva pg-mirror]', tab, (e && e.message) || e);
      }
    }

    // After a delete, all rows below shift up by one in the sheet — re-pull so
    // local _rowIndex values match again.
    if (anyDelete) {
      try { await pullTab(token, ssId, tab); } catch (e) { /* non-fatal */ }
    }

    return { tab: tab, pushed: dirty.length };
  }

  async function pushAll(token, ssId) {
    var allMeta = await Minerva.db.getAllMeta();
    var results = [];
    for (var i = 0; i < allMeta.length; i++) {
      var t = allMeta[i].tab;
      // _log is append-only audit; never push it from the app. _config and
      // _prefs are user-facing meta and DO get pushed (in-app section adds
      // and preference toggles need to round-trip back to the spreadsheet).
      if (t === '_log') continue;
      try {
        var r = await pushTab(token, ssId, t);
        results.push(r);
      } catch (e) {
        results.push({ tab: t, error: (e && e.message) || String(e) });
      }
    }
    return results;
  }

  async function syncAll(token, ssId) {
    var pushResults = await pushAll(token, ssId);
    var pullResults = await pullAll(token, ssId);
    return { push: pushResults, pull: pullResults };
  }

  async function lastSync() {
    var all = await Minerva.db.getAllMeta();
    var latest = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].lastPulledAt && all[i].lastPulledAt > latest) {
        latest = all[i].lastPulledAt;
      }
    }
    return latest || null;
  }

  async function stats() {
    var meta = await Minerva.db.getAllMeta();
    var out = [];
    for (var i = 0; i < meta.length; i++) {
      var t = meta[i].tab;
      var n = await Minerva.db.countTab(t);
      out.push({ tab: t, count: n, lastPulledAt: meta[i].lastPulledAt || null });
    }
    out.sort(function (a, b) { return a.tab.localeCompare(b.tab); });
    return out;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.sync = {
    pullTab: pullTab,
    pullAll: pullAll,
    pushTab: pushTab,
    pushAll: pushAll,
    syncAll: syncAll,
    lastSync: lastSync,
    stats: stats,
    maybeSeedFromPg: maybeSeedFromPg
  };
})();
