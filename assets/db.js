/* Minerva — local IndexedDB store.
 *
 * One database with three stores:
 *   rows     — keyed by [tab, id]; one row per row in the user's spreadsheet.
 *              Carries the data fields plus internal metadata: _rowIndex,
 *              _updated (string), _dirty (1|0 — for Phase 3 push), _deleted (1|0).
 *              Indexes: byTab, byTabUpdated, byTabDirty.
 *   meta     — keyed by tab; per-tab schema cache (headers, types) plus
 *              sync metadata (lastPulledAt, lastPushedAt).
 *   drawings — keyed by [tab, rowId, col]; pending sketch payloads
 *              ({ strokes, svg, _dirty, _updated, _fileId? }) waiting for
 *              upload to Drive. Added in v2 for the touch-canvas editor.
 *
 * The rows/meta stores are intentionally generic — adding a section in
 * `_config` does not require an IndexedDB schema bump.
 */
(function () {
  'use strict';

  var DB_NAME = 'minerva';
  var DB_VERSION = 3;
  var _db = null;
  var _opening = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    // Single-flight: many async ops fire `open()` in parallel on first
    // load. Without this, each would issue its own `indexedDB.open()` and
    // overwrite `onversionchange` last-wins. Returning the same Promise
    // lets every caller share one upgrade-aware handle.
    if (_opening) return _opening;
    _opening = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        var ux = req.transaction;

        // v3 fixes a long-standing data-corruption bug: the rows store
        // used keyPath ['tab','id'], so every upsert overwrote the row's
        // own `tab` field with the storage tab name. _config has a column
        // literally named `tab` — that user data was being clobbered on
        // every pull, breaking section navigation. v3 renames the
        // storage-internal field to `_t` so the user's column survives.

        // Fresh DB: create v3 stores directly.
        if (e.oldVersion < 1) {
          var rows = db.createObjectStore('rows', { keyPath: ['_t', 'id'] });
          rows.createIndex('by_t', '_t', { unique: false });
          rows.createIndex('by_t_updated', ['_t', '_updated'], { unique: false });
          rows.createIndex('by_t_dirty', ['_t', '_dirty'], { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'tab' });
        }
        if (!db.objectStoreNames.contains('drawings')) {
          db.createObjectStore('drawings', { keyPath: ['tab', 'rowId', 'col'] });
        }

        // Existing v1/v2 user: migrate the rows store. Read all rows,
        // delete the old store, recreate with new keyPath, write rows
        // back with _t = old tab field. The user's `tab` column value
        // is gone (it was being overwritten anyway), so for _config
        // rows specifically, fall back to slug as the recovered tab —
        // slug == tab in every bundled preset and in the bootstrap
        // seed, so this matches the user's intent. Next pull from
        // Sheets will repopulate the actual column value.
        if (e.oldVersion >= 1 && e.oldVersion < 3 && db.objectStoreNames.contains('rows')) {
          var oldStore = ux.objectStore('rows');
          var keyPath = oldStore.keyPath;
          // Already on the new keyPath? (e.g. someone bumped DB_VERSION
          // manually without touching schema.) Skip the migration.
          var alreadyMigrated = (Array.isArray(keyPath) && keyPath[0] === '_t');
          if (!alreadyMigrated) {
            var getReq = oldStore.getAll();
            getReq.onsuccess = function () {
              var allRows = getReq.result || [];
              db.deleteObjectStore('rows');
              var newStore = db.createObjectStore('rows', { keyPath: ['_t', 'id'] });
              newStore.createIndex('by_t', '_t', { unique: false });
              newStore.createIndex('by_t_updated', ['_t', '_updated'], { unique: false });
              newStore.createIndex('by_t_dirty', ['_t', '_dirty'], { unique: false });
              for (var i = 0; i < allRows.length; i++) {
                var row = allRows[i];
                var t = row.tab;
                delete row.tab;
                row._t = t;
                if (t === '_config' && row.slug) row.tab = row.slug;
                newStore.put(row);
              }
            };
          }
        }
      };
      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () {
          // Another tab is upgrading — drop our handle so the next op
          // re-opens against the new schema. In-flight transactions
          // complete before close() takes effect.
          try { _db.close(); } catch (e) { /* ignore */ }
          _db = null;
          _opening = null;
        };
        _opening = null;
        resolve(_db);
      };
      req.onerror = function () { _opening = null; reject(req.error); };
      req.onblocked = function () { _opening = null; reject(new Error('IndexedDB upgrade blocked — close other Minerva tabs.')); };
    });
    return _opening;
  }

  function tx(db, store, mode) {
    return db.transaction(store, mode || 'readonly').objectStore(store);
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  // --- rows -----------------------------------------------------

  async function upsertRow(tab, row) {
    var db = await open();
    var rec = Object.assign({}, row, { _t: tab });
    return reqP(tx(db, 'rows', 'readwrite').put(rec));
  }

  async function upsertRows(tab, rows) {
    if (!rows || !rows.length) return [];
    var db = await open();
    var store = tx(db, 'rows', 'readwrite');
    return Promise.all(rows.map(function (r) {
      return reqP(store.put(Object.assign({}, r, { _t: tab })));
    }));
  }

  async function getRow(tab, id) {
    var db = await open();
    return reqP(tx(db, 'rows').get([tab, id]));
  }

  async function getAllRows(tab) {
    var db = await open();
    var idx = tx(db, 'rows').index('by_t');
    return reqP(idx.getAll(IDBKeyRange.only(tab)));
  }

  async function countTab(tab) {
    var db = await open();
    var idx = tx(db, 'rows').index('by_t');
    return reqP(idx.count(IDBKeyRange.only(tab)));
  }

  async function deleteRow(tab, id) {
    var db = await open();
    return reqP(tx(db, 'rows', 'readwrite').delete([tab, id]));
  }

  async function clearTab(tab) {
    var db = await open();
    var store = tx(db, 'rows', 'readwrite');
    var idx = store.index('by_t');
    return new Promise(function (resolve, reject) {
      var c = idx.openCursor(IDBKeyRange.only(tab));
      c.onsuccess = function () {
        var cur = c.result;
        if (cur) { cur.delete(); cur.continue(); }
        else resolve();
      };
      c.onerror = function () { reject(c.error); };
    });
  }

  async function getDirtyRows(tab) {
    // _dirty stored as 1/0 so it can be indexed.
    var db = await open();
    var idx = tx(db, 'rows').index('by_t_dirty');
    return reqP(idx.getAll(IDBKeyRange.only([tab, 1])));
  }

  // --- meta -----------------------------------------------------

  async function getMeta(tab) {
    var db = await open();
    return reqP(tx(db, 'meta').get(tab));
  }

  async function setMeta(tab, patch) {
    var db = await open();
    var existing = (await reqP(tx(db, 'meta').get(tab))) || { tab: tab };
    var next = Object.assign({}, existing, patch, { tab: tab });
    return reqP(tx(db, 'meta', 'readwrite').put(next));
  }

  async function listTabs() {
    var db = await open();
    return reqP(tx(db, 'meta').getAllKeys());
  }

  async function getAllMeta() {
    var db = await open();
    return reqP(tx(db, 'meta').getAll());
  }

  // --- drawings -------------------------------------------------

  async function getDrawing(tab, rowId, col) {
    var db = await open();
    return reqP(tx(db, 'drawings').get([tab, rowId, col]));
  }

  async function putDrawing(tab, rowId, col, payload) {
    var db = await open();
    var rec = Object.assign({}, payload, { tab: tab, rowId: rowId, col: col });
    return reqP(tx(db, 'drawings', 'readwrite').put(rec));
  }

  async function deleteDrawing(tab, rowId, col) {
    var db = await open();
    return reqP(tx(db, 'drawings', 'readwrite').delete([tab, rowId, col]));
  }

  async function getDirtyDrawingsForRow(tab, rowId) {
    var db = await open();
    var store = tx(db, 'drawings');
    // Compound key range: every entry whose [tab,rowId,*] prefix matches.
    var range = IDBKeyRange.bound([tab, rowId, ''], [tab, rowId, '￿']);
    return new Promise(function (resolve, reject) {
      var out = [];
      var c = store.openCursor(range);
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) { resolve(out); return; }
        if (cur.value && cur.value._dirty) out.push(cur.value);
        cur.continue();
      };
      c.onerror = function () { reject(c.error); };
    });
  }

  // --- bulk ops -------------------------------------------------

  async function clearAll() {
    var db = await open();
    await Promise.all([
      reqP(db.transaction('rows', 'readwrite').objectStore('rows').clear()),
      reqP(db.transaction('meta', 'readwrite').objectStore('meta').clear()),
      reqP(db.transaction('drawings', 'readwrite').objectStore('drawings').clear())
    ]);
  }

  async function close() {
    if (_db) { _db.close(); _db = null; }
    _opening = null;
  }

  // Crockford base32 ULID — 10 chars timestamp (sortable) + 16 chars random.
  var ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function ulid() {
    var ts = Date.now();
    var t = '';
    for (var i = 0; i < 10; i++) {
      t = ULID_ALPHABET[ts % 32] + t;
      ts = Math.floor(ts / 32);
    }
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var r = '';
    for (var j = 0; j < 16; j++) r += ULID_ALPHABET[bytes[j] % 32];
    return t + r;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.db = {
    open: open,
    upsertRow: upsertRow,
    upsertRows: upsertRows,
    getRow: getRow,
    getAllRows: getAllRows,
    countTab: countTab,
    deleteRow: deleteRow,
    clearTab: clearTab,
    getDirtyRows: getDirtyRows,
    getMeta: getMeta,
    setMeta: setMeta,
    listTabs: listTabs,
    getAllMeta: getAllMeta,
    clearAll: clearAll,
    close: close,
    ulid: ulid,
    getDrawing: getDrawing,
    putDrawing: putDrawing,
    deleteDrawing: deleteDrawing,
    getDirtyDrawingsForRow: getDirtyDrawingsForRow
  };
})();
