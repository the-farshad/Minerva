/* Minerva — first-connect spreadsheet bootstrap.
 *
 * Idempotent: finds the user's existing "Minerva" spreadsheet (drive.file
 * scope means we only see files this app created) or creates a new one,
 * then ensures the meta tabs (_config, _prefs, _log) and the four seed
 * section tabs (goals, tasks, projects, notes) exist with their header
 * row + type-hint row populated.
 *
 * The schema below matches Phase 2's expectations: row 1 = column names,
 * row 2 = type hints (text | longtext | markdown | date | datetime |
 * select(...) | check | number | progress(0..N) | ref(tab) | link |
 * multiselect(...) | ...). Row 3+ is data.
 */
(function () {
  'use strict';

  var SHEETS_TITLE = 'Minerva';

  var SCHEMA = {
    _config: {
      headers: ['slug','title','icon','tab','order','enabled','defaultSort','defaultFilter'],
      types:   ['text','text','text','text','number','check','text','text'],
      rows: [
        ['goals',    'Goals',    'target',          'goals',    1, 'TRUE', 'due',         ''],
        ['tasks',    'Tasks',    'check-square',    'tasks',    2, 'TRUE', 'due',         'status:!=done'],
        ['projects', 'Projects', 'folder',          'projects', 3, 'TRUE', 'name',        ''],
        ['notes',    'Notes',    'file-text',       'notes',    4, 'TRUE', 'created:desc',''],
        ['habits',   'Habits',   'zap',             'habits',   5, 'TRUE', 'name',        '']
      ]
    },
    _prefs: {
      headers: ['key','value'],
      types:   ['text','text'],
      rows: [
        ['theme',     'auto'],
        ['font',      'system'],
        ['weekStart', 'mon'],
        ['createdBy', 'minerva v0.1'],
        ['createdAt', new Date().toISOString()],
      ]
    },
    _log: {
      headers: ['ts','actor','action','section','rowId','summary'],
      types:   ['datetime','text','text','text','text','longtext'],
      rows: []
    },
    goals: {
      headers: ['id','name','progress','due','parent','notes','_updated'],
      types:   ['text','text','progress(0..100)','date','ref(goals)','markdown','datetime'],
      rows: []
    },
    tasks: {
      headers: ['id','title','status','priority','due','project','link','notes','_updated'],
      types:   ['text','text','select(todo,doing,done)','select(low,med,high)','date','ref(projects)','link','longtext','datetime'],
      rows: []
    },
    projects: {
      headers: ['id','name','status','start','end','goal','description','_updated'],
      types:   ['text','text','select(planning,active,done,paused)','date','date','ref(goals)','markdown','datetime'],
      rows: []
    },
    notes: {
      // Combined notes + sketches — every note row can carry a markdown
      // body and an optional hand-drawn sketch (drawing type → Drive
      // fileId or data: URL). The sketches preset is kept for back-compat
      // but new sections route both into notes.
      headers: ['id','title','body','sketch','tags','created','_updated'],
      types:   ['text','text','markdown','drawing','multiselect()','datetime','datetime'],
      rows: []
    },
    habits: {
      headers: ['id','name','color','target','last_done','_updated'],
      types:   ['text','text','color','number','date','datetime'],
      rows: []
    },
    habit_log: {
      headers: ['id','habit_id','date','count','_updated'],
      types:   ['text','ref(habits)','date','number','datetime'],
      rows: []
    }
  };

  // Ordered list — _config first so it's the leftmost tab in Sheets.
  var TAB_ORDER = ['_config','_prefs','_log','goals','tasks','projects','notes','habits','habit_log'];

  async function findOrCreate(token) {
    var found = await Minerva.sheets.findByName(token, SHEETS_TITLE);
    if (found && found.files && found.files.length > 0) {
      return { spreadsheetId: found.files[0].id, fresh: false };
    }
    var created = await Minerva.sheets.createSpreadsheet(token, SHEETS_TITLE, '_config');
    return { spreadsheetId: created.spreadsheetId, fresh: true };
  }

  async function ensureTabs(token, ssId) {
    var ss = await Minerva.sheets.getSpreadsheet(token, ssId);
    var existing = (ss.sheets || []).map(function (s) { return s.properties.title; });
    var toAdd = TAB_ORDER.filter(function (t) { return existing.indexOf(t) < 0; });
    if (toAdd.length === 0) return existing;
    var requests = toAdd.map(function (title) {
      return { addSheet: { properties: { title: title } } };
    });
    await Minerva.sheets.batchUpdate(token, ssId, requests);
    return existing.concat(toAdd);
  }

  async function isEmpty(token, ssId, tab) {
    try {
      var r = await Minerva.sheets.getValues(token, ssId, tab + '!A1:A2');
      return !r.values || r.values.length === 0 || (r.values.length === 1 && (!r.values[0] || !r.values[0][0]));
    } catch (e) {
      return true;
    }
  }

  async function seedTab(token, ssId, tab) {
    var def = SCHEMA[tab];
    if (!def) return;
    var values = [def.headers, def.types];
    if (def.rows && def.rows.length) values = values.concat(def.rows);
    await Minerva.sheets.updateValues(token, ssId, tab + '!A1', values);
  }

  async function bootstrap(token) {
    var fc = await findOrCreate(token);
    await ensureTabs(token, fc.spreadsheetId);
    // Only seed tabs that are still empty, so re-running bootstrap is safe.
    for (var i = 0; i < TAB_ORDER.length; i++) {
      var tab = TAB_ORDER[i];
      if (await isEmpty(token, fc.spreadsheetId, tab)) {
        await seedTab(token, fc.spreadsheetId, tab);
      }
    }
    return fc;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.bootstrap = bootstrap;

  // Build / version metadata. Surfaced in the home footer and Settings so
  // a user can verify which version they're actually running (PWA caches
  // can lag a deploy by a refresh). Keep `build` in sync with the
  // CACHE_VERSION in sw.js — bump both whenever you ship.
  window.Minerva.version = {
    semver: 'v0.22',
    build:  57,
    label:  'v0.22 · build 57'
  };
})();
