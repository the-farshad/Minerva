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

  var SEED_TABS = ['_config', '_prefs', '_log', 'goals', 'tasks', 'projects', 'notes'];

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

    if (values.length === 0) {
      await Minerva.db.setMeta(tab, { headers: [], types: [], lastPulledAt: Date.now() });
      await Minerva.db.clearTab(tab);
      return { tab: tab, count: 0 };
    }

    var headers = values[0];
    var types = values[1] || [];
    await Minerva.db.setMeta(tab, {
      headers: headers,
      types: types,
      lastPulledAt: Date.now()
    });

    var idField = pickIdField(headers);

    var dataRows = values.slice(2);
    var rows = [];
    for (var i = 0; i < dataRows.length; i++) {
      var raw = dataRows[i] || [];
      var obj = { _rowIndex: i + 3, _dirty: 0, _deleted: 0 };
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (raw[j] != null) ? raw[j] : '';
      }
      var id = idField ? obj[idField] : (tab + ':' + (i + 3));
      if (!id) continue;             // blank row, skip
      obj.id = id;
      rows.push(obj);
    }

    // Phase 2 strategy: replace. Phase 3 will merge to preserve _dirty rows.
    await Minerva.db.clearTab(tab);
    await Minerva.db.upsertRows(tab, rows);

    return { tab: tab, count: rows.length };
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

  // Pull `_config` first (so we know all section tabs), then pull everything.
  async function pullAll(token, ssId, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var results = [];

    // Phase A — pull _config so we know all the section tabs the user has.
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
    lastSync: lastSync,
    stats: stats
  };
})();
