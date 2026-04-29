/* Minerva — Phase 0 router + views.
 * Routes:
 *   #/           — landing
 *   #/settings   — local config (BYO OAuth client + spreadsheet ID)
 *   #/share      — quick-share (note / question / poll → URL + QR)
 *   #/share/<t>  — quick-share seeded from token (after "edit a copy")
 *   #/p/<token>  — public viewer (decodes the hash payload, renders card)
 *
 * Phase 0 has no Google calls; auth + sheets land in Phase 1.
 */
(function () {
  'use strict';

  var M = window.Minerva || (window.Minerva = {});
  var STORE = 'minerva.config.v1';

  // ---- DOM helpers ----

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      appendKid(n, arguments[i]);
    }
    return n;
  }
  function appendKid(parent, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) { k.forEach(function (kk) { appendKid(parent, kk); }); return; }
    parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }

  // ---- config ----

  function readConfig() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; }
    catch (e) { return {}; }
  }
  function writeConfig(patch) {
    var cur = readConfig();
    var next = Object.assign({}, cur, patch);
    localStorage.setItem(STORE, JSON.stringify(next));
    return next;
  }

  // ---- theme + font picker ----

  function bindPicker() {
    $$('.seg').forEach(function (seg) {
      var ctrl = seg.dataset.control; // 'theme' | 'font'
      var key = 'minerva.' + ctrl;
      var fallback = ctrl === 'theme' ? 'auto' : 'system';
      var cur = localStorage.getItem(key) || fallback;
      syncSeg(seg, cur);
      seg.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-value]');
        if (!btn) return;
        var v = btn.dataset.value;
        localStorage.setItem(key, v);
        document.documentElement.setAttribute('data-' + ctrl, v);
        syncSeg(seg, v);
      });
    });
  }
  function syncSeg(seg, value) {
    $$('button', seg).forEach(function (b) {
      var on = b.dataset.value === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // ---- nav ----

  var navEl = $('#nav');
  var content = $('#content');

  function setBusy(b) { content.setAttribute('aria-busy', b ? 'true' : 'false'); }

  // _config cache — refreshed after every sync. Drives nav + home cards.
  var configCache = null;

  async function refreshConfig() {
    try {
      var rows = await M.db.getAllRows('_config');
      configCache = rows || [];
    } catch (e) {
      configCache = [];
    }
  }

  function isEnabled(r) {
    return r.enabled === 'TRUE' || r.enabled === true || r.enabled === 'true';
  }

  function sectionRows() {
    if (!configCache || !configCache.length) return [];
    return configCache.slice()
      .filter(isEnabled)
      .filter(function (r) { return r.slug && r.tab; })
      .sort(function (a, b) {
        return (Number(a.order) || 0) - (Number(b.order) || 0);
      });
  }

  function renderNav(active) {
    var items = [{ hash: '#/', label: 'Home' }];
    var cfg = readConfig();
    var hasSheet = !!cfg.spreadsheetId;
    if (hasSheet) {
      items.push({ hash: '#/today', label: '☀ Today' });
      sectionRows().forEach(function (r) {
        items.push({
          hash: '#/s/' + encodeURIComponent(r.slug),
          label: ((r.icon ? r.icon + ' ' : '') + (r.title || r.slug))
        });
      });
    }
    items.push({ hash: '#/share', label: 'Quick share' });
    items.push({ hash: '#/settings', label: 'Settings' });

    navEl.innerHTML = '';
    items.forEach(function (it) {
      navEl.appendChild(el('a', {
        href: it.hash,
        class: 'nav-link' + (it.hash === active ? ' active' : '')
      }, it.label));
    });
  }

  // ---- shared bits ----

  function flash(parent, msg, kind) {
    var f = el('div', { class: 'flash', role: 'status' }, msg);
    if (kind === 'error') f.style.color = 'var(--error)';
    parent.appendChild(f);
    setTimeout(function () { f.remove(); }, 3500);
  }

  function field(label, input, hint) {
    var id = 'f-' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return el('div', { class: 'field' },
      el('label', { for: id }, label),
      input,
      hint ? el('p', { class: 'hint' }, hint) : null
    );
  }

  function callout(title, body) {
    return el('div', { class: 'callout' },
      el('h3', null, title),
      el('p', null, body)
    );
  }

  function opt(value, label, current) {
    var o = el('option', { value: value }, label);
    if (value === current) o.setAttribute('selected', '');
    return o;
  }

  // ---- views ----

  // ---- dashboard stats ------------------------------------------------

  function aliveOf(rows) { return (rows || []).filter(function (r) { return !r._deleted; }); }
  function statusOf(r) { return String(r.status || '').toLowerCase(); }
  function dateOf(v) { return v ? String(v).slice(0, 10) : ''; }

  async function buildStats() {
    var today = todayStr();
    var stats = [];

    // Tasks
    try {
      var tasks = aliveOf(await M.db.getAllRows('tasks'));
      if (tasks.length) {
        var done = tasks.filter(function (r) { return statusOf(r) === 'done'; }).length;
        var dueToday = tasks.filter(function (r) {
          return r.due && dateOf(r.due) === today && statusOf(r) !== 'done';
        }).length;
        var overdue = tasks.filter(function (r) {
          return r.due && dateOf(r.due) < today && statusOf(r) !== 'done';
        }).length;
        var pct = tasks.length ? Math.round(100 * done / tasks.length) : 0;

        stats.push({ label: 'Tasks done',  value: done + ' / ' + tasks.length, pct: pct, href: '#/s/tasks' });
        stats.push({ label: 'Due today',   value: String(dueToday), accent: dueToday > 0, href: '#/s/tasks' });
        stats.push({ label: 'Overdue',     value: String(overdue),  danger: overdue > 0,  href: '#/s/tasks' });
      }
    } catch (e) { /* ignore */ }

    // Goals
    try {
      var goals = aliveOf(await M.db.getAllRows('goals'));
      if (goals.length) {
        var totalProgress = goals.reduce(function (s, r) { return s + (Number(r.progress) || 0); }, 0);
        var avg = goals.length ? Math.round(totalProgress / goals.length) : 0;
        stats.push({ label: 'Avg goal progress', value: avg + '%', pct: avg, href: '#/s/goals' });
      }
    } catch (e) { /* ignore */ }

    // Projects
    try {
      var projects = aliveOf(await M.db.getAllRows('projects'));
      var activeProjects = projects.filter(function (r) { return statusOf(r) === 'active'; }).length;
      if (projects.length) {
        stats.push({ label: 'Active projects', value: String(activeProjects) + ' / ' + projects.length, href: '#/s/projects' });
      }
    } catch (e) { /* ignore */ }

    // Notes
    try {
      var notes = aliveOf(await M.db.getAllRows('notes'));
      if (notes.length) {
        stats.push({ label: 'Notes', value: String(notes.length), href: '#/s/notes' });
      }
    } catch (e) { /* ignore */ }

    return stats;
  }

  function renderStatCard(s) {
    var children = [
      el('div', { class: 'stat-label' }, s.label),
      el('div', { class: 'stat-value' }, s.value)
    ];
    if (typeof s.pct === 'number') {
      var bar = el('div', { class: 'stat-bar' });
      var fill = el('div', { class: 'stat-bar-fill' });
      fill.style.width = Math.max(0, Math.min(100, s.pct)) + '%';
      bar.appendChild(fill);
      children.push(bar);
    }
    var cls = 'stat-card';
    if (s.danger) cls += ' stat-danger';
    else if (s.accent) cls += ' stat-accent';
    if (s.href) {
      var a = el('a', { class: cls, href: s.href });
      children.forEach(function (c) { a.appendChild(c); });
      return a;
    }
    return el('div', { class: cls }, children);
  }

  async function viewHome() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };
    var connected = st.hasToken && cfg.spreadsheetId;

    if (connected) {
      var stats = await buildStats();
      var sections = sectionRows();
      var cards = await Promise.all(sections.map(async function (r) {
        var count = 0, lastSync = null;
        try {
          count = await M.db.countTab(r.tab);
          var meta = await M.db.getMeta(r.tab);
          if (meta) lastSync = meta.lastPulledAt || null;
        } catch (e) { /* ignore */ }
        return el('a', { class: 'section-card', href: '#/s/' + encodeURIComponent(r.slug) },
          el('div', { class: 'section-card-icon' }, r.icon || '○'),
          el('div', { class: 'section-card-body' },
            el('h3', null, r.title || r.slug),
            el('p', { class: 'small muted' },
              count + ' row' + (count === 1 ? '' : 's'),
              lastSync ? ' · synced ' + M.render.relativeTime(lastSync) : ''
            )
          )
        );
      }));
      return el('section', { class: 'view' },
        el('h2', null, 'Welcome back' + (st.email ? ', ' + st.email : '')),
        el('p', { class: 'lead' },
          'Your sections live in ',
          el('a', { href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'your spreadsheet'),
          '. Adding a new section is a row in ', el('code', null, '_config'), ' plus a tab — no code change.'
        ),
        stats.length
          ? el('div', { class: 'stats-grid' }, stats.map(renderStatCard))
          : null,
        sections.length
          ? el('div', { class: 'section-cards' }, cards)
          : el('p', { class: 'muted' }, 'No sections yet. Open Settings and click Sync now.'),
        el('div', { class: 'cta-row' },
          el('a', { class: 'btn btn-ghost', href: '#/share' }, 'Quick share & QR'),
          el('a', { class: 'btn btn-ghost', href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Open spreadsheet ↗'),
          el('a', { class: 'btn btn-ghost', href: '#/settings' }, 'Settings')
        )
      );
    }

    // Not connected — landing with a 4-step setup checklist.
    return el('section', { class: 'view' },
      el('h2', null, 'Welcome to Minerva'),
      el('p', { class: 'lead' },
        'A lightweight personal planner — goals, tasks, projects, notes — stored in a Google Sheet that ',
        el('em', null, 'you'),
        ' own. Static site, no servers, no accounts. Four short steps to get started:'
      ),
      renderOnboarding(cfg, st),
      el('div', { class: 'callouts callouts-compact' },
        callout('Share publicly with QR', 'Any note, question, or poll can become a public card with a stable URL and a QR code. Works without connecting.'),
        callout('No build, no backend', 'Pure HTML/CSS/JS on GitHub Pages. Hackable. Forkable. Yours.'),
        callout('Open source', el('span', null,
          'Minerva is GPL-3. Source: ',
          el('a', { href: 'https://github.com/the-farshad/Minerva', target: '_blank', rel: 'noopener' }, 'github.com/the-farshad/Minerva')
        ))
      ),
      el('div', { class: 'cta-row' },
        el('a', { class: 'btn btn-ghost', href: '#/share' }, 'Try Quick share & QR (no login) →')
      )
    );
  }

  function renderOnboarding(cfg, st) {
    // Step 1: site is loading, so Pages is on (or we're on localhost).
    var step1Done = true;
    // Step 2: detected only by side effect — if connect succeeded.
    var step2Done = !!st.hasToken;
    // Step 3: client ID saved locally.
    var step3Done = !!cfg.clientId;
    // Step 4: connected to a spreadsheet.
    var step4Done = !!(st.hasToken && cfg.spreadsheetId);

    var doneCount = [step1Done, step2Done, step3Done, step4Done].filter(Boolean).length;

    function step(n, done, current, title, body) {
      var classes = 'onboarding-step';
      if (done) classes += ' is-done';
      if (current) classes += ' is-current';
      return el('li', { class: classes },
        el('span', { class: 'onboarding-num' }, done ? '✓' : String(n)),
        el('div', { class: 'onboarding-body' },
          el('h3', null, title),
          el('p', null, body)
        )
      );
    }

    var firstUndone = !step1Done ? 1 : !step3Done ? 3 : !step4Done ? 4 : 0;

    var progressFill = el('div', { class: 'onboarding-progress-fill' });
    progressFill.style.width = (doneCount / 4 * 100) + '%';

    return el('div', { class: 'onboarding' },
      el('div', { class: 'onboarding-progress' },
        progressFill,
        el('span', { class: 'onboarding-progress-label' }, doneCount + ' / 4 done')
      ),
      el('ol', { class: 'onboarding-steps' },
        step(1, step1Done, false,
          'Open the app',
          el('span', null, 'Done — you\'re here. The hosted instance is at ',
            el('a', { href: 'https://minerva.thefarshad.com', target: '_blank', rel: 'noopener' }, 'minerva.thefarshad.com'),
            '.'
          )
        ),
        step(2, step3Done, firstUndone === 3,
          'Create a Google OAuth Client ID',
          el('span', null,
            '~5 minutes in Google Cloud Console. The detailed walkthrough lives in ',
            el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-google-oauth.md', target: '_blank', rel: 'noopener' }, 'docs/setup-google-oauth.md'),
            '. Three non-sensitive scopes: ', el('code', null, 'drive.file'), ', ',
            el('code', null, 'userinfo.email'), ', ', el('code', null, 'openid'), '.'
          )
        ),
        step(3, step3Done, firstUndone === 3,
          'Paste it into Settings',
          el('span', null, 'Open ',
            el('a', { href: '#/settings' }, 'Settings'),
            ' and paste your Client ID into the OAuth field. Save.'
          )
        ),
        step(4, step4Done, firstUndone === 4,
          'Connect Google',
          el('span', null,
            'Click ', el('strong', null, 'Connect Google'),
            ' in Settings. Minerva will create a spreadsheet in your Drive and seed it. After that, sections appear in the nav and editing is one click away.'
          )
        )
      ),
      el('div', { class: 'onboarding-cta' },
        firstUndone === 3
          ? el('a', { class: 'btn', href: '#/settings' }, 'Open Settings →')
          : firstUndone === 4
            ? el('a', { class: 'btn', href: '#/settings' }, 'Connect Google →')
            : null
      )
    );
  }

  // ---- push queue (single-flight, coalescing) -------------------------

  var pushInFlight = null;
  var pushPending = false;
  function schedulePush() {
    if (pushInFlight) { pushPending = true; return pushInFlight; }
    pushInFlight = (async function () {
      pushIndicatorState = 'saving';
      paintPushIndicator();
      var lastError = null;
      try {
        do {
          pushPending = false;
          var c = readConfig();
          if (!c.clientId || !c.spreadsheetId) break;
          try {
            var token = await M.auth.getToken(c.clientId);
            var results = await M.sync.pushAll(token, c.spreadsheetId);
            // Surface tab-level errors that pushAll swallowed into the result.
            var errs = (results || []).filter(function (r) { return r && r.error; });
            if (errs.length) lastError = errs[0].error || 'Unknown sync error';
          } catch (e) {
            console.warn('[Minerva push]', e);
            lastError = (e && e.message) || String(e);
            break;
          }
        } while (pushPending);
      } finally {
        pushInFlight = null;
        if (lastError) {
          pushLastError = lastError;
          pushIndicatorState = 'error';
        } else {
          pushIndicatorState = 'hidden';
        }
        paintPushIndicator();
      }
    })();
    return pushInFlight;
  }

  async function commitCellEdit(tab, rowId, columnName, newValue) {
    var row = await M.db.getRow(tab, rowId);
    if (!row) return;
    if (row[columnName] === newValue) return;
    var prevStatus = row.status;
    row[columnName] = newValue;
    row._updated = new Date().toISOString();
    row._dirty = 1;
    await M.db.upsertRow(tab, row);
    schedulePush();

    // Recurring tasks: status -> done transition spawns the next occurrence
    // for any row that has a `recurrence` column populated. The recurrence
    // is parsed from a small text vocab (daily, weekly, every N days,
    // every monday, etc.); see computeNextDue.
    if (columnName === 'status'
        && String(newValue).toLowerCase() === 'done'
        && String(prevStatus || '').toLowerCase() !== 'done'
        && row.recurrence) {
      await spawnRecurrence(tab, row).catch(function (e) {
        console.warn('[Minerva recurrence]', e);
      });
    }
  }

  // ---- recurring tasks ----------------------------------------------

  function computeNextDue(currentDue, recurrence) {
    if (!currentDue) return null;
    // Anchor on the date portion; supports both YYYY-MM-DD and full ISO.
    var iso = String(currentDue).slice(0, 10);
    var parts = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!parts) return null;
    var d = new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3]));
    if (isNaN(d.getTime())) return null;

    var rec = String(recurrence || '').toLowerCase().trim();
    if (rec === 'daily')        d.setUTCDate(d.getUTCDate() + 1);
    else if (rec === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
    else if (rec === 'biweekly' || rec === 'fortnightly') d.setUTCDate(d.getUTCDate() + 14);
    else if (rec === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (rec === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
    else if (rec === 'yearly' || rec === 'annual' || rec === 'annually') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else {
      var nm = rec.match(/^every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/);
      if (nm) {
        var n = parseInt(nm[1], 10);
        var unit = nm[2];
        if (unit.indexOf('day') === 0)        d.setUTCDate(d.getUTCDate() + n);
        else if (unit.indexOf('week') === 0)  d.setUTCDate(d.getUTCDate() + 7 * n);
        else if (unit.indexOf('month') === 0) d.setUTCMonth(d.getUTCMonth() + n);
        else if (unit.indexOf('year') === 0)  d.setUTCFullYear(d.getUTCFullYear() + n);
        else return null;
      } else {
        var dnm = rec.match(/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
        if (!dnm) return null;
        var days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        var target = days.indexOf(dnm[1]);
        var current = d.getUTCDay();
        var delta = ((target - current) + 7) % 7 || 7;
        d.setUTCDate(d.getUTCDate() + delta);
      }
    }
    return d.toISOString().slice(0, 10);
  }

  async function spawnRecurrence(tab, doneRow) {
    var nextDue = computeNextDue(doneRow.due, doneRow.recurrence);
    if (!nextDue) return;
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) return;
    var newRow = await addRow(tab, meta.headers);
    meta.headers.forEach(function (h) {
      if (h === 'id' || h === '_updated') return;
      if (h.charAt(0) === '_') return;
      if (h === 'status') newRow[h] = 'todo';
      else if (h === 'due') newRow[h] = nextDue;
      else newRow[h] = doneRow[h] != null ? doneRow[h] : '';
    });
    newRow._dirty = 1;
    await M.db.upsertRow(tab, newRow);
    schedulePush();
    flash(document.body, 'Spawned next: ' + (newRow.title || 'recurring task') + ' (due ' + nextDue + ')');
  }

  async function addRow(tab, headers) {
    var row = { id: M.db.ulid(), _localOnly: 1, _dirty: 1, _deleted: 0, _rowIndex: null };
    headers.forEach(function (h) {
      if (h === 'id') return;
      if (h === '_updated') row[h] = new Date().toISOString();
      else row[h] = '';
    });
    await M.db.upsertRow(tab, row);
    schedulePush();
    return row;
  }

  async function deleteRow(tab, rowId) {
    var row = await M.db.getRow(tab, rowId);
    if (!row) return;
    row._deleted = 1;
    row._dirty = 1;
    row._updated = new Date().toISOString();
    await M.db.upsertRow(tab, row);
    schedulePush();
  }

  // ---- section view ---------------------------------------------------

  function findDateCol(meta) {
    if (!meta || !meta.headers || !meta.types) return null;
    for (var i = 0; i < meta.headers.length; i++) {
      var h = meta.headers[i];
      if (M.render.isInternal(h)) continue;
      var t = M.render.parseType(meta.types[i]);
      if (t.kind === 'date' || t.kind === 'datetime') return h;
    }
    return null;
  }

  function findSelfRefCol(meta, tab) {
    if (!meta || !meta.headers || !meta.types) return null;
    for (var i = 0; i < meta.headers.length; i++) {
      var t = M.render.parseType(meta.types[i]);
      if (t.kind === 'ref' && t.refTab === tab && !t.multi) return meta.headers[i];
    }
    return null;
  }

  function findProgressCol(meta) {
    if (!meta || !meta.headers || !meta.types) return null;
    for (var i = 0; i < meta.headers.length; i++) {
      var t = M.render.parseType(meta.types[i]);
      if (t.kind === 'progress') return { name: meta.headers[i], min: t.min || 0, max: t.max || 100 };
    }
    return null;
  }

  // Build a map of incoming references TO each row in `targetTab`.
  // Returns { [rowId]: [{ fromTab, fromCol, fromRow }, ...] }.
  // Scans every other meta + tab known locally and inspects its ref columns.
  async function computeBacklinks(targetTab) {
    var backlinks = {};
    try {
      var allMeta = await M.db.getAllMeta();
      for (var m of allMeta) {
        if (!m || !m.tab || !m.headers || !m.types) continue;
        // Find any ref(targetTab) or ref(targetTab,multi) columns on this tab.
        var refCols = [];
        for (var i = 0; i < m.headers.length; i++) {
          var t = M.render.parseType(m.types[i]);
          if (t.kind === 'ref' && t.refTab === targetTab) {
            refCols.push({ name: m.headers[i], multi: !!t.multi });
          }
        }
        if (!refCols.length) continue;
        var rows = await M.db.getAllRows(m.tab);
        rows.forEach(function (r) {
          if (r._deleted) return;
          refCols.forEach(function (c) {
            var raw = r[c.name];
            if (raw == null || raw === '') return;
            var ids = c.multi
              ? String(raw).split(',').map(function (x) { return x.trim(); }).filter(Boolean)
              : [String(raw).trim()];
            ids.forEach(function (id) {
              if (!id) return;
              if (!backlinks[id]) backlinks[id] = [];
              backlinks[id].push({ fromTab: m.tab, fromCol: c.name, fromRow: r });
            });
          });
        });
      }
    } catch (e) { /* non-fatal */ }
    return backlinks;
  }

  function ymd(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function readViewMode(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.view') || '{}');
      return raw[slug] || 'list';
    } catch (e) { return 'list'; }
  }
  function writeViewMode(slug, mode) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.view') || '{}');
      raw[slug] = mode;
      localStorage.setItem('minerva.section.view', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  function readSort(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.sort') || '{}');
      return raw[slug] || null;
    } catch (e) { return null; }
  }
  function writeSort(slug, sort) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.sort') || '{}');
      if (sort) raw[slug] = sort; else delete raw[slug];
      localStorage.setItem('minerva.section.sort', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  function readSavedViews(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.views') || '{}');
      return raw[slug] || [];
    } catch (e) { return []; }
  }
  function writeSavedViews(slug, views) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.views') || '{}');
      if (views && views.length) raw[slug] = views;
      else delete raw[slug];
      localStorage.setItem('minerva.section.views', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  async function viewSection(slug) {
    var cfg = readConfig();
    var sec = (configCache || []).find(function (r) { return r.slug === slug; });
    if (!sec) {
      return el('section', { class: 'view' },
        el('h2', null, 'Section not found'),
        el('p', null, 'No section with slug ', el('code', null, slug), ' in `_config`.'),
        el('p', null, el('a', { href: '#/' }, 'Go home →'), ' · ',
                       el('a', { href: '#/settings' }, 'Sync now'))
      );
    }

    // The habits section gets a custom heatmap-first view.
    if (slug === 'habits') return await viewHabits(sec, cfg);
    var sheetLink = cfg.spreadsheetId
      ? el('a', { href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Edit in Sheets ↗')
      : null;

    var view = el('section', { class: 'view view-section' });
    var header = el('div', { class: 'view-section-head' });
    var meta1Span = el('span');
    var addBtn = el('button', { class: 'btn', type: 'button' }, '+ Add row');
    var modeToggle = el('div', { class: 'seg seg-mode' });
    var calNav = el('div', { class: 'cal-nav' });
    var filterInput = el('input', {
      type: 'search', placeholder: 'Filter rows…', class: 'section-filter'
    });
    var viewsBar = el('div', { class: 'saved-views' });

    header.appendChild(el('h2', null, (sec.icon ? sec.icon + ' ' : '') + (sec.title || sec.slug)));
    var headerRight = el('div', { class: 'view-section-head-right' }, filterInput, modeToggle, calNav, addBtn);
    header.appendChild(headerRight);
    view.appendChild(header);
    view.appendChild(viewsBar);
    view.appendChild(el('p', { class: 'lead' }, meta1Span, sheetLink ? ' · ' : null, sheetLink));

    var bodyHost = el('div');
    view.appendChild(bodyHost);
    var hint = el('p', { class: 'small muted' });
    view.appendChild(hint);

    var mode = readViewMode(slug);
    var userSort = readSort(slug); // null or { col, dir: 'asc'|'desc' }
    var calCursor = new Date(); calCursor.setDate(1);
    var liveQuery = '';
    var debounceFilter = null;
    filterInput.addEventListener('input', function () {
      if (debounceFilter) clearTimeout(debounceFilter);
      debounceFilter = setTimeout(function () {
        liveQuery = filterInput.value.trim().toLowerCase();
        paintViewsBar();
        refresh();
      }, 60);
    });

    function onSortChange(next) {
      // next is { col, dir } or null to clear back to defaultSort.
      userSort = next;
      writeSort(slug, next);
      paintViewsBar();
      refresh();
    }

    function applySavedView(v) {
      userSort = v.sort || null;
      writeSort(slug, userSort);
      liveQuery = (v.query || '').toLowerCase();
      filterInput.value = v.query || '';
      paintViewsBar();
      refresh();
    }

    function captureCurrentView() {
      var name = (prompt('Name this view:') || '').trim();
      if (!name) return;
      var saved = readSavedViews(slug);
      // Replace if same name exists
      saved = saved.filter(function (v) { return v.name !== name; });
      saved.push({
        name: name,
        sort: userSort || null,
        query: filterInput.value.trim() || ''
      });
      writeSavedViews(slug, saved);
      paintViewsBar();
      flash(view, 'Saved view "' + name + '".');
    }

    function deleteSavedView(name) {
      var saved = readSavedViews(slug).filter(function (v) { return v.name !== name; });
      writeSavedViews(slug, saved);
      paintViewsBar();
    }

    function paintViewsBar() {
      var saved = readSavedViews(slug);
      var hasUnsaved = !!(userSort || liveQuery);
      viewsBar.replaceChildren();
      if (!saved.length && !hasUnsaved) return;

      saved.forEach(function (v) {
        var chip = el('span', { class: 'view-chip' });
        var apply = el('button', {
          type: 'button', class: 'view-chip-apply', title: 'Apply this view',
          onclick: function () { applySavedView(v); }
        }, v.name);
        var rm = el('button', {
          type: 'button', class: 'view-chip-rm', title: 'Delete this view',
          'aria-label': 'Delete view ' + v.name,
          onclick: function () {
            if (confirm('Delete saved view "' + v.name + '"?')) deleteSavedView(v.name);
          }
        }, '×');
        chip.appendChild(apply);
        chip.appendChild(rm);
        viewsBar.appendChild(chip);
      });

      if (hasUnsaved) {
        viewsBar.appendChild(el('button', {
          type: 'button', class: 'view-save', onclick: captureCurrentView
        }, '+ Save current view'));
        viewsBar.appendChild(el('button', {
          type: 'button', class: 'view-clear',
          onclick: function () {
            userSort = null;
            writeSort(slug, null);
            liveQuery = '';
            filterInput.value = '';
            paintViewsBar();
            refresh();
          }
        }, 'Clear'));
      }
    }
    paintViewsBar();

    function paintModeToggle(hasDate, hasTree) {
      modeToggle.innerHTML = '';
      if (!hasDate && !hasTree) return;
      var listBtn = el('button', { type: 'button', 'data-value': 'list',
        class: mode === 'list' ? 'active' : '' }, 'List');
      listBtn.addEventListener('click', function () { switchMode('list'); });
      modeToggle.appendChild(listBtn);
      if (hasTree) {
        var treeBtn = el('button', { type: 'button', 'data-value': 'tree',
          class: mode === 'tree' ? 'active' : '' }, 'Tree');
        treeBtn.addEventListener('click', function () { switchMode('tree'); });
        modeToggle.appendChild(treeBtn);
      }
      if (hasDate) {
        var calBtn = el('button', { type: 'button', 'data-value': 'cal',
          class: mode === 'cal' ? 'active' : '' }, 'Calendar');
        calBtn.addEventListener('click', function () { switchMode('cal'); });
        modeToggle.appendChild(calBtn);
      }
    }

    function paintCalNav(visible) {
      calNav.innerHTML = '';
      if (!visible) return;
      var label = calCursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
      var prev = el('button', { class: 'icon-btn', type: 'button', title: 'Previous month' }, '‹');
      var next = el('button', { class: 'icon-btn', type: 'button', title: 'Next month' }, '›');
      var today = el('button', { class: 'btn btn-ghost', type: 'button', title: 'Jump to current month' }, 'Today');
      prev.addEventListener('click', function () {
        calCursor.setMonth(calCursor.getMonth() - 1);
        refresh();
      });
      next.addEventListener('click', function () {
        calCursor.setMonth(calCursor.getMonth() + 1);
        refresh();
      });
      today.addEventListener('click', function () {
        calCursor = new Date(); calCursor.setDate(1);
        refresh();
      });
      calNav.appendChild(prev);
      calNav.appendChild(el('span', { class: 'cal-month' }, label));
      calNav.appendChild(next);
      calNav.appendChild(today);
    }

    function switchMode(m) {
      mode = m;
      writeViewMode(slug, m);
      refresh();
    }

    async function refresh() {
      var meta = await M.db.getMeta(sec.tab);
      var allRows = await M.db.getAllRows(sec.tab);
      var visible = allRows.filter(function (r) { return !r._deleted; });
      var backlinks = await computeBacklinks(sec.tab);

      // Sort: user click overrides _config.defaultSort.
      var sortSpec = userSort
        ? userSort.col + (userSort.dir === 'desc' ? ':desc' : '')
        : sec.defaultSort;
      var sorted = M.render.applySort(visible, sortSpec);
      var filtered = M.render.applyFilter(sorted, sec.defaultFilter);

      // Per-section live filter (typed in the header search box).
      if (liveQuery) {
        var qterms = liveQuery.split(/\s+/).filter(Boolean);
        var visibleHeaders = (meta && meta.headers || []).filter(function (h) {
          return !M.render.isInternal(h) && h !== 'id';
        });
        filtered = filtered.filter(function (r) {
          var hay = visibleHeaders
            .map(function (h) { return r[h] != null ? String(r[h]) : ''; })
            .join('  ').toLowerCase();
          return qterms.every(function (t) { return hay.indexOf(t) >= 0; });
        });
      }

      var dateCol = findDateCol(meta);
      var parentCol = findSelfRefCol(meta, sec.tab);
      var canCal = !!dateCol;
      var canTree = !!parentCol;
      if (mode === 'cal' && !canCal) mode = 'list';
      if (mode === 'tree' && !canTree) mode = 'list';

      paintModeToggle(canCal, canTree);
      paintCalNav(mode === 'cal');

      var meta1 = filtered.length + ' row' + (filtered.length === 1 ? '' : 's');
      if (visible.length !== filtered.length) meta1 += ' (of ' + visible.length + ')';
      var parts = [meta1];
      var activeSort = userSort
        ? userSort.col + (userSort.dir === 'desc' ? ' ↓' : ' ↑') + ' (click)'
        : (sec.defaultSort ? 'sorted by ' + sec.defaultSort : '');
      if (activeSort) parts.push(activeSort);
      if (sec.defaultFilter) parts.push('filtered: ' + sec.defaultFilter);
      if (liveQuery) parts.push('searching "' + liveQuery + '"');
      meta1Span.textContent = parts.join(' · ');

      if (mode === 'cal' && dateCol) {
        bodyHost.replaceChildren(renderCalendar(filtered, dateCol, calCursor, sec.tab));
        hint.replaceChildren(
          'Calendar groups rows by ', el('code', null, dateCol),
          '. Switch back to list to edit cells inline.'
        );
      } else if (mode === 'tree' && parentCol) {
        bodyHost.replaceChildren(renderTree(meta, filtered, sec.tab, parentCol, refresh, backlinks));
        hint.replaceChildren(
          'Tree groups rows by their ', el('code', null, parentCol),
          ' field. ', el('strong', null, '+'), ' adds a subtask · ',
          el('strong', null, '↺'),
          ' shows incoming refs from other sections. Click ▸/▾ to expand.'
        );
      } else {
        bodyHost.replaceChildren(renderSectionTable(meta, filtered, sec.tab, refresh, userSort, onSortChange, backlinks));
        hint.replaceChildren(
          'Click any cell to edit. Click a column header to sort. ',
          el('kbd', null, 'Enter'), ' to save, ',
          el('kbd', null, 'Esc'), ' to cancel.'
        );
      }

      paintBacklinksFooter(backlinks);
    }

    var backlinksFooter = el('div', { class: 'backlinks-footer' });
    view.appendChild(backlinksFooter);

    function paintBacklinksFooter(backlinks) {
      backlinksFooter.replaceChildren();
      var keys = Object.keys(backlinks || {});
      if (!keys.length) return;
      // Top-N most-linked rows in this section.
      var ranked = keys.map(function (id) {
        return { id: id, refs: backlinks[id] };
      }).sort(function (a, b) { return b.refs.length - a.refs.length; }).slice(0, 8);

      var rowsById = {};
      (allRows || []).forEach(function (r) { rowsById[r.id] = r; });

      backlinksFooter.appendChild(el('h3', { class: 'backlinks-h' },
        '↺ Linked from ',
        el('span', { class: 'small muted' }, '(' + keys.length + ' row' + (keys.length === 1 ? '' : 's') + ' referenced)')));
      var ul = el('ul', { class: 'backlinks-list' });
      ranked.forEach(function (entry) {
        var row = rowsById[entry.id];
        if (!row) return;
        var label = row.title || row.name || entry.id;
        var byTab = {};
        entry.refs.forEach(function (ref) {
          byTab[ref.fromTab] = (byTab[ref.fromTab] || 0) + 1;
        });
        var summary = Object.keys(byTab).map(function (t) {
          return byTab[t] + ' from ' + t;
        }).join(' · ');
        var li = el('li', { class: 'backlinks-row' });
        li.appendChild(el('span', { class: 'backlinks-title' }, label));
        li.appendChild(el('span', { class: 'small muted' }, summary));
        ul.appendChild(li);
      });
      backlinksFooter.appendChild(ul);
    }

    addBtn.addEventListener('click', async function () {
      var meta = await M.db.getMeta(sec.tab);
      if (!meta || !meta.headers) {
        flash(view, 'No schema cached — Sync first.', 'error');
        return;
      }
      await addRow(sec.tab, meta.headers);
      mode = 'list';
      writeViewMode(slug, 'list');
      await refresh();
    });

    await refresh();
    return view;
  }

  // ---- today view ---------------------------------------------------

  async function markTaskDone(rowId) {
    var row = await M.db.getRow('tasks', rowId);
    if (!row) return;
    var wasDone = String(row.status || '').toLowerCase() === 'done';
    row.status = 'done';
    row._updated = new Date().toISOString();
    row._dirty = 1;
    await M.db.upsertRow('tasks', row);
    schedulePush();
    if (!wasDone && row.recurrence) {
      try { await spawnRecurrence('tasks', row); } catch (e) { console.warn(e); }
    }
  }

  async function viewToday() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false };
    if (!cfg.spreadsheetId || !st.hasToken) {
      return el('section', { class: 'view' },
        el('h2', null, 'Today'),
        el('p', null, 'Connect first.'),
        el('p', null, el('a', { href: '#/settings' }, 'Open Settings →'))
      );
    }

    var today = todayStr();
    var tasks = (await M.db.getAllRows('tasks').catch(function () { return []; }))
      .filter(function (r) {
        if (r._deleted) return false;
        if (String(r.status || '').toLowerCase() === 'done') return false;
        if (!r.due) return false;
        return String(r.due).slice(0, 10) <= today;
      })
      .sort(function (a, b) {
        return String(a.due).localeCompare(String(b.due));
      });

    var habits = (await M.db.getAllRows('habits').catch(function () { return []; }))
      .filter(function (h) { return !h._deleted; });
    var habitLogs = (await M.db.getAllRows('habit_log').catch(function () { return []; }))
      .filter(function (l) { return !l._deleted; });
    var doneToday = {};
    habitLogs.forEach(function (l) {
      if (String(l.date).slice(0, 10) === today) doneToday[l.habit_id] = true;
    });
    var habitsLeft = habits.filter(function (h) { return !doneToday[h.id]; });
    var habitsDone = habits.filter(function (h) { return doneToday[h.id]; });

    var notes = (await M.db.getAllRows('notes').catch(function () { return []; }))
      .filter(function (n) {
        if (n._deleted) return false;
        if (!n.created) return false;
        return Date.now() - new Date(n.created).getTime() < 7 * 86400000;
      })
      .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); })
      .slice(0, 5);

    var view = el('section', { class: 'view view-today' });
    view.appendChild(el('h2', null, '☀ Today  ',
      el('span', { class: 'small muted' }, new Date().toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric'
      }))
    ));

    // -- tasks block --
    view.appendChild(el('h3', null, 'Tasks  ',
      el('span', { class: 'small muted' }, '(' + tasks.length + ')')));
    if (!tasks.length) {
      view.appendChild(el('p', { class: 'muted' }, 'Nothing due today. ✓'));
    } else {
      var ul = el('ul', { class: 'today-list' });
      tasks.forEach(function (t) {
        var dueDate = String(t.due).slice(0, 10);
        var overdue = dueDate < today;
        var li = el('li', { class: 'today-item' + (overdue ? ' today-overdue' : '') });
        var doneBtn = el('button', {
          class: 'today-check',
          type: 'button',
          title: 'Mark done',
          onclick: async function () {
            doneBtn.disabled = true;
            await markTaskDone(t.id);
            li.style.opacity = '0.4';
            li.style.textDecoration = 'line-through';
            setTimeout(function () { li.remove(); }, 300);
          }
        }, '✓');
        li.appendChild(doneBtn);
        var titleSpan = el('a', {
          class: 'today-title',
          href: '#/s/tasks'
        }, t.title || t.id);
        li.appendChild(titleSpan);
        var meta = [];
        if (overdue) meta.push('overdue (' + dueDate + ')');
        if (t.priority) meta.push(t.priority);
        if (t.project) meta.push('· ' + t.project);
        if (meta.length) {
          li.appendChild(el('span', { class: 'today-meta' }, meta.join(' · ')));
        }
        ul.appendChild(li);
      });
      view.appendChild(ul);
    }

    // -- habits block --
    view.appendChild(el('h3', null, 'Habits  ',
      el('span', { class: 'small muted' }, '(' + habitsDone.length + ' / ' + habits.length + ' done)')));
    if (!habits.length) {
      view.appendChild(el('p', { class: 'muted' },
        'No habits yet — ', el('a', { href: '#/s/habits' }, 'add one →')));
    } else if (!habitsLeft.length) {
      view.appendChild(el('p', { class: 'muted' }, 'All done for today. 🔥'));
    } else {
      var hwrap = el('div', { class: 'today-habits' });
      habitsLeft.forEach(function (h) {
        var card = el('div', { class: 'today-habit' });
        card.appendChild(el('div', { class: 'today-habit-name' }, h.name || h.id));
        var btn = el('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: async function () {
            btn.disabled = true;
            try { await logHabitToday(h.id); } catch (e) { /* surface */ }
            card.style.opacity = '0.5';
            setTimeout(function () { card.remove(); }, 300);
          }
        }, '✓ Done');
        card.appendChild(btn);
        hwrap.appendChild(card);
      });
      view.appendChild(hwrap);
    }

    // -- recent notes block --
    if (notes.length) {
      view.appendChild(el('h3', null, 'Recent notes'));
      var nul = el('ul', { class: 'today-list today-notes' });
      notes.forEach(function (n) {
        var li = el('li', { class: 'today-item' });
        li.appendChild(el('span', { class: 'today-note-date' }, String(n.created || '').slice(0, 10)));
        li.appendChild(el('a', { class: 'today-title', href: '#/s/notes' },
          n.title || (n.body ? String(n.body).slice(0, 60) : n.id)));
        nul.appendChild(li);
      });
      view.appendChild(nul);
    }

    view.appendChild(el('p', { class: 'small muted' },
      el('a', { href: '#/s/tasks' }, 'All tasks →'),
      ' · ',
      el('a', { href: '#/s/habits' }, 'All habits →'),
      ' · ',
      el('a', { href: '#/s/notes' }, 'All notes →')
    ));

    return view;
  }

  // ---- habits view --------------------------------------------------

  function ymdOf(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function calcStreak(habitLogsByDate) {
    var d = new Date();
    var streak = 0;
    while (true) {
      var k = ymdOf(d);
      if (!habitLogsByDate[k]) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  async function logHabitToday(habitId) {
    var date = todayStr();
    var existing = (await M.db.getAllRows('habit_log')).find(function (r) {
      return r.habit_id === habitId && String(r.date).slice(0, 10) === date && !r._deleted;
    });
    if (existing) {
      existing.count = (Number(existing.count) || 0) + 1;
      existing._updated = new Date().toISOString();
      existing._dirty = 1;
      await M.db.upsertRow('habit_log', existing);
    } else {
      var lmeta = await M.db.getMeta('habit_log');
      if (!lmeta || !lmeta.headers) throw new Error('habit_log not synced — Sync first.');
      var row = await addRow('habit_log', lmeta.headers);
      row.habit_id = habitId;
      row.date = date;
      row.count = 1;
      row._dirty = 1;
      await M.db.upsertRow('habit_log', row);
    }
    var habit = await M.db.getRow('habits', habitId);
    if (habit) {
      habit.last_done = date;
      habit._updated = new Date().toISOString();
      habit._dirty = 1;
      await M.db.upsertRow('habits', habit);
    }
    schedulePush();
  }

  function renderHeatmap(logsByDate, weeks, color) {
    weeks = weeks || 12;
    color = color || 'var(--accent)';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    // Find the Monday on/before (weeks * 7) days ago for a clean grid.
    var start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    // Find the Sunday-before-or-equal start so columns are full.
    var weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    var maxCount = 0;
    Object.keys(logsByDate).forEach(function (k) {
      if (logsByDate[k] > maxCount) maxCount = logsByDate[k];
    });
    if (maxCount < 1) maxCount = 1;

    var grid = el('div', { class: 'heatmap-grid' });
    var totalCols = Math.ceil((today.getTime() - weekStart.getTime()) / (7 * 86400000)) + 1;
    var d = new Date(weekStart);
    for (var w = 0; w < totalCols; w++) {
      var col = el('div', { class: 'heatmap-col' });
      for (var dow = 0; dow < 7; dow++) {
        var key = ymdOf(d);
        var count = logsByDate[key] || 0;
        var future = d > today;
        var level = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4));
        var cell = el('div', {
          class: 'heatmap-cell heatmap-c' + level + (future ? ' heatmap-future' : ''),
          title: key + (count ? ' — done ' + count + (count === 1 ? ' time' : ' times') : ' — nothing logged')
        });
        if (count) cell.style.background = color;
        if (count && level < 4) cell.style.opacity = String(0.3 + 0.175 * level);
        col.appendChild(cell);
        d.setDate(d.getDate() + 1);
      }
      grid.appendChild(col);
    }
    return grid;
  }

  async function viewHabits(sec, cfg) {
    var view = el('section', { class: 'view view-habits' });
    var header = el('div', { class: 'view-section-head' });
    var addBtn = el('button', { class: 'btn', type: 'button' }, '+ Add habit');
    header.appendChild(el('h2', null, (sec.icon ? sec.icon + ' ' : '') + (sec.title || 'Habits')));
    header.appendChild(el('div', { class: 'view-section-head-right' }, addBtn));
    view.appendChild(header);
    view.appendChild(el('p', { class: 'lead' },
      'Streaks and a 12-week heatmap of your habit log. Click ',
      el('em', null, 'Done today'),
      ' to log a completion.'
    ));

    var grid = el('div', { class: 'habits-grid' });
    view.appendChild(grid);
    view.appendChild(el('p', { class: 'small muted' },
      'Habit data lives in the ', el('code', null, 'habits'),
      ' tab and one log row per completion in the ', el('code', null, 'habit_log'),
      ' tab. Edit them directly in your spreadsheet for bulk changes.'
    ));

    async function refresh() {
      var habits = (await M.db.getAllRows('habits')).filter(function (h) { return !h._deleted; });
      var allLogs = (await M.db.getAllRows('habit_log')).filter(function (l) { return !l._deleted; });

      grid.replaceChildren();

      if (!habits.length) {
        grid.appendChild(el('p', { class: 'muted' },
          'No habits yet. Click + Add habit to start.'));
        return;
      }

      habits.forEach(function (h) {
        var hLogs = allLogs.filter(function (l) { return l.habit_id === h.id; });
        var byDate = {};
        hLogs.forEach(function (l) {
          var k = String(l.date || '').slice(0, 10);
          if (!k) return;
          byDate[k] = (byDate[k] || 0) + (Number(l.count) || 1);
        });
        var streak = calcStreak(byDate);
        var done = !!byDate[todayStr()];

        var card = el('div', { class: 'habit-card' });
        card.appendChild(el('div', { class: 'habit-card-head' },
          el('h3', null, h.name || h.id),
          el('span', { class: 'habit-streak' },
            el('strong', null, String(streak)),
            ' day' + (streak === 1 ? '' : 's')
          )
        ));
        if (h.target) {
          card.appendChild(el('p', { class: 'small muted' },
            'Target: ', el('code', null, String(h.target)) + ' / day'));
        }
        card.appendChild(renderHeatmap(byDate, 12, h.color || 'var(--accent)'));
        card.appendChild(el('div', { class: 'habit-actions' },
          el('button', {
            class: 'btn' + (done ? ' btn-ghost' : ''),
            type: 'button',
            onclick: async function () {
              try {
                await logHabitToday(h.id);
                await refresh();
              } catch (e) {
                flash(view, 'Could not log: ' + e.message, 'error');
              }
            }
          }, done ? 'Log another today' : '✓ Done today'),
          el('a', { class: 'btn btn-ghost',
            href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Edit in Sheets ↗')
        ));
        grid.appendChild(card);
      });
    }

    addBtn.addEventListener('click', async function () {
      var meta = await M.db.getMeta('habits');
      if (!meta || !meta.headers) {
        flash(view, 'No habits schema — Sync first.', 'error');
        return;
      }
      var row = await addRow('habits', meta.headers);
      row.name = 'New habit';
      row._dirty = 1;
      await M.db.upsertRow('habits', row);
      schedulePush();
      await refresh();
    });

    await refresh();
    return view;
  }

  function renderTree(meta, rows, tab, parentCol, refresh, backlinks) {
    var byId = {};
    rows.forEach(function (r) {
      byId[r.id] = { row: r, children: [] };
    });
    var roots = [];
    rows.forEach(function (r) {
      var pid = r[parentCol];
      if (pid && byId[pid]) byId[pid].children.push(byId[r.id]);
      else roots.push(byId[r.id]);
    });

    var titleCol = (meta.headers || []).indexOf('title') >= 0 ? 'title'
      : (meta.headers || []).indexOf('name') >= 0 ? 'name'
      : 'id';
    var progress = findProgressCol(meta);
    var statusHeader = (meta.headers || []).indexOf('status') >= 0 ? 'status' : null;
    var dueHeader = (meta.headers || []).indexOf('due') >= 0 ? 'due'
      : (meta.headers || []).indexOf('end') >= 0 ? 'end' : null;

    function nodeEl(node, depth) {
      var r = node.row;
      var has = node.children.length > 0;
      var label = r[titleCol] || r.id;

      var wrap = el('li', { class: 'tree-node' });
      var header = el('div', { class: 'tree-row' });
      header.style.paddingLeft = (0.4 + depth * 1.1) + 'rem';

      var toggle = has
        ? el('button', { class: 'tree-toggle', type: 'button', 'aria-expanded': 'true' }, '▾')
        : el('span', { class: 'tree-leaf' }, '·');
      header.appendChild(toggle);

      var titleA = el('a', { class: 'tree-title', href: M.sheets.spreadsheetUrl(readConfig().spreadsheetId), target: '_blank', rel: 'noopener' }, String(label));
      header.appendChild(titleA);

      if (statusHeader) {
        var s = String(r[statusHeader] || '');
        if (s) header.appendChild(M.render.renderCell(s, 'select(' + s + ')'));
      }

      if (progress) {
        header.appendChild(M.render.renderCell(r[progress.name], 'progress(' + progress.min + '..' + progress.max + ')'));
      }

      if (dueHeader && r[dueHeader]) {
        header.appendChild(el('span', { class: 'tree-due small muted' }, String(r[dueHeader]).slice(0, 10)));
      }

      if (has) {
        header.appendChild(el('span', { class: 'tree-count small muted' }, node.children.length + ' child' + (node.children.length === 1 ? '' : 'ren')));
      }

      if (backlinks && backlinks[r.id] && backlinks[r.id].length) {
        var bn = backlinks[r.id].length;
        header.appendChild(el('span', { class: 'backlink-badge', title: bn + ' incoming reference' + (bn === 1 ? '' : 's') }, '↺ ' + bn));
      }

      var addChildBtn = el('button', {
        class: 'tree-add-child',
        type: 'button',
        title: 'Add subtask under this row',
        'aria-label': 'Add subtask',
        onclick: async function (e) {
          e.preventDefault();
          var newRow = await addRow(tab, meta.headers);
          newRow[parentCol] = r.id;
          if (meta.headers.indexOf('title') >= 0) newRow.title = 'New';
          else if (meta.headers.indexOf('name') >= 0) newRow.name = 'New';
          if (meta.headers.indexOf('status') >= 0) newRow.status = 'todo';
          newRow._dirty = 1;
          await M.db.upsertRow(tab, newRow);
          schedulePush();
          if (refresh) await refresh();
        }
      }, '+');
      header.appendChild(addChildBtn);

      wrap.appendChild(header);

      if (has) {
        var childUl = el('ul', { class: 'tree-children' });
        node.children.forEach(function (c) { childUl.appendChild(nodeEl(c, depth + 1)); });
        wrap.appendChild(childUl);

        toggle.addEventListener('click', function () {
          var open = childUl.style.display !== 'none';
          childUl.style.display = open ? 'none' : '';
          toggle.textContent = open ? '▸' : '▾';
          toggle.setAttribute('aria-expanded', String(!open));
        });
      }

      return wrap;
    }

    if (!roots.length) {
      return el('p', { class: 'muted' }, 'No rows in this section yet.');
    }

    var root = el('ul', { class: 'tree' });
    roots.forEach(function (r) { root.appendChild(nodeEl(r, 0)); });
    return root;
  }

  function renderCalendar(rows, dateCol, monthDate, tab) {
    var year = monthDate.getFullYear();
    var month = monthDate.getMonth();
    var firstDay = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0).getDate();
    var startOffset = firstDay.getDay(); // 0 = Sunday
    var today = todayStr();

    var byDate = {};
    rows.forEach(function (r) {
      var key = String(r[dateCol] || '').slice(0, 10);
      if (!key) return;
      (byDate[key] = byDate[key] || []).push(r);
    });

    var weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var headRow = el('div', { class: 'cal-head' },
      weekdays.map(function (w) { return el('div', { class: 'cal-day-h' }, w); })
    );

    var cells = [];
    for (var p = 0; p < startOffset; p++) {
      cells.push(el('div', { class: 'cal-cell cal-pad' }));
    }
    for (var d = 1; d <= lastDay; d++) {
      var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var items = byDate[dateStr] || [];
      var cls = 'cal-cell';
      if (dateStr === today) cls += ' cal-today';
      if (items.length) cls += ' cal-has';

      var cell = el('div', { class: cls });
      cell.appendChild(el('div', { class: 'cal-day' }, String(d)));
      if (items.length) {
        var list = el('ul', { class: 'cal-items' });
        items.slice(0, 3).forEach(function (r) {
          var label = r.title || r.name || r.id;
          var li = el('li', { class: 'cal-item', title: label }, label);
          if (String(r.status || '').toLowerCase() === 'done') li.classList.add('done');
          list.appendChild(li);
        });
        if (items.length > 3) {
          list.appendChild(el('li', { class: 'cal-item cal-more' }, '+ ' + (items.length - 3) + ' more'));
        }
        cell.appendChild(list);
      }
      cells.push(cell);
    }
    while (cells.length % 7 !== 0) cells.push(el('div', { class: 'cal-cell cal-pad' }));

    return el('div', { class: 'calendar' }, headRow, el('div', { class: 'cal-grid' }, cells));
  }

  function renderSectionTable(meta, rows, tab, refresh, userSort, onSortChange, backlinks) {
    if (!meta || !meta.headers || !meta.headers.length) {
      return el('p', { class: 'muted' }, 'No schema cached yet — open Settings and click Sync now.');
    }
    if (!rows.length) {
      return el('p', { class: 'muted' }, 'No rows yet. Click ', el('em', null, '+ Add row'), ' to start, or add some in your spreadsheet then Sync.');
    }
    var visibleCols = [];
    for (var i = 0; i < meta.headers.length; i++) {
      var h = meta.headers[i];
      if (M.render.isInternal(h)) continue;
      if (h === 'id') continue;
      visibleCols.push({ name: h, type: meta.types[i] || 'text' });
    }
    var thead = el('thead', null,
      el('tr', null,
        visibleCols.map(function (c) {
          var isActive = userSort && userSort.col === c.name;
          var arrow = isActive ? (userSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
          var th = el('th', {
            class: 'th-sortable' + (isActive ? ' sort-active' : ''),
            tabindex: '0',
            title: 'Click to sort'
          });
          th.appendChild(document.createTextNode(c.name));
          if (arrow) th.appendChild(el('span', { class: 'sort-arrow' }, arrow));
          var cycle = function () {
            if (!onSortChange) return;
            var next;
            if (!isActive) next = { col: c.name, dir: 'asc' };
            else if (userSort.dir === 'asc') next = { col: c.name, dir: 'desc' };
            else next = null;
            onSortChange(next);
          };
          th.addEventListener('click', cycle);
          th.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle(); }
          });
          return th;
        }).concat([
          el('th', { class: 'col-actions', 'aria-label': 'Actions' }, '')
        ])
      )
    );
    var tbody = el('tbody', null, rows.map(function (row) {
      var tr = el('tr', { 'data-rowid': row.id });
      if (row._dirty) tr.classList.add('row-dirty');
      visibleCols.forEach(function (c, ci) {
        var td = el('td', { 'data-col': c.name, 'data-type': c.type, tabindex: '0' });
        td.appendChild(M.render.renderCell(row[c.name], c.type));
        // Append a small backlink badge to the first visible column.
        if (ci === 0 && backlinks && backlinks[row.id] && backlinks[row.id].length) {
          var n = backlinks[row.id].length;
          var badge = el('span', { class: 'backlink-badge', title: n + ' incoming reference' + (n === 1 ? '' : 's') }, '↺ ' + n);
          td.appendChild(badge);
        }
        td.addEventListener('click', function () { startEdit(td, row, c, tab, refresh); });
        td.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startEdit(td, row, c, tab, refresh);
          }
        });
        tr.appendChild(td);
      });
      var actions = el('td', { class: 'col-actions' });
      var delBtn = el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Delete row',
        'aria-label': 'Delete row',
        onclick: async function () {
          if (!confirm('Delete this row? This will remove it from your spreadsheet on next sync.')) return;
          await deleteRow(tab, row.id);
          await refresh();
        }
      }, '×');
      actions.appendChild(delBtn);
      tr.appendChild(actions);
      return tr;
    }));
    var wrap = el('div', { class: 'table-wrap' });
    wrap.appendChild(el('table', { class: 'rows' }, thead, tbody));
    return wrap;
  }

  function startEdit(td, row, col, tab, refresh) {
    if (td.classList.contains('editing')) return;
    var current = row[col.name];

    function endEdit(content) {
      td.classList.remove('editing');
      td.replaceChildren(content);
    }

    var editor = M.editors.make(current, col.type,
      async function onCommit(newValue) {
        endEdit(M.render.renderCell(newValue, col.type));
        if (newValue !== current) {
          await commitCellEdit(tab, row.id, col.name, newValue);
          await refresh();
        }
      },
      function onCancel() {
        endEdit(M.render.renderCell(current, col.type));
      }
    );
    td.classList.add('editing');
    td.replaceChildren(editor);
    if (typeof editor.focus === 'function') editor.focus();
    if (typeof editor.select === 'function' && editor.tagName !== 'TEXTAREA') {
      try { editor.select(); } catch (e) { /* no-op for non-text inputs */ }
    }
  }

  function viewSettings() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };

    var form = el('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      var f = new FormData(form);
      writeConfig({
        clientId:      String(f.get('clientId') || '').trim(),
        spreadsheetId: String(f.get('spreadsheetId') || '').trim()
      });
      flash(form, 'Saved locally.');
    } },
      field('Google OAuth Client ID',
        el('input', { name: 'clientId', type: 'text',
          placeholder: '123456789-abc.apps.googleusercontent.com',
          value: cfg.clientId || '', autocomplete: 'off', spellcheck: 'false' }),
        'Create one at Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web). Authorized JavaScript origin: this domain (and http://localhost:8000 for local preview).'
      ),
      field('Spreadsheet ID (optional)',
        el('input', { name: 'spreadsheetId', type: 'text',
          placeholder: 'leave blank — Minerva creates one for you on first connect',
          value: cfg.spreadsheetId || '', autocomplete: 'off', spellcheck: 'false' }),
        'Found in your Sheet URL: docs.google.com/spreadsheets/d/<this-part>/edit'
      ),
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn', type: 'submit' }, 'Save'),
        (cfg.clientId || cfg.spreadsheetId)
          ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
              if (confirm('Clear local Minerva config? Your Google account and Sheet are not affected.')) {
                localStorage.removeItem(STORE);
                if (M.auth) M.auth.signOut();
                location.hash = '#/settings';
                location.reload();
              }
            } }, 'Clear local config')
          : null
      ),
      el('p', { class: 'small muted' }, 'Stored only in your browser via localStorage. Nothing is sent anywhere by saving.')
    );

    var status = el('div', { class: 'auth-status' });
    var localPanel = el('div', { class: 'local-store' });

    var stageLabels = {
      auth: 'Opening Google sign-in…',
      bootstrap: 'Setting up your Minerva spreadsheet…',
      syncing: 'Pulling your data into the local store…'
    };

    function paintStatus(stage) {
      var c = readConfig();
      var state = M.auth ? M.auth.getState() : { hasToken: false, email: null };
      var ok = state.hasToken && c.spreadsheetId;
      status.replaceChildren(
        el('h3', null, 'Connection'),
        ok
          ? el('p', null,
              'Connected as ', el('em', null, state.email || 'your Google account'), '. ',
              el('a', { href: M.sheets.spreadsheetUrl(c.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Open spreadsheet ↗')
            )
          : el('p', { class: 'muted' },
              c.clientId
                ? 'Not connected yet — click Connect to authorize Minerva and create your spreadsheet.'
                : 'Save a Google OAuth Client ID above first. Then come back and click Connect.'
            ),
        stage && stageLabels[stage]
          ? el('p', { class: 'small muted' }, stageLabels[stage])
          : null,
        el('div', { class: 'form-actions' },
          ok
            ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
                if (confirm('Sign out? Your spreadsheet is not affected.')) {
                  M.auth.signOut();
                  paintStatus();
                  paintLocal();
                }
              } }, 'Disconnect')
            : el('button', { class: 'btn', type: 'button',
                disabled: !c.clientId,
                onclick: function () { void connect(); }
              }, 'Connect Google'),
          ok ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { void syncNow(); } }, 'Sync now') : null,
          ok ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { void connect(); } }, 'Re-run bootstrap') : null
        )
      );
    }

    function fmtRel(ts) {
      if (!ts) return 'never';
      var d = Date.now() - ts;
      if (d < 5000) return 'just now';
      if (d < 60000) return Math.round(d / 1000) + 's ago';
      if (d < 3600000) return Math.round(d / 60000) + 'm ago';
      if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
      return new Date(ts).toLocaleString();
    }

    async function paintLocal() {
      try {
        var stats = await M.sync.stats();
      } catch (e) {
        localPanel.replaceChildren(
          el('h3', null, 'Local store'),
          el('p', { class: 'muted' }, 'IndexedDB unavailable: ', String((e && e.message) || e))
        );
        return;
      }
      var last = await M.sync.lastSync();
      var rows = stats.length
        ? el('table', { class: 'kv' },
            el('thead', null, el('tr', null,
              el('th', null, 'Tab'),
              el('th', null, 'Rows'),
              el('th', null, 'Last sync')
            )),
            el('tbody', null, stats.map(function (s) {
              return el('tr', null,
                el('td', null, el('code', null, s.tab)),
                el('td', null, String(s.count)),
                el('td', { class: 'muted' }, fmtRel(s.lastPulledAt))
              );
            }))
          )
        : el('p', { class: 'muted' }, 'Empty — connect, then click Sync now.');

      localPanel.replaceChildren(
        el('h3', null, 'Local store'),
        el('p', { class: 'small muted' },
          'Your spreadsheet is mirrored to a private IndexedDB store in this browser. ',
          last ? ('Last full sync ' + fmtRel(last) + '.') : 'Never synced yet.'
        ),
        rows,
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn btn-ghost', type: 'button',
            onclick: function () {
              if (confirm('Clear the local mirror? Your spreadsheet is not affected; the next sync will re-populate.')) {
                M.db.clearAll().then(paintLocal);
              }
            } }, 'Clear local mirror')
        )
      );
    }

    async function syncNow() {
      var c = readConfig();
      if (!c.clientId || !c.spreadsheetId) {
        flash(localPanel, 'Connect first.', 'error');
        return;
      }
      try {
        paintStatus('syncing');
        var token = await M.auth.getToken(c.clientId);
        var results = await M.sync.syncAll(token, c.spreadsheetId);
        await refreshConfig();
        paintStatus();
        await paintLocal();
        renderNav(navActive());
        var errs = (results.pull || []).filter(function (r) { return r.error; })
          .concat((results.push || []).filter(function (r) { return r.error; }));
        if (errs.length) {
          flash(localPanel, 'Synced with ' + errs.length + ' error(s) — see console.', 'error');
          errs.forEach(function (e) { console.warn('[Minerva sync]', e); });
        } else {
          flash(localPanel, 'Pushed pending edits, then pulled ' + (results.pull || []).length + ' tab(s).');
        }
      } catch (err) {
        paintStatus();
        flash(localPanel, 'Sync failed: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    async function connect() {
      var c = readConfig();
      if (!c.clientId) {
        flash(status, 'Save a Client ID first.', 'error');
        return;
      }
      try {
        paintStatus('auth');
        var token = await M.auth.requestToken(c.clientId, c.spreadsheetId ? '' : 'consent');
        paintStatus('bootstrap');
        var bs = await M.bootstrap(token);
        writeConfig({ spreadsheetId: bs.spreadsheetId });
        paintStatus('syncing');
        await M.sync.pullAll(token, bs.spreadsheetId);
        await refreshConfig();
        paintStatus();
        await paintLocal();
        renderNav(navActive());
        flash(status, bs.fresh ? 'Spreadsheet created, seeded, and pulled.' : 'Connected and synced.');
      } catch (err) {
        paintStatus();
        flash(status, 'Connect failed: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    paintStatus();
    paintLocal();

    var notifyPanel = el('div', { class: 'tg-panel' });
    var tgPanel = el('div', { class: 'tg-panel' });
    var icalPanel = el('div', { class: 'tg-panel' });
    var presetsPanel = el('div', { class: 'tg-panel' });
    var aiPanel = el('div', { class: 'tg-panel' });
    paintNotify();
    paintIcal();
    paintPresets();
    paintAi();
    paintTg();

    function paintAi() {
      var c = M.ai.readCfg();
      var providers = [
        { v: 'anthropic', label: 'Anthropic (Claude)' },
        { v: 'openai',    label: 'OpenAI' },
        { v: 'ollama',    label: 'Ollama (local)' },
        { v: 'byo',       label: 'BYO endpoint (OpenAI-compatible)' }
      ];

      var aiForm = el('form', { class: 'form', onsubmit: function (e) {
        e.preventDefault();
        var f = new FormData(aiForm);
        M.ai.writeCfg({
          provider: String(f.get('aiProvider') || ''),
          apiKey:   String(f.get('aiApiKey') || '').trim(),
          endpoint: String(f.get('aiEndpoint') || '').trim(),
          model:    String(f.get('aiModel') || '').trim()
        });
        paintAi();
        flash(aiPanel, 'AI settings saved.');
      } },
        field('Provider',
          (function () {
            var sel = document.createElement('select');
            sel.name = 'aiProvider';
            providers.forEach(function (p) {
              var o = document.createElement('option');
              o.value = p.v;
              o.textContent = p.label;
              if ((c.provider || 'anthropic') === p.v) o.selected = true;
              sel.appendChild(o);
            });
            return sel;
          })(),
          'Anthropic uses the browser-direct beta header. Ollama runs against a local server (set OLLAMA_ORIGINS=* on it). BYO points at any OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter…).'
        ),
        field('API key',
          el('input', { name: 'aiApiKey', type: 'password',
            value: c.apiKey || '',
            placeholder: 'leave blank for Ollama on localhost',
            autocomplete: 'off', spellcheck: 'false' }),
          'Stored in your browser only. Sent only to your configured endpoint.'
        ),
        field('Endpoint (optional)',
          el('input', { name: 'aiEndpoint', type: 'text',
            value: c.endpoint || '',
            placeholder: M.ai.defaultEndpoint(c.provider || 'anthropic'),
            autocomplete: 'off', spellcheck: 'false' }),
          'Leave blank for the provider\'s default.'
        ),
        field('Model (optional)',
          el('input', { name: 'aiModel', type: 'text',
            value: c.model || '',
            placeholder: M.ai.defaultModel(c.provider || 'anthropic'),
            autocomplete: 'off', spellcheck: 'false' }),
          ''
        ),
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn', type: 'submit' }, 'Save'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            disabled: !(c.provider && (c.apiKey || c.provider === 'ollama')),
            onclick: function () { showAI('Say hello in one sentence.'); }
          }, 'Test'),
          (c.provider || c.apiKey)
            ? el('button', { class: 'btn btn-ghost', type: 'button',
                onclick: function () {
                  if (!confirm('Clear AI settings?')) return;
                  M.ai.clearCfg();
                  paintAi();
                } }, 'Clear AI settings')
            : null
        )
      );

      aiPanel.replaceChildren(
        el('h3', null, 'AI assistant'),
        el('p', { class: 'small muted' },
          'BYO API key. Open the assistant any time with ',
          el('kbd', null, '⌘/Ctrl + J'),
          '. Your prompts (and any data context Minerva attaches) go directly from your browser to the configured endpoint — Minerva never proxies AI traffic.'
        ),
        aiForm
      );
    }

    function paintPresets() {
      var c = readConfig();
      var st = M.auth ? M.auth.getState() : { hasToken: false };
      var connected = st.hasToken && c.spreadsheetId;

      var children = [
        el('h3', null, 'Add a section'),
        el('p', { class: 'small muted' },
          connected
            ? 'One-click presets — pick one and Minerva creates the tab in your spreadsheet, seeds the schema, and adds it to your nav. You can rename columns or extend the schema directly in Sheets afterward.'
            : 'Connect first. Each preset creates a new tab in your spreadsheet plus a row in `_config`.'
        )
      ];

      if (connected) {
        var existingSlugs = (configCache || []).map(function (r) { return r.slug; });
        var grid = el('div', { class: 'preset-grid' });
        (M.presets || []).forEach(function (p) {
          var taken = existingSlugs.indexOf(p.slug) >= 0;
          var card = el('div', { class: 'preset-card' + (taken ? ' preset-taken' : '') },
            el('div', { class: 'preset-icon' }, p.icon || '○'),
            el('div', { class: 'preset-body' },
              el('h4', null, p.title),
              el('p', { class: 'small muted' }, p.description),
              taken
                ? el('span', { class: 'small muted' }, '✓ already added')
                : el('button', { class: 'btn btn-ghost', type: 'button',
                    onclick: async function () {
                      try {
                        flash(presetsPanel, 'Adding ' + p.title + '…');
                        await addPreset(p);
                        await refreshConfig();
                        renderNav(navActive());
                        paintPresets();
                        flash(presetsPanel, 'Added ' + p.title + '. Check the nav above.');
                      } catch (err) {
                        flash(presetsPanel, 'Failed: ' + (err && err.message || err), 'error');
                      }
                    }
                  }, 'Add')
            )
          );
          grid.appendChild(card);
        });
        children.push(grid);
      }
      presetsPanel.replaceChildren.apply(presetsPanel, children);
    }

    async function addPreset(p) {
      var c = readConfig();
      if (!c.clientId || !c.spreadsheetId) throw new Error('Connect first.');
      var token = await M.auth.getToken(c.clientId);

      // 1. Ensure the tab exists; create + seed if not.
      var ss = await M.sheets.getSpreadsheet(token, c.spreadsheetId);
      var existing = (ss.sheets || []).map(function (s) { return s.properties.title; });
      if (existing.indexOf(p.slug) < 0) {
        await M.sheets.batchUpdate(token, c.spreadsheetId, [{
          addSheet: { properties: { title: p.slug } }
        }]);
        var values = [p.schema.headers.slice(), p.schema.types.slice()];
        await M.sheets.updateValues(token, c.spreadsheetId, p.slug + '!A1', values);
      }

      // 2. Append the _config row locally; the dirty-queue push lifts it to Sheets.
      var configMeta = await M.db.getMeta('_config');
      if (!configMeta || !configMeta.headers) throw new Error('Sync first — _config schema not cached.');
      var maxOrder = (configCache || []).reduce(function (m, r) {
        var n = Number(r.order) || 0;
        return n > m ? n : m;
      }, 0);
      var row = await addRow('_config', configMeta.headers);
      row.slug = p.slug;
      row.title = p.title;
      row.icon = p.icon;
      row.tab = p.slug;
      row.order = maxOrder + 1;
      row.enabled = 'TRUE';
      row.defaultSort = p.defaultSort || '';
      row.defaultFilter = p.defaultFilter || '';
      row._dirty = 1;
      await M.db.upsertRow('_config', row);
      schedulePush();

      // 3. Pull the new tab into the local store so the section is immediately viewable.
      try { await M.sync.pullTab(token, c.spreadsheetId, p.slug); } catch (e) { /* non-fatal */ }
      try { await M.sync.pullTab(token, c.spreadsheetId, '_config'); } catch (e) { /* non-fatal */ }
    }

    function paintIcal() {
      var c = readConfig();
      var ic = readUi().ical || {};
      var connected = !!c.spreadsheetId;
      var children = [
        el('h3', null, 'Calendar feed (iCal)'),
        el('p', { class: 'small muted' },
          'Publish your tasks as a public .ics file in your own Drive, then subscribe to it from Apple Calendar, Google Calendar, Outlook — anywhere. The file content updates whenever you click Update feed; subscribers refresh on their own schedule.'
        )
      ];
      if (!connected) {
        children.push(el('p', { class: 'muted small' }, 'Connect first.'));
      } else {
        children.push(
          el('div', { class: 'form-actions' },
            el('button', { class: 'btn', type: 'button',
              onclick: async function () {
                try {
                  flash(icalPanel, 'Publishing…');
                  var token = await M.auth.getToken(c.clientId);
                  var res = await M.ical.publish(token);
                  writeUi({ ical: { fileId: res.fileId, url: res.url, webcal: res.webcal, count: res.count, when: Date.now() } });
                  paintIcal();
                  flash(icalPanel, 'Published ' + res.count + ' event' + (res.count === 1 ? '' : 's') + '.');
                } catch (err) {
                  flash(icalPanel, 'Publish failed: ' + (err && err.message ? err.message : err), 'error');
                }
              } }, ic.url ? 'Update feed' : 'Publish feed')
          )
        );
        if (ic.url) {
          var urlInput = el('input', { type: 'text', value: ic.url, readonly: true, class: 'url' });
          children.push(
            el('div', { class: 'form-actions' },
              el('span', { class: 'small muted' }, ic.count + ' event' + (ic.count === 1 ? '' : 's') + ' · last published ', M.render.relativeTime(ic.when))
            ),
            el('div', { class: 'link-row' }, urlInput,
              el('button', { class: 'btn btn-ghost', type: 'button',
                onclick: function () {
                  urlInput.select();
                  if (navigator.clipboard) navigator.clipboard.writeText(ic.url);
                  flash(icalPanel, 'URL copied');
                } }, 'Copy'),
              el('a', { class: 'btn btn-ghost', href: ic.webcal }, 'Subscribe (webcal://)')
            ),
            el('p', { class: 'small muted' },
              'Tip: in Google Calendar, ', el('strong', null, 'Other calendars → + → From URL'),
              '; in Apple Calendar, ', el('strong', null, 'File → New Calendar Subscription'), '. Most clients refresh every few hours.'
            )
          );
        }
      }
      icalPanel.replaceChildren.apply(icalPanel, children);
    }

    function paintNotify() {
      var supports = 'Notification' in window;
      var perm = supports ? Notification.permission : 'unsupported';
      var ui = readUi();
      var disabled = ui && ui.notifyDisabled;

      var children = [
        el('h3', null, 'Browser notifications'),
        el('p', { class: 'small muted' },
          'Desktop notifications fire (alongside any Telegram pings) when a task is due today, while a Minerva tab is open. ',
          'Permission status: ', el('em', null, perm), '.')
      ];

      if (!supports) {
        children.push(el('p', { class: 'small muted' }, 'Your browser does not expose the Notification API.'));
      } else if (perm === 'granted') {
        children.push(
          el('div', { class: 'form-actions' },
            el('label', { class: 'small' },
              el('input', { type: 'checkbox', checked: !disabled,
                onchange: function (e) {
                  writeUi({ notifyDisabled: !e.target.checked });
                  scheduleReminders();
                  paintNotify();
                } }),
              ' Enable desktop reminders for due tasks'),
            el('button', { class: 'btn btn-ghost', type: 'button',
              onclick: function () {
                desktopNotify('Minerva', 'Test notification — looks good ✓');
              } }, 'Send test notification')
          )
        );
      } else if (perm === 'denied') {
        children.push(el('p', { class: 'small muted' },
          'Permission was denied. Re-enable in your browser site settings (lock icon → Notifications) and reload.'));
      } else {
        children.push(el('div', { class: 'form-actions' },
          el('button', { class: 'btn', type: 'button',
            onclick: async function () {
              var ok = await requestBrowserNotificationPermission();
              if (ok) scheduleReminders();
              paintNotify();
            } }, 'Allow notifications')));
      }

      notifyPanel.replaceChildren.apply(notifyPanel, children);
    }

    function paintTg() {
      var tg = readTg();
      var hasToken = !!tg.token;
      var hasChat = !!tg.chatId;
      var enabled = hasToken && hasChat && !tg.disabled;

      var tgForm = el('form', { class: 'form', onsubmit: function (e) {
        e.preventDefault();
        var f = new FormData(tgForm);
        writeTg({
          token:  String(f.get('tgToken')  || '').trim(),
          chatId: String(f.get('tgChatId') || '').trim()
        });
        scheduleReminders();
        paintTg();
        flash(tgPanel, 'Saved.');
      } },
        field('Bot token',
          el('input', { name: 'tgToken', type: 'text',
            value: tg.token || '',
            placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz',
            autocomplete: 'off', spellcheck: 'false' }),
          'From @BotFather → /newbot. Stays in your browser only.'
        ),
        field('Chat ID',
          el('input', { name: 'tgChatId', type: 'text',
            value: tg.chatId || '',
            placeholder: 'detect after you message your bot',
            autocomplete: 'off', spellcheck: 'false' }),
          'The Telegram chat reminders will go to. Use Detect to fill this in automatically.'
        ),
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn', type: 'submit' }, 'Save'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            disabled: !hasToken,
            onclick: async function () {
              var t = readTg().token;
              if (!t) return;
              try {
                var me = await M.telegram.getMe(t);
                flash(tgPanel, 'Connected as @' + (me.username || me.first_name) + '.');
              } catch (err) {
                flash(tgPanel, 'getMe failed: ' + err.message, 'error');
              }
            } }, 'Test connection'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            disabled: !hasToken,
            onclick: async function () {
              var t = readTg().token;
              if (!t) return;
              try {
                var id = await M.telegram.detectChatId(t);
                if (!id) {
                  flash(tgPanel, 'No recent messages — send /start to your bot in Telegram first.', 'error');
                  return;
                }
                writeTg({ chatId: id });
                paintTg();
                flash(tgPanel, 'Chat ID set: ' + id);
              } catch (err) {
                flash(tgPanel, 'getUpdates failed: ' + err.message, 'error');
              }
            } }, 'Detect chat ID'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            disabled: !(hasToken && hasChat),
            onclick: async function () {
              var t = readTg();
              try {
                await M.telegram.sendMessage(t.token, t.chatId, '*Minerva connected* ✅');
                flash(tgPanel, 'Test message sent.');
              } catch (err) {
                flash(tgPanel, 'sendMessage failed: ' + err.message, 'error');
              }
            } }, 'Send test message'),
          (hasToken || hasChat)
            ? el('button', { class: 'btn btn-ghost', type: 'button',
                onclick: async function () {
                  if (!confirm('Clear local Telegram config? Your bot in Telegram is not affected.')) return;
                  localStorage.removeItem(TG_KEY);
                  if (tgTimer) { clearInterval(tgTimer); tgTimer = null; }
                  paintTg();
                } }, 'Clear Telegram config')
            : null
        ),
        (hasToken && hasChat)
          ? el('div', { class: 'form-actions' },
              el('label', { class: 'small' },
                el('input', { type: 'checkbox', checked: !tg.disabled,
                  onchange: function (e) {
                    writeTg({ disabled: !e.target.checked });
                    if (e.target.checked) scheduleReminders();
                    else if (tgTimer) { clearInterval(tgTimer); tgTimer = null; }
                    paintTg();
                  }
                }),
                ' Daily reminders for due tasks (while a tab is open)'
              )
            )
          : null
      );

      var note;
      if (!hasToken) note = 'Paste a bot token to start. ';
      else if (!hasChat) note = 'Token saved. Send /start to your bot in Telegram, then click Detect chat ID. ';
      else if (tg.disabled) note = 'Reminders disabled. ';
      else note = 'Connected. Reminders fire while a Minerva tab is open. ';

      tgPanel.replaceChildren(
        el('h3', null, 'Telegram bot'),
        el('p', { class: 'small muted' }, note,
          el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-telegram.md',
                    target: '_blank', rel: 'noopener' }, 'Setup walkthrough →')
        ),
        tgForm
      );
    }

    // Wrap each panel in a section with an id so the TOC can link to it.
    function panel(id, content) {
      var s = el('section', { class: 'settings-section', id: id });
      if (Array.isArray(content)) content.forEach(function (c) { if (c) s.appendChild(c); });
      else if (content) s.appendChild(content);
      return s;
    }

    var connectionPanel = el('div');
    connectionPanel.appendChild(form);
    connectionPanel.appendChild(status);

    var sections = [
      { id: 'settings-connection', label: 'Connection',  content: connectionPanel },
      { id: 'settings-store',      label: 'Local store', content: localPanel },
      { id: 'settings-sections',   label: 'Add a section', content: presetsPanel },
      { id: 'settings-notify',     label: 'Notifications', content: notifyPanel },
      { id: 'settings-ical',       label: 'Calendar feed', content: icalPanel },
      { id: 'settings-telegram',   label: 'Telegram bot',  content: tgPanel },
      { id: 'settings-ai',         label: 'AI assistant',  content: aiPanel }
    ];

    var toc = el('aside', { class: 'settings-toc', 'aria-label': 'Settings sections' });
    var tocList = el('ul');
    sections.forEach(function (s) {
      var a = el('a', {
        href: '#' + s.id,
        onclick: function (e) {
          e.preventDefault();
          var t = document.getElementById(s.id);
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.replaceState(null, '', '#/settings');
        }
      }, s.label);
      tocList.appendChild(el('li', null, a));
    });
    toc.appendChild(el('h3', null, 'Sections'));
    toc.appendChild(tocList);

    var body = el('div', { class: 'settings-body' });
    sections.forEach(function (s) {
      body.appendChild(panel(s.id, s.content));
    });

    return el('section', { class: 'view view-settings' },
      el('h2', null, 'Settings'),
      el('p', { class: 'lead' },
        'Minerva keeps no secrets in its repo. You bring your own Google OAuth client; Minerva remembers it locally. ',
        el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-google-oauth.md', target: '_blank', rel: 'noopener' }, 'Detailed setup walkthrough →')
      ),
      el('div', { class: 'settings-layout' },
        toc,
        body
      )
    );
  }

  function viewShare() {
    // optional seed payload: #/share/<token>
    var seed = {};
    var seedMatch = (location.hash || '').match(/^#\/share\/(.+)$/);
    if (seedMatch) {
      try { seed = M.decode(seedMatch[1]); } catch (e) { /* ignore */ }
    }

    var form = el('form', { class: 'form', onsubmit: function (e) { e.preventDefault(); } },
      field('Title',
        el('input', { name: 'title', type: 'text', value: seed.title || '',
          placeholder: 'Lunch poll', oninput: rerender })
      ),
      field('Body / question',
        el('textarea', { name: 'body', rows: 3,
          placeholder: 'What should we eat on Friday?', oninput: rerender }, seed.body || '')
      ),
      field('Choices (one per line, optional — turns it into a poll)',
        el('textarea', { name: 'choices', rows: 4,
          placeholder: 'Pizza\nSushi\nThai', oninput: rerender }, (seed.choices || []).join('\n'))
      ),
      field('Kind',
        el('select', { name: 'kind', onchange: rerender },
          opt('note', 'Note', seed.kind),
          opt('question', 'Question', seed.kind),
          opt('poll', 'Poll', seed.kind)
        )
      )
    );

    var linkRow = el('div', { class: 'link-row' });
    var qrWrap = el('div', { class: 'qr-wrap' });
    var card = el('div', { class: 'card-preview' });

    function getPayload() {
      var f = new FormData(form);
      var rawChoices = String(f.get('choices') || '').split('\n')
        .map(function (s) { return s.trim(); }).filter(Boolean);
      var payload = {
        kind: f.get('kind') || 'note',
        title: String(f.get('title') || '').trim(),
        body: String(f.get('body') || '').trim()
      };
      if (rawChoices.length) payload.choices = rawChoices;
      return payload;
    }

    function rerender() {
      var payload = getPayload();
      // auto-promote to poll if choices were typed
      if (payload.choices && payload.kind === 'note') payload.kind = 'poll';

      if (!payload.title && !payload.body) {
        linkRow.replaceChildren();
        qrWrap.replaceChildren();
        card.replaceChildren(el('p', { class: 'muted' }, 'Fill in a title or body to generate a sharable link.'));
        return;
      }

      var url = M.shareUrl(payload);

      var urlInput = el('input', { type: 'text', value: url, readonly: true, class: 'url', 'aria-label': 'Public share URL' });
      var copyBtn = el('button', { class: 'btn', type: 'button', onclick: function () {
        urlInput.select();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { flash(linkRow, 'Link copied'); });
        } else {
          document.execCommand('copy');
          flash(linkRow, 'Link copied');
        }
      } }, 'Copy link');
      linkRow.replaceChildren(urlInput, copyBtn);

      var qr = M.qr(url, { ec: 'M', margin: 2 });
      qr.classList.add('qr');
      qrWrap.replaceChildren(
        qr,
        el('div', { class: 'qr-actions' },
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
            M.downloadPng(qr, 'minerva-' + (payload.kind || 'share') + '.png');
          } }, 'Download PNG'),
          el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, 'Open public view ↗')
        )
      );

      card.replaceChildren(renderCard(payload));
    }

    rerender();

    return el('section', { class: 'view view-share' },
      el('h2', null, 'Quick share'),
      el('p', { class: 'lead' },
        'Build a public card — note, question, or poll — and get a stable URL plus a QR code. The data lives ',
        el('em', null, 'in the URL itself'),
        ', so nothing is uploaded; anyone with the link sees the same card you do.'
      ),
      el('div', { class: 'share-grid' },
        el('div', { class: 'share-col' }, form, linkRow),
        el('div', { class: 'share-col' },
          el('h3', { class: 'mini-h' }, 'QR'),
          qrWrap,
          el('h3', { class: 'mini-h' }, 'Preview'),
          card
        )
      )
    );
  }

  function renderCard(p) {
    var kind = String(p.kind || 'note').toLowerCase();
    var kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);

    var bodyEl = null;
    if (p.body) {
      // Render the body as markdown for richer share cards.
      bodyEl = el('div', { class: 'card-body' });
      bodyEl.appendChild(M.render.renderCell(p.body, 'markdown'));
    }

    return el('article', { class: 'card card-' + kind },
      el('div', { class: 'card-kind' }, kindLabel),
      p.title ? el('h3', { class: 'card-title' }, p.title) : null,
      bodyEl,
      (p.choices && p.choices.length)
        ? el('ul', { class: 'card-choices' }, p.choices.map(function (c) { return el('li', null, c); }))
        : null
    );
  }

  function viewPublic(token) {
    var payload;
    try { payload = M.decode(token); }
    catch (e) {
      return el('section', { class: 'view' },
        el('h2', null, 'Invalid share link'),
        el('p', null, 'This link is malformed or truncated.'),
        el('p', null, el('a', { href: '#/share' }, 'Create a new one →'))
      );
    }

    var url = location.href;
    var qr = M.qr(url, { ec: 'M', margin: 2 });
    qr.classList.add('qr', 'qr-small');

    return el('section', { class: 'view view-public' },
      renderCard(payload),
      el('div', { class: 'public-meta' },
        qr,
        el('div', null,
          el('p', { class: 'small muted' }, 'Shared via ',
            el('a', { href: '#/' }, 'Minerva'),
            '. The data lives in the URL itself — no server is involved.'),
          el('div', { class: 'qr-actions' },
            el('a', { href: '#/share/' + token, class: 'btn btn-ghost' }, 'Edit a copy'),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function () { flash(document.body, 'Link copied'); });
              }
            } }, 'Copy link'),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
              M.downloadPng(qr, 'minerva-public.png');
            } }, 'Download QR PNG')
          )
        )
      )
    );
  }

  function viewNotFound(hash) {
    return el('section', { class: 'view' },
      el('h2', null, 'Not found'),
      el('p', null, 'No view at ', el('code', null, hash || '#/'), '.'),
      el('p', null, el('a', { href: '#/' }, 'Go home →'))
    );
  }

  // ---- router ----

  async function route() {
    setBusy(true);
    var hash = location.hash || '#/';
    var view, active = '';
    var sectionMatch;

    try {
      if (hash === '#/' || hash === '' || hash === '#') {
        view = await viewHome(); active = '#/';
      } else if (hash === '#/settings') {
        view = viewSettings(); active = '#/settings';
      } else if (/^#\/share(\/.*)?$/.test(hash)) {
        view = viewShare(); active = '#/share';
      } else if (/^#\/p\/.+/.test(hash)) {
        view = viewPublic(hash.replace(/^#\/p\//, ''));
      } else if (hash === '#/today') {
        view = await viewToday(); active = '#/today';
      } else if ((sectionMatch = hash.match(/^#\/s\/(.+)$/))) {
        var slug = decodeURIComponent(sectionMatch[1]);
        view = await viewSection(slug);
        active = '#/s/' + encodeURIComponent(slug);
      } else {
        view = viewNotFound(hash);
      }
    } catch (err) {
      view = el('section', { class: 'view' },
        el('h2', null, 'Something went wrong'),
        el('p', null, 'Render error: ', el('code', null, String(err && err.message || err))),
        el('p', null, el('a', { href: '#/' }, 'Go home →'))
      );
    }

    renderNav(active);
    content.replaceChildren(view);
    setBusy(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ---- Telegram reminders -------------------------------------------

  var TG_KEY = 'minerva.telegram.v1';

  function readTg() {
    try { return JSON.parse(localStorage.getItem(TG_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeTg(patch) {
    var cur = readTg();
    var next = Object.assign({}, cur, patch);
    localStorage.setItem(TG_KEY, JSON.stringify(next));
    return next;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function alreadyPinged(rowId, date) {
    var sent = readTg().sent || {};
    return sent[date] && sent[date][rowId];
  }
  function markPinged(rowId, date) {
    var cur = readTg();
    var sent = cur.sent || {};
    // prune any non-today date keys to keep storage small
    Object.keys(sent).forEach(function (k) { if (k !== date) delete sent[k]; });
    if (!sent[date]) sent[date] = {};
    sent[date][rowId] = 1;
    writeTg({ sent: sent });
  }

  // Browser desktop notifications
  function browserNotificationsAllowed() {
    return ('Notification' in window) && Notification.permission === 'granted';
  }
  async function requestBrowserNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      var p = await Notification.requestPermission();
      return p === 'granted';
    } catch (e) { return false; }
  }
  function desktopNotify(title, body, opts) {
    if (!browserNotificationsAllowed()) return;
    try {
      var n = new Notification(title, Object.assign({
        body: body,
        icon: 'docs/assets/minerva-logo.png',
        tag: (opts && opts.tag) || 'minerva',
        renotify: false
      }, opts || {}));
      if (opts && opts.onClick) n.onclick = opts.onClick;
    } catch (e) { /* ignore */ }
  }

  async function tickReminders() {
    var tg = readTg();
    var tgEnabled = !!(tg.token && tg.chatId && !tg.disabled);
    var notify = browserNotificationsAllowed() && !readUi().notifyDisabled;
    if (!tgEnabled && !notify) return;

    var tasksRow = (configCache || []).find(function (r) {
      return r.slug === 'tasks' || r.tab === 'tasks';
    });
    var tasksTab = tasksRow ? tasksRow.tab : 'tasks';

    var rows;
    try { rows = await M.db.getAllRows(tasksTab); }
    catch (e) { return; }

    var date = todayStr();
    var dueOrOverdue = (rows || []).filter(function (r) {
      if (r._deleted) return false;
      var status = String(r.status || '').toLowerCase();
      if (status === 'done') return false;
      if (!r.due) return false;
      return String(r.due).slice(0, 10) <= date;
    });

    for (var i = 0; i < dueOrOverdue.length; i++) {
      var r = dueOrOverdue[i];
      if (alreadyPinged(r.id, date)) continue;
      var label = r.title || r.id;
      var dueStr = String(r.due).slice(0, 10);
      var prefix = dueStr < date ? '⏰ overdue (' + dueStr + ')' : '⏰ due today';
      var pingedSomewhere = false;

      if (tgEnabled) {
        var msg = prefix + ': *' + label + '*';
        if (r.priority) msg += '\n_priority: ' + r.priority + '_';
        try {
          await M.telegram.sendMessage(tg.token, tg.chatId, msg);
          pingedSomewhere = true;
        } catch (e) {
          console.warn('[Minerva tg]', e);
        }
      }

      if (notify) {
        desktopNotify(prefix, label + (r.priority ? '  ·  ' + r.priority : ''), {
          tag: 'minerva-task-' + r.id,
          onClick: function (slug) {
            return function () {
              window.focus();
              location.hash = '#/s/' + encodeURIComponent(slug);
            };
          }(tasksRow ? tasksRow.slug : 'tasks')
        });
        pingedSomewhere = true;
      }

      if (pingedSomewhere) markPinged(r.id, date);
    }
  }

  // Schedule a periodic reminder check while the tab is open.
  var tgTimer = null;
  function scheduleReminders() {
    if (tgTimer) { clearInterval(tgTimer); tgTimer = null; }
    var tg = readTg();
    var anyChannel = (!!(tg.token && tg.chatId && !tg.disabled))
      || (browserNotificationsAllowed() && !readUi().notifyDisabled);
    if (!anyChannel) return;
    tickReminders();
    tgTimer = setInterval(tickReminders, 30 * 60 * 1000);
  }

  function navActive() {
    var h = location.hash || '#/';
    if (h === '#/' || h === '' || h === '#') return '#/';
    if (h === '#/today') return '#/today';
    if (/^#\/s\//.test(h)) return h;
    if (/^#\/share/.test(h)) return '#/share';
    if (h === '#/settings') return '#/settings';
    return '';
  }

  // ---- AI assistant overlay (`Cmd/Ctrl+J`) ----

  var AI_PROMPTS = [
    {
      label: 'Summarize my week',
      build: async function () {
        var ctx = await M.ai.buildContext({ includeNotes: true });
        return [
          { role: 'system', content: 'You are a concise planning assistant. Use the user\'s data below to write a short markdown summary of their last week — what shipped, what slipped, themes. Keep it tight: 5–10 bullet points.\n\n' + ctx },
          { role: 'user', content: 'Summarize my week.' }
        ];
      }
    },
    {
      label: 'Suggest a next action',
      build: async function () {
        var ctx = await M.ai.buildContext();
        return [
          { role: 'system', content: 'You are a focused planning assistant. Given the user\'s tasks/goals/projects below, propose ONE next concrete action they should take right now — not a list, just the single most-leveraged thing — with a one-sentence rationale.\n\n' + ctx },
          { role: 'user', content: 'What should I do next?' }
        ];
      }
    },
    {
      label: 'Decompose a goal',
      build: async function () {
        var ctx = await M.ai.buildContext();
        return [
          { role: 'system', content: 'You are a planning assistant. The user wants help breaking down a goal. Use their existing context below for awareness, but ask which specific goal they mean if it isn\'t obvious, then propose 5–8 concrete sub-tasks as a markdown checklist.\n\n' + ctx },
          { role: 'user', content: 'Help me decompose a goal into next-actionable steps.' }
        ];
      }
    },
    {
      label: 'Find duplicates',
      build: async function () {
        var ctx = await M.ai.buildContext({ includeNotes: true });
        return [
          { role: 'system', content: 'You are a librarian for the user\'s planning data. Scan the rows below and report any likely duplicates or overlaps — same intent under different wording, near-identical titles, etc. Output as a short markdown list grouped by section.\n\n' + ctx },
          { role: 'user', content: 'Find likely duplicates across my data.' }
        ];
      }
    },
    {
      label: 'Cluster my notes',
      build: async function () {
        var ctx = await M.ai.buildContext({ includeNotes: true });
        return [
          { role: 'system', content: 'You are a librarian. Cluster the user\'s notes into 3–6 themes; for each theme, list the matching note titles as a sublist. Markdown output.\n\n' + ctx },
          { role: 'user', content: 'Cluster my notes into themes.' }
        ];
      }
    }
  ];

  async function showAI(seedPrompt) {
    if (document.querySelector('.ai-overlay')) return;
    var aiCfg = M.ai.readCfg();
    var hasProvider = !!(aiCfg.provider && (aiCfg.apiKey || aiCfg.provider === 'ollama'));

    var overlay = el('div', { class: 'modal-overlay ai-overlay',
      onclick: function () { overlay.remove(); }
    });

    var input = document.createElement('textarea');
    input.className = 'editor';
    input.rows = 3;
    input.placeholder = 'Ask the assistant… (⌘/Ctrl+Enter to send)';
    if (seedPrompt) input.value = seedPrompt;

    var output = el('div', { class: 'ai-output' });
    var statusLine = el('p', { class: 'small muted' });

    function paintStatus() {
      var c = M.ai.readCfg();
      if (!c.provider) {
        statusLine.replaceChildren(
          el('span', null, 'No provider configured. ',
            el('a', { href: '#/settings', onclick: function () { overlay.remove(); } }, 'Open Settings →')
          )
        );
      } else {
        var modelLabel = c.model || M.ai.defaultModel(c.provider);
        statusLine.replaceChildren(
          el('span', null, 'Provider: ',
            el('strong', null, c.provider),
            ' · model: ',
            el('em', null, modelLabel),
            ' · ',
            el('a', { href: '#/settings', onclick: function () { overlay.remove(); } }, 'change')
          )
        );
      }
    }
    paintStatus();

    var sending = false;
    async function send(messages) {
      if (sending) return;
      sending = true;
      output.replaceChildren(el('p', { class: 'muted small' }, 'Thinking…'));
      try {
        var resp = await M.ai.ask(messages, { maxTokens: 2048 });
        output.replaceChildren(M.render.renderCell(resp.text || '(empty response)', 'markdown'));
      } catch (err) {
        output.replaceChildren(
          el('p', { class: 'error' }, 'Request failed: ' + (err && err.message ? err.message : String(err))),
          el('p', { class: 'small muted' }, 'Common causes: missing/invalid API key, CORS blocked (try Ollama or a BYO proxy), wrong model name.')
        );
      } finally {
        sending = false;
      }
    }

    function freeFormSend() {
      var text = input.value.trim();
      if (!text) return;
      var msgs = [{
        role: 'system',
        content: 'You are a concise planning assistant for the Minerva personal-planning app. Reply in markdown when listing or structuring information.'
      }, {
        role: 'user',
        content: text
      }];
      send(msgs);
    }

    var promptButtons = AI_PROMPTS.map(function (p) {
      return el('button', { class: 'btn btn-ghost ai-prompt-btn', type: 'button',
        onclick: async function () {
          if (!hasProvider) {
            output.replaceChildren(el('p', { class: 'error' },
              'Configure a provider first in Settings.'));
            return;
          }
          input.value = p.label;
          var msgs = await p.build();
          send(msgs);
        }
      }, p.label);
    });

    var panel = el('div', { class: 'modal-panel ai-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('div', { class: 'ai-head' },
        el('h3', null, 'AI assistant'),
        el('button', { class: 'icon-btn', type: 'button', title: 'Close',
          onclick: function () { overlay.remove(); } }, '×')
      ),
      statusLine,
      el('div', { class: 'ai-prompts' }, promptButtons),
      input,
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn', type: 'button',
          onclick: freeFormSend,
          disabled: !hasProvider }, 'Send'),
        el('span', { class: 'small muted' }, '⌘/Ctrl+Enter')
      ),
      output
    );

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        freeFormSend();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        overlay.remove();
      }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 30);
  }

  // ---- quick capture overlay (`/`) ----

  function pickInboxSection() {
    var sects = sectionRows();
    return sects.find(function (s) { return s.slug === 'inbox'; })
      || sects.find(function (s) { return s.slug === 'notes'; })
      || sects[0] || null;
  }

  async function showCapture() {
    if (document.querySelector('.capture-overlay')) return;
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false };
    if (!cfg.spreadsheetId || !st.hasToken) {
      flash(document.body, 'Connect first to capture.', 'error');
      return;
    }
    var sects = sectionRows();
    if (!sects.length) return;
    var initial = pickInboxSection();

    var overlay = el('div', { class: 'modal-overlay capture-overlay',
      onclick: function () { overlay.remove(); }
    });

    var sectSelect = document.createElement('select');
    sects.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.slug;
      o.textContent = (s.icon ? s.icon + ' ' : '') + (s.title || s.slug);
      sectSelect.appendChild(o);
    });
    if (initial) sectSelect.value = initial.slug;

    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Title';
    titleInput.className = 'editor';

    var bodyTa = document.createElement('textarea');
    bodyTa.rows = 4;
    bodyTa.placeholder = 'Body (optional). Cmd/Ctrl + Enter to save.';
    bodyTa.className = 'editor';

    var form = el('form', { class: 'modal-panel capture-panel',
      onclick: function (e) { e.stopPropagation(); },
      onsubmit: function (e) { e.preventDefault(); save(); }
    },
      el('h3', null, 'Quick capture'),
      field('Section', sectSelect),
      field('Title', titleInput),
      field('Body', bodyTa),
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn', type: 'submit' }, 'Save'),
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () { overlay.remove(); } }, 'Cancel')
      ),
      el('p', { class: 'small muted' },
        el('kbd', null, 'Enter'), ' on title to save · ',
        el('kbd', null, '⌘/Ctrl+Enter'), ' in body · ',
        el('kbd', null, 'Esc'), ' to close')
    );

    async function save() {
      var slug = sectSelect.value;
      var sec = sects.find(function (s) { return s.slug === slug; });
      if (!sec) return;
      var meta = await M.db.getMeta(sec.tab);
      if (!meta || !meta.headers) {
        flash(form, 'No schema cached for ' + slug + '. Sync first.', 'error');
        return;
      }
      var row = await addRow(sec.tab, meta.headers);
      // Try to map title/body onto the most natural columns.
      var hs = meta.headers;
      var titleVal = titleInput.value.trim();
      var bodyVal = bodyTa.value.trim();
      if (titleVal) {
        if (hs.indexOf('title') >= 0) row.title = titleVal;
        else if (hs.indexOf('name') >= 0) row.name = titleVal;
        else if (hs.indexOf('question') >= 0) row.question = titleVal;
        else if (hs.indexOf('decision') >= 0) row.decision = titleVal;
      }
      if (bodyVal) {
        if (hs.indexOf('body') >= 0) row.body = bodyVal;
        else if (hs.indexOf('notes') >= 0) row.notes = bodyVal;
        else if (hs.indexOf('description') >= 0) row.description = bodyVal;
        else if (hs.indexOf('answer') >= 0) row.answer = bodyVal;
      }
      if (hs.indexOf('created') >= 0 && !row.created) {
        row.created = new Date().toISOString();
      }
      row._dirty = 1;
      await M.db.upsertRow(sec.tab, row);
      schedulePush();
      overlay.remove();
      flash(document.body, 'Captured to ' + (sec.title || sec.slug) + '.');
    }

    titleInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
    bodyTa.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      }
    });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });

    overlay.appendChild(form);
    document.body.appendChild(overlay);
    setTimeout(function () { titleInput.focus(); }, 30);
  }

  // ---- global search overlay (`Cmd/Ctrl+K`) ----

  async function showSearch() {
    if (document.querySelector('.search-overlay')) return;
    var sects = sectionRows();
    if (!sects.length) {
      flash(document.body, 'Connect and sync first.', 'error');
      return;
    }

    var overlay = el('div', { class: 'modal-overlay search-overlay',
      onclick: function () { overlay.remove(); }
    });

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search across all sections…';
    input.className = 'search-input';

    var hint = el('p', { class: 'small muted' }, 'Type to search · ',
      el('kbd', null, '↑/↓'), ' to navigate · ',
      el('kbd', null, 'Enter'), ' to open · ',
      el('kbd', null, 'Esc'), ' to close');

    var resultsEl = el('div', { class: 'search-results' });

    var panel = el('div', { class: 'modal-panel search-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      input,
      hint,
      resultsEl
    );

    // Pre-load all visible rows once for snappy filtering.
    var corpus = [];
    await Promise.all(sects.map(async function (s) {
      try {
        var meta = await M.db.getMeta(s.tab);
        var rows = await M.db.getAllRows(s.tab);
        rows.forEach(function (r) {
          if (r._deleted) return;
          var fields = [];
          (meta && meta.headers || []).forEach(function (h) {
            if (M.render.isInternal(h)) return;
            if (h === 'id') return;
            if (r[h]) fields.push(String(r[h]));
          });
          corpus.push({ section: s, row: r, hay: fields.join('  ').toLowerCase() });
        });
      } catch (e) { /* ignore one tab */ }
    }));

    var selectedIdx = 0;
    var hits = [];

    function paint() {
      var q = input.value.trim().toLowerCase();
      if (!q) {
        resultsEl.replaceChildren(el('p', { class: 'muted small' },
          corpus.length + ' rows indexed across ' + sects.length + ' sections.'));
        hits = [];
        selectedIdx = 0;
        return;
      }
      var terms = q.split(/\s+/).filter(Boolean);
      hits = corpus.filter(function (entry) {
        return terms.every(function (t) { return entry.hay.indexOf(t) >= 0; });
      });
      if (!hits.length) {
        resultsEl.replaceChildren(el('p', { class: 'muted small' }, 'No matches.'));
        return;
      }
      hits = hits.slice(0, 30);
      if (selectedIdx >= hits.length) selectedIdx = 0;
      resultsEl.replaceChildren.apply(resultsEl, hits.map(function (h, i) {
        var label = h.row.title || h.row.name || h.row.question || h.row.decision || h.row.id;
        var sub = h.row.body || h.row.notes || h.row.description || h.row.answer || '';
        var item = el('a', {
          class: 'search-hit' + (i === selectedIdx ? ' selected' : ''),
          href: '#/s/' + encodeURIComponent(h.section.slug),
          onclick: function () { overlay.remove(); }
        },
          el('div', { class: 'search-hit-section' },
            (h.section.icon ? h.section.icon + ' ' : '') + (h.section.title || h.section.slug)),
          el('div', { class: 'search-hit-title' }, String(label)),
          sub ? el('div', { class: 'search-hit-sub' },
            String(sub).slice(0, 140)) : null
        );
        return item;
      }));
    }

    var debounceT = null;
    input.addEventListener('input', function () {
      if (debounceT) clearTimeout(debounceT);
      debounceT = setTimeout(paint, 60);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (hits.length) selectedIdx = (selectedIdx + 1) % hits.length;
        paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hits.length) selectedIdx = (selectedIdx - 1 + hits.length) % hits.length;
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (hits[selectedIdx]) {
          location.hash = '#/s/' + encodeURIComponent(hits[selectedIdx].section.slug);
          overlay.remove();
        }
      }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    paint();
    setTimeout(function () { input.focus(); }, 30);
  }

  // ---- keyboard shortcuts + help overlay ----

  function showHelp() {
    if (document.querySelector('.help-overlay')) return;
    var overlay = el('div', { class: 'help-overlay',
      onclick: function () { overlay.remove(); }
    });
    var rows = [
      ['g', 'Home'],
      ['t', 'Today'],
      ['1 – 9', 'Open the Nth section'],
      ['/', 'Quick capture'],
      ['⌘/Ctrl + K', 'Search across everything'],
      ['⌘/Ctrl + J', 'AI assistant'],
      ['q', 'Quick share'],
      ['s', 'Settings'],
      ['?', 'This panel'],
      ['Esc', 'Close overlay / cancel edit'],
      ['Enter', 'Save current edit']
    ];
    var panel = el('div', { class: 'help-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Keyboard shortcuts'),
      el('table', { class: 'kv' },
        el('tbody', null, rows.map(function (r) {
          return el('tr', null,
            el('td', null, el('kbd', null, r[0])),
            el('td', null, r[1])
          );
        }))
      ),
      el('p', { class: 'small muted' }, 'Click anywhere outside or press ', el('kbd', null, 'Esc'), ' to close.')
    );
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function closeHelp() {
    var ov = document.querySelector('.help-overlay');
    if (ov) ov.remove();
  }

  document.addEventListener('keydown', function (e) {
    // Esc closes help even if focus is in an input.
    if (e.key === 'Escape' && document.querySelector('.help-overlay')) {
      e.preventDefault();
      closeHelp();
      return;
    }
    // Cmd/Ctrl+K opens search even when focus is in an input.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      showSearch();
      return;
    }
    // Cmd/Ctrl+J opens AI assistant.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      showAI();
      return;
    }
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '?' || (e.shiftKey && e.key === '/')) { showHelp(); return; }
    if (e.key === '/') { e.preventDefault(); showCapture(); return; }
    if (e.key === 'g') { location.hash = '#/'; return; }
    if (e.key === 't') { location.hash = '#/today'; return; }
    if (e.key === 's') { location.hash = '#/settings'; return; }
    if (e.key === 'q') { location.hash = '#/share'; return; }

    // 1–9 → Nth section.
    if (/^[1-9]$/.test(e.key)) {
      var idx = parseInt(e.key, 10) - 1;
      var sects = sectionRows();
      if (sects[idx]) {
        location.hash = '#/s/' + encodeURIComponent(sects[idx].slug);
      }
    }
  });

  // ---- boot ----

  // ---- resume state ----

  var UI_KEY = 'minerva.ui.v1';
  function readUi() {
    try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeUi(patch) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(Object.assign({}, readUi(), patch))); }
    catch (e) { /* ignore */ }
  }
  var saveUiSoon = (function () {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        writeUi({ hash: location.hash, scrollY: window.scrollY, when: Date.now() });
      }, 200);
    };
  })();
  window.addEventListener('scroll', saveUiSoon, { passive: true });
  window.addEventListener('hashchange', saveUiSoon);

  // ---- push-status indicator (bottom-right pill) ----

  var pushIndicator = null;
  var pushIndicatorState = 'hidden'; // 'hidden' | 'saving' | 'error'
  var pushLastError = null;

  function ensurePushIndicator() {
    if (pushIndicator) return;
    pushIndicator = document.createElement('div');
    pushIndicator.className = 'push-indicator';
    pushIndicator.hidden = true;
    document.body.appendChild(pushIndicator);
  }
  function paintPushIndicator() {
    ensurePushIndicator();
    if (pushIndicatorState === 'hidden') {
      pushIndicator.hidden = true;
      pushIndicator.className = 'push-indicator';
      pushIndicator.replaceChildren();
      return;
    }
    pushIndicator.hidden = false;
    if (pushIndicatorState === 'saving') {
      pushIndicator.className = 'push-indicator';
      pushIndicator.replaceChildren(document.createTextNode('Saving…'));
    } else if (pushIndicatorState === 'error') {
      pushIndicator.className = 'push-indicator push-error';
      pushIndicator.replaceChildren(
        el('span', null, 'Sync failed'),
        el('button', {
          type: 'button',
          class: 'push-retry',
          title: pushLastError ? String(pushLastError) : '',
          onclick: function () {
            pushIndicatorState = 'hidden';
            paintPushIndicator();
            schedulePush();
          }
        }, 'Retry'),
        el('button', {
          type: 'button',
          class: 'push-dismiss',
          title: 'Dismiss',
          'aria-label': 'Dismiss',
          onclick: function () {
            pushIndicatorState = 'hidden';
            paintPushIndicator();
          }
        }, '×')
      );
    }
  }

  // ---- service worker registration + offline indicator ---------------

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return; // never registers from file://
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('[Minerva sw]', e);
    });
  }

  var offlineIndicator = null;
  function ensureOfflineIndicator() {
    if (offlineIndicator) return;
    offlineIndicator = document.createElement('div');
    offlineIndicator.className = 'offline-indicator';
    offlineIndicator.hidden = true;
    offlineIndicator.textContent = 'Offline — local edits will sync when you reconnect';
    document.body.appendChild(offlineIndicator);
  }
  function paintOnlineState() {
    ensureOfflineIndicator();
    offlineIndicator.hidden = navigator.onLine !== false;
  }

  async function boot() {
    bindPicker();
    ensurePushIndicator();
    ensureOfflineIndicator();
    paintOnlineState();
    window.addEventListener('online', function () {
      paintOnlineState();
      // a transition online → trigger any pending pushes
      if (pushPending || (!pushInFlight)) schedulePush();
    });
    window.addEventListener('offline', paintOnlineState);
    registerServiceWorker();
    await refreshConfig();

    // Restore last view if the user landed on a bare URL.
    if (!location.hash || location.hash === '' || location.hash === '#') {
      var s = readUi();
      if (s && s.hash && s.hash !== '#/' && s.hash !== '#') {
        // only restore if the saved hash is recent (< 7 days)
        if (!s.when || Date.now() - s.when < 7 * 86400000) {
          location.hash = s.hash;
        }
      }
    }
    await route();
    var s2 = readUi();
    if (s2 && s2.hash === location.hash && s2.scrollY) {
      setTimeout(function () { window.scrollTo(0, s2.scrollY); }, 60);
    }
    scheduleReminders();
  }

  window.addEventListener('hashchange', route);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
