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

  async function pullTab(token, ssId, tab) {
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

    for (var i = 0; i < dirty.length; i++) {
      var row = dirty[i];

      // Flush any pending drawings for this row first — the multipart upload
      // produces fileIds that need to land in row cells before we PUT the
      // row's values to Sheets. If a drawing's upload fails, leave the row
      // dirty and skip it for now; the next push retries.
      if (!row._deleted && Minerva.draw && Minerva.draw.flushPending) {
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
      if (!row._deleted && hasPendingSketch(row)) {
        console.warn('[Minerva draw] row carries pending sentinel with no local drawing; skipping push', tab, row.id);
        continue;
      }

      if (row._deleted) {
        if (row._localOnly || !row._rowIndex) {
          // never reached the sheet — just drop it locally.
          await Minerva.db.deleteRow(tab, row.id);
        } else if (sheetId != null) {
          await Minerva.sheets.batchUpdate(token, ssId, [{
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: row._rowIndex - 1,
                endIndex: row._rowIndex
              }
            }
          }]);
          await Minerva.db.deleteRow(tab, row.id);
          anyDelete = true;
        }
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
        continue;
      }

      if (row._rowIndex) {
        var values2 = rowToValues(row, headers);
        await Minerva.sheets.updateValues(token, ssId, tab + '!A' + row._rowIndex, [values2]);
        row._dirty = 0;
        await Minerva.db.upsertRow(tab, row);
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
    stats: stats
  };
})();
