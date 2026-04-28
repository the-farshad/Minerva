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

  async function viewHome() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };
    var connected = st.hasToken && cfg.spreadsheetId;

    if (connected) {
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

    // Not connected — landing.
    var primaryCta = cfg.clientId
      ? el('a', { class: 'btn', href: '#/settings' }, 'Connect your Google account →')
      : el('a', { class: 'btn', href: '#/settings' }, 'Set up in Settings →');
    return el('section', { class: 'view' },
      el('h2', null, 'Welcome to Minerva'),
      el('p', { class: 'lead' },
        'Minerva is a lightweight personal planner — goals, tasks, projects, notes — stored in a Google Sheet that ',
        el('em', null, 'you'),
        ' own. The app is a static site; nothing is on our servers because there are no servers.'
      ),
      el('div', { class: 'callouts' },
        callout('Bring your own Sheet', 'Each user connects their own Google account. Minerva creates one spreadsheet per user and reads its routes, sections, and column types from a `_config` tab inside it.'),
        callout('Share publicly with QR', 'Any note, question, or poll can become a public card with a stable URL and a QR code — perfect for posters, surveys, and quick handoffs.'),
        callout('No build, no backend', 'Pure HTML/CSS/JS on GitHub Pages. Hackable. Forkable. Yours.')
      ),
      el('div', { class: 'cta-row' },
        primaryCta,
        el('a', { class: 'btn btn-ghost', href: '#/share' }, 'Quick share & QR')
      )
    );
  }

  // ---- push queue (single-flight, coalescing) -------------------------

  var pushInFlight = null;
  var pushPending = false;
  function schedulePush() {
    if (pushInFlight) { pushPending = true; return pushInFlight; }
    pushInFlight = (async function () {
      paintPushIndicator();
      try {
        do {
          pushPending = false;
          var c = readConfig();
          if (!c.clientId || !c.spreadsheetId) break;
          try {
            var token = await M.auth.getToken(c.clientId);
            await M.sync.pushAll(token, c.spreadsheetId);
          } catch (e) {
            console.warn('[Minerva push]', e);
            break;
          }
        } while (pushPending);
      } finally {
        pushInFlight = null;
        paintPushIndicator();
      }
    })();
    return pushInFlight;
  }

  async function commitCellEdit(tab, rowId, columnName, newValue) {
    var row = await M.db.getRow(tab, rowId);
    if (!row) return;
    if (row[columnName] === newValue) return;
    row[columnName] = newValue;
    row._updated = new Date().toISOString();
    row._dirty = 1;
    await M.db.upsertRow(tab, row);
    schedulePush();
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
    var sheetLink = cfg.spreadsheetId
      ? el('a', { href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Edit in Sheets ↗')
      : null;

    var view = el('section', { class: 'view view-section' });
    var header = el('div', { class: 'view-section-head' });
    var meta1Span = el('span');
    var addBtn = el('button', { class: 'btn', type: 'button' }, '+ Add row');

    header.appendChild(el('h2', null, (sec.icon ? sec.icon + ' ' : '') + (sec.title || sec.slug)));
    header.appendChild(addBtn);
    view.appendChild(header);
    view.appendChild(el('p', { class: 'lead' }, meta1Span, sheetLink ? ' · ' : null, sheetLink));

    var tableHost = el('div');
    view.appendChild(tableHost);
    view.appendChild(el('p', { class: 'small muted' },
      'Click any cell to edit. ', el('kbd', null, 'Enter'), ' to save, ', el('kbd', null, 'Esc'), ' to cancel. Writes are queued and flushed to your spreadsheet automatically.'));

    async function refresh() {
      var meta = await M.db.getMeta(sec.tab);
      var allRows = await M.db.getAllRows(sec.tab);
      var visible = allRows.filter(function (r) { return !r._deleted; });
      var sorted = M.render.applySort(visible, sec.defaultSort);
      var filtered = M.render.applyFilter(sorted, sec.defaultFilter);

      var meta1 = filtered.length + ' row' + (filtered.length === 1 ? '' : 's');
      if (visible.length !== filtered.length) meta1 += ' (of ' + visible.length + ')';
      var parts = [meta1];
      if (sec.defaultSort) parts.push('sorted by ' + sec.defaultSort);
      if (sec.defaultFilter) parts.push('filtered: ' + sec.defaultFilter);
      meta1Span.textContent = parts.join(' · ');

      tableHost.replaceChildren(renderSectionTable(meta, filtered, sec.tab, refresh));
    }

    addBtn.addEventListener('click', async function () {
      var meta = await M.db.getMeta(sec.tab);
      if (!meta || !meta.headers) {
        flash(view, 'No schema cached — Sync first.', 'error');
        return;
      }
      await addRow(sec.tab, meta.headers);
      await refresh();
    });

    await refresh();
    return view;
  }

  function renderSectionTable(meta, rows, tab, refresh) {
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
        visibleCols.map(function (c) { return el('th', null, c.name); }).concat([
          el('th', { class: 'col-actions', 'aria-label': 'Actions' }, '')
        ])
      )
    );
    var tbody = el('tbody', null, rows.map(function (row) {
      var tr = el('tr', { 'data-rowid': row.id });
      if (row._dirty) tr.classList.add('row-dirty');
      visibleCols.forEach(function (c) {
        var td = el('td', { 'data-col': c.name, 'data-type': c.type, tabindex: '0' });
        td.appendChild(M.render.renderCell(row[c.name], c.type));
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

    var tgPanel = el('div', { class: 'tg-panel' });
    paintTg();

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

    return el('section', { class: 'view' },
      el('h2', null, 'Settings'),
      el('p', { class: 'lead' },
        'Minerva keeps no secrets in its repo. You bring your own Google OAuth client; Minerva remembers it locally. ',
        el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-google-oauth.md', target: '_blank', rel: 'noopener' }, 'Detailed setup walkthrough →')
      ),
      form,
      status,
      localPanel,
      tgPanel
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
    return el('article', { class: 'card card-' + kind },
      el('div', { class: 'card-kind' }, kindLabel),
      p.title ? el('h3', { class: 'card-title' }, p.title) : null,
      p.body ? el('p', { class: 'card-body' }, p.body) : null,
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

  async function tickReminders() {
    var tg = readTg();
    if (!tg.token || !tg.chatId || tg.disabled) return;

    // Find the tasks tab — _config tells us which.
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
      var line = '*' + (r.title || r.id) + '*';
      var dueStr = String(r.due).slice(0, 10);
      var prefix = dueStr < date ? '⏰ overdue (' + dueStr + ')' : '⏰ due today';
      var msg = prefix + ': ' + line;
      if (r.priority) msg += '\n_priority: ' + r.priority + '_';
      try {
        await M.telegram.sendMessage(tg.token, tg.chatId, msg);
        markPinged(r.id, date);
      } catch (e) {
        console.warn('[Minerva tg]', e);
        break;
      }
    }
  }

  // Schedule a periodic reminder check while the tab is open.
  var tgTimer = null;
  function scheduleReminders() {
    if (tgTimer) { clearInterval(tgTimer); tgTimer = null; }
    var tg = readTg();
    if (!tg.token || !tg.chatId || tg.disabled) return;
    tickReminders();
    tgTimer = setInterval(tickReminders, 30 * 60 * 1000); // every 30 min
  }

  function navActive() {
    var h = location.hash || '#/';
    if (h === '#/' || h === '' || h === '#') return '#/';
    if (/^#\/s\//.test(h)) return h;
    if (/^#\/share/.test(h)) return '#/share';
    if (h === '#/settings') return '#/settings';
    return '';
  }

  // ---- keyboard shortcuts + help overlay ----

  function showHelp() {
    if (document.querySelector('.help-overlay')) return;
    var overlay = el('div', { class: 'help-overlay',
      onclick: function () { overlay.remove(); }
    });
    var rows = [
      ['g', 'Home'],
      ['q', 'Quick share'],
      ['s', 'Settings'],
      ['1 – 9', 'Open the Nth section'],
      ['?', 'This panel'],
      ['Esc', 'Close panel / cancel cell edit'],
      ['Enter', 'Save current cell edit']
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
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '?' || (e.shiftKey && e.key === '/')) { showHelp(); return; }
    if (e.key === 'g') { location.hash = '#/'; return; }
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

  // ---- push-status indicator (bottom-right pill while pushes run) ----

  var pushIndicator = null;
  function ensurePushIndicator() {
    if (pushIndicator) return;
    pushIndicator = document.createElement('div');
    pushIndicator.className = 'push-indicator';
    pushIndicator.hidden = true;
    pushIndicator.textContent = 'Saving…';
    document.body.appendChild(pushIndicator);
  }
  function paintPushIndicator() {
    ensurePushIndicator();
    pushIndicator.hidden = !pushInFlight;
  }

  async function boot() {
    bindPicker();
    ensurePushIndicator();
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
