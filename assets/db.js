/* Minerva — local IndexedDB store.
 *
 * One database with two stores:
 *   rows  — keyed by [tab, id]; one row per row in the user's spreadsheet.
 *           Carries the data fields plus internal metadata: _rowIndex,
 *           _updated (string), _dirty (1|0 — for Phase 3 push), _deleted (1|0).
 *           Indexes: byTab, byTabUpdated, byTabDirty.
 *   meta  — keyed by tab; per-tab schema cache (headers, types) plus
 *           sync metadata (lastPulledAt, lastPushedAt).
 *
 * The store is intentionally generic — there is no table per section. Adding
 * a section in `_config` does not require an IndexedDB schema bump.
 */
(function () {
  'use strict';

  var DB_NAME = 'minerva';
  var DB_VERSION = 1;
  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('rows')) {
          var rows = db.createObjectStore('rows', { keyPath: ['tab', 'id'] });
          rows.createIndex('byTab', 'tab', { unique: false });
          rows.createIndex('byTabUpdated', ['tab', '_updated'], { unique: false });
          rows.createIndex('byTabDirty', ['tab', '_dirty'], { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'tab' });
        }
      };
      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () { _db.close(); _db = null; };
        resolve(_db);
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB upgrade blocked — close other Minerva tabs.')); };
    });
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
    var rec = Object.assign({}, row, { tab: tab });
    return reqP(tx(db, 'rows', 'readwrite').put(rec));
  }

  async function upsertRows(tab, rows) {
    if (!rows || !rows.length) return [];
    var db = await open();
    var store = tx(db, 'rows', 'readwrite');
    return Promise.all(rows.map(function (r) {
      return reqP(store.put(Object.assign({}, r, { tab: tab })));
    }));
  }

  async function getRow(tab, id) {
    var db = await open();
    return reqP(tx(db, 'rows').get([tab, id]));
  }

  async function getAllRows(tab) {
    var db = await open();
    var idx = tx(db, 'rows').index('byTab');
    return reqP(idx.getAll(IDBKeyRange.only(tab)));
  }

  async function countTab(tab) {
    var db = await open();
    var idx = tx(db, 'rows').index('byTab');
    return reqP(idx.count(IDBKeyRange.only(tab)));
  }

  async function deleteRow(tab, id) {
    var db = await open();
    return reqP(tx(db, 'rows', 'readwrite').delete([tab, id]));
  }

  async function clearTab(tab) {
    var db = await open();
    var store = tx(db, 'rows', 'readwrite');
    var idx = store.index('byTab');
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
    var idx = tx(db, 'rows').index('byTabDirty');
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

  // --- bulk ops -------------------------------------------------

  async function clearAll() {
    var db = await open();
    await Promise.all([
      reqP(db.transaction('rows', 'readwrite').objectStore('rows').clear()),
      reqP(db.transaction('meta', 'readwrite').objectStore('meta').clear())
    ]);
  }

  async function close() {
    if (_db) { _db.close(); _db = null; }
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
    ulid: ulid
  };
})();
