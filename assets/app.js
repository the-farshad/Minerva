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

  // Active section view's keyboard context — set by viewSection while it's
  // mounted, cleared when the route changes away.
  var sectionCtx = null;

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
    var items = [{ hash: '#/', label: 'Home', icon: 'home' }];
    var cfg = readConfig();
    var hasSheet = !!cfg.spreadsheetId;
    if (hasSheet) {
      items.push({ hash: '#/today', label: 'Today', icon: 'sun', badge: 'today' });
      items.push({ hash: '#/schedule', label: 'Schedule', icon: 'calendar-clock' });
      sectionRows().forEach(function (r) {
        items.push({
          hash: '#/s/' + encodeURIComponent(r.slug),
          label: r.title || r.slug,
          icon: r.icon,
          badge: r.tab === 'tasks' ? 'tasks' : null
        });
      });
    }
    items.push({ hash: '#/share', label: 'Quick share', icon: 'qr-code' });
    items.push({ hash: '#/settings', label: 'Settings', icon: 'settings' });

    navEl.innerHTML = '';
    items.forEach(function (it) {
      var a = el('a', {
        href: it.hash,
        class: 'nav-link' + (it.hash === active ? ' active' : ''),
        'data-badge': it.badge || ''
      });
      if (it.icon) a.appendChild(M.render.icon(it.icon));
      a.appendChild(document.createTextNode(it.label));
      navEl.appendChild(a);
    });
    M.render.refreshIcons();
    if (hasSheet) paintNavBadges();
  }

  async function paintNavBadges() {
    try {
      var today = todayStr();
      // Pending tasks (status != done, due present and today/before today, or no due).
      var pendingTasks = 0;
      var dueOrOverdueToday = 0;
      var tasks = await M.db.getAllRows('tasks').catch(function () { return []; });
      tasks.forEach(function (r) {
        if (r._deleted) return;
        if (String(r.status || '').toLowerCase() === 'done') return;
        pendingTasks++;
        if (r.due && String(r.due).slice(0, 10) <= today) dueOrOverdueToday++;
      });

      // Habits not done today.
      var habitsLeft = 0;
      try {
        var habits = (await M.db.getAllRows('habits')).filter(function (h) { return !h._deleted; });
        var logs = (await M.db.getAllRows('habit_log')).filter(function (l) { return !l._deleted; });
        var doneSet = {};
        logs.forEach(function (l) {
          if (String(l.date).slice(0, 10) === today) doneSet[l.habit_id] = true;
        });
        habitsLeft = habits.filter(function (h) { return !doneSet[h.id]; }).length;
      } catch (e) { /* ignore */ }

      var todayCount = dueOrOverdueToday + habitsLeft;

      navEl.querySelectorAll('a[data-badge]').forEach(function (a) {
        var kind = a.getAttribute('data-badge');
        // remove any existing badge node
        var existing = a.querySelector('.nav-badge');
        if (existing) existing.remove();
        var n = 0;
        if (kind === 'today') n = todayCount;
        else if (kind === 'tasks') n = pendingTasks;
        if (n > 0) {
          var badge = document.createElement('span');
          badge.className = 'nav-badge';
          badge.textContent = n > 99 ? '99+' : String(n);
          a.appendChild(badge);
        }
      });
    } catch (e) { /* non-fatal */ }
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
        var iconWrap = el('div', { class: 'section-card-icon' });
        iconWrap.appendChild(M.render.icon(r.icon || 'circle'));
        return el('a', { class: 'section-card', href: '#/s/' + encodeURIComponent(r.slug) },
          iconWrap,
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
        // Refresh nav badges after a push so counts reflect newest state.
        try { paintNavBadges(); } catch (e) { /* ignore */ }
      }
    })();
    return pushInFlight;
  }

  // ---- undo stack ---------------------------------------------------

  var UNDO_KEY = 'minerva.undo.v1';
  var UNDO_MAX = 50;

  function readUndoStack() {
    try { return JSON.parse(localStorage.getItem(UNDO_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeUndoStack(stack) {
    try { localStorage.setItem(UNDO_KEY, JSON.stringify(stack.slice(-UNDO_MAX))); }
    catch (e) { /* ignore */ }
  }
  function pushUndo(entry) {
    var s = readUndoStack();
    entry.ts = Date.now();
    s.push(entry);
    writeUndoStack(s);
  }
  function popUndo() {
    var s = readUndoStack();
    if (!s.length) return null;
    var last = s.pop();
    writeUndoStack(s);
    return last;
  }

  async function undo() {
    var entry = popUndo();
    if (!entry) {
      flash(document.body, 'Nothing to undo.');
      return;
    }
    try {
      if (entry.kind === 'edit') {
        var row = await M.db.getRow(entry.tab, entry.rowId);
        if (!row) { flash(document.body, 'Row no longer exists.'); return; }
        row[entry.field] = (entry.prevValue == null) ? '' : entry.prevValue;
        row._updated = new Date().toISOString();
        row._dirty = 1;
        await M.db.upsertRow(entry.tab, row);
        flash(document.body, 'Undid edit on ' + entry.field + '.');
      } else if (entry.kind === 'add') {
        var addedRow = await M.db.getRow(entry.tab, entry.rowId);
        if (!addedRow) { flash(document.body, 'Row already gone.'); return; }
        addedRow._deleted = 1;
        addedRow._dirty = 1;
        addedRow._updated = new Date().toISOString();
        await M.db.upsertRow(entry.tab, addedRow);
        flash(document.body, 'Undid add — row deleted.');
      } else if (entry.kind === 'delete') {
        var snap = entry.snapshot;
        if (!snap || !snap.id) {
          flash(document.body, 'Snapshot lost — cannot restore.', 'error');
          return;
        }
        snap._deleted = 0;
        snap._dirty = 1;
        snap._updated = new Date().toISOString();
        await M.db.upsertRow(entry.tab, snap);
        flash(document.body, 'Undid delete — row restored.');
      }
      schedulePush();
      // Re-render current view if it's a list/today view that displays this data.
      var h = location.hash;
      if (h === '#/' || h === '#/today' || /^#\/s\//.test(h)) await route();
    } catch (err) {
      flash(document.body, 'Undo failed: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  async function commitCellEdit(tab, rowId, columnName, newValue) {
    var row = await M.db.getRow(tab, rowId);
    if (!row) return;
    if (row[columnName] === newValue) return;
    var prevStatus = row.status;
    var prevValue = row[columnName];
    pushUndo({ kind: 'edit', tab: tab, rowId: rowId, field: columnName, prevValue: prevValue });
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
    pushUndo({ kind: 'add', tab: tab, rowId: row.id });
    schedulePush();
    return row;
  }

  async function deleteRow(tab, rowId) {
    var row = await M.db.getRow(tab, rowId);
    if (!row) return;
    // Take a snapshot before flipping _deleted so undo can restore it.
    var snapshot = Object.assign({}, row);
    delete snapshot.tab; // tab is a key in the IndexedDB record, not row data
    pushUndo({ kind: 'delete', tab: tab, rowId: rowId, snapshot: snapshot });
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
    // Per-section accent: if the user added a `color` column to _config,
    // use that value as --accent for everything inside the section view.
    if (sec.color && /^#?[0-9a-f]{3,8}$|^rgb|^hsl/i.test(String(sec.color).trim())) {
      var c = String(sec.color).trim();
      if (/^[0-9a-f]{3,8}$/i.test(c)) c = '#' + c;
      view.style.setProperty('--accent', c);
      view.style.setProperty('--accent-2', c);
    }
    var header = el('div', { class: 'view-section-head' });
    var meta1Span = el('span');
    var addBtn = el('button', { class: 'btn', type: 'button' }, '+ Add row');
    // Single 'Import ▾' control that opens a small menu with both
    // import flows — keeps the section header tidy without removing
    // either path.
    var importWrap = el('div', { class: 'import-wrap' });
    var importMenu = null;
    var importBtn = el('button', { class: 'btn btn-ghost', type: 'button',
      title: 'Add rows: from URL (arXiv/YouTube), or paste CSV/TSV',
      onclick: function (e) {
        e.stopPropagation();
        if (importMenu) { importMenu.remove(); importMenu = null; return; }
        importMenu = el('div', { class: 'import-menu' });
        var pick = function (label, hint, run) {
          var item = el('button', { type: 'button', class: 'import-menu-item',
            onclick: function (ev) { ev.stopPropagation(); importMenu.remove(); importMenu = null; run(); }
          },
            el('div', { class: 'import-menu-label' }, label),
            el('div', { class: 'import-menu-hint' }, hint)
          );
          importMenu.appendChild(item);
        };
        pick('From URL', 'arXiv id, YouTube URL, web page', function () { showUrlImport(sec.tab); });
        pick('Paste CSV / TSV', 'Bulk-import rows from a clipboard paste', function () { showCsvImport(sec.tab); });
        importWrap.appendChild(importMenu);
        var close = function (ev) {
          if (importMenu && !importMenu.contains(ev.target) && ev.target !== importBtn) {
            importMenu.remove(); importMenu = null;
            document.removeEventListener('click', close);
          }
        };
        setTimeout(function () { document.addEventListener('click', close); }, 0);
      }
    }, 'Import ▾');
    importWrap.appendChild(importBtn);
    var modeToggle = el('div', { class: 'seg seg-mode' });
    var calNav = el('div', { class: 'cal-nav' });
    var filterInput = el('input', {
      type: 'search', placeholder: 'Filter rows…', class: 'section-filter'
    });
    var viewsBar = el('div', { class: 'saved-views' });

    var titleH2 = el('h2');
    if (sec.icon) titleH2.appendChild(M.render.icon(sec.icon));
    titleH2.appendChild(document.createTextNode(sec.title || sec.slug));
    header.appendChild(titleH2);
    var headerRight = el('div', { class: 'view-section-head-right' }, filterInput, modeToggle, calNav, importWrap, addBtn);
    header.appendChild(headerRight);
    view.appendChild(header);
    view.appendChild(viewsBar);
    view.appendChild(el('p', { class: 'lead' }, meta1Span, sheetLink ? ' · ' : null, sheetLink));

    var bulkBar = el('div', { class: 'bulk-bar', hidden: true });
    view.appendChild(bulkBar);
    var bodyHost = el('div');
    view.appendChild(bodyHost);
    var hint = el('p', { class: 'small muted' });
    view.appendChild(hint);

    // Selection state for bulk ops, scoped to this view instance.
    var selectedIds = new Set();

    function paintBulkBar() {
      if (selectedIds.size === 0 || mode !== 'list') {
        bulkBar.hidden = true;
        bulkBar.replaceChildren();
        return;
      }
      bulkBar.hidden = false;
      // Decide if BibTeX makes sense — only when at least one selected row
      // has the necessary authors+title fields.
      var bibtexEligible = false;
      bulkBar.replaceChildren(
        el('span', { class: 'bulk-count' }, selectedIds.size + ' selected'),
        el('button', { class: 'btn', type: 'button',
          onclick: async function () {
            var meta = await M.db.getMeta(sec.tab);
            if (!meta || (meta.headers || []).indexOf('status') < 0) {
              flash(view, 'No status column on this section.', 'error');
              return;
            }
            var ids = Array.from(selectedIds);
            for (var i = 0; i < ids.length; i++) {
              var row = await M.db.getRow(sec.tab, ids[i]);
              if (!row) continue;
              var prev = row.status;
              if (String(prev || '').toLowerCase() === 'done') continue;
              pushUndo({ kind: 'edit', tab: sec.tab, rowId: row.id, field: 'status', prevValue: prev });
              row.status = 'done';
              row._updated = new Date().toISOString();
              row._dirty = 1;
              await M.db.upsertRow(sec.tab, row);
              if (row.recurrence) { try { await spawnRecurrence(sec.tab, row); } catch (e) { /* ignore */ } }
            }
            schedulePush();
            selectedIds.clear();
            await refresh();
            flash(view, 'Marked ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + ' as done.');
          }
        }, 'Mark done'),
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: async function () {
            var n = selectedIds.size;
            if (!confirm('Delete ' + n + ' row' + (n === 1 ? '' : 's') + '? This is undoable until your next ' + UNDO_MAX + '-deep operation.')) return;
            var ids = Array.from(selectedIds);
            for (var i = 0; i < ids.length; i++) {
              await deleteRow(sec.tab, ids[i]);
            }
            selectedIds.clear();
            await refresh();
            flash(view, 'Deleted ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + '.');
          }
        }, 'Delete'),
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: async function () {
            var ids = Array.from(selectedIds);
            var entries = [];
            for (var i = 0; i < ids.length; i++) {
              var row = await M.db.getRow(sec.tab, ids[i]);
              if (row && rowHasBibtex(row)) entries.push(rowToBibtex(row));
            }
            if (!entries.length) {
              flash(view, 'No selected rows have author + title fields.', 'error');
              return;
            }
            var blob = entries.join('\n\n');
            try {
              await navigator.clipboard.writeText(blob);
              flash(view, 'Copied BibTeX for ' + entries.length + ' row' + (entries.length === 1 ? '' : 's') + '.');
            } catch (err) {
              console.log(blob);
              flash(view, 'Clipboard unavailable — see console.', 'error');
            }
          }
        }, 'Copy BibTeX'),
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () {
            selectedIds.clear();
            paintBulkBar();
            // re-render to clear checkbox state
            var rows = bodyHost.querySelectorAll('tbody tr.is-bulk-selected');
            rows.forEach(function (r) {
              r.classList.remove('is-bulk-selected');
              var cb = r.querySelector('.bulk-cb');
              if (cb) cb.checked = false;
            });
            var head = bodyHost.querySelector('thead .bulk-cb-all');
            if (head) head.checked = false;
          }
        }, 'Clear')
      );
    }

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
        bodyHost.replaceChildren(renderSectionTable(meta, filtered, sec.tab, refresh, userSort, onSortChange, backlinks, selectedIds, paintBulkBar));
        hint.replaceChildren(
          'Click any cell to edit. Click a column header to sort. Tick the checkboxes to select rows for bulk actions. ',
          el('kbd', null, 'Enter'), ' to save, ',
          el('kbd', null, 'Esc'), ' to cancel.'
        );
      }

      paintBacklinksFooter(backlinks);
      paintBulkBar();
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

    // Wire j/k/e/x/c row-navigation when this view is the active route.
    var selectedIndex = -1;
    function rowsInDom() { return bodyHost.querySelectorAll('tbody tr[data-rowid]'); }
    function setSelection(idx, scroll) {
      var trs = rowsInDom();
      if (!trs.length) { selectedIndex = -1; return; }
      var prev = bodyHost.querySelector('tr.is-selected');
      if (prev) prev.classList.remove('is-selected');
      selectedIndex = Math.max(0, Math.min(trs.length - 1, idx));
      trs[selectedIndex].classList.add('is-selected');
      if (scroll !== false) trs[selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    sectionCtx = {
      slug: slug,
      tab: sec.tab,
      mode: function () { return mode; },
      refresh: refresh,
      moveSelection: function (delta) {
        if (mode !== 'list') return;
        var trs = rowsInDom();
        if (!trs.length) return;
        if (selectedIndex < 0) setSelection(delta > 0 ? 0 : trs.length - 1);
        else setSelection(selectedIndex + delta);
      },
      editSelected: function () {
        if (mode !== 'list' || selectedIndex < 0) return;
        var tr = rowsInDom()[selectedIndex];
        if (!tr) return;
        var firstTd = tr.querySelector('td[data-col]');
        if (firstTd) firstTd.click();
      },
      detailSelected: function () {
        if (mode !== 'list' || selectedIndex < 0) return;
        var tr = rowsInDom()[selectedIndex];
        if (!tr) return;
        var rowId = tr.dataset.rowid;
        if (rowId) showRowDetail(sec.tab, rowId);
      },
      deleteSelected: async function () {
        if (mode !== 'list' || selectedIndex < 0) return;
        var tr = rowsInDom()[selectedIndex];
        if (!tr) return;
        var rowId = tr.dataset.rowid;
        if (!rowId) return;
        if (!confirm('Delete this row?')) return;
        await deleteRow(sec.tab, rowId);
        await refresh();
        // try to keep cursor near the deleted row
        var newTrs = rowsInDom();
        if (newTrs.length) setSelection(Math.min(selectedIndex, newTrs.length - 1), false);
      },
      toggleDoneSelected: async function () {
        if (mode !== 'list' || selectedIndex < 0) return;
        var tr = rowsInDom()[selectedIndex];
        if (!tr) return;
        var rowId = tr.dataset.rowid;
        if (!rowId) return;
        var row = await M.db.getRow(sec.tab, rowId);
        if (!row) return;
        var headers = (await M.db.getMeta(sec.tab)).headers || [];
        if (headers.indexOf('status') < 0) {
          flash(view, 'No status column on this section.', 'error');
          return;
        }
        var prevStatus = row.status;
        var nowDone = String(row.status || '').toLowerCase() !== 'done';
        row.status = nowDone ? 'done' : 'todo';
        row._updated = new Date().toISOString();
        row._dirty = 1;
        await M.db.upsertRow(sec.tab, row);
        schedulePush();
        if (nowDone && row.recurrence) {
          try { await spawnRecurrence(sec.tab, row); } catch (e) { /* ignore */ }
        }
        await refresh();
      }
    };

    await refresh();
    return view;
  }

  // ---- when-to-meet group availability poll -------------------------

  function viewMeetNew() {
    var view = el('section', { class: 'view view-meet' });
    var titleH2 = el('h2');
    titleH2.appendChild(M.render.icon('users'));
    titleH2.appendChild(document.createTextNode(' When to meet'));
    view.appendChild(titleH2);
    view.appendChild(el('p', { class: 'lead' },
      'Make a group-availability poll. Pick a date range and a daily time window; everyone you share the link with marks the slots they\'re free, copies a response token, and sends it back. Paste responses together to see overlapping availability — no backend, no accounts, no data leaves your browser unless you share it.'
    ));

    var today = new Date();
    var weekFromNow = new Date(today.getTime() + 7 * 86400000);
    function isoDate(d) { return d.toISOString().slice(0, 10); }

    var titleInput = el('input', { type: 'text', class: 'editor', placeholder: 'e.g. Project kick-off' });
    var startInput = el('input', { type: 'date', class: 'editor', value: isoDate(today) });
    var endInput = el('input', { type: 'date', class: 'editor', value: isoDate(weekFromNow) });
    var fromInput = el('input', { type: 'number', class: 'editor', min: '0', max: '23', value: '9' });
    var toInput = el('input', { type: 'number', class: 'editor', min: '1', max: '24', value: '18' });
    var slotInput = el('input', { type: 'number', class: 'editor', min: '15', max: '120', step: '15', value: '30' });
    var noteInput = el('input', { type: 'text', class: 'editor', placeholder: 'Optional note shown to participants' });

    var output = el('div', { class: 'meet-output' });

    function buildLink() {
      try {
        var poll = M.meet.build({
          title: titleInput.value.trim(),
          start: startInput.value, end: endInput.value,
          fromHour: parseInt(fromInput.value, 10) || 9,
          toHour: parseInt(toInput.value, 10) || 18,
          slotMin: parseInt(slotInput.value, 10) || 30,
          note: noteInput.value.trim()
        });
        if (!poll.days.length || !poll.slots.length) {
          output.replaceChildren(el('p', { class: 'muted' }, 'Pick a valid range + window.'));
          return;
        }
        var token = M.meet.encodePoll(poll);
        var url = location.origin + location.pathname + '#/meet/' + token;
        var urlInput = el('input', { type: 'text', readonly: true, class: 'url', value: url });
        var qr = M.qr(url, { ec: 'M', margin: 2 });
        qr.classList.add('qr');
        output.replaceChildren(
          el('p', { class: 'small muted' },
            poll.days.length + ' day' + (poll.days.length === 1 ? '' : 's') + ' · ',
            poll.slots.length + ' slot' + (poll.slots.length === 1 ? '' : 's') + '/day · ',
            'shareable URL below'
          ),
          el('div', { class: 'link-row' },
            urlInput,
            el('button', { class: 'btn', type: 'button',
              onclick: function () {
                urlInput.select();
                if (navigator.clipboard) navigator.clipboard.writeText(url);
                flash(output, 'Link copied');
              } }, 'Copy link'),
            el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, 'Preview ↗')
          ),
          el('div', { class: 'qr-wrap' },
            qr,
            el('div', { class: 'qr-actions' },
              el('button', { class: 'btn btn-ghost', type: 'button',
                onclick: function () { M.downloadPng(qr, 'minerva-meeting.png'); }
              }, 'Download QR'))
          )
        );
      } catch (err) {
        output.replaceChildren(el('p', { class: 'error' }, 'Build failed: ' + (err.message || err)));
      }
    }

    var debounce = null;
    [titleInput, startInput, endInput, fromInput, toInput, slotInput, noteInput].forEach(function (i) {
      i.addEventListener('input', function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(buildLink, 200);
      });
    });

    var form = el('div', { class: 'avail-form' },
      field('Title', titleInput),
      field('Note', noteInput),
      field('From', startInput),
      field('To', endInput),
      field('Daily start (hour)', fromInput),
      field('Daily end (hour)', toInput),
      field('Slot length (min)', slotInput)
    );
    view.appendChild(form);
    view.appendChild(output);
    buildLink();
    return view;
  }

  function buildSlotGrid(poll, opts) {
    opts = opts || {};
    var rows = poll.slots.length;
    var cols = poll.days.length;
    // 0 = unselected, 1 = selected. Optionally, opts.heat is a 2D array of
    // counts to render as background intensity.
    var grid = [];
    for (var i = 0; i < rows; i++) { grid[i] = []; for (var j = 0; j < cols; j++) grid[i][j] = 0; }
    if (opts.initial) {
      opts.initial.forEach(function (idx) {
        var r = idx % rows;
        var c = Math.floor(idx / rows);
        if (r < rows && c < cols) grid[r][c] = 1;
      });
    }

    var wrap = el('div', { class: 'meet-grid-wrap' });
    var maxHeat = 1;
    if (opts.heat) {
      opts.heat.forEach(function (row) { row.forEach(function (n) { if (n > maxHeat) maxHeat = n; }); });
    }

    var head = el('div', { class: 'meet-grid-head' });
    head.appendChild(el('div', { class: 'meet-grid-corner' }));
    poll.days.forEach(function (d) {
      var lbl = M.meet.dayLabel(d);
      var col = el('div', { class: 'meet-grid-col-head' },
        el('div', { class: 'meet-grid-weekday' }, lbl.weekday),
        el('div', { class: 'meet-grid-monthday' }, lbl.monthDay)
      );
      head.appendChild(col);
    });
    wrap.appendChild(head);

    var body = el('div', { class: 'meet-grid-body' });
    for (var r = 0; r < rows; r++) {
      var row = el('div', { class: 'meet-grid-row' });
      row.appendChild(el('div', { class: 'meet-grid-time' }, poll.slots[r]));
      for (var c = 0; c < cols; c++) {
        (function (rr, cc) {
          var cell = document.createElement('div');
          cell.className = 'meet-grid-cell';
          cell.dataset.r = rr; cell.dataset.c = cc;
          if (opts.heat) {
            var n = opts.heat[rr][cc];
            if (n > 0) {
              cell.classList.add('meet-heat');
              cell.style.setProperty('--heat', String(n / maxHeat));
              cell.title = n + ' available';
            }
          }
          if (grid[rr][cc]) cell.classList.add('selected');
          row.appendChild(cell);
        })(r, c);
      }
      body.appendChild(row);
    }
    wrap.appendChild(body);

    // Drag-select. mousedown / touchstart decides whether we're adding or
    // removing (based on the starting cell's current state), then
    // mouseover / touchmove applies the same op to every cell traversed.
    if (!opts.readonly) {
      var dragging = false;
      var addMode = true;
      function paintCell(cell, on) {
        var rr = +cell.dataset.r;
        var cc = +cell.dataset.c;
        grid[rr][cc] = on ? 1 : 0;
        cell.classList.toggle('selected', !!on);
      }

      body.addEventListener('mousedown', function (e) {
        var cell = e.target.closest('.meet-grid-cell');
        if (!cell) return;
        e.preventDefault();
        dragging = true;
        addMode = !cell.classList.contains('selected');
        paintCell(cell, addMode);
      });
      body.addEventListener('mouseover', function (e) {
        if (!dragging) return;
        var cell = e.target.closest('.meet-grid-cell');
        if (!cell) return;
        paintCell(cell, addMode);
      });

      body.addEventListener('touchstart', function (e) {
        var cell = e.target.closest('.meet-grid-cell');
        if (!cell) return;
        e.preventDefault();
        dragging = true;
        addMode = !cell.classList.contains('selected');
        paintCell(cell, addMode);
      }, { passive: false });
      body.addEventListener('touchmove', function (e) {
        if (!dragging) return;
        e.preventDefault();
        var t = e.touches[0];
        if (!t) return;
        var hit = document.elementFromPoint(t.clientX, t.clientY);
        var cell = hit && hit.closest && hit.closest('.meet-grid-cell');
        if (cell && body.contains(cell)) paintCell(cell, addMode);
      }, { passive: false });

      var stopDrag = function () { dragging = false; };
      window.addEventListener('mouseup', stopDrag);
      window.addEventListener('touchend', stopDrag);
      window.addEventListener('touchcancel', stopDrag);
    }

    return {
      el: wrap,
      readGrid: function () { return grid; },
      readYes: function () {
        var out = [];
        for (var rr = 0; rr < rows; rr++) {
          for (var cc = 0; cc < cols; cc++) {
            if (grid[rr][cc]) out.push(cc * rows + rr);
          }
        }
        return out;
      }
    };
  }

  function viewMeetParticipant(token) {
    var poll;
    try { poll = M.meet.decodePoll(token); }
    catch (e) {
      return el('section', { class: 'view' },
        el('h2', null, 'Invalid meeting link'),
        el('p', null, 'This poll URL is malformed or truncated.'),
        el('p', null, el('a', { href: '#/meet/new' }, 'Create a new poll →'))
      );
    }
    var view = el('section', { class: 'view view-meet' });
    view.appendChild(el('h2', null, poll.t || 'Group availability'));
    if (poll.n) view.appendChild(el('p', { class: 'lead' }, poll.n));
    view.appendChild(el('p', { class: 'small muted' },
      'Click cells (or drag) to mark when you\'re free. Times are in your local time zone (',
      el('em', null, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
      '). When done, fill in your name and copy the response token to send back to the organizer.'
    ));

    var grid = buildSlotGrid(poll);
    view.appendChild(grid.el);

    var nameInput = el('input', { type: 'text', class: 'editor', placeholder: 'Your name' });
    var output = el('div', { class: 'meet-output' });

    var submitBtn = el('button', { class: 'btn', type: 'button',
      onclick: function () {
        var name = nameInput.value.trim();
        if (!name) {
          flash(view, 'Type your name first.', 'error');
          nameInput.focus();
          return;
        }
        var yes = grid.readYes();
        if (!yes.length) {
          flash(view, 'Mark at least one slot.', 'error');
          return;
        }
        var resp = { v: 1, name: name, yes: yes };
        var rtoken = M.meet.encodeResponse(resp);
        var aggregateUrl = location.origin + location.pathname + '#/meet/' + token + '/' + rtoken;
        var subject = 'Re: ' + (poll.t || 'meeting availability');
        var bodyText =
          name + ' marked ' + yes.length + ' available slot' + (yes.length === 1 ? '' : 's') +
          ' for "' + (poll.t || 'meeting') + '".\n\n' +
          'Open this link to add my response to the aggregate view:\n' + aggregateUrl + '\n';

        var actions = [];
        // Native share — opens iOS/Android share sheet, also works on
        // Chromium desktop (Windows / ChromeOS) and Safari on macOS.
        if (navigator.share) {
          var shareBtn = el('button', { class: 'btn', type: 'button',
            onclick: function () {
              navigator.share({
                title: poll.t || 'Meeting availability',
                text: bodyText,
                url: aggregateUrl
              }).catch(function () { /* user cancelled */ });
            } });
          shareBtn.appendChild(M.render.icon('share-2'));
          shareBtn.appendChild(document.createTextNode(' Share'));
          actions.push(shareBtn);
        }

        var mailto = poll.o
          ? 'mailto:' + encodeURIComponent(poll.o) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(bodyText)
          : 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(bodyText);
        var emailA = el('a', { class: 'btn btn-ghost', href: mailto });
        emailA.appendChild(M.render.icon('mail'));
        emailA.appendChild(document.createTextNode(' Email'));
        actions.push(emailA);

        // Telegram share-link via tg://msg_url; falls back to t.me URL.
        var tgUrl = 'https://t.me/share/url?url=' + encodeURIComponent(aggregateUrl) + '&text=' + encodeURIComponent(bodyText);
        var tgA = el('a', { class: 'btn btn-ghost', href: tgUrl, target: '_blank', rel: 'noopener' });
        tgA.appendChild(M.render.icon('send'));
        tgA.appendChild(document.createTextNode(' Telegram'));
        actions.push(tgA);

        // WhatsApp share — wa.me/?text=...
        var waUrl = 'https://wa.me/?text=' + encodeURIComponent(bodyText + '\n' + aggregateUrl);
        var waA = el('a', { class: 'btn btn-ghost', href: waUrl, target: '_blank', rel: 'noopener' });
        waA.appendChild(M.render.icon('message-circle'));
        waA.appendChild(document.createTextNode(' WhatsApp'));
        actions.push(waA);

        var urlInput = el('input', { type: 'text', readonly: true, class: 'url', value: aggregateUrl });
        var copyBtn = el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () {
            urlInput.select();
            if (navigator.clipboard) navigator.clipboard.writeText(aggregateUrl);
            flash(output, 'URL copied');
          } });
        copyBtn.appendChild(M.render.icon('copy'));
        copyBtn.appendChild(document.createTextNode(' Copy URL'));
        actions.push(copyBtn);

        output.replaceChildren(
          el('p', { class: 'small' }, 'Send your response back to the organizer:'),
          el('div', { class: 'meet-share-row' }, actions),
          el('div', { class: 'link-row' }, urlInput)
        );
        M.render.refreshIcons();
      }
    }, 'Generate response');

    view.appendChild(el('div', { class: 'meet-submit' },
      field('Your name', nameInput),
      el('div', { class: 'form-actions' }, submitBtn)
    ));
    view.appendChild(output);
    return view;
  }

  function viewMeetAggregate(pollToken, responsesPart) {
    var poll;
    try { poll = M.meet.decodePoll(pollToken); }
    catch (e) {
      return el('section', { class: 'view' },
        el('h2', null, 'Invalid meeting link'),
        el('p', null, 'The poll part of this URL is malformed.')
      );
    }
    var responseTokens = String(responsesPart || '').split(';').filter(Boolean);
    var responses = [];
    var failed = 0;
    responseTokens.forEach(function (t) {
      try { responses.push(M.meet.decodeResponse(t)); }
      catch (e) { failed++; }
    });

    var rows = poll.slots.length;
    var cols = poll.days.length;
    var heat = [];
    for (var r = 0; r < rows; r++) { heat[r] = []; for (var c = 0; c < cols; c++) heat[r][c] = 0; }
    responses.forEach(function (resp) {
      (resp.yes || []).forEach(function (idx) {
        var rr = idx % rows;
        var cc = Math.floor(idx / rows);
        if (rr < rows && cc < cols) heat[rr][cc]++;
      });
    });

    var view = el('section', { class: 'view view-meet' });
    view.appendChild(el('h2', null, poll.t || 'Group availability — results'));
    view.appendChild(el('p', { class: 'lead' },
      responses.length + ' response' + (responses.length === 1 ? '' : 's'),
      failed > 0 ? ' (· ' + failed + ' couldn\'t be parsed)' : '',
      '. Cells darken with the number of people available.'
    ));

    if (responses.length) {
      view.appendChild(el('p', { class: 'small muted' },
        responses.map(function (r) { return r.name; }).join(' · ')));
    }

    var grid = buildSlotGrid(poll, { heat: heat, readonly: true });
    view.appendChild(grid.el);

    // Best-slot summary: which cells have the maximum count? Surface them
    // in a small list so the organizer doesn't have to squint at the heatmap.
    var bestCount = 0;
    heat.forEach(function (row) { row.forEach(function (n) { if (n > bestCount) bestCount = n; }); });
    if (bestCount > 0) {
      var bestSlots = [];
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          if (heat[r][c] === bestCount) {
            bestSlots.push({
              date: poll.days[c],
              time: poll.slots[r],
              r: r, c: c
            });
          }
        }
      }
      // Mark the best cells visually
      setTimeout(function () {
        bestSlots.forEach(function (s) {
          var cell = grid.el.querySelector('.meet-grid-cell[data-r="' + s.r + '"][data-c="' + s.c + '"]');
          if (cell) cell.classList.add('meet-best');
        });
      }, 0);
      var bestEl = el('div', { class: 'meet-best-summary' },
        el('h3', null,
          M.render.icon('sparkles'),
          ' Best slot' + (bestSlots.length === 1 ? '' : 's'),
          el('span', { class: 'small muted' }, '  ' + bestCount + ' / ' + responses.length + ' available')
        ),
        el('ul', { class: 'avail-list' }, bestSlots.slice(0, 12).map(function (s) {
          var d = new Date(s.date + 'T' + s.time + ':00');
          return el('li', null, d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + '  ' + s.time);
        }))
      );
      view.appendChild(bestEl);
    }

    var addInput = el('input', { type: 'text', class: 'editor', placeholder: 'Paste a response URL or token to add' });
    addInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var raw = addInput.value.trim();
        if (!raw) return;
        var t = raw.replace(/^.*\//, ''); // accept full URL or just token
        var current = responseTokens.slice();
        current.push(t);
        location.hash = '#/meet/' + pollToken + '/' + current.join(';');
      }
    });

    view.appendChild(el('div', { class: 'form-actions' },
      el('label', { class: 'small' }, 'Add response: ', addInput),
      el('a', { class: 'btn btn-ghost', href: '#/meet/' + pollToken, target: '_blank', rel: 'noopener' }, 'Open participant view ↗')
    ));

    view.appendChild(el('p', { class: 'small muted' },
      'Bookmark or copy this URL to keep aggregating — every response token is in the URL hash itself, so this page is its own database.'
    ));

    return view;
  }

  // ---- schedule view + availability sharing -------------------------

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function fmtTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  async function viewSchedule() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false };
    if (!cfg.spreadsheetId || !st.hasToken) {
      return el('section', { class: 'view' },
        el('h2', null, 'Schedule'),
        el('p', null, 'Connect first.'),
        el('p', null, el('a', { href: '#/settings' }, 'Open Settings →'))
      );
    }

    var view = el('section', { class: 'view view-schedule' });
    var titleH2 = el('h2');
    titleH2.appendChild(M.render.icon('calendar-clock'));
    titleH2.appendChild(document.createTextNode(' Schedule  '));
    titleH2.appendChild(el('span', { class: 'small muted' }, 'next 7 days'));
    view.appendChild(titleH2);

    var actionRow = el('div', { class: 'cta-row' },
      el('button', { class: 'btn', type: 'button',
        onclick: function () { showAvailabilityShare(); }
      }, 'Share my availability'),
      el('a', { class: 'btn btn-ghost', href: '#/meet/new' }, 'When to meet — group poll →'),
      el('a', { class: 'btn btn-ghost', href: '#/today' }, 'Today →')
    );
    view.appendChild(actionRow);

    view.appendChild(el('p', { class: 'small muted' },
      'Busy blocks come from any tab with start + end datetime columns ',
      '(e.g., the ', el('code', null, 'events'), ' preset) plus tasks with a ',
      el('code', null, 'due'), ' date. Free slots are computed inside ',
      el('code', null, '09:00–18:00'), ' Mon–Fri.'
    ));

    var rangeStart = startOfDay(new Date());
    var rangeEnd = new Date(rangeStart.getTime() + 7 * 86400000);
    var busy;
    try { busy = await M.schedule.collectBusy({ start: rangeStart, end: rangeEnd, workStart: 9 }); }
    catch (e) { busy = []; }
    var slots;
    try { slots = M.schedule.freeSlots(busy, { start: rangeStart, end: rangeEnd, workStart: 9, workEnd: 18, skipWeekends: true }); }
    catch (e) { slots = []; }

    // Group by day for display
    var daysHost = el('div', { class: 'sched-days' });
    for (var i = 0; i < 7; i++) {
      var d = new Date(rangeStart.getTime() + i * 86400000);
      var ds = startOfDay(d);
      var nextDay = new Date(ds.getTime() + 86400000);
      var dayBusy = busy.filter(function (b) { return b.start >= ds && b.start < nextDay; });
      var dayFree = slots.filter(function (s) { return s.start >= ds && s.start < nextDay; });
      var weekend = d.getDay() === 0 || d.getDay() === 6;

      var dayBox = el('div', { class: 'sched-day' + (weekend ? ' sched-weekend' : '') });
      var head = el('div', { class: 'sched-day-head' },
        el('span', { class: 'sched-day-name' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
        el('span', { class: 'sched-day-date' }, d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
      );
      dayBox.appendChild(head);

      var blocksHost = el('div', { class: 'sched-blocks' });
      if (weekend) {
        blocksHost.appendChild(el('p', { class: 'small muted' }, 'Weekend — outside default work hours.'));
      } else {
        if (dayBusy.length) {
          dayBusy.forEach(function (b) {
            blocksHost.appendChild(el('div', { class: 'sched-busy' },
              el('span', { class: 'sched-time' }, fmtTime(b.start) + '–' + fmtTime(b.end)),
              el('span', { class: 'sched-label' }, b.label),
              el('span', { class: 'sched-tab small muted' }, b.tab)
            ));
          });
        }
        if (dayFree.length) {
          dayFree.forEach(function (s) {
            blocksHost.appendChild(el('div', { class: 'sched-free' },
              el('span', { class: 'sched-time' }, fmtTime(s.start) + '–' + fmtTime(s.end)),
              el('span', { class: 'sched-label' }, 'free')
            ));
          });
        } else if (!dayBusy.length) {
          blocksHost.appendChild(el('p', { class: 'small muted' }, 'Nothing scheduled. Whole work day is free.'));
        }
      }
      dayBox.appendChild(blocksHost);
      daysHost.appendChild(dayBox);
    }
    view.appendChild(daysHost);

    return view;
  }

  async function showAvailabilityShare() {
    if (document.querySelector('.avail-overlay')) return;
    var overlay = el('div', { class: 'modal-overlay avail-overlay',
      onclick: function () { overlay.remove(); }
    });

    var today = new Date(); today.setHours(0, 0, 0, 0);
    var weekFromNow = new Date(today.getTime() + 7 * 86400000);
    function isoDate(d) { return d.toISOString().slice(0, 10); }

    var startInput = el('input', { type: 'date', class: 'editor', value: isoDate(today) });
    var endInput = el('input', { type: 'date', class: 'editor', value: isoDate(weekFromNow) });
    var workStartInput = el('input', { type: 'number', class: 'editor', min: '0', max: '23', value: '9' });
    var workEndInput = el('input', { type: 'number', class: 'editor', min: '1', max: '24', value: '18' });
    var slotInput = el('input', { type: 'number', class: 'editor', min: '15', max: '480', step: '15', value: '30' });
    var titleInput = el('input', { type: 'text', class: 'editor',
      placeholder: 'A friendly note for the recipient (optional)' });
    var skipWeekendsCb = el('input', { type: 'checkbox', checked: true });

    var preview = el('div', { class: 'avail-preview' });
    var linkRow = el('div', { class: 'link-row' });
    var qrWrap = el('div', { class: 'qr-wrap' });

    async function rebuild() {
      var rs = new Date(startInput.value + 'T00:00:00');
      var re = new Date(endInput.value + 'T23:59:59');
      if (re < rs) {
        preview.replaceChildren(el('p', { class: 'error' }, 'End date must be after start date.'));
        linkRow.replaceChildren();
        qrWrap.replaceChildren();
        return;
      }
      var ws = parseInt(workStartInput.value, 10) || 9;
      var we = parseInt(workEndInput.value, 10) || 18;
      var sl = parseInt(slotInput.value, 10) || 30;
      var skipW = skipWeekendsCb.checked;

      var busy = await M.schedule.collectBusy({ start: rs, end: re, workStart: ws });
      var slots = M.schedule.freeSlots(busy, { start: rs, end: re, workStart: ws, workEnd: we, slotMin: sl, skipWeekends: skipW });

      if (!slots.length) {
        preview.replaceChildren(el('p', { class: 'muted' }, 'No free slots in this range — try widening the work hours or extending the date range.'));
        linkRow.replaceChildren();
        qrWrap.replaceChildren();
        return;
      }

      var ul = el('ul', { class: 'avail-list' });
      slots.slice(0, 24).forEach(function (s) {
        ul.appendChild(el('li', null, M.schedule.fmtRange(s)));
      });
      var summary = el('p', { class: 'small muted' },
        slots.length + ' free slot' + (slots.length === 1 ? '' : 's') + ' across ',
        Math.ceil((re - rs) / 86400000), ' days. ',
        slots.length > 24 ? '(Preview shows first 24.)' : ''
      );
      preview.replaceChildren(summary, ul);

      var token = M.schedule.encodeAvailability(slots, {
        title: titleInput.value.trim(),
        ws: ws, we: we
      });
      var url = location.origin + location.pathname + '#/avail/' + token;
      var urlInput = el('input', { type: 'text', readonly: true, class: 'url', value: url });
      linkRow.replaceChildren(
        urlInput,
        el('button', { class: 'btn', type: 'button',
          onclick: function () {
            urlInput.select();
            if (navigator.clipboard) navigator.clipboard.writeText(url);
            flash(linkRow, 'Link copied');
          } }, 'Copy link')
      );

      qrWrap.replaceChildren();
      try {
        var qr = M.qr(url, { ec: 'M', margin: 2 });
        qr.classList.add('qr');
        qrWrap.append(
          qr,
          el('div', { class: 'qr-actions' },
            el('button', { class: 'btn btn-ghost', type: 'button',
              onclick: function () { M.downloadPng(qr, 'minerva-availability.png'); }
            }, 'Download PNG'),
            el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, 'Open public view ↗')
          )
        );
      } catch (e) { /* QR opt-in only when generator is loaded */ }
    }

    var debounce = null;
    [startInput, endInput, workStartInput, workEndInput, slotInput, titleInput].forEach(function (i) {
      i.addEventListener('input', function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(rebuild, 200);
      });
    });
    skipWeekendsCb.addEventListener('change', rebuild);

    var panel = el('div', { class: 'modal-panel avail-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Share my availability'),
      el('p', { class: 'small muted' },
        'Generates a public URL containing only your free slots — recipients see when you\'re available, not what you\'re busy with. They can\'t book directly; treat the link as ',
        el('em', null, '"reach out and pick a slot"'),
        '.'
      ),
      el('div', { class: 'avail-form' },
        field('From', startInput),
        field('To', endInput),
        field('Work hours start', workStartInput),
        field('Work hours end', workEndInput),
        field('Min slot (minutes)', slotInput),
        field('Note', titleInput),
        el('label', { class: 'small' },
          skipWeekendsCb,
          ' Skip weekends'
        )
      ),
      preview,
      linkRow,
      qrWrap,
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () { overlay.remove(); } }, 'Done')
      )
    );

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    rebuild();
  }

  function viewAvailability(token) {
    var data;
    try { data = M.schedule.decodeAvailability(token); }
    catch (e) {
      return el('section', { class: 'view' },
        el('h2', null, 'Invalid availability link'),
        el('p', null, 'This link is malformed or truncated.')
      );
    }

    var view = el('section', { class: 'view view-availability' });
    view.appendChild(el('h2', null, 'Availability'));
    if (data.meta && data.meta.title) {
      view.appendChild(el('p', { class: 'lead' }, data.meta.title));
    }
    view.appendChild(el('p', { class: 'small muted' },
      'Free time slots — pick one and reach out to book. Times are in the sender\'s local time zone (',
      el('em', null, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'), ' as rendered on this device).'
    ));

    if (!data.slots.length) {
      view.appendChild(el('p', { class: 'muted' }, 'No slots available.'));
      return view;
    }

    // Group by day
    var byDay = {};
    data.slots.forEach(function (s) {
      var key = M.schedule.dayKey(s.start);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push(s);
    });
    var keys = Object.keys(byDay).sort();
    var grid = el('div', { class: 'sched-days' });
    keys.forEach(function (k) {
      var first = byDay[k][0].start;
      var box = el('div', { class: 'sched-day' });
      box.appendChild(el('div', { class: 'sched-day-head' },
        el('span', { class: 'sched-day-name' }, first.toLocaleDateString(undefined, { weekday: 'short' })),
        el('span', { class: 'sched-day-date' }, first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
      ));
      var blocks = el('div', { class: 'sched-blocks' });
      byDay[k].forEach(function (s) {
        blocks.appendChild(el('div', { class: 'sched-free' },
          el('span', { class: 'sched-time' }, fmtTime(s.start) + '–' + fmtTime(s.end)),
          el('span', { class: 'sched-label' }, 'available')
        ));
      });
      box.appendChild(blocks);
      grid.appendChild(box);
    });
    view.appendChild(grid);

    view.appendChild(el('p', { class: 'small muted' },
      'Shared via ', el('a', { href: '#/' }, 'Minerva'), '. The data lives in the URL — no server is involved.'
    ));
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

    // Today's events from the 'events' preset (or any tab with start/end).
    var startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    var endOfToday = new Date(startOfToday.getTime() + 86400000);
    var todaysEvents = [];
    try {
      var allMeta = await M.db.getAllMeta();
      for (var m of allMeta) {
        if (!m || !m.headers || !m.types) continue;
        if ((m.headers.indexOf('start') < 0) || (m.headers.indexOf('end') < 0)) continue;
        var rows = await M.db.getAllRows(m.tab);
        rows.forEach(function (r) {
          if (r._deleted) return;
          if (!r.start || !r.end) return;
          var s = new Date(r.start);
          if (isNaN(s.getTime())) return;
          if (s < startOfToday || s >= endOfToday) return;
          todaysEvents.push({ row: r, start: s, end: new Date(r.end), tab: m.tab });
        });
      }
      todaysEvents.sort(function (a, b) { return a.start - b.start; });
    } catch (e) { /* non-fatal */ }

    var view = el('section', { class: 'view view-today' });
    var todayH2 = el('h2');
    todayH2.appendChild(M.render.icon('sun'));
    todayH2.appendChild(document.createTextNode(' Today  '));
    todayH2.appendChild(el('span', { class: 'small muted' }, new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    })));
    view.appendChild(todayH2);

    // Quick-add: typing here + Enter creates a task due today.
    var quickAdd = document.createElement('input');
    quickAdd.type = 'text';
    quickAdd.className = 'today-quick-add';
    quickAdd.placeholder = 'Add a task for today… (Enter)';
    quickAdd.autocomplete = 'off';
    quickAdd.addEventListener('keydown', async function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var title = quickAdd.value.trim();
      if (!title) return;
      try {
        var meta = await M.db.getMeta('tasks');
        if (!meta || !meta.headers) {
          flash(view, 'No tasks tab synced yet.', 'error');
          return;
        }
        var row = await addRow('tasks', meta.headers);
        row.title = title;
        if (meta.headers.indexOf('due') >= 0) row.due = todayStr();
        if (meta.headers.indexOf('status') >= 0) row.status = 'todo';
        row._dirty = 1;
        await M.db.upsertRow('tasks', row);
        schedulePush();
        quickAdd.value = '';
        flash(view, 'Added: ' + title);
        if (location.hash === '#/today') await route();
      } catch (err) {
        flash(view, 'Add failed: ' + (err && err.message ? err.message : err), 'error');
      }
    });
    view.appendChild(quickAdd);

    // -- events block (only render when there are any) --
    if (todaysEvents.length) {
      view.appendChild(el('h3', null, 'Today’s events  ',
        el('span', { class: 'small muted' }, '(' + todaysEvents.length + ')')));
      var eul = el('ul', { class: 'today-list' });
      todaysEvents.forEach(function (e) {
        var fmt = function (d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
        var li = el('li', { class: 'today-item' });
        li.appendChild(el('span', { class: 'today-note-date' }, fmt(e.start) + '–' + fmt(e.end)));
        li.appendChild(el('a', { class: 'today-title', href: '#/s/' + encodeURIComponent(e.tab) },
          e.row.title || e.row.id));
        if (e.row.location) {
          li.appendChild(el('span', { class: 'today-meta small muted' }, e.row.location));
        }
        eul.appendChild(li);
      });
      view.appendChild(eul);
    }

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
    var habitsH2 = el('h2');
    if (sec.icon) habitsH2.appendChild(M.render.icon(sec.icon));
    habitsH2.appendChild(document.createTextNode(sec.title || 'Habits'));
    header.appendChild(habitsH2);
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
        var bb = el('span', { class: 'backlink-badge', title: bn + ' incoming reference' + (bn === 1 ? '' : 's') });
        bb.appendChild(M.render.icon('link-2'));
        bb.appendChild(document.createTextNode(' ' + bn));
        header.appendChild(bb);
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

  function renderSectionTable(meta, rows, tab, refresh, userSort, onSortChange, backlinks, selectedIds, onBulkChange) {
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

    var allSelected = !!selectedIds && rows.length > 0 && rows.every(function (r) { return selectedIds.has(r.id); });
    var bulkAllCb = document.createElement('input');
    bulkAllCb.type = 'checkbox';
    bulkAllCb.className = 'bulk-cb-all';
    bulkAllCb.title = 'Select all rows';
    bulkAllCb.checked = allSelected;
    bulkAllCb.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!selectedIds) return;
      if (bulkAllCb.checked) rows.forEach(function (r) { selectedIds.add(r.id); });
      else rows.forEach(function (r) { selectedIds.delete(r.id); });
      // toggle each row checkbox
      bodyHost = bodyHost; // captured
      var trs = (e.target.closest('table') || document).querySelectorAll('tbody tr');
      trs.forEach(function (tr) {
        var rid = tr.dataset.rowid;
        var cb = tr.querySelector('.bulk-cb');
        var on = bulkAllCb.checked;
        if (cb) cb.checked = on;
        tr.classList.toggle('is-bulk-selected', on);
      });
      if (onBulkChange) onBulkChange();
    });

    var thead = el('thead', null,
      el('tr', null,
        [el('th', { class: 'col-bulk' }, bulkAllCb)].concat(visibleCols.map(function (c) {
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
        })).concat([
          el('th', { class: 'col-actions', 'aria-label': 'Actions' }, '')
        ])
      )
    );
    var tbody = el('tbody', null, rows.map(function (row) {
      var tr = el('tr', { 'data-rowid': row.id });
      if (row._dirty) tr.classList.add('row-dirty');
      var isSelected = !!selectedIds && selectedIds.has(row.id);
      if (isSelected) tr.classList.add('is-bulk-selected');
      tr.addEventListener('dblclick', function (e) {
        // Don't open detail when double-clicking the bulk checkbox or actions
        if (e.target.closest('.col-bulk, .col-actions, button, input, textarea, select')) return;
        showRowDetail(tab, row.id);
      });

      // checkbox column
      var rowCb = document.createElement('input');
      rowCb.type = 'checkbox';
      rowCb.className = 'bulk-cb';
      rowCb.checked = isSelected;
      rowCb.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!selectedIds) return;
        if (rowCb.checked) selectedIds.add(row.id);
        else selectedIds.delete(row.id);
        tr.classList.toggle('is-bulk-selected', rowCb.checked);
        // Sync the header "all" checkbox
        var th = (tr.closest('table') || document).querySelector('thead .bulk-cb-all');
        if (th) th.checked = rows.every(function (r) { return selectedIds.has(r.id); });
        if (onBulkChange) onBulkChange();
      });
      var bulkTd = el('td', { class: 'col-bulk' });
      bulkTd.appendChild(rowCb);
      tr.appendChild(bulkTd);

      visibleCols.forEach(function (c, ci) {
        var td = el('td', { 'data-col': c.name, 'data-type': c.type, tabindex: '0' });
        td.appendChild(M.render.renderCell(row[c.name], c.type));
        // Append a small backlink badge to the first visible column.
        if (ci === 0 && backlinks && backlinks[row.id] && backlinks[row.id].length) {
          var n = backlinks[row.id].length;
          var badge = el('span', { class: 'backlink-badge', title: n + ' incoming reference' + (n === 1 ? '' : 's') });
          badge.appendChild(M.render.icon('link-2'));
          badge.appendChild(document.createTextNode(' ' + n));
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
    var themePanel = el('div', { class: 'tg-panel' });
    paintNotify();
    paintIcal();
    paintPresets();
    paintAi();
    paintTheme();
    paintTg();

    var bookmarkletPanel = el('div', { class: 'tg-panel' });
    paintBookmarklet();

    function paintBookmarklet() {
      // The snippet runs on any web page: grabs title/URL/selection, encodes
      // them as a Minerva share token, opens #/capture/<token>.
      var origin = (location.origin || 'https://minerva.thefarshad.com');
      var snippet =
        "javascript:(function(){" +
        "var t=document.title||'',u=location.href,s=String(window.getSelection&&window.getSelection()||'');" +
        "var p={title:t.slice(0,160),body:u+(s?'\\n\\n'+s:'')};" +
        "var j=JSON.stringify(p);" +
        "var b=btoa(unescape(encodeURIComponent(j))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');" +
        "window.open(" + JSON.stringify(origin) + "+'/#/capture/'+b,'_blank');" +
        "})();";

      bookmarkletPanel.replaceChildren(
        el('h3', null, 'Quick-capture bookmarklet'),
        el('p', { class: 'small muted' },
          'Drag this link to your browser\'s bookmarks bar. Clicking it on any web page opens Minerva\'s quick-capture modal pre-filled with the page title, URL, and any selected text — picks up the inbox/notes section by default. Works on any browser that allows ',
          el('code', null, 'javascript:'), ' bookmarks.'
        ),
        el('p', null,
          el('a', {
            class: 'btn',
            href: snippet,
            onclick: function (e) { e.preventDefault(); flash(bookmarkletPanel, 'Drag this link to your bookmarks bar — don\'t click here.'); }
          }, '+ Capture to Minerva')
        ),
        el('details', null,
          el('summary', { class: 'small muted' }, 'View / copy the snippet'),
          el('pre', { class: 'small' }, snippet)
        )
      );
    }

    function paintTheme() {
      var current = localStorage.getItem('minerva.customCss') || '';
      var ta = document.createElement('textarea');
      ta.className = 'editor';
      ta.rows = 8;
      ta.spellcheck = false;
      ta.placeholder = "[data-theme=\"light\"] {\n  --accent: #c44;\n  --bg: #fafafa;\n}\n\n.section-card { border-radius: 16px; }";
      ta.value = current;

      function apply(css) {
        var existing = document.getElementById('minerva-custom-style');
        if (existing) existing.remove();
        if (!css) return;
        var s = document.createElement('style');
        s.id = 'minerva-custom-style';
        s.textContent = css;
        document.head.appendChild(s);
      }

      themePanel.replaceChildren(
        el('h3', null, 'Custom theme'),
        el('p', { class: 'small muted' },
          'Override any CSS variable or class. Persists in your browser only. Useful keys: ',
          el('code', null, '--accent'), ', ',
          el('code', null, '--bg'), ', ',
          el('code', null, '--surface'), ', ',
          el('code', null, '--fg'), ', ',
          el('code', null, '--radius'), '. Scope to a theme with ',
          el('code', null, '[data-theme="dark"] { ... }'), '.'
        ),
        ta,
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn', type: 'button',
            onclick: function () {
              var css = ta.value;
              localStorage.setItem('minerva.customCss', css);
              apply(css);
              flash(themePanel, 'Saved & applied.');
            }
          }, 'Save & apply'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            onclick: function () {
              apply(ta.value);
              flash(themePanel, 'Previewed (not saved).');
            }
          }, 'Preview'),
          (current
            ? el('button', { class: 'btn btn-ghost', type: 'button',
                onclick: function () {
                  if (!confirm('Remove your custom CSS?')) return;
                  localStorage.removeItem('minerva.customCss');
                  apply('');
                  ta.value = '';
                  paintTheme();
                  flash(themePanel, 'Reset to defaults.');
                } }, 'Reset')
            : null)
        )
      );
    }

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
      { id: 'settings-ai',         label: 'AI assistant',  content: aiPanel },
      { id: 'settings-bookmarklet', label: 'Bookmarklet',  content: bookmarkletPanel },
      { id: 'settings-theme',      label: 'Custom theme',  content: themePanel }
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
    // Clear keyboard context every navigation; viewSection re-installs.
    sectionCtx = null;

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
      } else if (hash === '#/schedule') {
        view = await viewSchedule(); active = '#/schedule';
      } else if ((sectionMatch = hash.match(/^#\/avail\/(.+)$/))) {
        view = viewAvailability(sectionMatch[1]); active = '';
      } else if (hash === '#/meet/new') {
        view = viewMeetNew(); active = '#/schedule';
      } else if ((sectionMatch = hash.match(/^#\/meet\/([^/]+)\/([^?]+)$/))) {
        view = viewMeetAggregate(sectionMatch[1], sectionMatch[2]); active = '';
      } else if ((sectionMatch = hash.match(/^#\/meet\/(.+)$/))) {
        view = viewMeetParticipant(sectionMatch[1]); active = '';
      } else if ((sectionMatch = hash.match(/^#\/capture\/(.+)$/))) {
        // Bookmarklet entry point — decode payload and open quick-capture.
        var payload = {};
        try { payload = M.decode(sectionMatch[1]); } catch (e) { /* invalid */ }
        view = await viewHome();
        active = '#/';
        history.replaceState(null, '', '#/');
        setTimeout(function () { showCapture(payload); }, 50);
      } else if ((sectionMatch = hash.match(/^#\/search\/(.+)$/))) {
        // OpenSearch landing — open the global-search overlay seeded.
        view = await viewHome();
        active = '#/';
        var q = decodeURIComponent(sectionMatch[1]);
        // Defer slightly so the route's content lands before the overlay.
        setTimeout(function () {
          showSearch();
          var input = document.querySelector('.search-overlay .search-input');
          if (input) {
            input.value = q;
            input.dispatchEvent(new Event('input'));
          }
        }, 50);
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
    M.render.refreshIcons();
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
    if (h === '#/schedule') return '#/schedule';
    if (/^#\/s\//.test(h)) return h;
    if (/^#\/share/.test(h)) return '#/share';
    if (h === '#/settings') return '#/settings';
    return '';
  }

  // ---- smart URL import modal (arXiv / YouTube / generic) ----

  async function showUrlImport(tab) {
    if (document.querySelector('.url-import-overlay')) return;
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) {
      flash(document.body, 'No schema cached — Sync first.', 'error');
      return;
    }

    var overlay = el('div', { class: 'modal-overlay url-import-overlay',
      onclick: function () { overlay.remove(); }
    });

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'editor';
    input.placeholder = 'arXiv ID · DOI (10.xxxx/...) · YouTube URL · any other URL';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var preview = el('div', { class: 'url-import-preview' });
    var addBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'Add to ' + tab);
    var fetched = null;
    var debounce = null;

    function renderField(label, value) {
      if (!value) return null;
      return el('div', { class: 'url-import-field' },
        el('strong', null, label),
        el('span', null, String(value).slice(0, 600))
      );
    }

    async function lookup() {
      var raw = input.value.trim();
      fetched = null;
      addBtn.disabled = true;
      if (!raw) { preview.replaceChildren(); return; }
      preview.replaceChildren(el('p', { class: 'small muted' }, 'Looking up…'));
      try {
        var data = await M.import.lookup(raw);
        if (!data) {
          preview.replaceChildren(el('p', { class: 'small muted' },
            'Not recognized as arXiv, YouTube, or a URL. Either paste a real URL or use ',
            el('em', null, '+ Add row'), ' to enter manually.'));
          return;
        }
        fetched = data;
        var matches = Object.keys(data).filter(function (k) {
          return meta.headers.indexOf(k) >= 0 && data[k];
        });
        var unmappable = Object.keys(data).filter(function (k) {
          return meta.headers.indexOf(k) < 0 && data[k];
        });

        var nodes = [];
        var thumb = data.thumbnail
          ? (function () {
              var img = document.createElement('img');
              img.src = data.thumbnail;
              img.className = 'url-import-thumb';
              img.alt = '';
              return img;
            })()
          : null;
        if (thumb) nodes.push(thumb);
        ['kind', 'title', 'authors', 'year', 'url', 'pdf', 'abstract'].forEach(function (k) {
          var f = renderField(k, data[k]);
          if (f) nodes.push(f);
        });

        nodes.push(el('p', { class: 'small muted' },
          'Will populate ',
          el('strong', null, matches.length + ' column' + (matches.length === 1 ? '' : 's')),
          ': ', matches.join(', ') || '(none)',
          unmappable.length
            ? ' · skipping (no column): ' + unmappable.join(', ')
            : ''
        ));

        preview.replaceChildren.apply(preview, nodes);
        addBtn.disabled = matches.length === 0;
      } catch (err) {
        preview.replaceChildren(el('p', { class: 'error small' },
          'Lookup failed: ' + (err && err.message ? err.message : err)));
      }
    }

    input.addEventListener('input', function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(lookup, 350);
    });

    addBtn.addEventListener('click', async function () {
      if (!fetched) return;
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      try {
        var row = await addRow(tab, meta.headers);
        Object.keys(fetched).forEach(function (k) {
          if (meta.headers.indexOf(k) >= 0) row[k] = fetched[k];
        });
        if (meta.headers.indexOf('read') >= 0) row.read = 'FALSE';
        row._dirty = 1;
        await M.db.upsertRow(tab, row);
        schedulePush();
        overlay.remove();
        flash(document.body, 'Added: ' + (fetched.title || fetched.url || 'row'));
        await route();
      } catch (err) {
        flash(preview, 'Add failed: ' + (err && err.message ? err.message : err), 'error');
        addBtn.disabled = false;
        addBtn.textContent = 'Add to ' + tab;
      }
    });

    var panel = el('div', { class: 'modal-panel url-import-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Add from URL — ', el('code', null, tab)),
      el('p', { class: 'small muted' },
        'Auto-fetches metadata from ',
        el('strong', null, 'arXiv'), ' (paste 2401.12345 or any arxiv URL), ',
        el('strong', null, 'DOI'), ' (10.xxxx/yyy or doi.org URL — uses CrossRef), and ',
        el('strong', null, 'YouTube'), ' (any watch / youtu.be URL). Other URLs are added with title-only when CORS allows, or just the URL otherwise.'
      ),
      input,
      preview,
      el('div', { class: 'form-actions' },
        addBtn,
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () { overlay.remove(); } }, 'Cancel')
      )
    );

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
      if (e.key === 'Enter' && !addBtn.disabled) { e.preventDefault(); addBtn.click(); }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 30);
  }

  // ---- CSV/TSV import modal ----

  // Minimal RFC 4180-ish CSV parser. Handles quoted fields with embedded
  // commas / tabs / newlines / escaped quotes. Auto-detects delimiter on
  // first call from the first non-quoted occurrence in the first line.
  function parseDelimited(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    if (!text.length) return { rows: [], delim: ',' };
    // Sniff delimiter from the first line, ignoring stuff inside quotes.
    var firstNl = text.indexOf('\n');
    var head = firstNl < 0 ? text : text.slice(0, firstNl);
    var inQ = false;
    var delim = ',';
    for (var k = 0; k < head.length; k++) {
      if (head[k] === '"') inQ = !inQ;
      else if (!inQ && head[k] === '\t') { delim = '\t'; break; }
      else if (!inQ && head[k] === ',') { delim = ','; break; }
      else if (!inQ && head[k] === ';') { delim = ';'; break; }
    }

    var rows = [];
    var cur = [''];
    var inQuote = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      var next = text[i + 1];
      if (inQuote) {
        if (c === '"' && next === '"') { cur[cur.length - 1] += '"'; i++; }
        else if (c === '"') { inQuote = false; }
        else { cur[cur.length - 1] += c; }
      } else {
        if (c === '"' && cur[cur.length - 1] === '') { inQuote = true; }
        else if (c === delim) { cur.push(''); }
        else if (c === '\n') { rows.push(cur); cur = ['']; }
        else { cur[cur.length - 1] += c; }
      }
    }
    if (cur.length > 1 || cur[0]) rows.push(cur);
    // Trim trailing all-empty rows (common from a trailing newline).
    while (rows.length && rows[rows.length - 1].every(function (c) { return !c; })) rows.pop();
    return { rows: rows, delim: delim };
  }

  async function showCsvImport(tab) {
    if (document.querySelector('.csv-overlay')) return;
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) {
      flash(document.body, 'No schema cached — Sync first.', 'error');
      return;
    }
    var headers = meta.headers;

    var overlay = el('div', { class: 'modal-overlay csv-overlay',
      onclick: function () { overlay.remove(); }
    });

    var textarea = document.createElement('textarea');
    textarea.className = 'editor csv-input';
    textarea.rows = 8;
    textarea.placeholder = 'Paste comma- or tab-separated rows. The first row must be column names (matching the section\'s schema). Unrecognized columns are skipped.';

    var preview = el('div', { class: 'csv-preview' });
    var importBtn = el('button', { class: 'btn', type: 'button', disabled: true });
    importBtn.textContent = 'Import';

    function updatePreview() {
      var raw = textarea.value;
      if (!raw.trim()) {
        preview.replaceChildren();
        importBtn.disabled = true;
        return;
      }
      var parsed = parseDelimited(raw);
      var srcHeaders = parsed.rows[0] || [];
      var dataRows = parsed.rows.slice(1);

      var mapping = srcHeaders.map(function (h) {
        return headers.indexOf(h) >= 0 ? h : null;
      });
      var matched = srcHeaders.filter(function (_, i) { return mapping[i]; });
      var unmatched = srcHeaders.filter(function (_, i) { return !mapping[i]; });

      importBtn.disabled = !(matched.length && dataRows.length);

      var summary = el('p', { class: 'small muted' },
        'Detected ', el('strong', null, dataRows.length + ' row' + (dataRows.length === 1 ? '' : 's')),
        ' · delimiter ',
        el('code', null, parsed.delim === '\t' ? 'tab' : (parsed.delim === ';' ? '; ' : ',')),
        ' · ',
        matched.length
          ? el('span', null, 'mapping ', el('strong', null, matched.length + ' column' + (matched.length === 1 ? '' : 's')), ': ', matched.join(', '))
          : el('span', { class: 'error' }, 'no columns matched the schema — nothing will be imported'),
        unmatched.length
          ? el('span', null, ' · skipping ', el('em', null, unmatched.join(', ')))
          : null
      );

      var children = [summary];
      if (dataRows.length) {
        var n = Math.min(3, dataRows.length);
        var tbl = el('table', { class: 'csv-preview-table' });
        var ths = srcHeaders.map(function (h, i) {
          return el('th', { class: mapping[i] ? '' : 'csv-unmatched' }, h || ' ');
        });
        tbl.appendChild(el('thead', null, el('tr', null, ths)));
        tbl.appendChild(el('tbody', null, dataRows.slice(0, n).map(function (row) {
          return el('tr', null, srcHeaders.map(function (_, ci) {
            return el('td', { class: mapping[ci] ? '' : 'csv-unmatched' }, (row[ci] || '').slice(0, 80));
          }));
        })));
        var wrap = el('div', { class: 'csv-preview-wrap' });
        wrap.appendChild(tbl);
        children.push(wrap);
        if (dataRows.length > n) {
          children.push(el('p', { class: 'small muted' }, '… and ' + (dataRows.length - n) + ' more.'));
        }
      }
      preview.replaceChildren.apply(preview, children);
    }

    textarea.addEventListener('input', updatePreview);

    importBtn.addEventListener('click', async function () {
      var parsed = parseDelimited(textarea.value);
      if (parsed.rows.length < 2) return;
      var srcHeaders = parsed.rows[0];
      var dataRows = parsed.rows.slice(1).filter(function (r) {
        return r.some(function (v) { return String(v).trim(); });
      });
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        var added = 0;
        for (var i = 0; i < dataRows.length; i++) {
          var src = dataRows[i];
          var row = await addRow(tab, headers);
          srcHeaders.forEach(function (h, j) {
            if (headers.indexOf(h) >= 0 && h !== 'id' && !M.render.isInternal(h)) {
              row[h] = src[j] != null ? src[j] : '';
            }
          });
          row._dirty = 1;
          await M.db.upsertRow(tab, row);
          added++;
        }
        schedulePush();
        overlay.remove();
        flash(document.body, 'Imported ' + added + ' row' + (added === 1 ? '' : 's') + ' into ' + tab + '.');
        await route();
      } catch (err) {
        flash(preview, 'Import failed: ' + (err && err.message ? err.message : err), 'error');
        importBtn.disabled = false;
        importBtn.textContent = 'Import';
      }
    });

    var panel = el('div', { class: 'modal-panel csv-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Import rows from CSV / TSV — ',
        el('code', null, tab)
      ),
      el('p', { class: 'small muted' },
        'Paste rows below. First row must be column names. Recognized: ',
        headers.filter(function (h) { return !M.render.isInternal(h) && h !== 'id'; }).join(', '), '.'
      ),
      textarea,
      preview,
      el('div', { class: 'form-actions' },
        importBtn,
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () { overlay.remove(); } }, 'Cancel')
      )
    );

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(function () { textarea.focus(); }, 30);
  }

  // ---- BibTeX export ----

  function bibtexEscape(s) {
    return String(s == null ? '' : s)
      .replace(/[{}]/g, '')
      .replace(/[&%$_#]/g, function (c) { return '\\' + c; });
  }

  function rowHasBibtex(row) {
    return !!(row && (row.authors || row.author) && row.title);
  }

  function rowToBibtex(row) {
    var kind = String(row.kind || '').toLowerCase();
    var url = row.url || '';
    var type = '@article';
    if (kind === 'book') type = '@book';
    else if (/arxiv\.org/i.test(url) && !row.venue) type = '@misc';
    else if (kind === 'video' || kind === 'podcast') type = '@misc';
    else if (!row.venue) type = '@misc';

    var authorsStr = String(row.authors || row.author || '').trim();
    var firstLast = authorsStr.split(',')[0].trim().split(/\s+/).pop() || 'item';
    var year = String(row.year || '').slice(0, 4) || 'nd';
    var key = (firstLast.toLowerCase().replace(/[^a-z0-9]/g, '') || 'item') + year;

    var fields = [];
    fields.push('  title  = {' + bibtexEscape(row.title) + '}');
    if (authorsStr) {
      var bibAuthors = authorsStr.split(',').map(function (a) { return a.trim(); }).filter(Boolean).join(' and ');
      fields.push('  author = {' + bibtexEscape(bibAuthors) + '}');
    }
    if (row.year) fields.push('  year   = {' + bibtexEscape(row.year) + '}');
    if (row.venue) fields.push('  journal= {' + bibtexEscape(row.venue) + '}');
    if (url) fields.push('  url    = {' + url + '}');
    if (row.pdf) fields.push('  pdf    = {' + row.pdf + '}');
    if (row.abstract) {
      var abs = String(row.abstract).replace(/\s+/g, ' ').slice(0, 800);
      fields.push('  abstract = {' + bibtexEscape(abs) + '}');
    }
    if (/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/.test(url)) {
      var arxivId = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/)[1];
      fields.push('  eprint = {' + arxivId + '}');
      fields.push('  archivePrefix = {arXiv}');
    }
    if (/doi\.org\/(10\.\d{4,9}\/[^\s]+)/.test(url)) {
      var doi = url.match(/doi\.org\/(10\.\d{4,9}\/[^\s]+)/)[1];
      fields.push('  doi    = {' + doi + '}');
    }

    return type + '{' + key + ',\n' + fields.join(',\n') + '\n}';
  }

  // ---- row detail modal (double-click row or `d`) ----

  async function showRowDetail(tab, rowId) {
    if (document.querySelector('.row-detail-overlay')) return;
    var row = await M.db.getRow(tab, rowId);
    if (!row) { flash(document.body, 'Row not found.', 'error'); return; }
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) {
      flash(document.body, 'No schema cached for ' + tab + '.', 'error');
      return;
    }

    var overlay = el('div', { class: 'modal-overlay row-detail-overlay',
      onclick: function () { overlay.remove(); }
    });

    var titleText = row.title || row.name || row.question || row.decision || row.id;
    var panel = el('div', { class: 'modal-panel row-detail-panel',
      onclick: function (e) { e.stopPropagation(); }
    });

    var head = el('div', { class: 'row-detail-head' },
      el('h3', null, String(titleText)),
      el('button', { class: 'icon-btn', type: 'button', title: 'Close',
        onclick: function () { overlay.remove(); } }, '×')
    );
    panel.appendChild(head);

    var subtitle = el('p', { class: 'small muted' },
      tab + ' · id: ', el('code', null, row.id)
    );
    panel.appendChild(subtitle);

    var grid = el('div', { class: 'row-detail-grid' });
    panel.appendChild(grid);

    function renderField(h, type) {
      var labelEl = el('div', { class: 'row-detail-label' }, h);
      var valueEl = el('div', { class: 'row-detail-value', tabindex: '0',
        'data-col': h, 'data-type': type
      });
      valueEl.appendChild(M.render.renderCell(row[h], type));

      function startEditField() {
        if (valueEl.classList.contains('editing')) return;
        var current = row[h];
        var editor = M.editors.make(current, type,
          async function (newValue) {
            valueEl.classList.remove('editing');
            valueEl.replaceChildren(M.render.renderCell(newValue, type));
            if (newValue !== current) {
              await commitCellEdit(tab, rowId, h, newValue);
              row[h] = newValue;
            }
          },
          function () {
            valueEl.classList.remove('editing');
            valueEl.replaceChildren(M.render.renderCell(current, type));
          }
        );
        valueEl.classList.add('editing');
        valueEl.replaceChildren(editor);
        if (typeof editor.focus === 'function') editor.focus();
        if (typeof editor.select === 'function' && editor.tagName !== 'TEXTAREA') {
          try { editor.select(); } catch (e) { /* ignore */ }
        }
      }

      valueEl.addEventListener('click', startEditField);
      valueEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          if (valueEl.classList.contains('editing')) return;
          e.preventDefault();
          startEditField();
        }
      });

      return [labelEl, valueEl];
    }

    meta.headers.forEach(function (h, i) {
      if (M.render.isInternal(h)) return;
      if (h === 'id') return;
      var type = meta.types[i] || 'text';
      var pair = renderField(h, type);
      grid.appendChild(pair[0]);
      grid.appendChild(pair[1]);
    });

    var bibtexBtn = rowHasBibtex(row)
      ? el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: async function () {
            try {
              var bib = rowToBibtex(row);
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(bib);
                flash(panel, 'BibTeX copied to clipboard.');
              } else {
                flash(panel, 'Clipboard unavailable — open the console for the BibTeX.');
              }
              console.log(bib);
            } catch (err) {
              flash(panel, 'Copy failed: ' + (err && err.message ? err.message : err), 'error');
            }
          } }, 'Copy BibTeX')
      : null;

    panel.appendChild(el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: function () { overlay.remove(); } }, 'Close'),
      el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: async function () {
          if (!confirm('Delete this row?')) return;
          await deleteRow(tab, rowId);
          overlay.remove();
          if (location.hash !== '#/settings') await route();
        } }, 'Delete row'),
      bibtexBtn,
      readConfig().spreadsheetId
        ? el('a', { class: 'btn btn-ghost',
            href: M.sheets.spreadsheetUrl(readConfig().spreadsheetId),
            target: '_blank', rel: 'noopener' }, 'Open in Sheets ↗')
        : null
    ));

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.activeElement.closest('.editing')) {
        e.preventDefault();
        overlay.remove();
      }
    });
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
      label: 'Proposal — NSF structure',
      build: async function () {
        return [
          { role: 'system', content: 'You are a senior researcher mentoring a colleague through an NSF proposal. Reply concisely in markdown.' },
          { role: 'user', content: 'Walk me through the NSF proposal structure: every required section, its page limit, what reviewers look for in each. Highlight the Intellectual Merit / Broader Impacts requirement and any common reasons proposals get returned without review (page limits, font size, missing labeled subsections, etc.).' }
        ];
      }
    },
    {
      label: 'Proposal — NIH structure',
      build: async function () {
        return [
          { role: 'system', content: 'You are a senior PI mentoring an early-career researcher through an NIH R01. Reply concisely in markdown.' },
          { role: 'user', content: 'Walk me through the NIH R01 structure. Cover Specific Aims (1 page), Research Strategy (12 pages with Significance / Innovation / Approach subsections, each scored separately), the Approach section\'s emphasis on pitfalls and alternatives, and the modular budget threshold. Note that NIH funds people through their training so emphasize what reviewers look for in the bio sketch as well.' }
        ];
      }
    },
    {
      label: 'Proposal — ERC structure',
      build: async function () {
        return [
          { role: 'system', content: 'You are a researcher who has been on ERC review panels. Reply concisely in markdown.' },
          { role: 'user', content: 'Explain the ERC submission structure: Part B1 (Extended Synopsis 5 pages + CV 2 pages + Track Record 2 pages) and Part B2 (Scientific Proposal 14 pages, only requested at Step 2). Emphasize that ERC funds the PI\'s track record more than the consortium and that ground-breaking / high-risk framing is expected.' }
        ];
      }
    },
    {
      label: 'Proposal — critique my abstract',
      build: async function () {
        var draft = (prompt('Paste your draft abstract / project summary:') || '').trim();
        if (!draft) return [
          { role: 'user', content: 'I need help critiquing a research proposal abstract but I don\'t have one yet.' }
        ];
        return [
          { role: 'system', content: 'You are a senior reviewer critiquing a research proposal abstract. Be specific and constructive. Output a markdown table with three columns: Strength, Weakness, Suggested-revision. End with a one-sentence verdict on whether this would survive a competitive review panel as written.' },
          { role: 'user', content: 'Here is my draft:\n\n' + draft }
        ];
      }
    },
    {
      label: 'Proposal — broader impacts brainstorm',
      build: async function () {
        var topic = (prompt('Briefly describe the project (one sentence is fine):') || '').trim();
        if (!topic) return [
          { role: 'user', content: 'I need to brainstorm broader impacts but haven\'t described my project.' }
        ];
        return [
          { role: 'system', content: 'You are advising on the Broader Impacts section of an NSF proposal. Output 6–10 concrete, plausible activities the PI could include — diverse across the categories NSF cares about (education, public engagement, dataset/tool dissemination, training underrepresented groups, partnerships with industry/community). Be specific; avoid generic platitudes. Markdown bullet list.' },
          { role: 'user', content: 'Project: ' + topic }
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

  async function showCapture(seed) {
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
    seed = seed || {};

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
    if (seed.title) titleInput.value = seed.title;

    var bodyTa = document.createElement('textarea');
    bodyTa.rows = 4;
    bodyTa.placeholder = 'Body (optional). Cmd/Ctrl + Enter to save.';
    bodyTa.className = 'editor';
    if (seed.body) bodyTa.value = seed.body;
    if (seed.slug) {
      var match = sects.find(function (s) { return s.slug === seed.slug; });
      if (match) sectSelect.value = match.slug;
    }

    // Voice capture (Web Speech API) — transcribes into the body textarea.
    var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var voiceBtn = null;
    var recognition = null;
    var voiceBaseline = '';
    if (Recognition) {
      voiceBtn = document.createElement('button');
      voiceBtn.type = 'button';
      voiceBtn.className = 'btn btn-ghost voice-btn';
      voiceBtn.title = 'Voice capture (start/stop)';
      voiceBtn.appendChild(M.render.icon('mic'));

      function stopVoice() {
        if (recognition) {
          try { recognition.stop(); } catch (e) { /* ignore */ }
          recognition = null;
        }
        if (voiceBtn) voiceBtn.classList.remove('voice-active');
      }

      voiceBtn.addEventListener('click', function () {
        if (recognition) { stopVoice(); return; }
        try {
          recognition = new Recognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = navigator.language || 'en-US';
          voiceBaseline = bodyTa.value ? bodyTa.value.replace(/\s+$/, '') + ' ' : '';
          recognition.onresult = function (e) {
            var finalText = '';
            var interim = '';
            for (var i = e.resultIndex; i < e.results.length; i++) {
              var t = e.results[i][0].transcript;
              if (e.results[i].isFinal) finalText += t;
              else interim += t;
            }
            if (finalText) voiceBaseline += finalText;
            bodyTa.value = voiceBaseline + interim;
          };
          recognition.onerror = function (ev) {
            console.warn('[Minerva voice]', ev.error);
            stopVoice();
          };
          recognition.onend = function () {
            // Some browsers stop after ~60 seconds of silence; clear state
            // so the next click starts a new session.
            voiceBtn.classList.remove('voice-active');
            recognition = null;
          };
          recognition.start();
          voiceBtn.classList.add('voice-active');
          bodyTa.focus();
        } catch (err) {
          flash(form, 'Voice capture failed: ' + (err && err.message ? err.message : err), 'error');
          stopVoice();
        }
      });
    }

    // Body field with optional voice button to its right.
    var bodyRow = document.createElement('div');
    bodyRow.className = 'capture-body-row';
    bodyRow.appendChild(bodyTa);
    if (voiceBtn) bodyRow.appendChild(voiceBtn);
    var bodyField = field('Body', bodyRow,
      voiceBtn ? 'Click 🎤 for voice capture (Web Speech API).' : null);

    var form = el('form', { class: 'modal-panel capture-panel',
      onclick: function (e) { e.stopPropagation(); },
      onsubmit: function (e) { e.preventDefault(); save(); }
    },
      el('h3', null, 'Quick capture'),
      field('Section', sectSelect),
      field('Title', titleInput),
      bodyField,
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

  // (helper inside the closure above) — voice button needs to clear when modal closes too.

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
      ['⌘/Ctrl + Z', 'Undo last edit / add / delete'],
      ['q', 'Quick share'],
      ['s', 'Settings'],
      ['j / k', 'Move selection in a section list'],
      ['e', 'Edit selected row'],
      ['d', 'Open detail view of selected row'],
      ['c', 'Toggle status (done ↔ todo)'],
      ['x', 'Delete selected row'],
      ['Double-click', 'Row detail (full markdown, all fields)'],
      ['⌘/Ctrl + ⇧ + P', 'Pomodoro start / pause'],
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
    // Cmd/Ctrl+Z undoes the last Minerva mutation. Only intercept when the
    // user is not in an editable input — let the browser's native undo
    // handle text editing.
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey
        && !e.target.matches('input, textarea, [contenteditable]')) {
      e.preventDefault();
      undo();
      return;
    }
    // Cmd/Ctrl+Shift+P toggles the pomodoro timer.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      if (M.pomodoro) M.pomodoro.toggle();
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

    // Section-row navigation when a section view is active and in list mode.
    if (sectionCtx) {
      if (e.key === 'j') { e.preventDefault(); sectionCtx.moveSelection(1); return; }
      if (e.key === 'k') { e.preventDefault(); sectionCtx.moveSelection(-1); return; }
      if (e.key === 'e') { e.preventDefault(); sectionCtx.editSelected(); return; }
      if (e.key === 'x') { e.preventDefault(); sectionCtx.deleteSelected(); return; }
      if (e.key === 'c') { e.preventDefault(); sectionCtx.toggleDoneSelected(); return; }
      if (e.key === 'd') { e.preventDefault(); sectionCtx.detailSelected(); return; }
    }

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
    // Expose schedulePush so the pomodoro module can flush its log writes.
    window.MinervaSchedulePush = schedulePush;
    if (M.pomodoro) M.pomodoro.mount();
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
