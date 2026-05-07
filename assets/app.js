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
    // Real DOM nodes pass through; everything else gets stringified so a
    // stray number / boolean(true) / object literal doesn't blow up
    // appendChild with "Argument 1 is not an object".
    if (k && typeof k === 'object' && k.nodeType) {
      parent.appendChild(k);
      return;
    }
    parent.appendChild(document.createTextNode(String(k)));
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
    scheduleDriveConfigSync();
    return next;
  }

  // Recovery escape hatch: unregister every service worker, drop
  // every Cache Storage entry, and hard-reload via location.replace
  // with a cache-busting query. Reachable via the Diagnostics
  // "Force update" button and via `Minerva.forceUpdate()` in the
  // console. Used when an old build keeps running because the
  // service worker is serving cached assets even after a refresh.
  async function forceUpdateAll() {
    try {
      if (navigator.serviceWorker) {
        var regs = await navigator.serviceWorker.getRegistrations();
        for (var i = 0; i < regs.length; i++) {
          try { await regs[i].unregister(); } catch (e) { /* ignore */ }
        }
      }
      if (window.caches && caches.keys) {
        var keys = await caches.keys();
        for (var j = 0; j < keys.length; j++) {
          try { await caches.delete(keys[j]); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* best effort */ }
    var url = location.origin + location.pathname
      + '?_force=' + Date.now()
      + (location.hash || '');
    location.replace(url);
  }
  window.Minerva = window.Minerva || {};
  window.Minerva.forceUpdate = forceUpdateAll;

  // ---- Drive-backed config sync ----
  // Persists every Settings field — including the OAuth Client ID — to
  // a single JSON file on the user's Drive. The Client ID is a public
  // OAuth identifier (the redirect-URI allow-list is what gates abuse),
  // so colocating it with the rest of the snapshot lets a new device
  // skip re-typing it after the first sign-in. The bootstrap path on a
  // fresh device still requires the Client ID locally to start the
  // first OAuth redirect; once signed in, this file fills in the rest.
  var DRIVE_CONFIG_FILENAME = 'minerva-config.json';
  var driveConfigSyncTimer = null;
  var driveConfigSyncInflight = false;
  function configForSync() {
    var c = readConfig();
    var out = {};
    [
      'clientId', 'spreadsheetId', 'youtubeApiKey',
      'cobaltEndpoint', 'cobaltApiKey',
      'ytDlpServer', 'ytDlpFormat',
      'corsProxy', 'offlineQuality'
    ].forEach(function (k) { if (c[k] != null) out[k] = c[k]; });
    return out;
  }
  function scheduleDriveConfigSync() {
    if (driveConfigSyncTimer) clearTimeout(driveConfigSyncTimer);
    driveConfigSyncTimer = setTimeout(function () {
      driveConfigSyncTimer = null;
      runDriveConfigSync().catch(function (err) {
        console.warn('[Minerva drive-config-sync]', err);
      });
    }, 1500);
  }
  // True only when M.auth has a non-expired cached access token. The
  // background Drive sync helpers below short-circuit on this so they
  // never call getToken — calling getToken without a cached token
  // would auto-redirect to Google's sign-in, which is exactly the
  // "asks me to log in immediately" failure mode we want to avoid.
  function hasLiveAuthToken() {
    if (!M.auth || typeof M.auth.getState !== 'function') return false;
    var s = M.auth.getState();
    return !!(s && s.hasToken);
  }
  async function runDriveConfigSync() {
    if (driveConfigSyncInflight) return;
    var c = readConfig();
    if (!c.clientId) return;
    if (!M.auth || !M.sheets) return;
    if (!hasLiveAuthToken()) return; // never trigger a sign-in from a background sync
    driveConfigSyncInflight = true;
    try {
      var token = await M.auth.getToken(c.clientId);
      var existing = await M.sheets.findDriveFile(token, DRIVE_CONFIG_FILENAME, 'application/json');
      var fileId = existing && existing.files && existing.files[0] && existing.files[0].id;
      var body = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        config: configForSync()
      });
      await M.sheets.uploadDriveFile(token, DRIVE_CONFIG_FILENAME, 'application/json', body, fileId);
    } finally {
      driveConfigSyncInflight = false;
    }
  }
  async function loadDriveConfigIfPresent() {
    var c = readConfig();
    if (!c.clientId) return false;
    if (!M.auth || !M.sheets) return false;
    if (!hasLiveAuthToken()) return false; // never trigger a sign-in from a background load
    var token;
    try { token = await M.auth.getToken(c.clientId); }
    catch (e) { return false; }
    var existing;
    try { existing = await M.sheets.findDriveFile(token, DRIVE_CONFIG_FILENAME, 'application/json'); }
    catch (e) { return false; }
    var file = existing && existing.files && existing.files[0];
    if (!file) return false;
    var raw;
    try { raw = await M.sheets.getDriveFileContent(token, file.id); }
    catch (e) { return false; }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return false; }
    if (!parsed || !parsed.config) return false;
    var current = readConfig();
    var merged = Object.assign({}, parsed.config, current);
    // Local values win for any keys the user already set on this device,
    // so re-running the load doesn't clobber a fresh local edit before
    // the next outbound sync writes back.
    localStorage.setItem(STORE, JSON.stringify(merged));
    return true;
  }
  window.Minerva = window.Minerva || {};
  window.Minerva.driveConfigSync = {
    save: runDriveConfigSync,
    load: loadDriveConfigIfPresent
  };

  // Last sign-in error string. Persists in module state so the
  // Settings view can render a sticky banner instead of a 3.5-second
  // flash that the user might miss. Cleared by the Settings view's
  // dismiss button or by the next successful sign-in.
  var lastAuthError = '';
  function setAuthError(msg) {
    lastAuthError = String(msg || '');
    try {
      var listeners = document.querySelectorAll('.auth-error-banner');
      // If a banner is already on screen, refresh its text and the
      // Settings view's hook below picks up the new value on next
      // mount. Otherwise the next render of Settings paints it fresh.
      Array.prototype.forEach.call(listeners, function (n) {
        n.querySelector('.auth-error-msg').textContent = lastAuthError;
      });
    } catch (e) { /* ignore */ }
  }
  function getAuthError() { return lastAuthError; }
  function clearAuthError() {
    lastAuthError = '';
    try {
      Array.prototype.forEach.call(document.querySelectorAll('.auth-error-banner'),
        function (n) { n.remove(); });
    } catch (e) { /* ignore */ }
  }

  // Mirror the post-auth bootstrap steps that the Settings page's
  // connect() handler runs after a successful popup auth. Called from
  // boot() when an OAuth redirect just resolved — without it the user
  // would be signed in but not connected to a spreadsheet.
  async function finishOAuthBootstrap(token) {
    if (!M.bootstrap || !M.sync) return;
    var bs = await M.bootstrap(token);
    if (bs && bs.spreadsheetId) {
      writeConfig({ spreadsheetId: bs.spreadsheetId });
    }
    try { await loadDriveConfigIfPresent(); }
    catch (e) { console.warn('[Minerva drive-config-load]', e); }
    try { await M.sync.pullAll(token, bs.spreadsheetId); }
    catch (e) { console.warn('[Minerva post-redirect-pull]', e); }
    try { await refreshConfig(); } catch (e) { /* ignore */ }
    flash(document.body,
      bs && bs.fresh ? 'Spreadsheet created and synced.' : 'Connected and synced.');
    if (typeof route === 'function') {
      try { await route(); } catch (e) { /* ignore */ }
    }
    // Push the local config back to Drive so any local edits made
    // before connecting (e.g. typed-but-unsynced API keys) become
    // part of the canonical Drive snapshot.
    if (typeof scheduleDriveConfigSync === 'function') scheduleDriveConfigSync();
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

  // Slugs that have been folded into other surfaces. Rows still
  // exist in the user's _config tab (we never touch their data) but
  // they're hidden from the nav and section pickers so they don't
  // duplicate the merged target. Direct hits on #/s/<slug> redirect
  // to the absorbing surface.
  var DEPRECATED_SECTIONS = {
    sketches: { redirect: '#/s/notes', mergedInto: 'Notes' },
    meets:    { redirect: '#/schedule', mergedInto: 'Schedule' },
    goals:    { redirect: null, mergedInto: '' /* gallery-only removal */ }
  };

  function sectionRows() {
    if (!configCache || !configCache.length) return [];
    return configCache.slice()
      .filter(isEnabled)
      .filter(function (r) { return r.slug && r.tab; })
      .filter(function (r) { return !DEPRECATED_SECTIONS[r.slug]; })
      .sort(function (a, b) {
        return (Number(a.order) || 0) - (Number(b.order) || 0);
      });
  }

  function renderNav(active) {
    var groups = [];
    var cfg = readConfig();
    var hasSheet = !!cfg.spreadsheetId;

    // Group 1: home + the always-on action views. Today is now part
    // of Home (the inline plan block + stats); no separate Today
    // entry. Schedule absorbs the When-to-meet builder via its
    // existing form.
    var primary = [{ hash: '#/', label: 'Home', icon: 'home' }];
    if (hasSheet) {
      primary.push({ hash: '#/schedule', label: 'Schedule', icon: 'calendar-clock' });
    }
    groups.push(primary);

    // Group 2: user-defined sections.
    if (hasSheet) {
      var sections = sectionRows().map(function (r) {
        return {
          hash: '#/s/' + encodeURIComponent(r.slug),
          label: r.title || r.slug,
          icon: r.icon,
          badge: r.tab === 'tasks' ? 'tasks' : null
        };
      });
      if (sections.length) groups.push(sections);
    }

    // Group 3: utility.
    var utility = [
      { hash: '#/share', label: 'Quick share', icon: 'qr-code' },
      { hash: '#/settings', label: 'Settings', icon: 'settings' }
    ];
    groups.push(utility);

    navEl.innerHTML = '';
    groups.forEach(function (items, gi) {
      if (gi > 0) navEl.appendChild(el('span', { class: 'nav-sep', 'aria-hidden': 'true' }));
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
      el('label', { for: id }, label, hint ? renderHintToggle(hint) : null),
      input,
      hint ? renderHintBody(hint) : null
    );
  }

  // Collapsible hint pattern. The label gets an inline (i) button; the
  // hint paragraph below it stays hidden until clicked. Same DOM tree
  // for every field, no <details> tag because some hints contain
  // interactive controls (links, buttons) that swallow the disclosure
  // event when nested inside <summary>.
  function renderHintToggle(hint) {
    var btn = el('button', {
      type: 'button',
      class: 'field-hint-toggle',
      title: 'What does this do?',
      'aria-label': 'Show help',
      'aria-expanded': 'false',
      onclick: function (e) {
        e.preventDefault();
        var fld = btn.closest('.field');
        if (!fld) return;
        var body = fld.querySelector('.field-hint-body');
        if (!body) return;
        var open = body.hasAttribute('hidden') ? false : true;
        if (open) { body.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
        else { body.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
      }
    });
    var icon = M.render && M.render.icon ? M.render.icon('info') : document.createTextNode('ⓘ');
    btn.appendChild(icon);
    return btn;
  }
  function renderHintBody(hint) {
    return el('div', { class: 'hint field-hint-body', hidden: '' }, hint);
  }

  // Toggle row: label on the left, iOS-style switch on the right. The
  // checkbox carries the form field name so the existing FormData
  // submit picks it up like any other input.
  function switchField(label, name, on, hint) {
    var id = 'sw-' + Math.random().toString(36).slice(2, 8);
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = name;
    cb.id = id;
    if (on) cb.checked = true;
    var sw = el('span', { class: 'switch-toggle' }, cb, el('span', { class: 'switch-thumb' }));
    var labelEl = el('label', { for: id, class: 'switch-row-label' },
      label,
      hint ? renderHintToggle(hint) : null
    );
    var row = el('div', { class: 'switch-row' }, labelEl, sw);
    return el('div', { class: 'field switch-field' },
      row,
      hint ? renderHintBody(hint) : null
    );
  }

  // Variant of field() that pairs the input with a Test button and a
  // live status pill. The test function receives the current input
  // value and returns a promise resolving to a string (success
  // message) or rejecting with an error. The pill polls /health on
  // initial render so users see the current state without clicking.
  function fieldWithTest(label, input, testFn, hint, opts) {
    opts = opts || {};
    var id = 'f-' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    var status = el('p', { class: 'small field-test-status', hidden: true });
    var pill = el('span', { class: 'svc-pill is-unset' }, 'not set');

    // Open: launches the configured URL in a new tab. The opener
    // remains so the user can switch back. Hidden when no URL is
    // entered. The base URL is the field as-is (browsers handle
    // trailing `?` for the CORS proxy field gracefully).
    // Open / Stop only make sense for URL-shaped fields. Credential
    // fields (e.g. an API key) skip them entirely.
    var openLink = !opts.isCredential
      ? el('a', { class: 'btn btn-ghost field-test-btn',
          target: '_blank', rel: 'noopener', title: 'Open in a new tab' },
          M.render.icon('external-link'), ' Open')
      : null;
    function refreshOpenHref() {
      if (!openLink) return;
      var v = input.value.trim();
      if (!v) {
        openLink.style.display = 'none';
        openLink.removeAttribute('href');
      } else {
        openLink.style.display = '';
        openLink.href = v.replace(/\/+\?$/, '/');
      }
    }
    refreshOpenHref();
    input.addEventListener('input', refreshOpenHref);

    var btn = el('button', { class: 'btn btn-ghost field-test-btn', type: 'button',
      onclick: async function (e) {
        e.preventDefault();
        status.hidden = false;
        status.classList.remove('is-ok', 'is-err');
        status.textContent = 'Testing…';
        btn.disabled = true;
        try {
          var ok = await testFn(input.value.trim());
          status.classList.add('is-ok');
          status.textContent = '✓ ' + (ok || 'OK');
          // Reflect the successful test on the pill directly. Re-running
          // attachStatusPill here would issue a separate /health probe
          // that some endpoints (e.g. corsproxy.io) don't support, so
          // a green Test could flip back to "offline" a second later.
          if (opts.healthPath === false) {
            pill.className = 'svc-pill is-ok';
            pill.textContent = 'online';
            pill.title = 'Last test passed';
          } else {
            attachStatusPill(pill, input.value.trim(), opts.healthPath);
          }
        } catch (err) {
          status.classList.add('is-err');
          status.textContent = '✗ ' + (err && err.message || err);
          pill.className = 'svc-pill is-down';
          pill.textContent = 'offline';
        } finally {
          btn.disabled = false;
        }
      }
    }, 'Test');

    // Stop: POST /shutdown to the configured URL. Only minerva-services
    // accepts this; other endpoints will 404 quietly.
    var stopBtn = opts.canStop !== false ? el('button', {
      class: 'btn btn-ghost field-test-btn', type: 'button',
      title: 'Send /shutdown to the configured server',
      onclick: async function (e) {
        e.preventDefault();
        var v = input.value.trim();
        if (!v) return;
        var url = v.replace(/\/+$/, '') + '/shutdown';
        stopBtn.disabled = true;
        try {
          var r = await fetch(url, { method: 'POST' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          status.hidden = false;
          status.classList.remove('is-err');
          status.classList.add('is-ok');
          status.textContent = '✓ Stop request accepted';
          pill.className = 'svc-pill is-down';
          pill.textContent = 'offline';
        } catch (err) {
          status.hidden = false;
          status.classList.remove('is-ok');
          status.classList.add('is-err');
          status.textContent = '✗ Stop failed: ' + (err && err.message || err)
            + ' (only the combined minerva-services script supports /shutdown)';
        } finally {
          stopBtn.disabled = false;
        }
      }
    }, M.render.icon('square'), ' Stop') : null;

    var row = el('div', { class: 'field-test-row' }, input, pill, openLink, btn, stopBtn);
    if (opts.healthPath !== false) {
      setTimeout(function () { attachStatusPill(pill, input.value.trim(), opts.healthPath); }, 0);
    }
    return el('div', { class: 'field' },
      el('label', { for: id }, label, hint ? renderHintToggle(hint) : null),
      row,
      status,
      hint ? renderHintBody(hint) : null
    );
  }

  // Trigger a browser download of a helper script bundled with the
  // deployed app (e.g. docs/minerva-services.py). The file is fetched
  // relative to the current path so it works for any host. A flash
  // surfaces the next step the user should take.
  async function downloadHelperScript(relPath, suggestedName, nextStep) {
    try {
      var resp = await fetch(relPath, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var blob = await resp.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      flash(document.body, suggestedName + ' downloaded — ' + nextStep);
    } catch (err) {
      flash(document.body,
        'Couldn\'t fetch ' + relPath + ': ' + (err && err.message || err)
        + ' — copy it manually from the GitHub repo.', 'error');
    }
  }

  // ---- Settings field probes ----

  async function testYoutubeApiKey(key) {
    if (!key) throw new Error('Empty key');
    var url = 'https://www.googleapis.com/youtube/v3/videos'
      + '?part=id&id=dQw4w9WgXcQ&key=' + encodeURIComponent(key);
    var resp = await fetch(url);
    if (resp.status === 400 || resp.status === 403) {
      var body = await resp.json().catch(function () { return {}; });
      throw new Error((body.error && body.error.message) || ('HTTP ' + resp.status));
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    if (!data.items) throw new Error('Unexpected response shape');
    return 'API key accepted by YouTube Data API v3';
  }

  async function testYtDlpServer(endpoint) {
    if (!endpoint) throw new Error('Empty URL');
    var base = endpoint.replace(/\/+$/, '');
    var resp;
    try { resp = await fetch(base + '/health'); }
    catch (e) { throw new Error('Cannot reach server (' + (e.message || e) + ')'); }
    if (!resp.ok) throw new Error('Server returned HTTP ' + resp.status);
    var data;
    try { data = await resp.json(); }
    catch (e) { throw new Error('Server response is not JSON — verify this is a Minerva yt-dlp server'); }
    if (!data || data.ok !== true) throw new Error('Health check did not report ok:true');
    return 'Server reachable (' + (data.service || 'yt-dlp') + ')';
  }

  async function testCobaltEndpoint(endpoint) {
    if (!endpoint) throw new Error('Empty URL');
    var base = endpoint.replace(/\/+$/, '');
    // Cobalt's root returns a JSON manifest with version + commit info.
    var resp;
    try { resp = await fetch(base + '/'); }
    catch (e) { throw new Error('Cannot reach Cobalt (' + (e.message || e) + ')'); }
    if (!resp.ok) throw new Error('Cobalt returned HTTP ' + resp.status);
    var data;
    try { data = await resp.json(); }
    catch (e) { throw new Error('Response is not JSON — verify the URL points at a Cobalt API'); }
    var ver = (data && (data.cobalt && data.cobalt.version || data.version)) || '?';
    return 'Cobalt instance reachable (version ' + ver + ')';
  }

  async function testCorsProxy(prefix) {
    if (!prefix) throw new Error('Empty prefix — leave blank to disable instead of testing');
    var probeTarget = 'https://api.crossref.org/works/10.1038/nature14539';
    var resp;
    try { resp = await fetch(prefix + encodeURIComponent(probeTarget)); }
    catch (e) { throw new Error('Cannot reach proxy (' + (e.message || e) + ')'); }
    if (!resp.ok) throw new Error('Proxy returned HTTP ' + resp.status);
    // Be permissive about the body shape: some proxies (and the
    // self-hosted minerva-services /proxy?) return CrossRef JSON
    // verbatim; others return JSON wrapped in a status envelope; some
    // strip headers and return raw text. Accept anything that looks
    // like a CrossRef-shaped JSON OR contains the DOI we asked for.
    var body = await resp.text();
    if (body.indexOf('10.1038/nature14539') >= 0) {
      return 'Proxy reaches CrossRef successfully';
    }
    try {
      var data = JSON.parse(body);
      if (data && (data.message || data.DOI || data.doi)) {
        return 'Proxy reaches CrossRef and returns JSON';
      }
    } catch (e) { /* fall through */ }
    throw new Error('Proxy reachable but the response did not look like CrossRef data');
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
        var pct = tasks.length ? Math.round(100 * done / tasks.length) : 0;

        // 30-day completion sparkline series — bucket done tasks by
        // _updated date, oldest first. NaN dates fall through.
        var DAYS = 30;
        var series = new Array(DAYS);
        for (var si = 0; si < DAYS; si++) series[si] = 0;
        var startD = new Date();
        startD.setHours(0, 0, 0, 0);
        var startMs = startD.getTime() - (DAYS - 1) * 86400000;
        var doneRecent = 0;
        tasks.forEach(function (r) {
          if (statusOf(r) !== 'done') return;
          var ts = r._updated ? Date.parse(r._updated) : NaN;
          if (!isFinite(ts)) return;
          var idx = Math.floor((ts - startMs) / 86400000);
          if (idx >= 0 && idx < DAYS) {
            series[idx]++;
            doneRecent++;
          }
        });

        stats.push({
          label: 'Tasks done',
          value: done + ' / ' + tasks.length,
          pct: pct,
          href: '#/s/tasks',
          chart: { kind: 'sparkline', series: series, total: doneRecent }
        });

        // Status mini-bar — bucket by actual status values present in
        // the data, with todo/doing/done preferred up front when seen.
        // Empty/missing status falls into 'todo' so all rows are accounted
        // for. The schema usually has todo/doing/done but other sheets
        // may define their own values; we render whatever is there.
        var counts = {};
        var order = [];
        function bumpStatus(key) {
          if (counts[key] == null) {
            counts[key] = 0;
            order.push(key);
          }
          counts[key]++;
        }
        tasks.forEach(function (r) {
          var s = statusOf(r);
          if (!s) s = 'todo';
          bumpStatus(s);
        });
        // Stable preferred order for the canonical buckets.
        var preferred = ['todo', 'doing', 'done'];
        var sortedKeys = [];
        preferred.forEach(function (k) {
          if (counts[k] != null) sortedKeys.push(k);
        });
        order.forEach(function (k) {
          if (preferred.indexOf(k) < 0) sortedKeys.push(k);
        });
        var segments = sortedKeys.map(function (k) {
          var accent;
          if (k === 'done') accent = 'var(--accent)';
          else if (k === 'doing') accent = 'var(--accent-2, var(--accent))';
          else accent = 'var(--muted)';
          return { label: k, value: counts[k], accent: accent };
        });
        stats.push({
          label: 'Status',
          href: '#/s/tasks',
          chart: { kind: 'status', segments: segments, total: tasks.length }
        });
      }
    } catch (e) { /* ignore */ }

    // Goals
    try {
      var goals = aliveOf(await M.db.getAllRows('goals'));
      if (goals.length) {
        var totalProgress = goals.reduce(function (s, r) { return s + (Number(r.progress) || 0); }, 0);
        var avg = goals.length ? Math.round(totalProgress / goals.length) : 0;
        stats.push({
          label: 'Avg goal progress',
          value: avg + '%',
          pct: avg,
          href: '#/s/goals',
          chart: { kind: 'donut', value: avg, max: 100 }
        });
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
    var hasChart = s.chart && M.charts;
    var isDonut = hasChart && s.chart.kind === 'donut';
    var isSpark = hasChart && s.chart.kind === 'sparkline';
    var isStatus = hasChart && s.chart.kind === 'status';

    var children = [];
    children.push(el('div', { class: 'stat-label' }, s.label));

    if (isSpark) {
      var sparkSvg = M.charts.sparkline(s.chart.series, { width: 120, height: 28, fill: true });
      sparkSvg.setAttribute('aria-label',
        '30-day task completion: ' + (s.chart.total || 0) + ' done');
      children.push(el('div', { class: 'stat-chart stat-chart-spark' }, sparkSvg));
      children.push(el('div', { class: 'stat-value' }, s.value));
    } else if (isDonut) {
      var donutSvg = M.charts.donut(s.chart.value, s.chart.max || 100, { size: 56, thickness: 8 });
      donutSvg.setAttribute('aria-label', s.label + ': ' + s.value);
      children.push(el('div', { class: 'stat-chart stat-chart-donut' }, donutSvg));
    } else if (isStatus) {
      var segs = s.chart.segments || [];
      var ariaParts = [];
      var captionParts = [];
      segs.forEach(function (seg) {
        if (!seg || !seg.value) return;
        ariaParts.push(seg.value + ' ' + (seg.label || ''));
        captionParts.push(seg.value + ' ' + (seg.label || ''));
      });
      var statusAria = 'Task status: ' + (ariaParts.length ? ariaParts.join(', ') : 'no rows');
      var barSvg = M.charts.stackedBar(segs, {
        width: 200, height: 10,
        ariaLabel: statusAria
      });
      children.push(el('div', { class: 'stat-chart stat-chart-status' }, barSvg));
      var captionText = captionParts.length ? captionParts.join(' · ') : 'No tasks';
      children.push(el('small', { class: 'stat-status-caption muted' }, captionText));
    } else {
      children.push(el('div', { class: 'stat-value' }, s.value));
      if (typeof s.pct === 'number') {
        var bar = el('div', { class: 'stat-bar' });
        var fill = el('div', { class: 'stat-bar-fill' });
        fill.style.width = Math.max(0, Math.min(100, s.pct)) + '%';
        bar.appendChild(fill);
        children.push(bar);
      }
    }

    var cls = 'stat-card';
    if (isDonut) cls += ' stat-card-donut';
    if (isStatus) cls += ' stat-card-status';
    if (s.danger) cls += ' stat-danger';
    else if (s.accent) cls += ' stat-accent';
    if (s.href) {
      var a = el('a', { class: cls, href: s.href });
      children.forEach(function (c) { a.appendChild(c); });
      return a;
    }
    return el('div', { class: cls }, children);
  }

  function timeOfDayGreeting() {
    var h = new Date().getHours();
    if (h < 5)  return 'Up late';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Up late';
  }

  function firstNameFromEmail(email) {
    if (!email) return '';
    var local = String(email).split('@')[0];
    var firstPart = local.split(/[._\-+]/)[0];
    if (!firstPart) return '';
    return firstPart.charAt(0).toUpperCase() + firstPart.slice(1).toLowerCase();
  }

  // Top-N most-recently-touched rows across every section tab.
  async function recentActivity(limit) {
    if (!M.db) return [];
    try {
      var allMeta = await M.db.getAllMeta();
      var out = [];
      for (var m of allMeta) {
        if (!m || !m.tab || m.tab.charAt(0) === '_') continue;
        if (/_log$/.test(m.tab)) continue;
        var rows = await M.db.getAllRows(m.tab);
        rows.forEach(function (r) {
          if (r._deleted) return;
          if (!r._updated) return;
          var hasLabel = (r.title && String(r.title).trim()) || (r.name && String(r.name).trim());
          if (!hasLabel) return;
          var ts = Date.parse(r._updated);
          if (!ts) return;
          out.push({ tab: m.tab, row: r, ts: ts });
        });
      }
      out.sort(function (a, b) { return b.ts - a.ts; });
      return out.slice(0, limit || 5);
    } catch (e) { return []; }
  }

  async function viewHome() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };
    var connected = st.hasToken && cfg.spreadsheetId;

    if (connected) return await viewHomeConnected(cfg, st);
    return viewHomeLanding(cfg, st);
  }

  async function viewHomeConnected(cfg, st) {
    // Headline numbers — same data the nav badge uses, surfaced inline.
    var today = todayStr();
    var tasks = (await M.db.getAllRows('tasks').catch(function () { return []; }))
      .filter(function (r) { return !r._deleted && String(r.status || '').toLowerCase() !== 'done'; });
    var dueToday = tasks.filter(function (r) {
      return r.due && String(r.due).slice(0, 10) === today;
    }).length;
    var overdue = tasks.filter(function (r) {
      return r.due && String(r.due).slice(0, 10) < today;
    }).length;

    var todaysEventsCount = 0;
    try {
      var startOfTodayD = new Date(); startOfTodayD.setHours(0, 0, 0, 0);
      var endOfTodayD = new Date(startOfTodayD.getTime() + 86400000);
      var allMeta = await M.db.getAllMeta();
      for (var m of allMeta) {
        if (!m || !m.headers) continue;
        if (m.headers.indexOf('start') < 0 || m.headers.indexOf('end') < 0) continue;
        var rows = await M.db.getAllRows(m.tab);
        rows.forEach(function (r) {
          if (r._deleted || !r.start) return;
          var s = new Date(r.start);
          if (isNaN(s.getTime())) return;
          if (s >= startOfTodayD && s < endOfTodayD) todaysEventsCount++;
        });
      }
    } catch (e) { /* non-fatal */ }

    var habitsLeft = 0;
    try {
      var habits = (await M.db.getAllRows('habits')).filter(function (h) { return !h._deleted; });
      var logs = (await M.db.getAllRows('habit_log')).filter(function (l) { return !l._deleted; });
      var done = {};
      logs.forEach(function (l) { if (String(l.date).slice(0, 10) === today) done[l.habit_id] = true; });
      habitsLeft = habits.filter(function (h) { return !done[h.id]; }).length;
    } catch (e) { /* ignore */ }

    // ---- hero -----------------------------------------------------------
    var greeting = timeOfDayGreeting();
    var name = firstNameFromEmail(st.email);
    var greet = greeting + (name ? ', ' + name : '');
    var dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    var hero = el('header', { class: 'home-hero' },
      el('h2', { class: 'home-hero-greet' }, greet),
      el('p', { class: 'home-hero-date' }, dateStr)
    );

    // Quick-add: same shape as Today's, surfaced on home.
    var qa = document.createElement('input');
    qa.type = 'text';
    qa.className = 'home-quick-add';
    qa.placeholder = 'Add a task…  (Enter)';
    qa.autocomplete = 'off';
    qa.addEventListener('keydown', async function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var title = qa.value.trim();
      if (!title) return;
      try {
        var meta = await M.db.getMeta('tasks');
        if (!meta || !meta.headers) {
          flash(hero, 'No tasks tab synced yet.', 'error');
          return;
        }
        var row = await addRow('tasks', meta.headers);
        row.title = title;
        if (meta.headers.indexOf('due') >= 0) row.due = today;
        if (meta.headers.indexOf('status') >= 0) row.status = 'todo';
        row._dirty = 1;
        await M.db.upsertRow('tasks', row);
        schedulePush();
        qa.value = '';
        await route(); // refresh stats inline
        // Re-focus the new quick-add input so the user can keep
        // brain-dumping tasks one after another without reaching
        // for the mouse.
        setTimeout(function () {
          var nextQa = document.querySelector('.home-quick-add');
          if (nextQa) nextQa.focus();
        }, 50);
      } catch (err) {
        flash(hero, 'Add failed: ' + (err && err.message ? err.message : err), 'error');
      }
    });
    hero.appendChild(qa);

    // Today summary pill (only when there's something to surface).
    var todayItems = [];
    if (overdue) todayItems.push({ icon: 'alert-triangle', text: overdue + ' overdue', cls: 'today-pill-danger' });
    if (dueToday) todayItems.push({ icon: 'calendar', text: dueToday + ' due today' });
    if (todaysEventsCount) todayItems.push({ icon: 'users', text: todaysEventsCount + ' event' + (todaysEventsCount === 1 ? '' : 's') });
    if (habitsLeft) todayItems.push({ icon: 'zap', text: habitsLeft + ' habit' + (habitsLeft === 1 ? '' : 's') + ' left' });
    if (todayItems.length) {
      var todayCard = el('a', { class: 'home-today-card', href: '#/today' });
      var todayHead = el('div', { class: 'home-today-head' });
      todayHead.appendChild(M.render.icon('sun'));
      todayHead.appendChild(el('span', { class: 'home-today-title' }, 'Today'));
      todayCard.appendChild(todayHead);
      var pillsWrap = el('div', { class: 'home-today-pills' });
      todayItems.forEach(function (p) {
        var pill = el('span', { class: 'home-today-pill ' + (p.cls || '') });
        pill.appendChild(M.render.icon(p.icon));
        pill.appendChild(document.createTextNode(' ' + p.text));
        pillsWrap.appendChild(pill);
      });
      todayCard.appendChild(pillsWrap);
      hero.appendChild(todayCard);
    } else {
      hero.appendChild(el('p', { class: 'small muted home-empty-today' },
        'Nothing scheduled for today. ',
        el('a', { href: '#/today' }, 'View Today')));
    }

    // ---- section grid ---------------------------------------------------
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

    // ---- recent activity ------------------------------------------------
    var recent = await recentActivity(5);
    var recentEl = null;
    if (recent.length) {
      var ul = el('ul', { class: 'home-recent' });
      recent.forEach(function (r) {
        var label = r.row.title || r.row.name || r.row.id;
        var li = el('li');
        // Detail view in-place; long-press / shift-click goes to section.
        var btn = el('button', {
          type: 'button',
          class: 'home-recent-link',
          title: 'Open detail (Shift+Click for section)',
          onclick: function (e) {
            if (e.shiftKey) {
              location.hash = '#/s/' + encodeURIComponent(r.tab);
            } else {
              showRowDetail(r.tab, r.row.id);
            }
          }
        });
        btn.appendChild(el('span', { class: 'home-recent-label' }, label));
        btn.appendChild(el('span', { class: 'home-recent-tab small muted' }, r.tab));
        btn.appendChild(el('span', { class: 'home-recent-when small muted' }, M.render.relativeTime(r.ts)));
        li.appendChild(btn);
        ul.appendChild(li);
      });
      recentEl = el('div', { class: 'home-block' },
        el('h3', { class: 'home-block-h' }, 'Recently edited'),
        ul
      );
    }

    // ---- stats ----------------------------------------------------------
    var stats = await buildStats();

    // ---- 7-day habit strip ---------------------------------------------
    // Walks habit_log rows and buckets completions by day for the trailing
    // 7 days (oldest first). Only shown when the section list includes a
    // 'habits' tab and there is at least one (alive) habit_log row.
    var habitStripEl = null;
    var hasHabitsTab = sections.some(function (r) { return r.tab === 'habits' || r.slug === 'habits'; });
    if (hasHabitsTab && M.charts && M.charts.heatmapStrip) {
      try {
        var habitLogs = aliveOf(await M.db.getAllRows('habit_log'));
        if (habitLogs.length) {
          var STRIP_DAYS = 7;
          var stripSeries = new Array(STRIP_DAYS);
          for (var hi = 0; hi < STRIP_DAYS; hi++) stripSeries[hi] = 0;
          var hStart = new Date();
          hStart.setHours(0, 0, 0, 0);
          var hStartMs = hStart.getTime() - (STRIP_DAYS - 1) * 86400000;
          var hTotal = 0;
          habitLogs.forEach(function (l) {
            var k = String(l.date || '').slice(0, 10);
            if (!k) return;
            var ts = Date.parse(k);
            if (!isFinite(ts)) return;
            var idx = Math.floor((ts - hStartMs) / 86400000);
            if (idx < 0 || idx >= STRIP_DAYS) return;
            var c = Number(l.count) || 1;
            stripSeries[idx] += c;
            hTotal += c;
          });
          var stripSvg = M.charts.heatmapStrip(stripSeries, {
            cellSize: 18,
            gap: 4,
            ariaLabel: 'Habit completions, last 7 days: ' + hTotal + ' total'
          });
          var stripHead = el('div', { class: 'home-habit-strip-head' });
          stripHead.appendChild(M.render.icon('flame'));
          stripHead.appendChild(document.createTextNode(' Habits — last 7 days'));
          habitStripEl = el('a', { class: 'home-habit-strip', href: '#/s/habits' },
            stripHead,
            stripSvg,
            el('small', { class: 'muted' },
              hTotal + ' completion' + (hTotal === 1 ? '' : 's'))
          );
        }
      } catch (e) { /* ignore */ }
    }

    // ---- inline "Today's plan" -----------------------------------------
    // What used to live at /today is now folded into home so there is a
    // single landing surface. The standalone /today route still resolves
    // and forwards to / for back-compat.
    var todayPlanEl = await buildHomeTodayPlan(today);

    return el('section', { class: 'view view-home-connected' },
      hero,
      stats.length ? el('div', { class: 'stats-grid' }, stats.map(renderStatCard)) : null,
      habitStripEl,
      todayPlanEl,
      sections.length
        ? el('div', { class: 'home-block' },
            el('h3', { class: 'home-block-h' }, 'Sections'),
            el('div', { class: 'section-cards' }, cards))
        : el('p', { class: 'muted' },
            'No sections yet. ',
            el('a', { href: '#/settings' }, 'Add one from the preset gallery')),
      recentEl,
      el('div', { class: 'home-footer-cta' },
        el('a', { href: '#/share', class: 'home-footer-link' }, 'Quick share'),
        el('a', { href: '#/schedule', class: 'home-footer-link' }, 'Schedule'),
        el('a', { href: '#/graph', class: 'home-footer-link' }, 'Graph'),
        el('a', { href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), class: 'home-footer-link', target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Spreadsheet'),
        el('a', { href: '#/settings', class: 'home-footer-link' }, 'Settings'),
        renderVersionBadge()
      )
    );
  }

  // Compose the inline today block embedded in the home view: today's
  // tasks (overdue + due today), habits not yet checked off, and any
  // events that start today. Returns null when there is nothing to
  // surface so the home page stays compact for empty days.
  async function buildHomeTodayPlan(today) {
    var tasks = (await M.db.getAllRows('tasks').catch(function () { return []; }))
      .filter(function (r) {
        if (r._deleted) return false;
        if (String(r.status || '').toLowerCase() === 'done') return false;
        if (!r.due) return false;
        return String(r.due).slice(0, 10) <= today;
      })
      .sort(function (a, b) { return String(a.due).localeCompare(String(b.due)); });

    var habits = (await M.db.getAllRows('habits').catch(function () { return []; }))
      .filter(function (h) { return !h._deleted; });
    var habitLogs = (await M.db.getAllRows('habit_log').catch(function () { return []; }))
      .filter(function (l) { return !l._deleted; });
    var doneToday = {};
    habitLogs.forEach(function (l) {
      if (String(l.date).slice(0, 10) === today) doneToday[l.habit_id] = true;
    });
    var habitsLeft = habits.filter(function (h) { return !doneToday[h.id]; });

    var startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    var endOfToday = new Date(startOfToday.getTime() + 86400000);
    var events = [];
    try {
      var allMeta = await M.db.getAllMeta();
      for (var m of allMeta) {
        if (!m || !m.headers || !m.types) continue;
        if (m.headers.indexOf('start') < 0 || m.headers.indexOf('end') < 0) continue;
        var rows = await M.db.getAllRows(m.tab);
        rows.forEach(function (r) {
          if (r._deleted || !r.start) return;
          var s = new Date(r.start);
          if (isNaN(s.getTime()) || s < startOfToday || s >= endOfToday) return;
          events.push({ row: r, start: s, tab: m.tab });
        });
      }
      events.sort(function (a, b) { return a.start - b.start; });
    } catch (e) { /* non-fatal */ }

    if (!tasks.length && !habitsLeft.length && !events.length) return null;

    var wrap = el('div', { class: 'home-block home-today-plan' });
    var head = el('h3', { class: 'home-block-h' });
    head.appendChild(M.render.icon('sun'));
    head.appendChild(document.createTextNode(' Today'));
    wrap.appendChild(head);

    if (tasks.length) {
      var tList = el('ul', { class: 'home-today-list' });
      tasks.slice(0, 8).forEach(function (t) {
        var overdueCls = (String(t.due).slice(0, 10) < today) ? ' is-overdue' : '';
        var li = el('li', { class: 'home-today-item' + overdueCls });
        var doneBtn = el('button', { class: 'home-today-check', type: 'button',
          title: 'Mark done',
          'aria-label': 'Mark done',
          onclick: async function (e) {
            e.preventDefault();
            var fresh = await M.db.getRow('tasks', t.id);
            if (!fresh || fresh._deleted) return;
            fresh.status = 'done';
            fresh._dirty = 1;
            fresh._updated = new Date().toISOString();
            await M.db.upsertRow('tasks', fresh);
            schedulePush();
            await route();
          }
        });
        doneBtn.appendChild(M.render.icon('square'));
        var label = el('button', { class: 'home-today-label', type: 'button',
          onclick: function () { showRowDetail('tasks', t.id); }
        }, t.title || '(untitled task)');
        var when = el('span', { class: 'home-today-when small muted' }, String(t.due).slice(0, 10));
        li.appendChild(doneBtn);
        li.appendChild(label);
        li.appendChild(when);
        tList.appendChild(li);
      });
      wrap.appendChild(tList);
    }

    if (habitsLeft.length) {
      var hList = el('ul', { class: 'home-today-list home-today-habits' });
      habitsLeft.slice(0, 8).forEach(function (h) {
        var li = el('li', { class: 'home-today-item' });
        var doneBtn = el('button', { class: 'home-today-check', type: 'button',
          title: 'Log done',
          'aria-label': 'Log done',
          onclick: async function (e) {
            e.preventDefault();
            try {
              var meta = await M.db.getMeta('habit_log');
              if (!meta || !meta.headers) return;
              var row = await addRow('habit_log', meta.headers);
              if (meta.headers.indexOf('habit_id') >= 0) row.habit_id = h.id;
              if (meta.headers.indexOf('date') >= 0) row.date = today;
              if (meta.headers.indexOf('count') >= 0) row.count = '1';
              row._dirty = 1;
              await M.db.upsertRow('habit_log', row);
              schedulePush();
              await route();
            } catch (err) { /* ignore */ }
          }
        });
        doneBtn.appendChild(M.render.icon('zap'));
        li.appendChild(doneBtn);
        li.appendChild(el('span', { class: 'home-today-label' }, h.name || h.title || '(habit)'));
        hList.appendChild(li);
      });
      wrap.appendChild(hList);
    }

    if (events.length) {
      var eList = el('ul', { class: 'home-today-list home-today-events' });
      events.slice(0, 6).forEach(function (e) {
        var li = el('li', { class: 'home-today-item' });
        li.appendChild(el('span', { class: 'home-today-when' },
          e.start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        ));
        var btn = el('button', { class: 'home-today-label', type: 'button',
          onclick: function () { showRowDetail(e.tab, e.row.id); }
        }, e.row.title || e.row.name || '(event)');
        li.appendChild(btn);
        eList.appendChild(li);
      });
      wrap.appendChild(eList);
    }

    return wrap;
  }

  // Click-to-copy build pill. Rendered in the home footer and the
  // Settings header. Useful for diagnosing service-worker cache lag,
  // where a deploy may need a refresh before the active assets match
  // the published build label.
  function renderVersionBadge() {
    var v = (window.Minerva && Minerva.version) || { label: 'v?' };
    var badge = el('button', {
      type: 'button',
      class: 'version-badge',
      title: 'Click to copy: ' + v.label,
      onclick: async function () {
        try {
          await navigator.clipboard.writeText(v.label);
          flash(document.body, 'Version copied: ' + v.label);
        } catch (e) {
          flash(document.body, v.label, 'error');
        }
      }
    }, v.label);
    return badge;
  }

  function viewHomeLanding(cfg, st) {
    var view = el('section', { class: 'view view-home-landing' });
    var hero = el('header', { class: 'home-hero home-hero-landing' },
      el('h2', { class: 'home-hero-greet' }, 'Minerva'),
      el('p', { class: 'home-hero-date' }, 'A planner backed by a Google Sheet you own.'),
      el('p', { class: 'lead' },
        'Goals, tasks, projects, notes, habits, papers, meetings — all in one Sheet, mirrored to your browser, sharable as URLs and QR codes. ',
        el('strong', null, 'Static site. No servers. No accounts.'),
        ' Open-source under GPL-3.'
      )
    );
    view.appendChild(hero);
    view.appendChild(renderOnboarding(cfg, st));
    view.appendChild(el('div', { class: 'callouts callouts-compact' },
      callout('Share publicly', 'Quick-share notes, questions, or polls — get a stable URL and a QR code. Works without connecting.'),
      callout('Plan & schedule', 'Free-time view, share-availability links, and a no-backend "When to meet" group poll.'),
      callout('Research-friendly', 'arXiv + DOI + YouTube smart-import, BibTeX export, KaTeX math, PDF preview, proposal helper.'),
      callout('No build, no backend', 'Pure HTML/CSS/JS on GitHub Pages. Hackable. Forkable. Yours.'),
      callout('Privacy by default', 'Minimal `drive.file` scope; no telemetry; data stays in your Google account.'),
      callout('Open source', el('span', null,
        'GPL-3. Source: ',
        el('a', { href: 'https://github.com/the-farshad/Minerva', target: '_blank', rel: 'noopener' }, 'github.com/the-farshad/Minerva')
      ))
    ));
    view.appendChild(el('div', { class: 'cta-row' },
      el('a', { class: 'btn', href: '#/settings' }, 'Open Settings'),
      el('a', { class: 'btn btn-ghost', href: '#/share' }, 'Try Quick share & QR (no login)')
    ));
    return view;
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
      var num = el('span', { class: 'onboarding-num' });
      if (done) num.appendChild(M.render.icon('check'));
      else num.appendChild(document.createTextNode(String(n)));
      return el('li', { class: classes },
        num,
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
          ? el('a', { class: 'btn', href: '#/settings' }, 'Open Settings')
          : firstUndone === 4
            ? el('a', { class: 'btn', href: '#/settings' }, 'Connect Google')
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

    // Auto-fill sibling fields on URL paste: when the user drops a YouTube
    // URL (or arXiv id, or DOI) into a link-typed cell, fetch metadata via
    // M.import.lookup and populate any empty columns in the same row that
    // match the lookup keys (title, channel, authors, year, thumbnail, ...).
    // Existing non-empty cells are never overwritten.
    autoFillFromUrl(tab, rowId, columnName, newValue).catch(function (err) {
      console.warn('[Minerva autoFill]', err);
    });

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

  async function autoFillFromUrl(tab, rowId, columnName, value) {
    if (!value || !M.import || !M.import.lookup) return;
    var s = String(value).trim();
    // Cheap pre-filter — only run lookup for URLs we know how to handle.
    var match = /youtube\.com|youtu\.be/i.test(s)
             || /arxiv\.org|^\d{4}\.\d{4,5}/i.test(s)
             || /(?:doi\.org\/|^)10\.\d{4,9}\//i.test(s);
    if (!match) return;
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) return;
    var idx = meta.headers.indexOf(columnName);
    if (idx < 0) return;
    var t = (meta.types && meta.types[idx]) || '';
    // Only auto-fill when the user pasted into a link- or url-typed cell.
    if (!/link|url/i.test(t) && columnName !== 'url') return;

    var data;
    try { data = await M.import.lookup(s); }
    catch (e) {
      // Surface a flash for playlist-paste errors so the user knows why
      // their playlist URL didn't expand. Other lookup errors stay quiet
      // (existing behavior).
      if (/[?&]list=[\w-]+/.test(s)) {
        flash(document.body, 'YouTube playlist: ' + ((e && e.message) || e), 'error');
      }
      return;
    }
    if (!data) return;

    var row = await M.db.getRow(tab, rowId);
    if (!row) return;

    // Playlist / channel branch: enumerate every video and add a row per video.
    // The pasted-into row receives item 0 (so the user keeps the row they
    // were editing); items 1..N-1 become new rows.
    if (data.kind === 'playlist' || data.kind === 'channel') {
      try {
        await importYoutubePlaylist(tab, data, row);
      } catch (e) {
        flash(document.body, (data.kind === 'channel' ? 'Channel' : 'Playlist') + ' import failed: ' + ((e && e.message) || e), 'error');
      }
      return;
    }

    // No API key but playlist / channel URL — surface guidance instead of
    // silently falling through to a single-video import.
    if (data.kind === 'playlist-needs-key' || data.kind === 'channel-needs-key') {
      flash(document.body, data.message, 'error');
      return;
    }

    var changed = false;
    Object.keys(data).forEach(function (k) {
      if (k === 'kind') return;
      if (meta.headers.indexOf(k) < 0) return;
      var existing = row[k];
      if (existing && String(existing).trim()) return;  // never overwrite
      var v = data[k];
      if (v == null || v === '') return;
      row[k] = v;
      changed = true;
    });
    if (!changed) return;
    row._updated = new Date().toISOString();
    row._dirty = 1;
    await M.db.upsertRow(tab, row);
    schedulePush();
    // Re-render so the auto-filled cells appear immediately.
    try { if (typeof route === 'function') await route(); } catch (e) { /* ignore */ }
  }

  // Add a row per item in a YouTube playlist enumeration. When sourceRow
  // is given (paste into an existing row), item 0 fills that row's empty
  // fields and items 1..N become new rows; when null (URL-import modal),
  // every item becomes a new row.
  async function importYoutubePlaylist(tab, data, sourceRow, opts) {
    opts = opts || {};
    var items = (data && data.items) || [];
    if (!items.length) return;
    var meta = await M.db.getMeta(tab);
    if (!meta || !meta.headers) return;
    var applyCategory = opts.category && meta.headers.indexOf('category') >= 0
      ? String(opts.category)
      : '';

    // Index URLs already present in this section so re-importing the
    // same playlist or channel adds only new videos. The sourceRow (if
    // any) is excluded from the index so the paste-into-row branch is
    // free to overwrite it with item 0.
    var existingUrls = new Set();
    if (meta.headers.indexOf('url') >= 0) {
      var existingRows = await M.db.getAllRows(tab);
      existingRows.forEach(function (r) {
        if (r._deleted) return;
        if (sourceRow && r.id === sourceRow.id) return;
        var u = r.url && String(r.url).trim();
        if (u) existingUrls.add(u);
      });
    }
    var skipped = 0;

    var startIdx = 0;
    if (sourceRow) {
      var first = items[0];
      // The user pasted a playlist URL into this row, so the URL cell
      // currently holds the *playlist* link (which won't render as a
      // YouTube thumbnail and breaks the play button). Replace it with
      // item 0's actual video URL so the row becomes a real video row.
      Object.keys(first).forEach(function (k) {
        if (k === 'videoId') return;
        if (meta.headers.indexOf(k) < 0) return;
        if (k === 'url') {
          sourceRow.url = first.url;
          return;
        }
        if (sourceRow[k] && String(sourceRow[k]).trim()) return;
        sourceRow[k] = first[k];
      });
      if (applyCategory && !sourceRow.category) sourceRow.category = applyCategory;
      sourceRow._updated = new Date().toISOString();
      sourceRow._dirty = 1;
      await M.db.upsertRow(tab, sourceRow);
      startIdx = 1;
    }

    var addedCount = 0;
    for (var i = startIdx; i < items.length; i++) {
      var item = items[i];
      var itemUrl = item.url && String(item.url).trim();
      if (itemUrl && existingUrls.has(itemUrl)) { skipped++; continue; }
      var newRow = await addRow(tab, meta.headers);
      Object.keys(item).forEach(function (k) {
        if (k === 'videoId') return;
        if (meta.headers.indexOf(k) < 0) return;
        var v = item[k];
        if (v == null || v === '') return;
        newRow[k] = v;
      });
      // YouTube tracker preset has a `read` column that serves as
      // watched/unwatched; default to FALSE so freshly-imported videos
      // start as unwatched (consistent with single-URL import).
      if (meta.headers.indexOf('read') >= 0 && !newRow.read) newRow.read = 'FALSE';
      if (applyCategory) newRow.category = applyCategory;
      newRow._updated = new Date().toISOString();
      newRow._dirty = 1;
      await M.db.upsertRow(tab, newRow);
      if (itemUrl) existingUrls.add(itemUrl);
      addedCount++;
    }
    schedulePush();
    var srcLabel = data.kind === 'channel'
      ? 'channel' + (data.channelTitle ? ' ' + data.channelTitle : '')
      : 'playlist';
    var msg;
    if (addedCount === 0 && skipped > 0) {
      msg = 'Already up to date — ' + skipped + ' video' + (skipped === 1 ? '' : 's')
        + ' from ' + srcLabel + ' already in section.';
    } else {
      msg = 'Imported ' + addedCount + ' video' + (addedCount === 1 ? '' : 's')
        + ' from ' + srcLabel
        + (data.truncated ? ' (capped at ' + data.max + ')' : '')
        + (skipped > 0 ? ' — skipped ' + skipped + ' already in section' : '');
    }
    flash(document.body, msg);
    try { if (typeof route === 'function') await route(); } catch (e) { /* ignore */ }
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
    // Drop any offline blob attached to this row so deleted videos
    // don't leave orphan storage. Best-effort: getVideo / deleteVideo
    // are no-ops when the row has nothing cached.
    if (M.db && M.db.deleteVideo) {
      try { await M.db.deleteVideo(tab, rowId); } catch (e) { /* ignore */ }
    }
    schedulePush();
  }

  // ---- section view ---------------------------------------------------

  function findDateCol(meta) {
    if (!meta || !meta.headers || !meta.types) return null;
    // Calendar view only earns its place when there's a column whose name
    // implies *scheduling* (when something is supposed to happen), not just
    // any datetime column. A YouTube tracker's `watched_at` is a record of
    // when you watched, not a plan for when to watch — calendar view of
    // that is noise. Same for `created`, `_updated`, `published`, etc.
    var SCHEDULE_NAMES = ['start','due','date','when','on','at','scheduled','deadline','from','begin'];
    for (var i = 0; i < meta.headers.length; i++) {
      var h = meta.headers[i];
      if (M.render.isInternal(h)) continue;
      var t = M.render.parseType(meta.types[i]);
      if (t.kind !== 'date' && t.kind !== 'datetime') continue;
      var lh = String(h).toLowerCase();
      if (SCHEDULE_NAMES.indexOf(lh) >= 0) return h;
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
      if (raw[slug]) return raw[slug];
    } catch (e) { /* fall through to default */ }
    // Per-section default mode. Notes opens in the reader layout
    // because the body column dominates that schema; tasks default to
    // the kanban board because progress through todo → doing → done is
    // the canonical flow. List remains the universal fallback.
    if (slug === 'notes') return 'reader';
    if (slug === 'tasks') return 'board';
    return 'list';
  }
  function writeViewMode(slug, mode) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.view') || '{}');
      raw[slug] = mode;
      localStorage.setItem('minerva.section.view', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  function readUnwatchedFilter(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.unwatched') || '{}');
      return !!raw[slug];
    } catch (e) { return false; }
  }
  function writeUnwatchedFilter(slug, on) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.unwatched') || '{}');
      if (on) raw[slug] = 1; else delete raw[slug];
      localStorage.setItem('minerva.section.unwatched', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  function readCategoryFilter(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.category') || '{}');
      return raw[slug] || '';
    } catch (e) { return ''; }
  }
  function writeCategoryFilter(slug, value) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.category') || '{}');
      if (value) raw[slug] = value; else delete raw[slug];
      localStorage.setItem('minerva.section.category', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  // Per-section default-hidden columns. Aim: a clean default view that
  // shows what users actually scan against, hiding rarely-needed columns
  // they can re-enable with the Columns ▾ button. Returns column names.
  function defaultHiddenCols(slug) {
    if (slug === 'youtube') return ['url', 'tags', 'notes', 'offline', 'watched_at'];
    if (slug === 'papers')  return ['notes'];
    if (slug === 'library') return ['abstract', 'notes', 'pdf'];
    if (slug === 'books')   return ['notes'];
    if (slug === 'films')   return ['notes'];
    if (slug === 'recipes') return ['ingredients'];
    return [];
  }
  function readHiddenCols(slug) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.hiddenCols') || '{}');
      if (raw[slug] != null) return raw[slug];
      return defaultHiddenCols(slug);
    } catch (e) { return defaultHiddenCols(slug); }
  }
  function writeHiddenCols(slug, arr) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.hiddenCols') || '{}');
      raw[slug] = arr;
      localStorage.setItem('minerva.section.hiddenCols', JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  function readCollapsedGroups(tab) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.collapsed') || '{}');
      return new Set(raw[tab] || []);
    } catch (e) { return new Set(); }
  }
  function writeCollapsedGroups(tab, set) {
    try {
      var raw = JSON.parse(localStorage.getItem('minerva.section.collapsed') || '{}');
      var arr = [];
      set.forEach(function (k) { arr.push(k); });
      if (arr.length) raw[tab] = arr; else delete raw[tab];
      localStorage.setItem('minerva.section.collapsed', JSON.stringify(raw));
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
        el('p', null, el('a', { href: '#/' }, 'Go home'), ' · ',
                       el('a', { href: '#/settings' }, 'Sync now'))
      );
    }

    // The habits section gets a custom heatmap-first view.
    if (slug === 'habits') return await viewHabits(sec, cfg);
    var sheetLink = cfg.spreadsheetId
      ? el('a', { href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Edit in Sheets')
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

    // Section-specific primary action. For YouTube, the natural action
    // is "Add video" (opens URL import) — never creating an empty row.
    // For other sections, "Add row" opens a form modal so the user
    // fills in fields before any row is created (no more empty junk).
    var isYoutube = sec.slug === 'youtube';
    var isPapers = sec.slug === 'papers';
    var primaryLabel = isYoutube ? '+ Add video' : (isPapers ? '+ Add paper' : '+ Add row');
    var addBtn = el('button', {
      class: 'btn btn-primary section-add-btn',
      type: 'button',
      title: isYoutube ? 'Paste a YouTube video or playlist URL'
        : (isPapers ? 'Paste an arXiv id, DOI, or paper URL — auto-fetches title/authors/abstract'
          : 'Open a form to add a new row')
    });
    addBtn.appendChild(M.render.icon(isYoutube ? 'youtube' : (isPapers ? 'file-text' : 'plus')));
    addBtn.appendChild(document.createTextNode(
      ' ' + (isYoutube ? 'Add video' : (isPapers ? 'Add paper' : 'Add row'))
    ));

    // Secondary import menu. For YouTube, only CSV/TSV (URL is the
    // primary). For other sections, both URL and CSV.
    var importWrap = el('div', { class: 'import-wrap' });
    var importMenu = null;
    var importBtn = el('button', { class: 'btn btn-ghost', type: 'button',
      title: isYoutube ? 'Bulk import from CSV/TSV' : 'Add rows from URL or CSV/TSV',
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
        if (!isYoutube) {
          pick('From URL', 'arXiv id, YouTube URL, web page', function () { showUrlImport(sec.tab); });
        }
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
    }, isYoutube ? 'CSV ▾' : 'Import ▾');
    importWrap.appendChild(importBtn);
    var modeToggle = el('div', { class: 'seg seg-mode' });
    var calNav = el('div', { class: 'cal-nav' });
    var filterInput = el('input', {
      type: 'search', placeholder: 'Filter rows…', class: 'section-filter'
    });
    var viewsBar = el('div', { class: 'saved-views' });

    // "Unwatched only" pill — shown only when the section has a `watched`
    // column. Visibility flipped inside refresh() once meta is known.
    var unwatchedOn = readUnwatchedFilter(slug);
    var unwatchedPill = el('button', {
      type: 'button',
      class: 'unwatched-toggle' + (unwatchedOn ? ' is-active' : ''),
      title: 'Show unwatched only',
      'aria-pressed': unwatchedOn ? 'true' : 'false',
      hidden: true
    },
      M.render.icon('eye-off'),
      el('span', { class: 'unwatched-toggle-label' }, 'Unwatched only')
    );
    unwatchedPill.addEventListener('click', function () {
      unwatchedOn = !unwatchedOn;
      writeUnwatchedFilter(slug, unwatchedOn);
      unwatchedPill.classList.toggle('is-active', unwatchedOn);
      unwatchedPill.setAttribute('aria-pressed', unwatchedOn ? 'true' : 'false');
      refresh();
    });

    var titleH2 = el('h2');
    if (sec.icon) titleH2.appendChild(M.render.icon(sec.icon));
    titleH2.appendChild(document.createTextNode(sec.title || sec.slug));
    header.appendChild(titleH2);
    // Columns ▾ menu — lets the user reveal hidden columns or hide more.
    var columnsWrap = el('div', { class: 'columns-wrap' });
    var columnsMenu = null;
    var columnsBtn = el('button', { class: 'btn btn-ghost', type: 'button',
      title: 'Show or hide table columns',
      onclick: function (e) {
        e.stopPropagation();
        if (columnsMenu) { columnsMenu.remove(); columnsMenu = null; return; }
        if (!lastMeta || !lastMeta.headers) return;
        columnsMenu = el('div', { class: 'columns-menu' });
        var hidden = new Set(readHiddenCols(slug));
        lastMeta.headers.forEach(function (h) {
          if (M.render.isInternal(h) || h === 'id') return;
          var lbl = el('label', { class: 'columns-menu-item' });
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !hidden.has(h);
          cb.addEventListener('change', function () {
            if (cb.checked) hidden.delete(h);
            else hidden.add(h);
            writeHiddenCols(slug, Array.from(hidden));
            refresh();
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(' ' + h));
          columnsMenu.appendChild(lbl);
        });
        var resetBtn = el('button', { class: 'columns-menu-reset', type: 'button',
          onclick: function () {
            writeHiddenCols(slug, defaultHiddenCols(slug));
            if (columnsMenu) { columnsMenu.remove(); columnsMenu = null; }
            refresh();
          }
        }, 'Reset to defaults');
        columnsMenu.appendChild(resetBtn);
        columnsWrap.appendChild(columnsMenu);
        var closeMenu = function (ev) {
          if (columnsMenu && !columnsMenu.contains(ev.target) && ev.target !== columnsBtn) {
            columnsMenu.remove(); columnsMenu = null;
            document.removeEventListener('click', closeMenu);
          }
        };
        setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
      }
    }, M.render.icon('columns'), ' Columns ▾');
    columnsWrap.appendChild(columnsBtn);

    var headerRight = el('div', { class: 'view-section-head-right' }, filterInput, unwatchedPill, columnsWrap, modeToggle, calNav, importWrap, addBtn);
    header.appendChild(headerRight);
    view.appendChild(header);
    view.appendChild(viewsBar);
    view.appendChild(el('p', { class: 'lead' }, meta1Span, sheetLink ? ' · ' : null, sheetLink));

    var bulkBar = el('div', { class: 'bulk-bar', hidden: true });
    view.appendChild(bulkBar);

    // Category chip-bar — shown only when section has a `category` column
    // AND at least one row has a non-empty value. Populated in refresh().
    var categoryFilter = readCategoryFilter(slug);
    var categoryBar = el('div', { class: 'category-bar', hidden: true });
    view.appendChild(categoryBar);

    // Per-section chart strip — currently only the tasks section.
    // Slice B-3 will add charts for goals/projects.
    var sectionChartStrip = el('section', {
      class: 'section-chart-strip', hidden: true,
      role: 'region', 'aria-label': 'Section chart'
    });
    view.appendChild(sectionChartStrip);

    var bodyHost = el('div');
    view.appendChild(bodyHost);
    var hint = el('p', { class: 'small muted' });
    view.appendChild(hint);

    // Selection state for bulk ops, scoped to this view instance.
    var selectedIds = new Set();
    // Cached schema for the section — refreshed at the top of every
    // refresh() so the bulk bar's button-set decisions don't have to
    // wait on an IndexedDB round-trip every time selection changes.
    var lastMeta = null;

    async function paintBulkBar() {
      if (selectedIds.size === 0 || mode !== 'list') {
        bulkBar.hidden = true;
        bulkBar.replaceChildren();
        return;
      }
      bulkBar.hidden = false;
      // Build a per-section action set. Each entry decides whether to
      // render against the section's schema (and any per-row data we can
      // peek at without an extra round-trip). Hides actions that don't
      // apply so YouTube users don't see "Mark done" / "Copy BibTeX".
      var meta = lastMeta || (await M.db.getMeta(sec.tab));
      var headers = (meta && meta.headers) || [];
      var has = function (col) { return headers.indexOf(col) >= 0; };
      var sectionLabel = sec.title || sec.slug || sec.tab;
      var children = [
        el('span', { class: 'bulk-count' },
          selectedIds.size + ' selected',
          el('span', { class: 'bulk-scope muted small' },
            ' · ' + sectionLabel))
      ];

      // Mark watched / unwatched — shown on YouTube and any section that
      // has a `watched` column.
      if (has('watched')) {
        children.push(el('button', { class: 'btn', type: 'button',
          title: 'Mark selected videos as watched',
          onclick: async function () {
            var ids = Array.from(selectedIds);
            for (var i = 0; i < ids.length; i++) {
              var row = await M.db.getRow(sec.tab, ids[i]);
              if (!row) continue;
              var prev = row.watched;
              if (String(prev || '').toUpperCase() === 'TRUE') continue;
              pushUndo({ kind: 'edit', tab: sec.tab, rowId: row.id, field: 'watched', prevValue: prev });
              row.watched = 'TRUE';
              if (has('watched_at') && !row.watched_at) row.watched_at = new Date().toISOString();
              row._updated = new Date().toISOString();
              row._dirty = 1;
              await M.db.upsertRow(sec.tab, row);
            }
            schedulePush();
            selectedIds.clear();
            await refresh();
            flash(view, 'Marked ' + ids.length + ' as watched.');
          } }, 'Mark watched'));
        children.push(el('button', { class: 'btn btn-ghost', type: 'button',
          title: 'Mark selected as unwatched',
          onclick: async function () {
            var ids = Array.from(selectedIds);
            for (var i = 0; i < ids.length; i++) {
              var row = await M.db.getRow(sec.tab, ids[i]);
              if (!row) continue;
              var prev = row.watched;
              if (String(prev || '').toUpperCase() !== 'TRUE') continue;
              pushUndo({ kind: 'edit', tab: sec.tab, rowId: row.id, field: 'watched', prevValue: prev });
              row.watched = 'FALSE';
              if (has('watched_at')) row.watched_at = '';
              row._updated = new Date().toISOString();
              row._dirty = 1;
              await M.db.upsertRow(sec.tab, row);
            }
            schedulePush();
            selectedIds.clear();
            await refresh();
            flash(view, 'Marked ' + ids.length + ' as unwatched.');
          } }, 'Mark unwatched'));
      }

      // Mark done — only when section has a `status` column (tasks).
      if (has('status')) {
        children.push(el('button', { class: 'btn', type: 'button',
          onclick: async function () {
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
        }, 'Mark done'));
      }

      // Refresh durations — YouTube only. Calls videos.list?part=contentDetails
      // for the selected rows' video ids and patches the duration column.
      if (sec.slug === 'youtube' && has('duration') && has('url')) {
        children.push(el('button', { class: 'btn btn-ghost', type: 'button',
          title: 'Fetch durations from the YouTube Data API',
          onclick: async function () {
            var apiKey = (M.import && M.import.ytApiKey) ? M.import.ytApiKey() : '';
            if (!apiKey) {
              flash(view, 'Add a YouTube Data API key in Settings to fetch durations.', 'error');
              return;
            }
            var ids = Array.from(selectedIds);
            var byVid = {};
            var vids = [];
            for (var i = 0; i < ids.length; i++) {
              var row = await M.db.getRow(sec.tab, ids[i]);
              if (!row) continue;
              var vid = M.import.youtubeVideoId(row.url || '');
              if (vid) { byVid[vid] = row; vids.push(vid); }
            }
            if (!vids.length) { flash(view, 'No YouTube URLs in selection.', 'error'); return; }
            try {
              var durs = await M.import.fetchDurationsByIds(vids, apiKey);
              var n = 0;
              for (var v in durs) {
                if (!Object.prototype.hasOwnProperty.call(durs, v)) continue;
                var row2 = byVid[v];
                if (!row2 || !durs[v]) continue;
                if (row2.duration === durs[v]) continue;
                row2.duration = durs[v];
                row2._updated = new Date().toISOString();
                row2._dirty = 1;
                await M.db.upsertRow(sec.tab, row2);
                n++;
              }
              schedulePush();
              await refresh();
              flash(view, 'Filled duration for ' + n + ' row' + (n === 1 ? '' : 's') + '.');
            } catch (err) {
              flash(view, 'Duration fetch failed: ' + (err && err.message ? err.message : err), 'error');
            }
          }
        }, 'Fetch durations'));
      }

      // BibTeX — only when at least one selected row would produce one.
      var bibtexAny = false;
      var sample = Array.from(selectedIds).slice(0, 5);
      for (var bi = 0; bi < sample.length; bi++) {
        var sr = await M.db.getRow(sec.tab, sample[bi]);
        if (sr && rowHasBibtex(sr)) { bibtexAny = true; break; }
      }
      if (bibtexAny) {
        children.push(el('button', { class: 'btn btn-ghost', type: 'button',
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
        }, 'Copy BibTeX'));
      }

      // Bulk download — YouTube only. When a yt-dlp server or Cobalt
      // endpoint is configured, the action fans out one fetch per row.
      // Otherwise it concatenates every URL into a single yt-dlp
      // invocation and writes that to the clipboard (yt-dlp accepts
      // multiple URL arguments).
      if (sec.slug === 'youtube') {
        children.push(el('button', { class: 'btn btn-ghost', type: 'button',
          title: 'Download every selected video for offline playback',
          onclick: async function () {
            var ids = Array.from(selectedIds);
            var rows = [];
            for (var i = 0; i < ids.length; i++) {
              var r = await M.db.getRow(sec.tab, ids[i]);
              if (r && r.url) rows.push(r);
            }
            if (!rows.length) { flash(view, 'No URLs in selection.', 'error'); return; }
            var bcfg = readConfig();
            var bytDlpOk = !!(bcfg.ytDlpServer || '').trim();
            var bCobaltOk = !!(bcfg.cobaltEndpoint || '').trim();
            if (bytDlpOk || bCobaltOk) {
              var via = bytDlpOk ? 'yt-dlp' : 'Cobalt';
              flash(view, 'Downloading ' + rows.length + ' video' + (rows.length === 1 ? '' : 's') + ' via ' + via + '.');
              var batch = addBulkDownloadJob(rows.length, 'Bulk · ' + via);
              for (var j = 0; j < rows.length; j++) {
                try {
                  if (bytDlpOk) await downloadOfflineViaYtDlp(sec.tab, rows[j], null);
                  else await downloadOfflineViaCobalt(sec.tab, rows[j], null);
                  batch.tick(true);
                } catch (e) {
                  console.warn('[Minerva bulk-dl]', e);
                  batch.tick(false);
                }
              }
              batch.done();
              await refresh();
              return;
            }
            // No Cobalt → single yt-dlp command with N URLs. The user
            // pastes once in their terminal and walks away.
            var fmt = readConfig().ytDlpFormat || 'mp4';
            var cmdParts = ['yt-dlp'];
            if (fmt === 'mp3') cmdParts.push('-x', '--audio-format', 'mp3');
            else if (fmt === 'bestaudio') cmdParts.push('-x');
            else if (fmt === 'mp4') cmdParts.push('-f', 'mp4');
            else cmdParts.push('-f', JSON.stringify(fmt));
            rows.forEach(function (r) { cmdParts.push(JSON.stringify(r.url)); });
            var cmd = cmdParts.join(' ');
            try {
              await navigator.clipboard.writeText(cmd);
              flash(view, 'yt-dlp command for ' + rows.length + ' video' + (rows.length === 1 ? '' : 's') + ' copied — paste in terminal, then ⬆ Upload each result.');
            } catch (e) {
              console.log(cmd);
              flash(view, 'Clipboard unavailable — yt-dlp command logged to console.', 'error');
            }
          }
        }, 'Download'));
      }

      // Remove offline — YouTube only. Drops cached blobs for the selection.
      if (sec.slug === 'youtube') {
        children.push(el('button', { class: 'btn btn-ghost', type: 'button',
          title: 'Remove the locally-cached video files for the selected rows',
          onclick: async function () {
            var ids = Array.from(selectedIds);
            var n = 0;
            for (var i = 0; i < ids.length; i++) {
              var existing = await M.db.getVideo(sec.tab, ids[i]);
              if (!existing) continue;
              await M.db.deleteVideo(sec.tab, ids[i]);
              if (has('offline')) {
                var row = await M.db.getRow(sec.tab, ids[i]);
                if (row && row.offline) {
                  pushUndo({ kind: 'edit', tab: sec.tab, rowId: row.id, field: 'offline', prevValue: row.offline });
                  row.offline = '';
                  row._updated = new Date().toISOString();
                  row._dirty = 1;
                  await M.db.upsertRow(sec.tab, row);
                }
              }
              n++;
            }
            schedulePush();
            await refresh();
            flash(view, n ? ('Removed ' + n + ' offline file' + (n === 1 ? '' : 's') + '.') : 'No offline files in selection.');
          }
        }, 'Remove offline'));
      }

      // Delete — always available; the destructive action sits at the
      // far right with a ghost style so it doesn't compete with the
      // primary section action.
      children.push(el('button', { class: 'btn btn-ghost btn-danger', type: 'button',
        onclick: async function () {
          var n = selectedIds.size;
          if (!confirm('Delete ' + n + ' row' + (n === 1 ? '' : 's') + ' from ' + sectionLabel + '? This is undoable until your next ' + UNDO_MAX + '-deep operation.')) return;
          var ids = Array.from(selectedIds);
          for (var i = 0; i < ids.length; i++) {
            // Drop any offline blob alongside the row delete.
            try { await M.db.deleteVideo(sec.tab, ids[i]); } catch (e) { /* ignore */ }
            await deleteRow(sec.tab, ids[i]);
          }
          selectedIds.clear();
          await refresh();
          flash(view, 'Deleted ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + ' from ' + sectionLabel + '.');
        }
      }, 'Delete'));

      children.push(el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: function () {
          selectedIds.clear();
          paintBulkBar();
          var rows = bodyHost.querySelectorAll('tbody tr.is-bulk-selected');
          rows.forEach(function (r) {
            r.classList.remove('is-bulk-selected');
            var cb = r.querySelector('.bulk-cb');
            if (cb) cb.checked = false;
          });
          bodyHost.querySelectorAll('thead .bulk-cb-all, .bulk-cb-group').forEach(function (cb) {
            cb.checked = false;
            cb.indeterminate = false;
          });
        }
      }, 'Clear'));

      bulkBar.replaceChildren.apply(bulkBar, children);
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

    function paintModeToggle(hasDate, hasTree, hasGraph, hasTiles, hasReader, hasBoard) {
      modeToggle.innerHTML = '';
      if (!hasDate && !hasTree && !hasGraph && !hasTiles && !hasReader && !hasBoard) return;
      if (hasReader) {
        var readerBtn = el('button', { type: 'button', 'data-value': 'reader',
          class: mode === 'reader' ? 'active' : '' }, 'Reader');
        readerBtn.addEventListener('click', function () { switchMode('reader'); });
        modeToggle.appendChild(readerBtn);
      }
      if (hasBoard) {
        var boardBtn = el('button', { type: 'button', 'data-value': 'board',
          class: mode === 'board' ? 'active' : '' }, 'Board');
        boardBtn.addEventListener('click', function () { switchMode('board'); });
        modeToggle.appendChild(boardBtn);
      }
      var listBtn = el('button', { type: 'button', 'data-value': 'list',
        class: mode === 'list' ? 'active' : '' }, 'List');
      listBtn.addEventListener('click', function () { switchMode('list'); });
      modeToggle.appendChild(listBtn);
      if (hasTiles) {
        var tilesBtn = el('button', { type: 'button', 'data-value': 'tiles',
          class: mode === 'tiles' ? 'active' : '' }, 'Grid');
        tilesBtn.addEventListener('click', function () { switchMode('tiles'); });
        modeToggle.appendChild(tilesBtn);
      }
      if (hasTree) {
        var treeBtn = el('button', { type: 'button', 'data-value': 'tree',
          class: mode === 'tree' ? 'active' : '' }, 'Tree');
        treeBtn.addEventListener('click', function () { switchMode('tree'); });
        modeToggle.appendChild(treeBtn);
      }
      if (hasGraph) {
        var graphBtn = el('button', { type: 'button', 'data-value': 'graph',
          class: mode === 'graph' ? 'active' : '' }, 'Graph');
        graphBtn.addEventListener('click', function () { switchMode('graph'); });
        modeToggle.appendChild(graphBtn);
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
      lastMeta = meta;
      // YouTube schema upgrade: older sheets lack the playlist + offline
      // columns. Auto-extend the schema (single Sheets API call) so
      // playlist grouping and offline storage start working without the
      // user having to delete + re-add the section.
      var upgrader = null;
      if (sec.slug === 'youtube') upgrader = maybeUpgradeYoutubeSchema;
      else if (sec.slug === 'papers') upgrader = maybeUpgradePapersSchema;
      else if (sec.slug === 'books') upgrader = maybeUpgradeBooksSchema;
      else if (sec.slug === 'films') upgrader = maybeUpgradeFilmsSchema;
      else if (sec.slug === 'recipes') upgrader = maybeUpgradeRecipesSchema;
      else if (sec.slug === 'notes') upgrader = maybeUpgradeNotesSchema;
      if (upgrader && meta && meta.headers) {
        try {
          var changed = await upgrader(meta);
          if (changed) { meta = await M.db.getMeta(sec.tab); lastMeta = meta; }
        } catch (e) { console.warn('[Minerva ' + sec.slug + '-upgrade]', e); }
      }
      var allRows = await M.db.getAllRows(sec.tab);
      var visible = allRows.filter(function (r) { return !r._deleted; });
      var backlinks = await computeBacklinks(sec.tab);

      // Sort: user click overrides _config.defaultSort.
      var sortSpec = userSort
        ? userSort.col + (userSort.dir === 'desc' ? ':desc' : '')
        : sec.defaultSort;
      var sorted = M.render.applySort(visible, sortSpec);
      var filtered = M.render.applyFilter(sorted, sec.defaultFilter);

      // Per-section live filter (typed in the header search box). Skip
      // `link`-typed columns so token matches do not catch substrings
      // inside URL slugs — only title-like text columns contribute to
      // the search haystack.
      if (liveQuery) {
        var qterms = liveQuery.split(/\s+/).filter(Boolean);
        var allHeaders0 = (meta && meta.headers) || [];
        var allTypes0 = (meta && meta.types) || [];
        var searchHeaders = allHeaders0.filter(function (h, i) {
          if (M.render.isInternal(h) || h === 'id') return false;
          var t = M.render.parseType(allTypes0[i] || 'text');
          return t.kind !== 'link';
        });
        filtered = filtered.filter(function (r) {
          var hay = searchHeaders
            .map(function (h) { return r[h] != null ? String(r[h]) : ''; })
            .join('  ').toLowerCase();
          return qterms.every(function (t) { return hay.indexOf(t) >= 0; });
        });
      }

      // "Unwatched only" pill — show pill when the section has a `watched`
      // column, and apply the filter when toggled on.
      var hasWatchedCol = !!(meta && meta.headers && meta.headers.indexOf('watched') >= 0);
      unwatchedPill.hidden = !hasWatchedCol;
      if (hasWatchedCol && unwatchedOn) {
        filtered = filtered.filter(function (r) {
          return String(r.watched || '').toUpperCase() !== 'TRUE';
        });
      }

      // Category chip-bar — driven by the first matching column in the
      // section schema: `category` is canonical; `kind` is the legacy name
      // used by Workouts. Multiselect-aware: row values are split on commas
      // so a row tagged "tutorial,course" appears under both chips.
      var headers0 = (meta && meta.headers) || [];
      var catCol = headers0.indexOf('category') >= 0 ? 'category'
        : (headers0.indexOf('kind') >= 0 ? 'kind' : '');
      function splitCats(v) {
        if (!v) return [];
        return String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      }
      if (catCol) {
        var seen = Object.create(null);
        var cats = [];
        sorted.forEach(function (r) {
          splitCats(r[catCol]).forEach(function (val) {
            if (seen[val]) return;
            seen[val] = 1;
            cats.push(val);
          });
        });
        categoryBar.replaceChildren();
        if (cats.length) {
          categoryBar.hidden = false;
          var allChip = el('button', {
            type: 'button',
            class: 'category-chip' + (categoryFilter ? '' : ' is-active'),
            onclick: function () {
              categoryFilter = '';
              writeCategoryFilter(slug, '');
              refresh();
            }
          }, 'All');
          categoryBar.appendChild(allChip);
          cats.sort();
          cats.forEach(function (cat) {
            var chip = el('button', {
              type: 'button',
              class: 'category-chip' + (categoryFilter === cat ? ' is-active' : ''),
              onclick: function () {
                categoryFilter = (categoryFilter === cat) ? '' : cat;
                writeCategoryFilter(slug, categoryFilter);
                refresh();
              }
            }, cat);
            categoryBar.appendChild(chip);
          });
        } else {
          categoryBar.hidden = true;
        }
        if (categoryFilter) {
          filtered = filtered.filter(function (r) {
            return splitCats(r[catCol]).indexOf(categoryFilter) >= 0;
          });
        }
      } else {
        categoryBar.hidden = true;
      }

      var dateCol = findDateCol(meta);
      var parentCol = findSelfRefCol(meta, sec.tab);
      var canCal = !!dateCol;
      var canTree = !!parentCol;
      var canGraph = !!parentCol && !!(M.graph && M.graph.renderGraph);
      // Tiles makes sense for any visual-leaning section — anything with
      // a url, pdf, drawing, or image column. Cheap test: scan headers.
      var canTiles = (meta && meta.headers || []).some(function (h, i) {
        var t = M.render.parseType((meta.types || [])[i] || 'text').kind;
        return h === 'url' || h === 'pdf' || t === 'link' || t === 'drawing';
      });
      // Reader mode shows up wherever a section has at least one
      // markdown / longtext column — i.e. any row with a long-form
      // body worth reading on its own. Notes is the canonical case;
      // Decisions, Recipes, Inbox, Journal, Proposals all qualify.
      var canReader = (meta && meta.headers || []).some(function (h, i) {
        if (M.render.isInternal(h) || h === 'id') return false;
        var t = M.render.parseType((meta.types || [])[i] || 'text').kind;
        return t === 'markdown' || t === 'longtext';
      });
      // Board mode shows up wherever a section has a select(...) column
      // with at least one option. Status / state / phase are the
      // canonical names; any other select column also qualifies.
      var boardCol = pickBoardColumn(meta);
      var canBoard = !!boardCol;
      if (mode === 'cal' && !canCal) mode = 'list';
      if (mode === 'tree' && !canTree) mode = 'list';
      if (mode === 'graph' && !canGraph) mode = 'list';
      if (mode === 'tiles' && !canTiles) mode = 'list';
      if (mode === 'reader' && !canReader) mode = 'list';
      if (mode === 'board' && !canBoard) mode = 'list';

      paintModeToggle(canCal, canTree, canGraph, canTiles, canReader, canBoard);
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
      } else if (mode === 'reader' && canReader) {
        bodyHost.replaceChildren(renderNotesReader(meta, filtered, sec.tab, refresh));
        hint.replaceChildren(
          'Pick a note on the left, edit on the right. ',
          el('strong', null, '+'), ' adds a new note. Click the sketch placeholder to draw inline.'
        );
      } else if (mode === 'board' && canBoard) {
        bodyHost.replaceChildren(renderKanbanBoard(meta, filtered, sec.tab, boardCol, refresh));
        hint.replaceChildren(
          'Drag a card between columns to change its ',
          el('code', null, boardCol),
          '. ',
          el('strong', null, '+'), ' under any column adds a card pre-set to that ',
          el('code', null, boardCol), '.'
        );
      } else if (mode === 'tiles' && canTiles) {
        // Pre-resolve which rows already have an offline blob so the
        // grid can paint Watch/Remove instead of Download where
        // appropriate. Keep whatever is currently in bodyHost on
        // screen during the async pre-pass to avoid a "Loading…"
        // flash on every action that triggers refresh().
        offlineRowIdSet(sec.tab, filtered).then(function (ids) {
          bodyHost.replaceChildren(renderTiles(meta, filtered, sec.tab, refresh, ids));
          if (M.render && M.render.refreshIcons) M.render.refreshIcons();
        });
        if (!bodyHost.firstChild) {
          // Cold first render — show a one-time placeholder so the
          // user knows the page is loading rather than empty.
          bodyHost.replaceChildren(el('p', { class: 'small muted' }, 'Loading…'));
        }
        hint.replaceChildren(
          'Grid groups rows by ',
          el('code', null, (meta.headers || []).indexOf('playlist') >= 0 ? 'playlist'
            : ((meta.headers || []).indexOf('category') >= 0 ? 'category' : 'kind')),
          '. Click a card to open the preview; the ⬇ icon downloads.'
        );
      } else if (mode === 'graph' && canGraph) {
        var graphHost = el('div', {
          class: 'graph-host', role: 'region',
          'aria-label': 'Section graph for ' + (sec.title || sec.slug || sec.tab)
        });
        bodyHost.replaceChildren(graphHost);
        hint.replaceChildren(
          'Graph view links rows by their ', el('code', null, parentCol),
          ' field. Drag to pan, scroll to zoom, click a node to open it. ',
          'Cycles render as dashed arcs.'
        );
        M.graph.buildGraphFromTab(sec.tab).then(function (data) {
          data.tab = sec.tab;
          M.graph.renderGraph(graphHost, data);
        });
      } else {
        bodyHost.replaceChildren(renderSectionTable(meta, filtered, sec.tab, refresh, userSort, onSortChange, backlinks, selectedIds, paintBulkBar));
        hint.replaceChildren(
          'Click any cell to edit. Click a column header to sort. Tick the checkboxes to select rows for bulk actions. ',
          el('kbd', null, 'Enter'), ' to save, ',
          el('kbd', null, 'Esc'), ' to cancel.'
        );
        // Register a YouTube playlist context for the preview modal so the
        // eye-icon next to a video URL can walk forward/back through the
        // sibling videos in this section. Recomputed on every refresh so
        // sort/filter changes are reflected.
        registerYouTubePlaylistContext(meta, filtered);
        registerOfflineLookup(meta, filtered, sec.tab);
      }

      paintBacklinksFooter(backlinks);
      paintBulkBar();
      paintSectionChartStrip(visible, meta);
    }

    function paintSectionChartStrip(rows, meta) {
      sectionChartStrip.replaceChildren();
      if (!rows || !rows.length || !M.charts) {
        sectionChartStrip.hidden = true;
        return;
      }
      if (sec.tab === 'tasks' && M.charts.sparkline) {
        var DAYS14 = 14;
        var arr = new Array(DAYS14);
        for (var si = 0; si < DAYS14; si++) arr[si] = 0;
        var startD = new Date();
        startD.setHours(0, 0, 0, 0);
        var startMs = startD.getTime() - (DAYS14 - 1) * 86400000;
        var doneRecent = 0;
        rows.forEach(function (r) {
          if (String(r.status || '').toLowerCase() !== 'done') return;
          var ts = r._updated ? Date.parse(r._updated) : NaN;
          if (!isFinite(ts)) return;
          var idx = Math.floor((ts - startMs) / 86400000);
          if (idx >= 0 && idx < DAYS14) {
            arr[idx]++;
            doneRecent++;
          }
        });
        var spark = M.charts.sparkline(arr, { width: 200, height: 32, fill: true });
        spark.setAttribute('aria-label',
          '14-day completion: ' + doneRecent + ' done');
        sectionChartStrip.setAttribute('aria-label', 'Tasks completion strip');
        sectionChartStrip.appendChild(spark);
        sectionChartStrip.appendChild(el('small', { class: 'muted' },
          'Last 14 days · ' + doneRecent + ' done'));
        sectionChartStrip.hidden = false;
        return;
      }
      if (sec.tab === 'goals' && M.charts.histogram) {
        var values = [];
        var sum = 0;
        rows.forEach(function (r) {
          var v = Number(r.progress);
          if (!isFinite(v)) return;
          if (v < 0) v = 0;
          if (v > 100) v = 100;
          values.push(v);
          sum += v;
        });
        if (!values.length) {
          sectionChartStrip.hidden = true;
          return;
        }
        var avg = Math.round(sum / values.length);
        var hist = M.charts.histogram(values, {
          bins: 10,
          max: 100,
          width: 240,
          height: 36,
          ariaLabel: 'Goal progress histogram across ' + values.length + ' goals'
        });
        sectionChartStrip.setAttribute('aria-label', 'Goals progress histogram');
        sectionChartStrip.appendChild(hist);
        sectionChartStrip.appendChild(el('small', { class: 'muted' },
          values.length + ' goal' + (values.length === 1 ? '' : 's') + ' · avg ' + avg + '%'));
        sectionChartStrip.hidden = false;
        return;
      }
      if (sec.tab === 'projects' && M.charts.gantt) {
        // Resolve start/end column names from cached meta. Default to
        // start/end (bootstrap shape) and fall back to startDate/endDate
        // or the first two date/datetime columns.
        var startCol = null;
        var endCol = null;
        if (meta && meta.headers) {
          var H = meta.headers;
          var T = meta.types || [];
          var hasH = function (c) { return H.indexOf(c) >= 0; };
          if (hasH('start') && hasH('end')) {
            startCol = 'start'; endCol = 'end';
          } else if (hasH('startDate') && hasH('endDate')) {
            startCol = 'startDate'; endCol = 'endDate';
          } else {
            var dateCols = [];
            for (var di = 0; di < H.length; di++) {
              if (M.render.isInternal(H[di])) continue;
              var pt = M.render.parseType(T[di] || 'text');
              if (pt.kind === 'date' || pt.kind === 'datetime') dateCols.push(H[di]);
              if (dateCols.length >= 2) break;
            }
            if (dateCols.length >= 2) {
              startCol = dateCols[0];
              endCol = dateCols[1];
            }
          }
        }
        if (!startCol || !endCol) {
          sectionChartStrip.hidden = true;
          return;
        }
        var items = [];
        rows.forEach(function (r) {
          var s = r[startCol];
          var e = r[endCol];
          if (!s || !e) return;
          var ts = Date.parse(s);
          var te = Date.parse(e);
          if (!isFinite(ts) || !isFinite(te)) return;
          items.push({
            label: r.name || r.title || r.id,
            start: ts,
            end: te
          });
        });
        if (!items.length) {
          sectionChartStrip.hidden = true;
          return;
        }
        var ganttSvg = M.charts.gantt(items, {
          width: 320,
          rowHeight: 8,
          gap: 2,
          ariaLabel: 'Project timeline with ' + items.length + ' active projects'
        });
        sectionChartStrip.setAttribute('aria-label', 'Projects timeline');
        sectionChartStrip.appendChild(ganttSvg);
        sectionChartStrip.appendChild(el('small', { class: 'muted' },
          items.length + ' active project' + (items.length === 1 ? '' : 's')));
        sectionChartStrip.hidden = false;
        return;
      }
      sectionChartStrip.hidden = true;
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
      // YouTube + Papers: jump straight to URL import. Both flows are
      // overwhelmingly URL-driven (paste a video / arXiv id / DOI and let
      // the importer auto-fetch metadata) — an empty form row is friction.
      if (isYoutube || isPapers) {
        showUrlImport(sec.tab);
        return;
      }
      // Meeting polls: route + creation goes through the When-to-meet
      // builder; the section's table is just an archive view of past
      // polls. Adding a "row" by hand isn't meaningful here.
      if (sec.slug === 'meets') {
        location.hash = '#/meet/new';
        return;
      }
      // Non-YouTube: open a form modal so the user fills in fields
      // before any row is created. Cancel = no row. Save = row created
      // with the values the user typed. No more empty junk rows.
      mode = 'list';
      writeViewMode(slug, 'list');
      showAddRowForm(sec.tab, meta, function () { refresh(); });
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
        // Section-aware toggle: tasks → status; YouTube + other "watched"
        // sections → watched. Without this, hitting `c` on a YouTube row
        // flashed an error instead of toggling the obvious thing.
        if (headers.indexOf('status') < 0) {
          if (headers.indexOf('watched') >= 0) {
            var prevW = row.watched;
            var nowWatched = String(row.watched || '').toUpperCase() !== 'TRUE';
            pushUndo({ kind: 'edit', tab: sec.tab, rowId: row.id, field: 'watched', prevValue: prevW });
            row.watched = nowWatched ? 'TRUE' : 'FALSE';
            if (headers.indexOf('watched_at') >= 0) {
              row.watched_at = nowWatched ? new Date().toISOString() : '';
            }
            row._updated = new Date().toISOString();
            row._dirty = 1;
            await M.db.upsertRow(sec.tab, row);
            schedulePush();
            await refresh();
            return;
          }
          flash(view, 'No status or watched column on this section.', 'error');
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
      'Make a group-availability poll. Pick a date range and a daily time window, then share the link. ',
      el('strong', null, 'Each person adds their availability and forwards the new link onward'),
      ' — every shared URL carries everyone\'s answers so far, so you don\'t collect responses by hand. No backend, no accounts, no data leaves your browser unless you share it.'
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
            el('button', { class: 'btn btn-ghost', type: 'button',
              title: 'Save the poll URL into a "meets" section so you can find it later',
              onclick: async function () {
                try {
                  await saveMeetPoll(poll, url);
                  flash(output, 'Poll saved to your sheet (meets section).');
                } catch (err) {
                  flash(output, 'Save failed: ' + (err && err.message || err), 'error');
                }
              } }, M.render.icon('save'), ' Save'),
            el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Preview')
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

  // Auto-mark-watched: given a URL that just started playing, find any
  // row in any enabled section whose link cell matches and whose schema
  // has both `watched` (check) and `watched_at` (datetime) columns.
  // Flip watched=TRUE and watched_at=now() if not already set. Pushes
  // the change to the user's sheet via the dirty queue.
  async function markRowWatchedByUrl(url) {
    if (!url) return false;
    var sections = sectionRows();
    if (!sections.length) return false;
    var changedAny = false;
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      if (!sec || !sec.tab) continue;
      var meta = await M.db.getMeta(sec.tab);
      if (!meta || !meta.headers) continue;
      var hasWatched = meta.headers.indexOf('watched') >= 0;
      var hasWatchedAt = meta.headers.indexOf('watched_at') >= 0;
      if (!hasWatched && !hasWatchedAt) continue;
      // Find a link-typed column whose value matches the URL.
      var linkCols = [];
      for (var i = 0; i < meta.headers.length; i++) {
        var t = M.render.parseType(meta.types[i] || 'text');
        if (t.kind === 'link') linkCols.push(meta.headers[i]);
      }
      if (!linkCols.length) continue;
      var rows = await M.db.getAllRows(sec.tab);
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (row._deleted) continue;
        var match = false;
        for (var k = 0; k < linkCols.length; k++) {
          if (String(row[linkCols[k]] || '').trim() === String(url).trim()) { match = true; break; }
        }
        if (!match) continue;
        var changed = false;
        if (hasWatched && String(row.watched || '').toUpperCase() !== 'TRUE') {
          row.watched = 'TRUE';
          changed = true;
        }
        if (hasWatchedAt && !row.watched_at) {
          row.watched_at = new Date().toISOString();
          changed = true;
        }
        if (changed) {
          row._dirty = 1;
          row._updated = new Date().toISOString();
          await M.db.upsertRow(sec.tab, row);
          changedAny = true;
        }
      }
    }
    if (changedAny) schedulePush();
    return changedAny;
  }

  // ---- YouTube schema migration ------------------------------------
  // The youtube preset gained columns over time (playlist, offline,
  // category, published). Existing sections pick them up via the generic
  // upgradeSectionSchema helper, which also handles type upgrades like
  // select(category) → multiselect(category). Idempotent.
  function maybeUpgradeYoutubeSchema(meta) {
    return upgradeSectionSchema('youtube', meta, [
      { name: 'playlist',  type: 'text', before: 'url' },
      { name: 'category',  type: 'multiselect(tutorial,talk,lecture,documentary,course,interview,music,news,vlog,other)', before: 'url' },
      { name: 'published', type: 'date', before: 'watched' },
      { name: 'offline',   type: 'text', before: '_updated' }
    ]);
  }

  // Generic schema-upgrade helper. additions is a list of
  //   { name: 'category', type: 'multiselect(...)', before: 'read' }
  // Inserts each missing column before the named anchor (or before
  // _updated when the anchor isn't found). When the column already
  // exists with a single-value `select(...)` type but the desired type
  // is `multiselect(...)`, the type is upgraded in place (preserves the
  // option list — single-value rows still parse cleanly as one-element
  // multi). Idempotent. Writes header + type rows back to the sheet,
  // then re-pulls so local meta + rows pick up the new column slots.
  async function upgradeSectionSchema(slug, meta, additions) {
    if (!meta || !meta.headers) return false;
    var headers = meta.headers.slice();
    var types = (meta.types || []).slice();
    var added = [];
    var retyped = [];
    additions.forEach(function (col) {
      var idx = headers.indexOf(col.name);
      if (idx >= 0) {
        // Type upgrade: select(...) → multiselect(...) keeps the options
        // list intact and lets old single values parse as one-elt arrays.
        var existingType = String(types[idx] || '').trim();
        var desired = String(col.type || '').trim();
        if (desired.indexOf('multiselect(') === 0
            && existingType.indexOf('select(') === 0
            && existingType.indexOf('multiselect(') !== 0) {
          // Preserve whichever option set is richer — the user may have
          // edited the spreadsheet to add custom options. Default to the
          // existing one.
          var newType = existingType.replace(/^select\(/, 'multiselect(');
          types[idx] = newType;
          retyped.push(col.name);
        }
        return;
      }
      var insertAt = col.before ? headers.indexOf(col.before) : -1;
      if (insertAt < 0) {
        var upIdx = headers.indexOf('_updated');
        if (upIdx >= 0) insertAt = upIdx;
      }
      if (insertAt < 0 || insertAt >= headers.length) {
        headers.push(col.name);
        types.push(col.type);
      } else {
        headers.splice(insertAt, 0, col.name);
        types.splice(insertAt, 0, col.type);
      }
      added.push(col.name);
    });
    if (!added.length && !retyped.length) return false;
    var c = readConfig();
    if (!c.spreadsheetId) return false;
    var token = await M.auth.getToken(c.clientId);
    await M.sheets.updateValues(token, c.spreadsheetId, slug + '!A1', [headers, types]);
    await M.sync.pullTab(token, c.spreadsheetId, slug);
    var msgParts = [];
    if (added.length) msgParts.push('added ' + added.join(', '));
    if (retyped.length) msgParts.push('upgraded ' + retyped.join(', ') + ' to multi-value');
    flash(document.body, slug + ' section upgraded: ' + msgParts.join('; ') + '.');
    return true;
  }

  function maybeUpgradePapersSchema(meta) {
    return upgradeSectionSchema('papers', meta, [
      // Bibliographic columns — populated by the URL Import auto-fetch
      // (arXiv API, CrossRef DOI). Inserted in roughly bibtex order.
      { name: 'venue',    type: 'text', before: 'url' },
      { name: 'volume',   type: 'text', before: 'url' },
      { name: 'pages',    type: 'text', before: 'url' },
      { name: 'doi',      type: 'text', before: 'url' },
      { name: 'pdf',      type: 'link', before: 'read' },
      // Mirrors the youtube `offline` breadcrumb. Carries
      // drive:<fileId> when the paper PDF has been uploaded to Drive,
      // so preview.js can mount the Drive viewer instead of the live
      // arXiv URL (arxiv blocks iframe embedding).
      { name: 'offline',  type: 'text', before: 'read' },
      // PDF.js text-layer highlights as JSON. The viewer reads on open
      // and writes back via the standard upsert + push pipeline.
      { name: 'highlights', type: 'longtext', before: 'read' },
      { name: 'abstract', type: 'markdown', before: 'read' },
      { name: 'category', type: 'multiselect(method,review,dataset,benchmark,position,survey,theory,application,other)', before: 'read' },
      { name: 'tags',     type: 'multiselect()', before: 'read' }
    ]);
  }
  function maybeUpgradeBooksSchema(meta) {
    return upgradeSectionSchema('books', meta, [
      { name: 'category', type: 'multiselect(fiction,non-fiction,biography,history,science,philosophy,technical,reference,poetry,other)', before: 'started' }
    ]);
  }
  function maybeUpgradeFilmsSchema(meta) {
    return upgradeSectionSchema('films', meta, [
      { name: 'category', type: 'multiselect(drama,comedy,action,thriller,sci-fi,horror,documentary,animation,romance,other)', before: 'watched' }
    ]);
  }
  function maybeUpgradeRecipesSchema(meta) {
    return upgradeSectionSchema('recipes', meta, [
      { name: 'category', type: 'multiselect(breakfast,lunch,dinner,snack,dessert,drink,sauce,baking,other)', before: 'tags' }
    ]);
  }
  function maybeUpgradeNotesSchema(meta) {
    return upgradeSectionSchema('notes', meta, [
      { name: 'sketch', type: 'drawing', before: 'tags' }
    ]);
  }

  // ---- preset add / remove (module scope) ---------------------------
  // Adds a section to the user's sheet + _config row, OR re-enables an
  // existing disabled row of the same slug. Auto-pulls _config schema
  // when missing. Throws on connect / schema problems.
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

    // 2. Either re-enable an existing row or append a new one.
    var configMeta = await M.db.getMeta('_config');
    if (!configMeta || !configMeta.headers) {
      try {
        await M.sync.pullTab(token, c.spreadsheetId, '_config');
        configMeta = await M.db.getMeta('_config');
      } catch (e) { /* fall through to error */ }
    }
    if (!configMeta || !configMeta.headers) throw new Error('Could not read _config schema. Click Sync in Settings, then try again.');
    var allRows = await M.db.getAllRows('_config');
    var existingRow = (allRows || []).find(function (r) { return r.slug === p.slug && !r._deleted; });
    if (existingRow) {
      existingRow.enabled = 'TRUE';
      existingRow._dirty = 1;
      existingRow._updated = new Date().toISOString();
      await M.db.upsertRow('_config', existingRow);
    } else {
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
    }
    schedulePush();

    // 3. Pull the new tab into the local store so the section is immediately viewable.
    try { await M.sync.pullTab(token, c.spreadsheetId, p.slug); } catch (e) { /* non-fatal */ }
    try { await M.sync.pullTab(token, c.spreadsheetId, '_config'); } catch (e) { /* non-fatal */ }
  }

  async function removePreset(slug) {
    var c = readConfig();
    if (!c.clientId || !c.spreadsheetId) throw new Error('Connect first.');
    var rows = await M.db.getAllRows('_config');
    var row = (rows || []).find(function (r) { return r.slug === slug && !r._deleted; });
    if (!row) throw new Error('Section "' + slug + '" not found in _config.');
    row.enabled = 'FALSE';
    row._dirty = 1;
    row._updated = new Date().toISOString();
    await M.db.upsertRow('_config', row);
    schedulePush();
  }

  // Save a "When to meet" poll into a `meets` section in the user's sheet
  // so the link doesn't only live in the URL hash. Auto-creates the section
  // (via the meets preset) on first save.
  async function saveMeetPoll(poll, url) {
    var c = readConfig();
    if (!c.clientId || !c.spreadsheetId) throw new Error('Connect first.');
    var token = await M.auth.getToken(c.clientId);

    // Ensure the `meets` section exists. If not, add the preset.
    var hasMeets = (configCache || []).some(function (r) {
      return r.slug === 'meets' && isEnabled(r);
    });
    if (!hasMeets) {
      var preset = (M.presets || []).find(function (p) { return p.slug === 'meets'; });
      if (!preset) throw new Error('Meets preset not bundled in this build.');
      await addPreset(preset);
      await refreshConfig();
      renderNav(navActive());
    }

    var meta = await M.db.getMeta('meets');
    if (!meta || !meta.headers) {
      try { await M.sync.pullTab(token, c.spreadsheetId, 'meets'); meta = await M.db.getMeta('meets'); }
      catch (e) { /* fall through */ }
    }
    if (!meta || !meta.headers) throw new Error('Meets schema not cached. Sync and try again.');

    var row = await addRow('meets', meta.headers);
    if (meta.headers.indexOf('title') >= 0) row.title = poll.t || 'Untitled poll';
    if (meta.headers.indexOf('url') >= 0) row.url = url;
    if (meta.headers.indexOf('days') >= 0) row.days = (poll.days || []).join(', ');
    if (meta.headers.indexOf('slots') >= 0) row.slots = (poll.slots || []).join(', ');
    if (meta.headers.indexOf('responses') >= 0) row.responses = '0';
    if (meta.headers.indexOf('status') >= 0) row.status = 'open';
    if (meta.headers.indexOf('note') >= 0) row.note = poll.n || '';
    if (meta.headers.indexOf('created') >= 0) row.created = new Date().toISOString();
    row._dirty = 1;
    await M.db.upsertRow('meets', row);
    // Await the push so "Saved" actually means it's in the sheet, not
    // just queued — the user has been burned by optimistic flashes.
    await schedulePush();
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

    var dayIsWeekend = poll.days.map(function (d) {
      var dt = new Date(d + 'T00:00:00');
      var w = dt.getDay();
      return w === 0 || w === 6;
    });

    var head = el('div', { class: 'meet-grid-head' });
    head.appendChild(el('div', { class: 'meet-grid-corner' }));
    poll.days.forEach(function (d, ci) {
      var lbl = M.meet.dayLabel(d);
      var col = el('div', { class: 'meet-grid-col-head' + (dayIsWeekend[ci] ? ' meet-grid-weekend' : '') },
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
          cell.className = 'meet-grid-cell' + (dayIsWeekend[cc] ? ' meet-grid-weekend' : '');
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
        el('p', null, el('a', { href: '#/meet/new' }, 'Create a new poll'))
      );
    }
    var view = el('section', { class: 'view view-meet' });
    view.appendChild(el('h2', null, poll.t || 'Group availability'));
    if (poll.n) view.appendChild(el('p', { class: 'lead' }, poll.n));
    view.appendChild(el('p', { class: 'small muted' },
      'Click cells (or drag) to mark when you\'re free. Times are in your local time zone (',
      el('em', null, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
      '). When done, type your name and Generate — the link below carries everyone\'s answers so far, including yours.'
    ));

    // Optional query params:
    //   ?r=<responseToken>           — pre-load a previous response (edit mode)
    //   ?prev=<r1>;<r2>;...          — carry forward existing aggregate
    //                                  responses so the new link cumulates them
    var preload = null;
    var prevTokens = [];
    try {
      var qs = location.hash.split('?')[1] || '';
      var rMatch = qs.match(/(?:^|&)r=([^&]+)/);
      if (rMatch) preload = M.meet.decodeResponse(decodeURIComponent(rMatch[1]));
      var prevMatch = qs.match(/(?:^|&)prev=([^&]+)/);
      if (prevMatch) {
        prevTokens = decodeURIComponent(prevMatch[1])
          .split(';').filter(Boolean);
      }
    } catch (e) { /* ignore malformed */ }
    var prevNames = [];
    prevTokens.forEach(function (t) {
      try {
        var dr = M.meet.decodeResponse(t);
        if (dr && dr.name) prevNames.push(dr.name);
      } catch (e) { /* skip unparseable */ }
    });
    if (prevNames.length) {
      view.appendChild(el('p', { class: 'small meet-prev-line' },
        M.render.icon('users'),
        ' Already responded: ',
        el('strong', null, prevNames.join(', ')),
        '. Your answer will be added to the chain.'
      ));
    }

    var initial = null;
    if (preload && Array.isArray(preload.yes)) {
      initial = preload.yes;
    }

    var grid = buildSlotGrid(poll, { initial: initial });
    view.appendChild(grid.el);

    var nameInput = el('input', { type: 'text', class: 'editor', placeholder: 'Your name' });
    if (preload && preload.name) nameInput.value = preload.name;

    if (preload) {
      view.insertBefore(
        el('p', { class: 'small muted' },
          'Loaded ', el('strong', null, preload.name || 'previous response'),
          ' for editing. Adjust the grid and regenerate to replace.'),
        grid.el
      );
    }

    // Add a 'Load my last response' button below the action row to let users
    // who lost their initial URL paste a previous response token to edit.
    var loadInput = el('input', { type: 'text', class: 'editor', placeholder: 'Paste a previous response URL or token to edit it' });
    loadInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var raw = loadInput.value.trim();
      if (!raw) return;
      var t = raw.replace(/^.*\//, '').split('?')[0];
      // Drop trailing semicolons or other separators just in case
      t = t.split(';')[0];
      location.hash = '#/meet/' + token + '?r=' + encodeURIComponent(t);
    });
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
        // Cumulative chain: glue the new response onto whatever the
        // previous aggregate already contained, so the link the user
        // shares next is always "everyone's answers including mine".
        var allTokens = prevTokens.concat([rtoken]);
        var aggregateUrl = location.origin + location.pathname + '#/meet/' + token + '/' + allTokens.join(';');
        var subject = 'Re: ' + (poll.t || 'meeting availability');
        var totalCount = allTokens.length;
        var bodyText =
          name + ' marked ' + yes.length + ' available slot' + (yes.length === 1 ? '' : 's') +
          ' for "' + (poll.t || 'meeting') + '".\n\n' +
          'This link includes everyone\'s answers so far (' + totalCount +
          ' response' + (totalCount === 1 ? '' : 's') + '). ' +
          'Open it to see the heatmap, or forward it to the next person to add their availability:\n' +
          aggregateUrl + '\n';

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

        var headLine = prevTokens.length
          ? 'Forward this link to the next person — it now carries '
            + totalCount + ' response' + (totalCount === 1 ? '' : 's')
            + ' (yours included).'
          : 'Share this link with everyone you want to invite — they\'ll add their availability and forward it on.';
        output.replaceChildren(
          el('p', { class: 'small' }, headLine),
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

    view.appendChild(el('details', { class: 'meet-edit-prev' },
      el('summary', { class: 'small muted' }, 'Load a previous response to edit it'),
      el('p', { class: 'small muted' },
        'If you saved your previous response URL or token, paste it here and press Enter — Minerva will pre-select your earlier picks so you can adjust without losing them.'),
      loadInput
    ));
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
    view.appendChild(el('h2', null, poll.t || 'Group availability'));
    view.appendChild(el('p', { class: 'lead' },
      responses.length + ' response' + (responses.length === 1 ? '' : 's') + ' so far',
      failed > 0 ? ' (· ' + failed + ' couldn\'t be parsed)' : '',
      '. Cells darken with the number of people available.'
    ));

    // Prominent "Add my availability" button — opens the participant view
    // with prev=<existing tokens> so the next response chains onto this
    // aggregate rather than replacing it. This is the everyone-adds flow.
    var prevQs = responseTokens.length ? '?prev=' + encodeURIComponent(responseTokens.join(';')) : '';
    var addMineBtn = el('a', {
      class: 'btn btn-primary meet-add-mine',
      href: '#/meet/' + pollToken + prevQs
    });
    addMineBtn.appendChild(M.render.icon('plus'));
    addMineBtn.appendChild(document.createTextNode(' Add my availability'));
    view.appendChild(el('div', { class: 'meet-add-mine-row' }, addMineBtn,
      el('span', { class: 'small muted' },
        'Each person clicks this, fills the grid, and shares the new link onward.'
      )
    ));

    if (responses.length) {
      var namesEl = el('div', { class: 'meet-names' });
      responses.forEach(function (resp, i) {
        var chip = el('span', { class: 'meet-name-chip' });
        chip.appendChild(document.createTextNode(resp.name));
        chip.appendChild(el('span', { class: 'small muted' }, ' (' + (resp.yes || []).length + ')'));
        var rm = el('button', {
          class: 'meet-name-rm', type: 'button', title: 'Remove this response',
          'aria-label': 'Remove ' + resp.name,
          onclick: function () {
            if (!confirm('Remove ' + resp.name + ' from this aggregate?')) return;
            var current = responseTokens.slice();
            current.splice(i, 1);
            location.hash = '#/meet/' + pollToken + (current.length ? '/' + current.join(';') : '');
          }
        });
        rm.appendChild(M.render.icon('x'));
        chip.appendChild(rm);
        namesEl.appendChild(chip);
      });
      view.appendChild(namesEl);
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

    var pageUrl = location.origin + location.pathname + location.hash;
    view.appendChild(el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button',
        onclick: async function () {
          var shareText = 'Group availability — ' + (poll.t || 'meeting') + '\n' +
            responses.length + ' response' + (responses.length === 1 ? '' : 's') +
            ' so far. Open this to see the heatmap or click "Add my availability":\n' +
            pageUrl;
          if (navigator.share) {
            try { await navigator.share({ title: poll.t || 'Group availability', text: shareText, url: pageUrl }); return; }
            catch (e) { /* user cancelled — fall through to clipboard */ }
          }
          if (navigator.clipboard) navigator.clipboard.writeText(pageUrl);
          flash(view, 'Link copied — share it with your group.');
        } }, M.render.icon('share-2'), ' Share with group'),
      el('label', { class: 'small' }, 'Or paste a response: ', addInput),
      el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: async function () {
          try {
            var meta = await M.db.getMeta('notes');
            if (!meta || !meta.headers) {
              flash(view, 'Sync first — notes schema not cached.', 'error');
              return;
            }
            var row = await addRow('notes', meta.headers);
            if (meta.headers.indexOf('title') >= 0) row.title = (poll.t || 'meeting') + ' — meet aggregate';
            if (meta.headers.indexOf('body') >= 0) {
              row.body = '**Aggregate URL:** ' + pageUrl + '\n\n' +
                '**Participant URL:** ' + location.origin + location.pathname + '#/meet/' + pollToken + '\n\n' +
                'Responses so far: ' + responses.map(function (r) { return r.name; }).join(', ');
            }
            if (meta.headers.indexOf('tags') >= 0) row.tags = 'meet';
            if (meta.headers.indexOf('created') >= 0) row.created = new Date().toISOString();
            row._dirty = 1;
            await M.db.upsertRow('notes', row);
            schedulePush();
            flash(view, 'Saved to notes.');
          } catch (err) {
            flash(view, 'Save failed: ' + (err && err.message ? err.message : err), 'error');
          }
        } }, 'Save to notes')
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

  function readScheduleRange() {
    try { return parseInt(localStorage.getItem('minerva.schedule.range') || '7', 10) || 7; }
    catch (e) { return 7; }
  }
  function writeScheduleRange(n) {
    try { localStorage.setItem('minerva.schedule.range', String(n)); } catch (e) { /* ignore */ }
  }

  async function viewSchedule() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false };
    if (!cfg.spreadsheetId || !st.hasToken) {
      return el('section', { class: 'view' },
        el('h2', null, 'Schedule'),
        el('p', null, 'Connect first.'),
        el('p', null, el('a', { href: '#/settings' }, 'Open Settings'))
      );
    }

    var view = el('section', { class: 'view view-schedule' });
    var titleH2 = el('h2');
    titleH2.appendChild(M.render.icon('calendar-clock'));
    titleH2.appendChild(document.createTextNode(' Schedule'));
    view.appendChild(titleH2);

    var rangeDays = readScheduleRange();
    var rangeSeg = el('div', { class: 'seg seg-mode' });
    [7, 14, 30].forEach(function (n) {
      var btn = el('button', { type: 'button', 'data-value': String(n),
        class: n === rangeDays ? 'active' : '',
        onclick: function () {
          rangeDays = n;
          writeScheduleRange(n);
          route();
        }
      }, n + ' days');
      rangeSeg.appendChild(btn);
    });

    var actionRow = el('div', { class: 'cta-row' },
      rangeSeg,
      el('button', { class: 'btn', type: 'button',
        onclick: function () { showAvailabilityShare(); }
      }, 'Share my availability'),
      el('a', { class: 'btn btn-ghost', href: '#/meet/new' }, 'When to meet — group poll'),
      el('a', { class: 'btn btn-ghost', href: '#/today' }, 'Today')
    );
    view.appendChild(actionRow);

    view.appendChild(el('p', { class: 'small muted' },
      'Busy blocks come from any tab with start + end datetime columns ',
      '(e.g., the ', el('code', null, 'events'), ' preset) plus tasks with a ',
      el('code', null, 'due'), ' date. Free slots are computed inside ',
      el('code', null, '09:00–18:00'), ' Mon–Fri.'
    ));

    var rangeStart = startOfDay(new Date());
    var rangeEnd = new Date(rangeStart.getTime() + rangeDays * 86400000);
    var busy;
    try { busy = await M.schedule.collectBusy({ start: rangeStart, end: rangeEnd, workStart: 9 }); }
    catch (e) { busy = []; }
    var slots;
    try { slots = M.schedule.freeSlots(busy, { start: rangeStart, end: rangeEnd, workStart: 9, workEnd: 18, skipWeekends: true }); }
    catch (e) { slots = []; }

    // Summary stats — sum busy/free across the whole range, render as
    // a small headline so the user gets an at-a-glance load picture.
    var busyMin = busy.reduce(function (s, b) { return s + (b.end - b.start) / 60000; }, 0);
    var freeMin = slots.reduce(function (s, b) { return s + (b.end - b.start) / 60000; }, 0);
    var totalMin = freeMin + busyMin;
    var freePct = totalMin > 0 ? Math.round(100 * freeMin / totalMin) : 0;
    function fmtH(min) {
      var h = min / 60;
      return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
    }
    var summary = el('div', { class: 'sched-summary' },
      el('div', { class: 'sched-stat' },
        el('div', { class: 'sched-stat-num' }, freePct + '%'),
        el('div', { class: 'sched-stat-lbl' }, 'free in window')
      ),
      el('div', { class: 'sched-stat' },
        el('div', { class: 'sched-stat-num' }, fmtH(busyMin)),
        el('div', { class: 'sched-stat-lbl' }, 'scheduled')
      ),
      el('div', { class: 'sched-stat' },
        el('div', { class: 'sched-stat-num' }, fmtH(freeMin)),
        el('div', { class: 'sched-stat-lbl' }, 'free')
      ),
      el('div', { class: 'sched-stat' },
        el('div', { class: 'sched-stat-num' }, slots.length),
        el('div', { class: 'sched-stat-lbl' }, 'open slot' + (slots.length === 1 ? '' : 's'))
      )
    );
    view.appendChild(summary);

    var daysHost = el('div', { class: 'sched-days' });
    for (var i = 0; i < rangeDays; i++) {
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
        blocksHost.appendChild(el('p', { class: 'small muted' }, 'Weekend.'));
      } else {
        if (dayBusy.length) {
          dayBusy.forEach(function (b) {
            var blockEl = el('div', { class: 'sched-busy', tabindex: '0',
              title: 'Open ' + b.label + ' (' + b.tab + ')',
              onclick: function () { showRowDetail(b.tab, b.rowId); }
            },
              el('span', { class: 'sched-time' }, fmtTime(b.start) + '–' + fmtTime(b.end)),
              el('span', { class: 'sched-label' }, b.label),
              el('span', { class: 'sched-tab small muted' }, b.tab)
            );
            blockEl.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                showRowDetail(b.tab, b.rowId);
              }
            });
            blocksHost.appendChild(blockEl);
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
            el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Open public view')
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
        el('p', null, el('a', { href: '#/settings' }, 'Open Settings'))
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
      var emptyTasks = el('p', { class: 'muted' });
      emptyTasks.appendChild(document.createTextNode('Nothing due today. '));
      emptyTasks.appendChild(M.render.icon('check'));
      view.appendChild(emptyTasks);
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
          'aria-label': 'Mark task done',
          onclick: async function () {
            doneBtn.disabled = true;
            await markTaskDone(t.id);
            li.style.opacity = '0.4';
            li.style.textDecoration = 'line-through';
            setTimeout(function () { li.remove(); }, 300);
          }
        });
        doneBtn.appendChild(M.render.icon('check'));
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
        'No habits yet — ', el('a', { href: '#/s/habits' }, 'add one')));
    } else if (!habitsLeft.length) {
      var allDone = el('p', { class: 'muted' });
      allDone.appendChild(document.createTextNode('All done for today. '));
      allDone.appendChild(M.render.icon('flame'));
      view.appendChild(allDone);
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
        });
        btn.appendChild(M.render.icon('check'));
        btn.appendChild(document.createTextNode(' Done'));
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
      el('a', { href: '#/s/tasks' }, 'All tasks'),
      ' · ',
      el('a', { href: '#/s/habits' }, 'All habits'),
      ' · ',
      el('a', { href: '#/s/notes' }, 'All notes')
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
        var habitDoneBtn2 = el('button', {
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
        });
        if (done) {
          habitDoneBtn2.appendChild(document.createTextNode('Log another today'));
        } else {
          habitDoneBtn2.appendChild(M.render.icon('check'));
          habitDoneBtn2.appendChild(document.createTextNode(' Done today'));
        }
        card.appendChild(el('div', { class: 'habit-actions' },
          habitDoneBtn2,
          el('a', { class: 'btn btn-ghost',
            href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Edit in Sheets')
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

  // Build a list of {title,url} entries from the given rows for every
  // link-typed column whose value is a YouTube URL, then register it
  // as the active playlist context on M.preview. The context provider
  // returns the slice of items + the start index that matches the URL
  // the user clicked. Cleared when the next section view (or any other
  // route) overwrites it via setPlaylistContext / clearPlaylistContext.
  // Build a URL → { tab, rowId, title } map for the current section
  // and hand it to the preview modal so plain-click on a row's URL
  // plays the cached offline blob (when one exists) instead of the
  // remote iframe.
  function registerOfflineLookup(meta, rows, tab) {
    if (!M.preview || typeof M.preview.setOfflineLookup !== 'function') return;
    var headers = (meta && meta.headers) || [];
    if (headers.indexOf('url') < 0) {
      M.preview.clearOfflineLookup && M.preview.clearOfflineLookup();
      return;
    }
    var byUrl = {};
    rows.forEach(function (r) {
      if (r._deleted) return;
      var u = r.url && String(r.url).trim();
      if (!u) return;
      var driveMatch = String(r.offline || '').match(/drive:([\w-]{20,})/);
      byUrl[u] = {
        tab: tab,
        rowId: r.id,
        title: r.title || '',
        driveFileId: driveMatch ? driveMatch[1] : ''
      };
    });
    var lookupFn = function (url) {
      var key = String(url || '').trim();
      return byUrl[key] || globalUrlIndex[key] || null;
    };
    currentOfflineLookup = lookupFn;
    // Contribute these rows to the cross-section index so a preview
    // opened from a non-papers context (search, graph, home, deep
    // link) still resolves the row.
    Object.keys(byUrl).forEach(function (k) { globalUrlIndex[k] = byUrl[k]; });
    M.preview.setOfflineLookup(lookupFn);
  }

  // Global URL → { tab, rowId, driveFileId, ... } index that lives
  // across section switches. Each registerOfflineLookup call merges
  // its section's rows in; rebuildGlobalUrlIndex() walks every tab
  // once at boot so even a brand-new tab finds papers / videos
  // without first navigating to their section.
  var globalUrlIndex = {};
  var currentOfflineLookup = null;
  async function rebuildGlobalUrlIndex() {
    try {
      var allMeta = await M.db.getAllMeta();
      for (var i = 0; i < allMeta.length; i++) {
        var tab = allMeta[i].tab;
        var headers = allMeta[i].headers || [];
        if (headers.indexOf('url') < 0) continue;
        var rows = await M.db.getAllRows(tab);
        rows.forEach(function (r) {
          if (r._deleted) return;
          var u = r.url && String(r.url).trim();
          if (!u) return;
          var driveMatch = String(r.offline || '').match(/drive:([\w-]{20,})/);
          globalUrlIndex[u] = {
            tab: tab,
            rowId: r.id,
            title: r.title || '',
            driveFileId: driveMatch ? driveMatch[1] : ''
          };
        });
      }
    } catch (e) { console.warn('[Minerva url-index]', e); }
  }

  function registerYouTubePlaylistContext(meta, rows) {
    if (!M.preview || typeof M.preview.setPlaylistContext !== 'function') return;
    var ytRe = /youtube\.com\/watch|youtu\.be\//i;
    var titleCol = (meta.headers || []).indexOf('title') >= 0 ? 'title'
      : (meta.headers || []).indexOf('name') >= 0 ? 'name'
      : null;
    var linkCols = [];
    for (var i = 0; i < (meta.headers || []).length; i++) {
      var h = meta.headers[i];
      if (M.render.isInternal(h)) continue;
      var t = M.render.parseType(meta.types[i] || 'text');
      if (t.kind === 'link') linkCols.push(h);
    }
    if (!linkCols.length) {
      M.preview.clearPlaylistContext();
      return;
    }
    var items = [];
    rows.forEach(function (r) {
      for (var j = 0; j < linkCols.length; j++) {
        var raw = r[linkCols[j]];
        if (raw == null || raw === '') continue;
        var s = String(raw).trim();
        if (!ytRe.test(s)) continue;
        var label = titleCol && r[titleCol] ? String(r[titleCol]) : s;
        items.push({ title: label, url: s });
        break; // one video per row keeps the playlist 1:1 with rows
      }
    });
    if (items.length < 2) {
      M.preview.clearPlaylistContext();
      return;
    }
    M.preview.setPlaylistContext(function (clickedUrl) {
      var idx = 0;
      for (var k = 0; k < items.length; k++) {
        if (items[k].url === clickedUrl) { idx = k; break; }
      }
      return { items: items, startIndex: idx };
    });
  }

  // Resolve which column drives kanban columns. Preference order:
  //   1. `status`
  //   2. `state`
  //   3. `phase`
  //   4. The first select(...) column found in the schema
  // Returns the column name, or null when no select column exists.
  function pickBoardColumn(meta) {
    var headers = (meta && meta.headers) || [];
    var types = (meta && meta.types) || [];
    var preferred = ['status', 'state', 'phase'];
    for (var pi = 0; pi < preferred.length; pi++) {
      var idx = headers.indexOf(preferred[pi]);
      if (idx >= 0) {
        var t = M.render.parseType(types[idx] || 'text');
        if (t.kind === 'select' && t.options && t.options.length) return preferred[pi];
      }
    }
    for (var i = 0; i < headers.length; i++) {
      if (M.render.isInternal(headers[i])) continue;
      var ti = M.render.parseType(types[i] || 'text');
      if (ti.kind === 'select' && ti.options && ti.options.length) return headers[i];
    }
    return null;
  }

  // Lightweight read-only metadata popup. Renders every non-internal
  // column for the row in a definition-list shape so the user can
  // inspect what's stored without leaving the current view. ESC and
  // overlay click both close.
  function showRowMetadataPopup(meta, row) {
    if (!meta || !row) return;
    if (document.querySelector('.row-info-overlay')) return;
    var headers = (meta && meta.headers) || [];
    var overlay = el('div', { class: 'modal-overlay row-info-overlay',
      onclick: function () { overlay.remove(); }
    });
    var entries = [];
    headers.forEach(function (h) {
      if (M.render.isInternal(h)) return;
      if (h === 'id') return;
      var v = row[h];
      if (v == null || v === '') return;
      entries.push({ k: h, v: v });
    });
    if (!entries.length) {
      entries.push({ k: '(no fields)', v: 'This row has no populated fields yet.' });
    }
    var dl = el('dl', { class: 'row-info-dl' });
    entries.forEach(function (e) {
      dl.appendChild(el('dt', null, e.k));
      var val = String(e.v);
      // Wrap long values; treat newlines as line breaks.
      var dd = el('dd', null, val);
      dl.appendChild(dd);
    });
    var panel = el('div', { class: 'modal-panel row-info-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, row.title || row.name || row.id || 'Row details'),
      dl,
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () { overlay.remove(); } }, 'Close')
      )
    );
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    M.render.refreshIcons();
  }

  // Pre-fetch which rows already have a cached offline blob so the
  // grid (and other surfaces) can render the right state without
  // making each tile async. Returns a Set of row ids.
  async function offlineRowIdSet(tab, rows) {
    var out = new Set();
    if (!M.db || !M.db.getVideo) return out;
    for (var i = 0; i < rows.length; i++) {
      try {
        var rec = await M.db.getVideo(tab, rows[i].id);
        if (rec && rec.blob) out.add(rows[i].id);
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  // Kanban view. Columns are the options of the section's chosen
  // select column (typically `status`); each row renders as a card.
  // Cards are HTML5-draggable; dropping onto a different column
  // commits the new value via commitCellEdit() and triggers refresh().
  // A per-column "+ Add" button creates a row pre-set to that column.
  function renderKanbanBoard(meta, rows, tab, col, refresh) {
    var headers = (meta && meta.headers) || [];
    var types = (meta && meta.types) || [];
    var colIdx = headers.indexOf(col);
    var parsed = M.render.parseType(types[colIdx] || 'text');
    var options = (parsed.options && parsed.options.length) ? parsed.options.slice() : [];

    // Group rows by their column value. Values that don't appear in
    // the declared options form an extra "(other)" column at the end
    // so they remain visible and movable.
    var byCol = {};
    options.forEach(function (o) { byCol[o] = []; });
    var extras = [];
    rows.forEach(function (r) {
      var v = String(r[col] || '').trim();
      if (!v) {
        extras.push(r);
        return;
      }
      if (byCol[v]) byCol[v].push(r);
      else {
        if (!byCol[v]) byCol[v] = [];
        byCol[v].push(r);
        if (options.indexOf(v) < 0) options.push(v);
      }
    });
    if (extras.length) {
      byCol[''] = extras;
      options.push('');
    }

    var titleCol = headers.indexOf('title') >= 0 ? 'title'
      : (headers.indexOf('name') >= 0 ? 'name' : '');
    var dueCol = headers.indexOf('due') >= 0 ? 'due'
      : (headers.indexOf('deadline') >= 0 ? 'deadline' : '');
    var prioCol = headers.indexOf('priority') >= 0 ? 'priority' : '';
    var tagsCol = headers.indexOf('tags') >= 0 ? 'tags' : '';

    function cardFor(row) {
      var card = el('div', {
        class: 'kanban-card',
        draggable: 'true',
        'data-row-id': row.id,
        onclick: function (e) {
          if (e.target.closest('button, input, a')) return;
          showRowDetail(tab, row.id);
        }
      });
      card.addEventListener('dragstart', function (e) {
        card.classList.add('is-dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.id);
        } catch (err) { /* ignore */ }
      });
      card.addEventListener('dragend', function () {
        card.classList.remove('is-dragging');
      });
      var titleText = (titleCol && row[titleCol]) || row.title || row.name || '(untitled)';
      card.appendChild(el('div', { class: 'kanban-card-title' }, titleText));

      var meta2Bits = [];
      if (dueCol && row[dueCol]) {
        meta2Bits.push(el('span', { class: 'kanban-card-due' },
          M.render.icon('calendar'), ' ' + String(row[dueCol]).slice(0, 10)
        ));
      }
      if (prioCol && row[prioCol]) {
        meta2Bits.push(el('span', { class: 'kanban-card-prio prio-' + String(row[prioCol]).toLowerCase() },
          row[prioCol]
        ));
      }
      if (meta2Bits.length) {
        card.appendChild(el('div', { class: 'kanban-card-meta' }, meta2Bits));
      }
      if (tagsCol && row[tagsCol]) {
        var tags = String(row[tagsCol]).split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        if (tags.length) {
          var chips = el('div', { class: 'kanban-card-tags' });
          tags.slice(0, 4).forEach(function (t) {
            chips.appendChild(el('span', { class: 'chip' }, t));
          });
          card.appendChild(chips);
        }
      }
      return card;
    }

    function columnFor(value) {
      var label = value || '(no ' + col + ')';
      var column = el('div', { class: 'kanban-col', 'data-col-value': value });

      var head = el('div', { class: 'kanban-col-head' },
        el('span', { class: 'kanban-col-title' }, label),
        el('span', { class: 'kanban-col-count small muted' }, String((byCol[value] || []).length))
      );
      column.appendChild(head);

      var list = el('div', { class: 'kanban-col-list' });
      column.appendChild(list);
      (byCol[value] || []).forEach(function (r) { list.appendChild(cardFor(r)); });

      var addBtn = el('button', { class: 'kanban-col-add btn btn-ghost', type: 'button',
        title: 'Add a card to "' + label + '"',
        onclick: async function () {
          var newRow = await addRow(tab, headers);
          if (titleCol) newRow[titleCol] = '';
          newRow[col] = value;
          newRow._dirty = 1;
          await M.db.upsertRow(tab, newRow);
          schedulePush();
          if (refresh) await refresh();
          // Open the row detail so the user can type the title and
          // fill the rest of the fields without hunting for the new
          // empty card on the board.
          showRowDetail(tab, newRow.id);
        }
      }, M.render.icon('plus'), ' Add card');
      column.appendChild(addBtn);

      // Drop handlers — the entire column is a drop zone, not just
      // the card list, so dropping in the empty space below also
      // works. dragenter/leave maintain a hover state for visual
      // feedback during the drag.
      column.addEventListener('dragover', function (e) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      });
      column.addEventListener('dragenter', function () {
        column.classList.add('is-drop-target');
      });
      column.addEventListener('dragleave', function (e) {
        if (e.target === column) column.classList.remove('is-drop-target');
      });
      column.addEventListener('drop', async function (e) {
        e.preventDefault();
        column.classList.remove('is-drop-target');
        var rowId = '';
        try { rowId = e.dataTransfer.getData('text/plain'); } catch (err) {}
        if (!rowId) return;
        var row = rows.find(function (r) { return r.id === rowId; });
        if (!row) return;
        if (String(row[col] || '') === value) return;
        await commitCellEdit(tab, rowId, col, value);
        if (refresh) await refresh();
      });

      return column;
    }

    var board = el('div', { class: 'kanban-board' });
    options.forEach(function (v) { board.appendChild(columnFor(v)); });
    if (M.render && M.render.refreshIcons) M.render.refreshIcons();
    return board;
  }

  // Two-pane note layout. The sidebar lists every row by title and
  // a stripped-markdown preview; selecting a row populates the right
  // pane with editors for the title input, body textarea, sketch
  // thumbnail, and tag chips. Each editor commits on blur. The
  // selected row id is persisted per tab in localStorage.
  function renderNotesReader(meta, rows, tab, refresh) {
    var headers = (meta && meta.headers) || [];
    var types = (meta && meta.types) || [];
    // Collect every markdown / longtext column. Multi-section
    // schemas (Decisions: context / options / decision / outcome /
    // reflection) get one editor per column in declared order.
    var bodyCols = [];
    headers.forEach(function (h, i) {
      if (M.render.isInternal(h) || h === 'id') return;
      var t = M.render.parseType(types[i] || 'text').kind;
      if (t === 'markdown' || t === 'longtext') bodyCols.push(h);
    });
    var primaryBodyCol = bodyCols[0] || 'body';
    var titleCol = headers.indexOf('title') >= 0 ? 'title'
      : (headers.indexOf('name') >= 0 ? 'name' : '');
    var sketchCol = headers.indexOf('sketch') >= 0 ? 'sketch' : '';
    var tagsCol = headers.indexOf('tags') >= 0 ? 'tags' : '';

    // Restore last-selected id (per-tab) so navigation feels sticky.
    var SEL_KEY = 'minerva.reader.sel';
    function readSel() {
      try { var raw = JSON.parse(localStorage.getItem(SEL_KEY) || '{}'); return raw[tab] || ''; }
      catch (e) { return ''; }
    }
    function writeSel(id) {
      try {
        var raw = JSON.parse(localStorage.getItem(SEL_KEY) || '{}');
        if (id) raw[tab] = id; else delete raw[tab];
        localStorage.setItem(SEL_KEY, JSON.stringify(raw));
      } catch (e) { /* ignore */ }
    }
    var selectedId = readSel();
    if (!rows.some(function (r) { return r.id === selectedId; })) {
      selectedId = rows.length ? rows[0].id : '';
    }

    var wrap = el('div', { class: 'notes-reader' });

    // ---- left: sidebar list -----------------------------------------
    var sidebar = el('div', { class: 'notes-reader-side' });
    var newBtn = el('button', { class: 'btn', type: 'button',
      onclick: async function () {
        var newRow = await addRow(tab, headers);
        if (titleCol) newRow[titleCol] = '';
        if (headers.indexOf('created') >= 0) newRow.created = new Date().toISOString();
        newRow._dirty = 1;
        await M.db.upsertRow(tab, newRow);
        schedulePush();
        writeSel(newRow.id);
        if (refresh) await refresh();
      }
    }, M.render.icon('plus'), ' New');
    sidebar.appendChild(el('div', { class: 'notes-reader-side-head' },
      el('span', { class: 'small muted' }, rows.length + ' item' + (rows.length === 1 ? '' : 's')),
      newBtn
    ));
    var sideList = el('div', { class: 'notes-reader-list' });
    var hasWatchedSide = headers.indexOf('watched') >= 0;
    rows.forEach(function (r) {
      var rawTitle = (titleCol && r[titleCol]) || '';
      var rawBody = (r[primaryBodyCol] || '').toString();
      // Strip markdown markers for the preview line — readable at a glance.
      var preview = rawBody.replace(/[#*_`>~\[\]\(\)]/g, '').replace(/\s+/g, ' ').trim();
      var item = el('div', { class: 'notes-reader-item-row' });
      if (hasWatchedSide) {
        var on = String(r.watched || '').toUpperCase() === 'TRUE';
        var wcb = el('button', {
          type: 'button',
          class: 'notes-reader-watched' + (on ? ' is-watched' : ''),
          title: on ? 'Mark unwatched' : 'Mark watched',
          'aria-label': on ? 'Mark unwatched' : 'Mark watched',
          onclick: async function (e) {
            e.preventDefault();
            e.stopPropagation();
            var fresh = await M.db.getRow(tab, r.id);
            if (!fresh || fresh._deleted) return;
            var nowOn = String(fresh.watched || '').toUpperCase() !== 'TRUE';
            pushUndo({ kind: 'edit', tab: tab, rowId: fresh.id, field: 'watched', prevValue: fresh.watched });
            fresh.watched = nowOn ? 'TRUE' : 'FALSE';
            if (headers.indexOf('watched_at') >= 0) {
              fresh.watched_at = nowOn ? new Date().toISOString() : '';
            }
            fresh._updated = new Date().toISOString();
            fresh._dirty = 1;
            await M.db.upsertRow(tab, fresh);
            schedulePush();
            if (refresh) await refresh();
          }
        });
        wcb.appendChild(M.render.icon(on ? 'check-circle-2' : 'circle'));
        item.appendChild(wcb);
      }
      var clickable = el('button', {
        type: 'button',
        class: 'notes-reader-item' + (r.id === selectedId ? ' is-active' : ''),
        onclick: function () {
          selectedId = r.id;
          writeSel(r.id);
          paint();
        }
      },
        el('div', { class: 'notes-reader-item-title' }, rawTitle || '(untitled)'),
        el('div', { class: 'notes-reader-item-preview' }, preview ? preview.slice(0, 120) : '(empty)')
      );
      item.appendChild(clickable);
      sideList.appendChild(item);
    });
    sidebar.appendChild(sideList);
    wrap.appendChild(sidebar);

    // ---- right: reading / editing pane ------------------------------
    var pane = el('div', { class: 'notes-reader-pane' });
    wrap.appendChild(pane);

    function paint() {
      // Reflect the selection in the sidebar without a full re-render.
      Array.prototype.forEach.call(sideList.querySelectorAll('.notes-reader-item'), function (n) {
        // Pull the row id by matching against the current rows list.
        // The .notes-reader-item-row wrapper holds the row id implicitly
        // by ordering, so a structural match still works.
      });
      var items = sideList.querySelectorAll('.notes-reader-item');
      Array.prototype.forEach.call(items, function (n, i) {
        n.classList.toggle('is-active', rows[i] && rows[i].id === selectedId);
      });
      pane.replaceChildren();
      var row = rows.find(function (r) { return r.id === selectedId; });
      if (!row) {
        pane.appendChild(el('p', { class: 'muted' }, 'Nothing here yet. Click ', el('em', null, '+ New'), ' to add an item.'));
        return;
      }

      // Title — single-line input, auto-saves on blur.
      var titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'notes-reader-title';
      titleInput.value = (titleCol && row[titleCol]) || '';
      titleInput.placeholder = 'Title';
      titleInput.addEventListener('blur', async function () {
        if (!titleCol) return;
        var v = titleInput.value;
        if (v === row[titleCol]) return;
        row[titleCol] = v;
        row._updated = new Date().toISOString();
        row._dirty = 1;
        await M.db.upsertRow(tab, row);
        schedulePush();
        if (refresh) refresh();
      });
      pane.appendChild(titleInput);

      // Optional small meta line: created date.
      if (row.created) {
        pane.appendChild(el('div', { class: 'small muted notes-reader-meta' },
          new Date(row.created).toLocaleString()
        ));
      }

      // One editor per markdown / longtext column in the schema. Each
      // editor commits on blur. Multi-section schemas (Decisions:
      // context / options / decision / outcome / reflection) get a
      // labelled stack of textareas instead of a single squashed body.
      bodyCols.forEach(function (colName) {
        var section = el('div', { class: 'notes-reader-section' });
        if (bodyCols.length > 1) {
          section.appendChild(el('div', { class: 'notes-reader-section-label small muted' }, colName));
        }
        var ta = document.createElement('textarea');
        ta.className = 'notes-reader-body';
        ta.value = row[colName] || '';
        ta.placeholder = bodyCols.length > 1
          ? colName.charAt(0).toUpperCase() + colName.slice(1) + '…'
          : 'Type here. Markdown supported.';
        ta.addEventListener('blur', async function () {
          var v = ta.value;
          if (v === row[colName]) return;
          row[colName] = v;
          row._updated = new Date().toISOString();
          row._dirty = 1;
          await M.db.upsertRow(tab, row);
          schedulePush();
          if (refresh) refresh();
        });
        section.appendChild(ta);
        pane.appendChild(section);
      });

      // Sketch — inline drawing thumbnail with click-to-edit. When the
      // sketch is empty the placeholder reads "Tap to draw" so the
      // affordance is obvious.
      if (sketchCol) {
        var sketchHost = el('div', { class: 'notes-reader-sketch' });
        var raw = (row[sketchCol] || '').toString().trim();
        if (raw && raw !== 'pending') {
          var img = document.createElement('img');
          img.alt = '';
          img.src = /^(https?:|data:)/i.test(raw)
            ? raw
            : ('https://drive.google.com/thumbnail?id=' + encodeURIComponent(raw) + '&sz=w800');
          sketchHost.appendChild(img);
        } else {
          sketchHost.classList.add('is-empty');
          sketchHost.appendChild(el('span', null, M.render.icon('pencil-line'), ' Tap to draw'));
        }
        sketchHost.addEventListener('click', function () {
          location.hash = '#/draw/' + encodeURIComponent(tab) +
            '/' + encodeURIComponent(row.id) +
            '?col=' + encodeURIComponent(sketchCol);
        });
        pane.appendChild(sketchHost);
      }

      // Tag chips — display only here; full editing remains in List
      // mode where the multiselect editor lives.
      if (tagsCol && row[tagsCol]) {
        var chips = el('div', { class: 'notes-reader-tags' });
        String(row[tagsCol]).split(',').forEach(function (t) {
          var v = t.trim(); if (!v) return;
          chips.appendChild(el('span', { class: 'chip' }, v));
        });
        pane.appendChild(chips);
      }

      // Footer actions — delete sits on the right with the danger style.
      var actions = el('div', { class: 'notes-reader-actions' });
      var delBtn = el('button', { class: 'btn btn-ghost btn-danger', type: 'button',
        onclick: async function () {
          if (!confirm('Delete this note?')) return;
          await deleteRow(tab, row.id);
          writeSel('');
          if (refresh) await refresh();
        }
      }, M.render.icon('trash-2'), ' Delete');
      actions.appendChild(delBtn);
      pane.appendChild(actions);

      M.render.refreshIcons();
    }
    paint();
    return wrap;
  }

  // Tiles view — visual cards grouped by playlist / category / kind
  // Card-grid layout grouping rows by `playlist`, `category`, or `kind`
  // when present. Each card surfaces a thumbnail (YouTube derivation
  // first, row.thumbnail second, monogram fallback otherwise), the
  // title, a sub-line (channel / authors), an optional duration or
  // year stamp, and — when the section has both `url` and `offline`
  // columns — an inline Download icon button that mirrors the
  // table-row routing.
  function renderTiles(meta, rows, tab, refresh, offlineIds) {
    var headers = (meta && meta.headers) || [];
    var groupCol = headers.indexOf('playlist') >= 0 ? 'playlist'
      : (headers.indexOf('category') >= 0 ? 'category'
        : (headers.indexOf('kind') >= 0 ? 'kind' : ''));
    var titleCol = headers.indexOf('title') >= 0 ? 'title'
      : (headers.indexOf('name') >= 0 ? 'name' : '');
    var subCol = headers.indexOf('channel') >= 0 ? 'channel'
      : (headers.indexOf('authors') >= 0 ? 'authors'
        : (headers.indexOf('author') >= 0 ? 'author' : ''));
    var hasWatched = headers.indexOf('watched') >= 0;
    var hasUrl = headers.indexOf('url') >= 0;
    var hasOffline = headers.indexOf('offline') >= 0;
    var collapsed = readCollapsedGroups(tab);

    var ytId = function (s) {
      var m = String(s || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/);
      return m ? m[1] : null;
    };

    function tileFor(r) {
      var tile = el('div', { class: 'tile' + (hasWatched && String(r.watched || '').toUpperCase() === 'TRUE' ? ' tile-watched' : '') });
      var thumb = el('div', { class: 'tile-thumb' });
      var url = hasUrl ? r.url : '';
      var yid = ytId(url);
      if (yid) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = 'https://img.youtube.com/vi/' + encodeURIComponent(yid) + '/mqdefault.jpg';
        thumb.appendChild(img);
      } else if (r.thumbnail) {
        var img2 = document.createElement('img');
        img2.loading = 'lazy';
        img2.alt = '';
        img2.src = String(r.thumbnail);
        thumb.appendChild(img2);
      } else {
        // Monogram fallback — first non-space char of the title.
        var t0 = (r[titleCol] || r.title || '?').toString().trim();
        thumb.classList.add('tile-thumb-mono');
        thumb.textContent = (t0[0] || '?').toUpperCase();
      }
      tile.appendChild(thumb);

      // Info button — opens a quick-look modal showing every column
      // value for the row. Lets the user inspect metadata without
      // opening the full row-detail route.
      var infoBtn = el('button', {
        type: 'button',
        class: 'tile-info',
        title: 'Show all fields',
        'aria-label': 'Show details',
        onclick: function (e) {
          e.preventDefault();
          e.stopPropagation();
          showRowMetadataPopup(meta, r);
        }
      });
      infoBtn.appendChild(M.render.icon('info'));
      thumb.appendChild(infoBtn);

      // Watched / unwatched toggle — visible when the section has a
      // `watched` column. Sits on the thumbnail's bottom-right corner
      // so it doesn't fight with the offline action buttons (top-right).
      if (hasWatched) {
        var watchedNow = String(r.watched || '').toUpperCase() === 'TRUE';
        var wTog = el('button', {
          type: 'button',
          class: 'tile-watched-toggle' + (watchedNow ? ' is-watched' : ''),
          title: watchedNow ? 'Mark unwatched' : 'Mark watched',
          'aria-label': watchedNow ? 'Mark unwatched' : 'Mark watched',
          onclick: async function (e) {
            e.preventDefault();
            e.stopPropagation();
            var fresh = await M.db.getRow(tab, r.id);
            if (!fresh || fresh._deleted) return;
            var nowOn = String(fresh.watched || '').toUpperCase() !== 'TRUE';
            pushUndo({ kind: 'edit', tab: tab, rowId: fresh.id, field: 'watched', prevValue: fresh.watched });
            fresh.watched = nowOn ? 'TRUE' : 'FALSE';
            if (headers.indexOf('watched_at') >= 0) {
              fresh.watched_at = nowOn ? new Date().toISOString() : '';
            }
            fresh._updated = new Date().toISOString();
            fresh._dirty = 1;
            await M.db.upsertRow(tab, fresh);
            schedulePush();
            if (refresh) await refresh();
          }
        });
        wTog.appendChild(M.render.icon(watchedNow ? 'check-circle-2' : 'circle'));
        thumb.appendChild(wTog);
      }

      // Per-card offline controls. The set of buttons depends on
      // whether a cached blob already exists for this row:
      //   • cached  → Watch offline + Remove (+ Open in Drive when
      //               the offline column carries a drive:<id> token)
      //   • absent  → Download (yt-dlp server → Cobalt → clipboard
      //               fallback; shift-click opens full options)
      var rowHasBlob = offlineIds && offlineIds.has(r.id);
      // Extract the Drive fileId left in the offline column by the
      // mirror-to-Drive flow (format: "yt-dlp · 12.3 MB · drive:1abc…").
      var driveIdMatch = String(r.offline || '').match(/drive:([\w-]{20,})/);
      var driveFileId = driveIdMatch ? driveIdMatch[1] : '';

      // Tile actions: Watch / Mirror stays visible (added below).
      // Edit / Delete / Save-to-disk / Remove-offline live in a
      // kebab popover so the action strip doesn't crowd the
      // thumbnail.
      var actionsHost = el('div', { class: 'tile-actions' });

      function tileMenuItem(icon, label, danger, run) {
        var b = el('button', {
          type: 'button',
          class: 'tile-menu-item' + (danger ? ' is-danger' : ''),
          onclick: function (e) {
            e.preventDefault(); e.stopPropagation();
            try { run(); } finally { closeTileMenu(); }
          }
        });
        b.appendChild(M.render.icon(icon));
        b.appendChild(document.createTextNode(' ' + label));
        return b;
      }
      var openMenu = null;
      function closeTileMenu() {
        if (openMenu) {
          try { openMenu.remove(); } catch (e) {}
          openMenu = null;
          document.removeEventListener('click', closeTileMenu);
        }
      }
      var kebabBtn = el('button', {
        type: 'button',
        class: 'tile-action tile-kebab',
        title: 'More actions',
        'aria-label': 'More actions',
        onclick: function (e) {
          e.preventDefault(); e.stopPropagation();
          if (openMenu) { closeTileMenu(); return; }
          var menu = el('div', { class: 'tile-menu' });
          menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
          menu.appendChild(tileMenuItem('pencil', 'Edit row', false, function () {
            if (typeof showRowDetail === 'function') showRowDetail(tab, r.id);
          }));
          if (rowHasBlob || driveFileId) {
            menu.appendChild(tileMenuItem('hard-drive', 'Save to ~/Minerva', false, function () {
              saveTileToHost();
            }));
          }
          if (rowHasBlob) {
            menu.appendChild(tileMenuItem('cloud-off', 'Remove offline copy', false, function () {
              dropOfflineBlob();
            }));
          }
          menu.appendChild(tileMenuItem('trash-2', 'Delete row', true, async function () {
            if (!confirm('Delete this row? Your local copy is removed and the next sync deletes it from the spreadsheet.')) return;
            try {
              await deleteRow(tab, r.id);
              if (refresh) await refresh();
            } catch (err) {
              flash(document.body, 'Delete failed: ' + (err && err.message || err), 'error');
            }
          }));
          actionsHost.appendChild(menu);
          openMenu = menu;
          // Close on next click anywhere else.
          setTimeout(function () { document.addEventListener('click', closeTileMenu); }, 0);
        }
      });
      kebabBtn.appendChild(M.render.icon('more-vertical'));
      actionsHost.appendChild(kebabBtn);

      async function dropOfflineBlob() {
        if (!confirm('Drop the local offline copy? The row stays — you can re-download later.')) return;
        try { await M.db.deleteVideo(tab, r.id); } catch (err) {}
        if (hasOffline && r.offline) {
          pushUndo({ kind: 'edit', tab: tab, rowId: r.id, field: 'offline', prevValue: r.offline });
          r.offline = '';
          r._updated = new Date().toISOString();
          r._dirty = 1;
          await M.db.upsertRow(tab, r);
          schedulePush();
        }
        if (refresh) await refresh();
      }

      async function saveTileToHost() {
        var endpoint = String(readConfig().ytDlpServer || '').trim().replace(/\/+$/, '');
        if (!endpoint) {
          flash(document.body, 'Set the helper URL in Settings first.', 'error');
          return;
        }
        try {
          var bytes, ext, kind;
          if (rowHasBlob) {
            var rec = await M.db.getVideo(tab, r.id);
            if (!rec || !rec.blob) throw new Error('No offline blob.');
            bytes = await rec.blob.arrayBuffer();
            ext = (rec.mime && /mp4/i.test(rec.mime)) ? '.mp4' : '';
            kind = 'videos';
            // Trigger a normal browser download too — works even
            // when the helper runs in a Docker container that can't
            // open the host's file manager via xdg-open.
            try {
              var dlA = document.createElement('a');
              dlA.href = URL.createObjectURL(rec.blob);
              dlA.download = (r.title || r.id || 'video') + (ext || '.mp4');
              document.body.appendChild(dlA); dlA.click(); dlA.remove();
              setTimeout(function () { try { URL.revokeObjectURL(dlA.href); } catch (e) {} }, 30000);
            } catch (e) { /* tolerate */ }
          } else {
            var c = readConfig();
            if (!c.clientId) throw new Error('Sign in first.');
            var token = await M.auth.getToken(c.clientId);
            var resp = await fetch(
              'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFileId) + '?alt=media',
              { headers: { Authorization: 'Bearer ' + token } }
            );
            if (!resp.ok) throw new Error('Drive ' + resp.status);
            var pdfBlob = await resp.blob();
            bytes = await pdfBlob.arrayBuffer();
            ext = '.pdf';
            kind = 'papers';
            try {
              var dlA2 = document.createElement('a');
              dlA2.href = URL.createObjectURL(pdfBlob);
              dlA2.download = (r.title || r.id || 'paper') + ext;
              document.body.appendChild(dlA2); dlA2.click(); dlA2.remove();
              setTimeout(function () { try { URL.revokeObjectURL(dlA2.href); } catch (e) {} }, 30000);
            } catch (e) { /* tolerate */ }
          }
          var stem = String(r.title || r.id || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
          if (ext && !stem.toLowerCase().endsWith(ext)) stem += ext;
          var saveResp = await fetch(
            endpoint + '/file/save?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(stem),
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
          );
          var saveJson = await saveResp.json();
          if (!saveJson.ok) throw new Error(saveJson.error || ('save ' + saveResp.status));
          flash(document.body,
            'Saved to ~/Minerva/' + kind + ' (and triggered a browser download).', 'ok');
        } catch (err) {
          flash(document.body, 'Save failed: ' + (err && err.message || err), 'error');
        }
      }

      thumb.appendChild(actionsHost);

      if (hasOffline && hasUrl && url) {
        if (rowHasBlob) {
          var watchBtn = el('button', {
            type: 'button',
            class: 'tile-action tile-watch',
            title: 'Play the locally-saved file',
            'aria-label': 'Watch offline',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              try {
                var rec = await M.db.getVideo(tab, r.id);
                if (rec && rec.blob && M.preview && M.preview.showVideoBlob) {
                  M.preview.showVideoBlob({
                    url: URL.createObjectURL(rec.blob),
                    title: r.title || (titleCol && r[titleCol]) || 'Offline video',
                    sourceUrl: url
                  });
                }
              } catch (err) { /* ignore */ }
            }
          });
          watchBtn.appendChild(M.render.icon('play-circle'));
          actionsHost.appendChild(watchBtn);

          // Open in Drive — visible only when the row carries a
          // drive:<fileId> breadcrumb. Plain click opens the file in
          // a new tab; the Watch button (above) stays the primary
          // action for in-app playback.
          if (driveFileId) {
            var driveBtn = el('a', {
              class: 'tile-action tile-drive',
              href: 'https://drive.google.com/file/d/' + encodeURIComponent(driveFileId) + '/view',
              target: '_blank',
              rel: 'noopener',
              title: 'Open in Google Drive',
              'aria-label': 'Open in Drive',
              onclick: function (e) { e.stopPropagation(); }
            });
            driveBtn.appendChild(M.render.icon('cloud'));
            actionsHost.appendChild(driveBtn);
          }

          // "Remove offline copy (keep row)" lives in the kebab menu
          // above; no separate primary-action button here. Less
          // duplication, less confusion between two trash-shaped
          // icons.
        } else {
          // Route by URL kind: papers (PDF / arxiv abs+pdf / doi.org)
          // can't be handled by yt-dlp — pushing one through it gives
          // the "Unsupported URL" 500 the user just hit. Send those
          // through uploadPaperPdfToDrive instead, write drive:<fileId>
          // back to row.offline so the next click reads from the
          // Drive-mirrored blob rather than the live host.
          var looksLikePaper = /\.pdf(\?|#|$)/i.test(url)
            || /arxiv\.org\/(?:abs|pdf)\//i.test(url)
            || /doi\.org\//i.test(url);
          var dlBtn = el('button', {
            type: 'button',
            class: 'tile-action tile-download',
            title: looksLikePaper
              ? 'Mirror this PDF to Drive so it opens offline'
              : 'Download for offline playback (shift-click for options)',
            'aria-label': 'Download',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (looksLikePaper) {
                var paperUrl = (function () {
                  // Prefer an explicit pdf column when present —
                  // arxiv abs URLs aren't fetchable as PDF directly,
                  // but the row's pdf column holds the real PDF link.
                  if (r.pdf) return String(r.pdf).trim();
                  if (/arxiv\.org\/abs\/(.+)$/i.test(url)) {
                    return url.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
                  }
                  return url;
                })();
                var job = addDownloadJob({ title: r.title || r.id || 'PDF' });
                try {
                  job.setStatus('Fetching PDF…');
                  var fid = await uploadPaperPdfToDrive(paperUrl, r.title || r.id);
                  if (!fid) throw new Error('Drive upload returned no fileId.');
                  // Persist the breadcrumb so preview.js routes the
                  // next open through the Drive blob loader.
                  var meta3 = await M.db.getMeta(tab);
                  if (meta3 && (meta3.headers || []).indexOf('offline') >= 0) {
                    var fresh3 = await M.db.getRow(tab, r.id);
                    if (fresh3) {
                      fresh3.offline = 'drive:' + fid;
                      fresh3._dirty = 1;
                      fresh3._updated = new Date().toISOString();
                      await M.db.upsertRow(tab, fresh3);
                      schedulePush();
                    }
                  }
                  job.done('Saved to Drive', {
                    label: 'Open',
                    icon: 'cloud',
                    run: function () {
                      window.open(
                        'https://drive.google.com/file/d/' + encodeURIComponent(fid) + '/view',
                        '_blank', 'noopener'
                      );
                    }
                  });
                  if (refresh) await refresh();
                } catch (err) {
                  job.fail('PDF mirror failed: ' + (err && err.message || err));
                }
                return;
              }
              if (e.shiftKey) {
                showOfflineSetupDialog(tab, r, refresh);
                return;
              }
              var cfg = readConfig();
              if ((cfg.ytDlpServer || '').trim()) {
                downloadOfflineViaYtDlp(tab, r, refresh);
                return;
              }
              if ((cfg.cobaltEndpoint || '').trim()) {
                downloadOfflineViaCobalt(tab, r, refresh);
                return;
              }
              copyYtDlpCommand(url);
            }
          });
          dlBtn.appendChild(M.render.icon(looksLikePaper ? 'cloud' : 'download'));
          actionsHost.appendChild(dlBtn);
        }
        if (rowHasBlob || driveFileId) tile.classList.add('tile-has-offline');
      }

      var body = el('div', { class: 'tile-body' });
      var titleEl = el('div', { class: 'tile-title' }, r[titleCol] || r.title || '(untitled)');
      body.appendChild(titleEl);
      if (subCol && r[subCol]) {
        body.appendChild(el('div', { class: 'tile-sub small muted' }, r[subCol]));
      }
      // Optional duration / year tag in the corner.
      var meta2 = '';
      if (r.duration) meta2 = String(r.duration);
      else if (r.year) meta2 = String(r.year);
      if (meta2) body.appendChild(el('div', { class: 'tile-meta small muted' }, meta2));
      tile.appendChild(body);

      tile.addEventListener('click', async function (e) {
        // Modifier-clicks defer to native link / OS behavior. Per-card
        // action buttons (Download / Watch / Remove) stop propagation
        // before this handler runs.
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        if (e.target.closest('.tile-action')) return;
        e.preventDefault();
        // Prefer the locally-cached blob over re-fetching the URL when
        // both are available. Falls through to the URL preview if the
        // lookup races or the blob has been removed since render.
        if (rowHasBlob && M.db && M.preview && M.preview.showVideoBlob) {
          try {
            var rec = await M.db.getVideo(tab, r.id);
            if (rec && rec.blob) {
              M.preview.showVideoBlob({
                url: URL.createObjectURL(rec.blob),
                title: r.title || (titleCol && r[titleCol]) || 'Offline video',
                sourceUrl: url
              });
              return;
            }
          } catch (err) { /* fall through to URL preview */ }
        }
        if (url && window.Minerva && Minerva.preview) {
          Minerva.preview.show(url);
        } else {
          showRowDetail(tab, r.id);
        }
      });
      return tile;
    }

    var wrap = el('div', { class: 'tiles-wrap' });
    if (groupCol) {
      var byGroup = {};
      var order = [];
      rows.forEach(function (r) {
        var key = (r[groupCol] && String(r[groupCol]).split(',')[0].trim()) || '(uncategorised)';
        if (!byGroup[key]) { byGroup[key] = []; order.push(key); }
        byGroup[key].push(r);
      });
      order.forEach(function (key) {
        var groupRows = byGroup[key];
        var isCol = collapsed.has(key);
        var head = el('div', { class: 'tiles-group-head' });
        var caret = el('button', {
          type: 'button',
          class: 'row-group-caret',
          title: isCol ? 'Expand' : 'Collapse',
          onclick: function () {
            var cur = readCollapsedGroups(tab);
            if (cur.has(key)) cur.delete(key);
            else cur.add(key);
            writeCollapsedGroups(tab, cur);
            if (refresh) refresh();
          }
        });
        caret.appendChild(M.render.icon(isCol ? 'chevron-right' : 'chevron-down'));
        head.appendChild(caret);
        var titleSpan = el('button', {
          type: 'button',
          class: 'tiles-group-title tiles-group-title-rename',
          title: 'Rename: changes the ' + (groupCol || 'group') + ' column on every row in this group',
          onclick: function (e) {
            e.preventDefault(); e.stopPropagation();
            if (!groupCol) return;
            var fresh = window.prompt('Rename "' + key + '" to:', key);
            if (fresh === null) return;
            var trimmed = String(fresh).trim();
            if (trimmed === key) return;
            (async function () {
              for (var gi = 0; gi < groupRows.length; gi++) {
                var gr = groupRows[gi];
                var fr = await M.db.getRow(tab, gr.id);
                if (!fr) continue;
                fr[groupCol] = trimmed;
                fr._dirty = 1;
                fr._updated = new Date().toISOString();
                await M.db.upsertRow(tab, fr);
              }
              schedulePush();
              if (refresh) await refresh();
              flash(document.body,
                'Renamed ' + groupRows.length + ' row' + (groupRows.length === 1 ? '' : 's') + ' to "' + trimmed + '".', 'ok');
            })().catch(function (err) {
              flash(document.body, 'Rename failed: ' + (err && err.message || err), 'error');
            });
          }
        }, key);
        head.appendChild(titleSpan);
        head.appendChild(el('span', { class: 'small muted' }, ' · ' + groupRows.length));

        // Per-group Download-all — same routing as the table view's
        // group head, mirrored here so the grid view has parity. Skips
        // rows that already have a cached blob.
        if (hasOffline && hasUrl) {
          var groupRowsClosure = groupRows;
          var dlAllBtn = el('button', {
            type: 'button',
            class: 'icon-btn row-group-dl tiles-group-dl',
            title: 'Download every video in "' + key + '"',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              var withUrl = groupRowsClosure.filter(function (rr) {
                return rr.url && (!offlineIds || !offlineIds.has(rr.id));
              });
              if (!withUrl.length) {
                flash(document.body, 'Nothing new to download in this group.');
                return;
              }
              var gcfg = readConfig();
              var gytDlpOk = !!(gcfg.ytDlpServer || '').trim();
              var gCobaltOk = !!(gcfg.cobaltEndpoint || '').trim();
              if (gytDlpOk || gCobaltOk) {
                flash(document.body, 'Downloading ' + withUrl.length + ' video' + (withUrl.length === 1 ? '' : 's') + '…');
                for (var i = 0; i < withUrl.length; i++) {
                  try {
                    if (gytDlpOk) await downloadOfflineViaYtDlp(tab, withUrl[i], null);
                    else await downloadOfflineViaCobalt(tab, withUrl[i], null);
                  } catch (er) { console.warn('[Minerva grid-group-dl]', er); }
                }
                if (refresh) await refresh();
                return;
              }
              var fmt = gcfg.ytDlpFormat || 'mp4';
              var parts = ['yt-dlp'];
              if (fmt === 'mp3') parts.push('-x', '--audio-format', 'mp3');
              else if (fmt === 'bestaudio') parts.push('-x');
              else if (fmt === 'mp4') parts.push('-f', 'mp4');
              else parts.push('-f', JSON.stringify(fmt));
              withUrl.forEach(function (rr) { parts.push(JSON.stringify(rr.url)); });
              var cmd = parts.join(' ');
              try {
                await navigator.clipboard.writeText(cmd);
                flash(document.body, 'yt-dlp command for ' + withUrl.length + ' video' + (withUrl.length === 1 ? '' : 's') + ' copied. Paste in terminal.');
              } catch (er) {
                console.log(cmd);
                flash(document.body, 'Clipboard blocked — yt-dlp command in console.', 'error');
              }
            }
          });
          dlAllBtn.appendChild(M.render.icon('download'));
          head.appendChild(dlAllBtn);

          // Per-group "delete all" — mirrors the list-view group
          // delete. Wipes every row in the playlist and the offline
          // blobs they own (deleteRow cascades to the videos store).
          var rmAllBtn = el('button', {
            type: 'button',
            class: 'icon-btn row-group-rm tiles-group-rm',
            title: 'Delete every video in "' + key + '" (and their offline copies)',
            'aria-label': 'Delete playlist',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              var n = groupRowsClosure.length;
              if (!n) return;
              if (!confirm('Delete ' + n + ' video' + (n === 1 ? '' : 's') + ' from "' + key + '"? Offline copies are removed too.')) return;
              for (var i = 0; i < n; i++) {
                try { await deleteRow(tab, groupRowsClosure[i].id); }
                catch (er) { console.warn('[Minerva grid-group-rm]', er); }
              }
              if (refresh) await refresh();
              flash(document.body, 'Deleted ' + n + ' video' + (n === 1 ? '' : 's') + '.');
            }
          });
          rmAllBtn.appendChild(M.render.icon('trash-2'));
          head.appendChild(rmAllBtn);
        }
        wrap.appendChild(head);
        if (!isCol) {
          var grid = el('div', { class: 'tiles-grid' });
          groupRows.forEach(function (r) { grid.appendChild(tileFor(r)); });
          wrap.appendChild(grid);
        }
      });
    } else {
      var grid = el('div', { class: 'tiles-grid' });
      rows.forEach(function (r) { grid.appendChild(tileFor(r)); });
      wrap.appendChild(grid);
    }
    return wrap;
  }

  function renderSectionTable(meta, rows, tab, refresh, userSort, onSortChange, backlinks, selectedIds, onBulkChange) {
    if (!meta || !meta.headers || !meta.headers.length) {
      return el('p', { class: 'muted' }, 'No schema cached yet — open Settings and click Sync now.');
    }
    if (!rows.length) {
      return el('p', { class: 'muted' }, 'No rows yet. Click ', el('em', null, '+ Add row'), ' to start, or add some in your spreadsheet then Sync.');
    }
    var hiddenColSet = new Set(readHiddenCols(tab));
    var visibleCols = [];
    for (var i = 0; i < meta.headers.length; i++) {
      var h = meta.headers[i];
      if (M.render.isInternal(h)) continue;
      if (h === 'id') continue;
      if (hiddenColSet.has(h)) continue;
      visibleCols.push({ name: h, type: meta.types[i] || 'text' });
    }
    var hasPlaylistCol = (meta.headers || []).indexOf('playlist') >= 0;
    var hasOfflineCol  = (meta.headers || []).indexOf('offline')  >= 0;
    var hasUrlCol      = (meta.headers || []).indexOf('url')      >= 0;
    var hasWatchedCol2 = (meta.headers || []).indexOf('watched')  >= 0;
    var hasWatchedAt2  = (meta.headers || []).indexOf('watched_at') >= 0;

    function syncAllCheckbox(table) {
      var head = table.querySelector('thead .bulk-cb-all');
      if (!head) return;
      var allChecked = rows.length > 0 && rows.every(function (r) { return selectedIds.has(r.id); });
      var anyChecked = rows.some(function (r) { return selectedIds.has(r.id); });
      head.checked = allChecked;
      head.indeterminate = !allChecked && anyChecked;
    }

    var allSelected = !!selectedIds && rows.length > 0 && rows.every(function (r) { return selectedIds.has(r.id); });
    var bulkAllCb = document.createElement('input');
    bulkAllCb.type = 'checkbox';
    bulkAllCb.className = 'bulk-cb-all';
    bulkAllCb.title = 'Select all rows in ' + tab;
    bulkAllCb.checked = allSelected;
    bulkAllCb.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!selectedIds) return;
      if (bulkAllCb.checked) rows.forEach(function (r) { selectedIds.add(r.id); });
      else rows.forEach(function (r) { selectedIds.delete(r.id); });
      var trs = (e.target.closest('table') || document).querySelectorAll('tbody tr');
      trs.forEach(function (tr) {
        var cb = tr.querySelector('.bulk-cb');
        var on = bulkAllCb.checked;
        if (cb) cb.checked = on;
        tr.classList.toggle('is-bulk-selected', on);
      });
      // Group checkboxes follow the all-checkbox.
      var groupCbs = (e.target.closest('table') || document).querySelectorAll('.bulk-cb-group');
      groupCbs.forEach(function (cb) { cb.checked = bulkAllCb.checked; cb.indeterminate = false; });
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

    function buildRow(row) {
      var tr = el('tr', { 'data-rowid': row.id });
      if (row._dirty) tr.classList.add('row-dirty');
      var isSelected = !!selectedIds && selectedIds.has(row.id);
      if (isSelected) tr.classList.add('is-bulk-selected');
      tr.addEventListener('dblclick', function (e) {
        if (e.target.closest('.col-bulk, .col-actions, button, input, textarea, select, a')) return;
        showRowDetail(tab, row.id);
      });

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
        syncAllCheckbox(tr.closest('table') || document);
        // Update the row's group checkbox state if the row sits in a group.
        var groupTr = tr.previousElementSibling;
        while (groupTr && !groupTr.classList.contains('row-group-head') && !groupTr.classList.contains('row-group-end')) {
          groupTr = groupTr.previousElementSibling;
        }
        if (groupTr && groupTr.classList.contains('row-group-head')) {
          var gid = groupTr.dataset.group;
          var groupRows = rows.filter(function (r) { return (r.playlist || '(no playlist)') === gid; });
          var allG = groupRows.every(function (r) { return selectedIds.has(r.id); });
          var anyG = groupRows.some(function (r) { return selectedIds.has(r.id); });
          var gcb = groupTr.querySelector('.bulk-cb-group');
          if (gcb) { gcb.checked = allG; gcb.indeterminate = !allG && anyG; }
        }
        if (onBulkChange) onBulkChange();
      });
      var bulkTd = el('td', { class: 'col-bulk' });
      bulkTd.appendChild(rowCb);
      tr.appendChild(bulkTd);

      visibleCols.forEach(function (c, ci) {
        var td = el('td', { 'data-col': c.name, 'data-type': c.type, tabindex: '0' });
        var parsed = M.render.parseType(c.type);

        if (parsed.kind === 'rating') {
          // One-click rating: render direct stars wired to commitCellEdit
          // so a single click sets the rating, no edit-mode round-trip.
          var ratingHost = renderInlineRating(row[c.name], parsed, function (newVal) {
            if (newVal === row[c.name]) return Promise.resolve();
            return commitCellEdit(tab, row.id, c.name, newVal).then(function () {
              row[c.name] = newVal;
              return refresh();
            });
          });
          td.appendChild(ratingHost);
          td.classList.add('cell-rating-host');
        } else {
          td.appendChild(M.render.renderCell(row[c.name], c.type));
          // Drawing cells route directly to the canvas editor regardless
          // of whether the cell already has a value. Click and Enter/Space
          // both trigger the navigation; the inline text editor used by
          // other cell types is bypassed for this column type.
          var openDrawEditor = function () {
            location.hash = '#/draw/' + encodeURIComponent(tab) +
              '/' + encodeURIComponent(row.id) +
              '?col=' + encodeURIComponent(c.name);
          };
          if (parsed.kind === 'drawing') {
            td.classList.add('cell-drawing-host');
            td.title = 'Click to draw';
          }
          td.addEventListener('click', function (e) {
            // Don't hijack clicks on our own controls (preview/play/etc).
            if (e.target.closest('.cell-preview, .cell-yt-play, .cell-yt-link, .cell-link, a, button, input, textarea, select, .star-btn')) return;
            if (parsed.kind === 'drawing') { openDrawEditor(); return; }
            startEdit(td, row, c, tab, refresh);
          });
          td.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (parsed.kind === 'drawing') { openDrawEditor(); return; }
              startEdit(td, row, c, tab, refresh);
            }
          });
        }
        // Append a small backlink badge to the first visible column.
        if (ci === 0 && backlinks && backlinks[row.id] && backlinks[row.id].length) {
          var n = backlinks[row.id].length;
          var badge = el('span', { class: 'backlink-badge', title: n + ' incoming reference' + (n === 1 ? '' : 's') });
          badge.appendChild(M.render.icon('link-2'));
          badge.appendChild(document.createTextNode(' ' + n));
          td.appendChild(badge);
        }
        tr.appendChild(td);
      });

      var actions = el('td', { class: 'col-actions' });

      // Per-row offline control — only sections with both `url` and
      // `offline` columns; the YouTube preset has both. Picks a video
      // file from disk and stores it as a Blob in IndexedDB.
      if (hasOfflineCol && hasUrlCol) {
        var offBtn = renderOfflineButton(tab, row, refresh);
        actions.appendChild(offBtn);
      }

      // Per-row mark-unwatched action. Rendered only when the row is
      // currently watched, so the action is always a state flip back to
      // unwatched. Provides parity with the bulk action without
      // requiring a selection.
      if (hasWatchedCol2 && String(row.watched || '').toUpperCase() === 'TRUE') {
        var unwatchBtn = el('button', {
          class: 'icon-btn row-unwatch',
          type: 'button',
          title: 'Mark unwatched',
          'aria-label': 'Mark unwatched',
          onclick: async function (e) {
            e.preventDefault();
            e.stopPropagation();
            pushUndo({ kind: 'edit', tab: tab, rowId: row.id, field: 'watched', prevValue: row.watched });
            row.watched = 'FALSE';
            if (hasWatchedAt2) row.watched_at = '';
            row._updated = new Date().toISOString();
            row._dirty = 1;
            await M.db.upsertRow(tab, row);
            schedulePush();
            if (refresh) await refresh();
          }
        });
        unwatchBtn.appendChild(M.render.icon('eye-off'));
        actions.appendChild(unwatchBtn);
      }

      var delBtn = el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Delete row',
        'aria-label': 'Delete row',
        onclick: async function () {
          if (!confirm('Delete this row? This will remove it from your spreadsheet on next sync.')) return;
          try { await M.db.deleteVideo(tab, row.id); } catch (e) { /* ignore */ }
          await deleteRow(tab, row.id);
          await refresh();
        }
      }, '×');
      actions.appendChild(delBtn);
      tr.appendChild(actions);
      return tr;
    }

    // Group rows by `playlist` only when the column exists AND at least
    // one row carries a non-empty value — otherwise the grouping just
    // adds a single "(no playlist)" header that adds noise.
    var anyPlaylist = hasPlaylistCol && rows.some(function (r) { return r.playlist && String(r.playlist).trim(); });
    var bodyChildren = [];
    if (anyPlaylist) {
      var collapsed = readCollapsedGroups(tab);
      var byGroup = {};
      var order = [];
      rows.forEach(function (r) {
        var key = (r.playlist && String(r.playlist).trim()) || '(no playlist)';
        if (!byGroup[key]) { byGroup[key] = []; order.push(key); }
        byGroup[key].push(r);
      });
      // Stable: keep first-seen order so the user's sort decides ranking.
      order.forEach(function (key) {
        var groupRows = byGroup[key];
        var isCollapsed = collapsed.has(key);
        var allG = groupRows.every(function (r) { return selectedIds.has(r.id); });
        var anyG = groupRows.some(function (r) { return selectedIds.has(r.id); });

        var gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'bulk-cb-group';
        gcb.title = 'Select every row in "' + key + '"';
        gcb.checked = allG;
        gcb.indeterminate = !allG && anyG;
        gcb.addEventListener('click', function (e) {
          e.stopPropagation();
          if (gcb.checked) groupRows.forEach(function (r) { selectedIds.add(r.id); });
          else            groupRows.forEach(function (r) { selectedIds.delete(r.id); });
          gcb.indeterminate = false;
          var table = e.target.closest('table') || document;
          // Flip the row checkboxes inside this group only.
          groupRows.forEach(function (r) {
            var tr = table.querySelector('tbody tr[data-rowid="' + cssEscape(r.id) + '"]');
            if (!tr) return;
            var cb = tr.querySelector('.bulk-cb');
            if (cb) cb.checked = gcb.checked;
            tr.classList.toggle('is-bulk-selected', gcb.checked);
          });
          syncAllCheckbox(table);
          if (onBulkChange) onBulkChange();
        });

        var headTd = document.createElement('td');
        headTd.colSpan = visibleCols.length + 2; // bulk + cols + actions
        headTd.className = 'row-group-head-cell';
        var caretBtn = el('button', {
          type: 'button',
          class: 'row-group-caret',
          title: isCollapsed ? 'Expand group' : 'Collapse group',
          'aria-expanded': isCollapsed ? 'false' : 'true',
          'aria-label': (isCollapsed ? 'Expand' : 'Collapse') + ' ' + key,
          onclick: function (e) {
            e.preventDefault();
            e.stopPropagation();
            var cur = readCollapsedGroups(tab);
            if (cur.has(key)) cur.delete(key);
            else cur.add(key);
            writeCollapsedGroups(tab, cur);
            if (refresh) refresh();
          }
        });
        caretBtn.appendChild(M.render.icon(isCollapsed ? 'chevron-right' : 'chevron-down'));
        var titleSpan = el('span', { class: 'row-group-title' }, key);
        var countSpan = el('span', { class: 'row-group-count small muted' },
          ' · ' + groupRows.length + ' video' + (groupRows.length === 1 ? '' : 's'));
        var watchedN = groupRows.filter(function (r) { return String(r.watched || '').toUpperCase() === 'TRUE'; }).length;
        if (watchedN > 0) {
          var pctW = Math.round(100 * watchedN / groupRows.length);
          countSpan.appendChild(document.createTextNode(' · ' + watchedN + ' watched (' + pctW + '%)'));
        }
        headTd.appendChild(caretBtn);
        headTd.appendChild(gcb);
        headTd.appendChild(titleSpan);
        headTd.appendChild(countSpan);

        // Per-group "download all" — one click grabs every URL in the
        // group via Cobalt (when configured) or via a single yt-dlp
        // command with all URLs on the user's clipboard.
        if (hasOfflineCol && hasUrlCol) {
          var groupRowsClosure = groupRows;
          var dlGroupBtn = el('button', {
            type: 'button',
            class: 'icon-btn row-group-dl',
            title: 'Download every video in "' + key + '"',
            'aria-label': 'Download playlist',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              var withUrl = groupRowsClosure.filter(function (r) { return r.url; });
              if (!withUrl.length) { flash(document.body, 'No URLs in this group.', 'error'); return; }
              var gcfg = readConfig();
              var gytDlpOk = !!(gcfg.ytDlpServer || '').trim();
              var gCobaltOk = !!(gcfg.cobaltEndpoint || '').trim();
              if (gytDlpOk || gCobaltOk) {
                var gvia = gytDlpOk ? 'yt-dlp' : 'Cobalt';
                flash(document.body, 'Downloading ' + withUrl.length + ' via ' + gvia + '…');
                var gbatch = addBulkDownloadJob(withUrl.length, key + ' · ' + gvia);
                for (var i = 0; i < withUrl.length; i++) {
                  try {
                    if (gytDlpOk) await downloadOfflineViaYtDlp(tab, withUrl[i], null);
                    else await downloadOfflineViaCobalt(tab, withUrl[i], null);
                    gbatch.tick(true);
                  } catch (er) {
                    console.warn('[Minerva group-dl]', er);
                    gbatch.tick(false);
                  }
                }
                gbatch.done();
                if (refresh) await refresh();
                return;
              }
              var fmt = readConfig().ytDlpFormat || 'mp4';
              var parts = ['yt-dlp'];
              if (fmt === 'mp3') parts.push('-x', '--audio-format', 'mp3');
              else if (fmt === 'bestaudio') parts.push('-x');
              else if (fmt === 'mp4') parts.push('-f', 'mp4');
              else parts.push('-f', JSON.stringify(fmt));
              withUrl.forEach(function (r) { parts.push(JSON.stringify(r.url)); });
              var cmd = parts.join(' ');
              try {
                await navigator.clipboard.writeText(cmd);
                flash(document.body, 'yt-dlp command for ' + withUrl.length + ' video' + (withUrl.length === 1 ? '' : 's') + ' copied. Paste in terminal.');
              } catch (er) {
                console.log(cmd);
                flash(document.body, 'Clipboard blocked — yt-dlp command in console.', 'error');
              }
            }
          });
          dlGroupBtn.appendChild(M.render.icon('download'));
          headTd.appendChild(dlGroupBtn);

          // Per-group "delete all" — wipes every row in the playlist
          // and any offline blobs they own. Always offered alongside
          // the download-all action so list-view users can clean up
          // a whole playlist without bulk-selecting.
          var rmGroupBtn = el('button', {
            type: 'button',
            class: 'icon-btn row-group-rm',
            title: 'Delete every row in "' + key + '" (and their offline copies)',
            'aria-label': 'Delete playlist',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              var n = groupRowsClosure.length;
              if (!n) return;
              if (!confirm('Delete ' + n + ' row' + (n === 1 ? '' : 's') + ' from "' + key + '"? Offline copies are removed too. Undoable until your next ' + UNDO_MAX + '-deep operation.')) return;
              for (var i = 0; i < n; i++) {
                try { await deleteRow(tab, groupRowsClosure[i].id); }
                catch (er) { console.warn('[Minerva group-rm]', er); }
              }
              if (refresh) await refresh();
              flash(document.body, 'Deleted ' + n + ' row' + (n === 1 ? '' : 's') + '.');
            }
          });
          rmGroupBtn.appendChild(M.render.icon('trash-2'));
          headTd.appendChild(rmGroupBtn);
        }

        var groupTr = el('tr', {
          class: 'row-group-head' + (isCollapsed ? ' is-collapsed' : ''),
          'data-group': key
        }, headTd);
        bodyChildren.push(groupTr);
        if (!isCollapsed) {
          groupRows.forEach(function (r) { bodyChildren.push(buildRow(r)); });
        }
      });
    } else {
      rows.forEach(function (r) { bodyChildren.push(buildRow(r)); });
    }

    var tbody = el('tbody', null, bodyChildren);
    var wrap = el('div', { class: 'table-wrap' });
    wrap.appendChild(el('table', { class: 'rows' + (anyPlaylist ? ' rows-grouped' : ''), }, thead, tbody));
    return wrap;
  }

  // Lightweight CSS.escape polyfill — we only need it for ULIDs which are
  // alphanumeric, but a robust escape lets us survive the (currently
  // theoretical) case where someone pastes an id with quotes or hyphens.
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return '\\' + c;
    });
  }

  // Render an inline rating control directly in a table cell. Click any
  // star to commit that rating; click the currently-set star again to
  // clear the rating. No edit-mode round-trip — feels native.
  function renderInlineRating(value, t, onCommit) {
    var max = t.max || 5;
    var current = Math.max(t.min || 0, Math.min(max, Number(value) || 0));
    var wrap = el('span', { class: 'stars stars-inline' });
    function paint() {
      wrap.replaceChildren();
      for (var i = 1; i <= max; i++) {
        (function (val) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'star-btn star-btn-inline' + (val <= current ? ' on' : '');
          btn.title = val + ' / ' + max + (val === current ? ' (click to clear)' : '');
          btn.setAttribute('aria-label', 'Rate ' + val + ' of ' + max);
          var ic = document.createElement('i');
          ic.setAttribute('data-lucide', 'star');
          btn.appendChild(ic);
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            // Click the currently-set rank to clear; otherwise set to it.
            var next = (val === current) ? '' : String(val);
            var parsed = next === '' ? 0 : Number(next);
            if (parsed === current) return;
            current = parsed;
            paint();
            Promise.resolve(onCommit(next)).catch(function (err) {
              console.warn('[Minerva rating]', err);
            });
          });
          wrap.appendChild(btn);
        })(i);
      }
      if (window.lucide && window.lucide.createIcons) {
        try { window.lucide.createIcons(); } catch (e) { /* ignore */ }
      }
    }
    paint();
    return wrap;
  }

  // Per-row "Save offline" toggle. Reads existing offline blob to decide
  // its label/state. Click Save → file picker; click Saved → confirm
  // remove. Click Watch → opens preview with blob URL when offline.
  function renderOfflineButton(tab, row, refresh) {
    var wrap = el('span', { class: 'offline-actions' });
    function paint() {
      wrap.replaceChildren();
      M.db.getVideo(tab, row.id).then(function (rec) {
        wrap.replaceChildren();
        if (rec && rec.blob) {
          var sizeMB = rec.blob.size ? (rec.blob.size / (1024 * 1024)).toFixed(1) : '?';
          var watchBtn = el('button', {
            class: 'btn btn-ghost offline-watch',
            type: 'button',
            title: 'Play the locally-saved file (' + sizeMB + ' MB)',
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              playOfflineBlob(rec, row);
            }
          });
          watchBtn.appendChild(M.render.icon('play-circle'));
          watchBtn.appendChild(document.createTextNode(' Offline'));
          var rmBtn = el('button', {
            class: 'icon-btn offline-remove',
            type: 'button',
            title: 'Remove the local copy (' + sizeMB + ' MB)',
            'aria-label': 'Remove offline copy',
            onclick: async function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (!confirm('Remove the local copy of this video?')) return;
              await M.db.deleteVideo(tab, row.id);
              if (row.offline) {
                pushUndo({ kind: 'edit', tab: tab, rowId: row.id, field: 'offline', prevValue: row.offline });
                row.offline = '';
                row._updated = new Date().toISOString();
                row._dirty = 1;
                await M.db.upsertRow(tab, row);
                schedulePush();
              }
              if (refresh) refresh();
            }
          });
          rmBtn.appendChild(M.render.icon('trash-2'));
          wrap.appendChild(watchBtn);
          wrap.appendChild(rmBtn);
        } else {
          var cfgRO = readConfig();
          var ytDlpOk = !!(cfgRO.ytDlpServer || '').trim();
          var cobaltOk = !!(cfgRO.cobaltEndpoint || '').trim();
          // Click-handler routing precedence:
          //   1. yt-dlp server endpoint, when configured.
          //   2. Cobalt endpoint, when configured.
          //   3. Clipboard write of an equivalent yt-dlp command.
          // Shift-click opens the full options modal regardless of
          // which path would otherwise run.
          var saveBtn = el('button', {
            class: 'btn btn-ghost offline-save',
            type: 'button',
            title: ytDlpOk
              ? 'Download via your yt-dlp server (shift-click for options)'
              : (cobaltOk
                ? 'Download via Cobalt (shift-click for options)'
                : 'Copy yt-dlp command (shift-click for options — set up a yt-dlp server for one-click downloads)'),
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) {
                showOfflineSetupDialog(tab, row, refresh);
                return;
              }
              if (ytDlpOk && row.url) {
                downloadOfflineViaYtDlp(tab, row, refresh);
                return;
              }
              if (cobaltOk && row.url) {
                downloadOfflineViaCobalt(tab, row, refresh);
                return;
              }
              copyYtDlpCommand(row.url || '');
            }
          });
          saveBtn.appendChild(M.render.icon('download'));
          saveBtn.appendChild(document.createTextNode(' Download'));
          wrap.appendChild(saveBtn);
          // Secondary upload button — always available, both when Cobalt
          // is and isn't configured. The user already has a local copy or
          // Cobalt is down, this is the escape hatch.
          var uploadBtn = el('button', {
            class: 'icon-btn offline-upload',
            type: 'button',
            title: 'Upload an existing local video file instead',
            'aria-label': 'Upload local video',
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              pickAndSaveOfflineFile(tab, row, refresh);
            }
          });
          uploadBtn.appendChild(M.render.icon('upload'));
          wrap.appendChild(uploadBtn);
        }
      }).catch(function () { /* db not yet open is fine */ });
    }
    paint();
    return wrap;
  }

  // Construct a yt-dlp invocation using the configured format and
  // write it to the clipboard. Returns silently; callers surface a
  // toast independently. No modal, no setup wizard.
  function buildYtDlpCommand(url, fmt) {
    fmt = fmt || (readConfig().ytDlpFormat || 'mp4');
    var parts = ['yt-dlp'];
    if (fmt === 'mp3') parts.push('-x', '--audio-format', 'mp3');
    else if (fmt === 'bestaudio') parts.push('-x');
    else if (fmt === 'mp4') parts.push('-f', 'mp4');
    else parts.push('-f', JSON.stringify(fmt));
    parts.push(JSON.stringify(url));
    return parts.join(' ');
  }
  async function copyYtDlpCommand(url) {
    if (!url) {
      flash(document.body, 'No URL on this row to download.', 'error');
      return;
    }
    var cmd = buildYtDlpCommand(url);
    try {
      await navigator.clipboard.writeText(cmd);
      flash(document.body, 'yt-dlp command copied — paste in your terminal, then click ⬆ Upload to attach the file.');
    } catch (e) {
      // Clipboard API blocked (insecure context, permissions). Fall back
      // to opening the modal so the user can still copy manually.
      flash(document.body, 'Couldn\'t auto-copy. Opening options…', 'error');
    }
  }

  // Modal offering three download paths in priority order:
  //   1. yt-dlp — copies a ready-to-paste command. Best for power users
  //      who already have it; no API, no server, no extension.
  //   2. Cobalt — one-click download via a Cobalt instance (self-hosted
  //      or public). Requires endpoint setup in Settings.
  //   3. Upload — pick an existing local file you downloaded yourself.
  function showOfflineSetupDialog(tab, row, refresh) {
    if (document.querySelector('.offline-setup-overlay')) return;
    var overlay = el('div', { class: 'modal-overlay offline-setup-overlay',
      onclick: function () { overlay.remove(); }
    });

    var url = row.url || '';
    var ytDlpFormat = (readConfig().ytDlpFormat || 'mp4').trim();
    var formatSelect = document.createElement('select');
    formatSelect.className = 'editor editor-select';
    [
      { v: 'mp4',                              label: 'mp4 (default)' },
      { v: 'best',                             label: 'best (any format)' },
      { v: 'bestvideo+bestaudio/best',         label: 'best video + audio (merge)' },
      { v: 'bestaudio',                        label: 'audio only (m4a/opus)' },
      { v: 'mp3',                              label: 'audio → mp3' }
    ].forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.v;
      o.textContent = f.label;
      if (f.v === ytDlpFormat) o.selected = true;
      formatSelect.appendChild(o);
    });

    function buildYtDlpCmd() {
      var fmt = formatSelect.value;
      // Audio-only shortcuts use -x; video formats use -f.
      var parts = ['yt-dlp'];
      if (fmt === 'mp3') {
        parts.push('-x', '--audio-format', 'mp3');
      } else if (fmt === 'bestaudio') {
        parts.push('-x');
      } else if (fmt === 'mp4') {
        parts.push('-f', 'mp4');
      } else {
        parts.push('-f', JSON.stringify(fmt));
      }
      parts.push(JSON.stringify(url));
      return parts.join(' ');
    }

    var cmdField = document.createElement('input');
    cmdField.type = 'text';
    cmdField.readOnly = true;
    cmdField.className = 'editor offline-ytdlp-cmd';
    cmdField.value = buildYtDlpCmd();
    cmdField.addEventListener('focus', function () { cmdField.select(); });

    formatSelect.addEventListener('change', function () {
      cmdField.value = buildYtDlpCmd();
      writeConfig({ ytDlpFormat: formatSelect.value });
    });

    var copyBtn = el('button', { class: 'btn', type: 'button',
      onclick: async function () {
        try {
          await navigator.clipboard.writeText(cmdField.value);
          flash(panel, 'Command copied — paste it in your terminal.');
        } catch (e) {
          cmdField.focus(); cmdField.select();
          flash(panel, 'Couldn\'t auto-copy — selected the text instead.', 'error');
        }
      }
    });
    copyBtn.appendChild(M.render.icon('clipboard'));
    copyBtn.appendChild(document.createTextNode(' Copy yt-dlp command'));

    var dcfg = readConfig();
    var ytDlpOk = !!(dcfg.ytDlpServer || '').trim();
    var cobaltOk = !!(dcfg.cobaltEndpoint || '').trim();

    var panel = el('div', { class: 'modal-panel offline-setup-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Download for offline playback'),
      el('p', { class: 'small muted' },
        'Browsers can\'t fetch YouTube directly (CORS). Pick a path below — yt-dlp server is the most direct.'
      ),

      el('div', { class: 'offline-method' },
        el('h4', null, '1 · ', M.render.icon('server'),
          ytDlpOk ? ' yt-dlp server — ready' : ' yt-dlp server (recommended)'),
        el('p', { class: 'small muted' },
          ytDlpOk
            ? ('Configured at ' + (dcfg.ytDlpServer || '') + '. Click below for a one-shot download.')
            : 'Run a tiny Python server on your machine (see docs/minerva-services.py), set its URL in Settings, and Minerva will POST the video URL → server runs yt-dlp → file streams back into offline storage. No API needed.'
        ),
        ytDlpOk
          ? el('button', { class: 'btn', type: 'button',
              onclick: function () {
                overlay.remove();
                downloadOfflineViaYtDlp(tab, row, refresh);
              }
            }, M.render.icon('download'), ' Download via yt-dlp server')
          : el('a', { class: 'btn btn-ghost', href: '#/settings',
              onclick: function () { overlay.remove(); }
            }, M.render.icon('settings'), ' Set up yt-dlp server')
      ),

      el('div', { class: 'offline-method' },
        el('h4', null, '2 · ', M.render.icon('terminal'), ' yt-dlp command (manual)'),
        el('p', { class: 'small muted' },
          'Don\'t want to run a server? Copy the command, paste in your terminal, then ',
          el('em', null, 'Upload local file'),
          ' below.'
        ),
        el('div', { class: 'offline-ytdlp-row' },
          el('label', { class: 'small muted' }, 'Format'),
          formatSelect
        ),
        el('div', { class: 'offline-ytdlp-row' },
          cmdField,
          copyBtn
        )
      ),

      el('div', { class: 'offline-method' },
        el('h4', null, '3 · ', M.render.icon('cloud-download'),
          cobaltOk ? ' Cobalt — ready' : ' Cobalt (alternative)'),
        el('p', { class: 'small muted' },
          cobaltOk
            ? 'Endpoint configured. Click below to download via Cobalt.'
            : 'Alternative one-click download via a self-hosted or public Cobalt instance.'
        ),
        cobaltOk
          ? el('button', { class: 'btn', type: 'button',
              onclick: function () {
                overlay.remove();
                downloadOfflineViaCobalt(tab, row, refresh);
              }
            }, M.render.icon('cloud-download'), ' Download via Cobalt')
          : el('a', { class: 'btn btn-ghost', href: '#/settings',
              onclick: function () { overlay.remove(); }
            }, M.render.icon('settings'), ' Set up Cobalt')
      ),

      el('div', { class: 'offline-method' },
        el('h4', null, '4 · ', M.render.icon('upload'), ' Upload local file'),
        el('p', { class: 'small muted' },
          'Already have the video on disk? Attach it directly.'
        ),
        el('button', { class: 'btn btn-ghost', type: 'button',
          onclick: function () {
            overlay.remove();
            pickAndSaveOfflineFile(tab, row, refresh);
          }
        }, M.render.icon('upload'), ' Pick a local file')
      ),

      el('div', { class: 'form-actions' },
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: function () { overlay.remove(); }
        }, 'Close')
      )
    );

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    if (window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch (e) { /* ignore */ }
    }
  }

  function pickAndSaveOfflineFile(tab, row, refresh) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mp4,.webm,.mkv,.mov';
    input.style.display = 'none';
    input.addEventListener('change', async function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      // Soft cap — IndexedDB blobs work but multi-GB stores fight quota.
      if (file.size > 2 * 1024 * 1024 * 1024) {
        if (!confirm('This file is ' + (file.size / 1e9).toFixed(1) + ' GB. Saving very large videos can hit your browser\'s storage quota. Continue?')) return;
      }
      try {
        await M.db.putVideo(tab, row.id, {
          blob: file,
          name: file.name,
          mime: file.type || 'video/mp4',
          size: file.size
        });
        // Mirror a tiny breadcrumb to the offline column so the spreadsheet
        // reflects which rows are saved (the blob itself stays local).
        var meta = await M.db.getMeta(tab);
        if (meta && (meta.headers || []).indexOf('offline') >= 0) {
          pushUndo({ kind: 'edit', tab: tab, rowId: row.id, field: 'offline', prevValue: row.offline });
          row.offline = 'local · ' + (file.size ? (file.size / (1024 * 1024)).toFixed(1) + ' MB' : 'saved');
          row._updated = new Date().toISOString();
          row._dirty = 1;
          await M.db.upsertRow(tab, row);
          schedulePush();
        }
        flash(document.body, 'Saved offline: ' + file.name);
        if (refresh) await refresh();
      } catch (err) {
        flash(document.body, 'Save failed: ' + (err && err.message ? err.message : err), 'error');
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  function playOfflineBlob(rec, row) {
    if (!rec || !rec.blob) return;
    var url = URL.createObjectURL(rec.blob);
    if (M.preview && M.preview.showVideoBlob) {
      M.preview.showVideoBlob({
        url: url,
        title: row.title || row.name || rec.name || 'Offline video',
        sourceUrl: row.url || ''
      });
      return;
    }
    // Fallback: open directly in a new tab.
    window.open(url, '_blank');
  }

  // ---- Cobalt downloader -------------------------------------------
  //
  // Calls a Cobalt API instance (https://github.com/imputnet/cobalt) to
  // resolve a YouTube URL to a CORS-safe download URL, then streams the
  // bytes into IndexedDB as a Blob. Cobalt v10 protocol:
  //   POST {endpoint}/    (some hosts accept /api/json — we send to /)
  //   {
  //     "url":           "<youtube url>",
  //     "downloadMode":  "auto" | "audio" | "mute",
  //     "videoQuality":  "144" | "240" | ... | "max",
  //     "filenameStyle": "classic"
  //   }
  // Response: { "status": "tunnel" | "redirect" | "error" | "picker", "url": "..." }
  // Tunnel URLs sit on Cobalt's own server and DO send CORS headers,
  // so the browser can fetch them as Blobs. Redirect URLs go to
  // googlevideo.com which doesn't allow CORS — those fail in browsers
  // and we surface a clear error.
  async function callCobalt(endpoint, apiKey, payload) {
    var base = String(endpoint || '').replace(/\/+$/, '');
    if (!base) throw new Error('Cobalt endpoint not configured');
    var headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Api-Key ' + apiKey;
    var resp = await fetch(base + '/', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    var data;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      var msg = (data && (data.error && data.error.code || data.text)) || ('HTTP ' + resp.status);
      throw new Error('Cobalt: ' + msg);
    }
    if (!data) throw new Error('Cobalt returned non-JSON');
    if (data.status === 'error') {
      throw new Error('Cobalt: ' + ((data.error && data.error.code) || data.text || 'unknown error'));
    }
    if (data.status === 'rate-limit') throw new Error('Cobalt rate-limited — wait or use a different instance');
    if (data.status === 'picker') throw new Error('Cobalt returned a picker (multi-stream); not supported here yet');
    if (data.status !== 'tunnel' && data.status !== 'redirect') {
      throw new Error('Cobalt status: ' + data.status);
    }
    return data;
  }

  async function fetchAsBlobWithProgress(url, onProgress) {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Download HTTP ' + resp.status);
    var total = parseInt(resp.headers.get('Content-Length') || '0', 10) || 0;
    if (!resp.body || !resp.body.getReader) {
      // No streaming support — just fetch the whole blob.
      return resp.blob();
    }
    var reader = resp.body.getReader();
    var chunks = [];
    var received = 0;
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (onProgress) {
        try { onProgress(received, total); } catch (e) {}
      }
    }
    return new Blob(chunks, { type: resp.headers.get('Content-Type') || 'video/mp4' });
  }

  // Stream a download from a user-run yt-dlp HTTP wrapper. Protocol:
  //   POST <server>/download  Content-Type: application/json
  //   body: { url, format }     where format mirrors yt-dlp's -f (mp4,
  //                             best, mp3, etc.)
  //   200 OK with the raw video bytes streamed back. Filename comes
  //   from the optional Content-Disposition header.
  // The reference Flask server in docs/minerva-services.py implements this.
  // Multi-job downloads tray. Stacks one card per concurrent download
  // bottom-right; each card has its own progress bar + status. Success
  // cards auto-dismiss after 4 s (12 s when an action button is
  // attached). Failure cards persist until explicitly dismissed.
  function getDownloadsTray() {
    var tray = document.querySelector('.downloads-tray');
    if (tray) return tray;
    tray = el('div', { class: 'downloads-tray', role: 'region', 'aria-label': 'Downloads' });
    var head = el('div', { class: 'downloads-tray-head' });
    var label = el('span', { class: 'downloads-tray-label' }, 'Downloads');
    var count = el('span', { class: 'downloads-tray-count small muted' }, '');
    var clearBtn = el('button', { class: 'btn btn-ghost btn-inline downloads-tray-clear', type: 'button',
      title: 'Dismiss every job in the tray',
      'aria-label': 'Clear downloads',
      onclick: function () {
        var body = tray.querySelector('.downloads-tray-body');
        if (!body) return;
        while (body.firstChild) body.removeChild(body.firstChild);
        refreshDownloadsCount(tray);
      }
    }, 'Clear');
    var minBtn = el('button', { class: 'icon-btn downloads-tray-min', type: 'button',
      title: 'Minimize',
      'aria-label': 'Toggle downloads tray',
      onclick: function () {
        var collapsed = tray.classList.toggle('is-collapsed');
        minBtn.title = collapsed ? 'Expand' : 'Minimize';
      }
    }, '–');
    head.appendChild(label);
    head.appendChild(count);
    head.appendChild(clearBtn);
    head.appendChild(minBtn);
    tray.appendChild(head);
    var body = el('div', { class: 'downloads-tray-body' });
    tray.appendChild(body);
    document.body.appendChild(tray);
    return tray;
  }
  function refreshDownloadsCount(tray) {
    var body = tray.querySelector('.downloads-tray-body');
    var count = tray.querySelector('.downloads-tray-count');
    var n = body ? body.querySelectorAll('.dl-job').length : 0;
    if (count) count.textContent = n + ' job' + (n === 1 ? '' : 's');
    if (n === 0) tray.classList.add('is-empty');
    else tray.classList.remove('is-empty');
  }
  // Aggregate progress card for bulk / playlist downloads. Sits at
  // the top of the downloads tray and tracks N total + X completed
  // (+ E errored) so the user can see "12 / 50 done" without
  // counting individual job cards.
  function addBulkDownloadJob(total, title) {
    var tray = getDownloadsTray();
    var trayBody = tray.querySelector('.downloads-tray-body') || tray;
    var card = el('div', { class: 'dl-job dl-job-bulk is-running' },
      el('div', { class: 'dl-job-head' },
        el('span', { class: 'dl-job-title' }, title || 'Bulk download'),
        el('button', { class: 'icon-btn dl-job-close', type: 'button',
          title: 'Dismiss',
          onclick: function () { try { card.remove(); refreshDownloadsCount(tray); } catch (e) {} }
        }, '×')
      ),
      el('div', { class: 'dl-job-status small muted' }, '0 / ' + total + ' done'),
      el('div', { class: 'dl-job-bar' }, el('span', { class: 'dl-job-fill' }))
    );
    // Pin to the top of the tray (most-recent-first body uses
    // column-reverse, so prepending = visually on top).
    if (trayBody.firstChild) trayBody.insertBefore(card, trayBody.firstChild);
    else trayBody.appendChild(card);
    refreshDownloadsCount(tray);
    if (M.render && M.render.refreshIcons) M.render.refreshIcons();
    var statusEl = card.querySelector('.dl-job-status');
    var fillEl = card.querySelector('.dl-job-fill');
    var ok = 0, fail = 0;
    function paint() {
      var done = ok + fail;
      var pct = total > 0 ? Math.round(100 * done / total) : 0;
      fillEl.style.width = pct + '%';
      statusEl.textContent = done + ' / ' + total + ' done'
        + (fail ? ' (' + fail + ' failed)' : '');
    }
    paint();
    return {
      tick: function (succeeded) {
        if (succeeded) ok++; else fail++;
        paint();
      },
      done: function () {
        card.classList.remove('is-running');
        card.classList.add(fail ? 'is-error' : 'is-done');
        statusEl.textContent = (ok + fail) + ' / ' + total + ' done'
          + (fail ? ' (' + fail + ' failed)' : '');
        // Auto-dismiss success-only batches; keep error batches up
        // so the user can read the count.
        if (!fail) {
          setTimeout(function () {
            try { card.remove(); } catch (e) {}
            refreshDownloadsCount(tray);
          }, 6000);
        }
      }
    };
  }

  function addDownloadJob(opts) {
    var tray = getDownloadsTray();
    var trayBody = tray.querySelector('.downloads-tray-body') || tray;
    var title = (opts && opts.title) || 'Downloading';
    var card = el('div', { class: 'dl-job is-running' },
      el('div', { class: 'dl-job-head' },
        el('span', { class: 'dl-job-title' }, title),
        el('button', { class: 'icon-btn dl-job-close', type: 'button',
          title: 'Dismiss',
          onclick: function () { try { card.remove(); refreshDownloadsCount(tray); } catch (e) {} }
        }, '×')
      ),
      el('div', { class: 'dl-job-status small muted' }, 'Starting…'),
      el('div', { class: 'dl-job-bar' }, el('span', { class: 'dl-job-fill' }))
    );
    trayBody.appendChild(card);
    refreshDownloadsCount(tray);
    if (M.render && M.render.refreshIcons) M.render.refreshIcons();
    var statusEl = card.querySelector('.dl-job-status');
    var fillEl = card.querySelector('.dl-job-fill');
    return {
      el: card,
      setStatus: function (text) { statusEl.textContent = text; },
      setProgress: function (received, total) {
        if (total > 0) {
          var pct = Math.round(100 * received / total);
          fillEl.style.width = pct + '%';
          statusEl.textContent = pct + '% · '
            + (received / (1024*1024)).toFixed(1) + ' / '
            + (total / (1024*1024)).toFixed(1) + ' MB';
        } else {
          statusEl.textContent = (received / (1024*1024)).toFixed(1) + ' MB';
        }
      },
      done: function (text, action) {
        card.classList.remove('is-running');
        card.classList.add('is-done');
        fillEl.style.width = '100%';
        statusEl.textContent = text || 'Done';
        if (action) {
          var btn = el('button', { class: 'btn dl-job-action', type: 'button',
            onclick: function () { try { action.run(); } catch (e) {} card.remove(); }
          }, M.render.icon(action.icon || 'play'), ' ' + action.label);
          card.appendChild(btn);
          if (M.render && M.render.refreshIcons) M.render.refreshIcons();
        }
        setTimeout(function () {
          if (card.classList.contains('is-done')) {
            try { card.remove(); } catch (e) {}
            refreshDownloadsCount(tray);
          }
        }, action ? 12000 : 4000);
      },
      fail: function (text) {
        card.classList.remove('is-running');
        card.classList.add('is-error');
        statusEl.textContent = text;
        // Surface a Retry button when the caller supplied a retry
        // function in addDownloadJob({retry: fn}). Clicking it removes
        // the failed card and re-runs the original async work, so a
        // transient yt-dlp / network failure doesn't force the user
        // to find the source row and click Download again.
        if (typeof opts.retry === 'function' && !card.querySelector('.dl-job-retry')) {
          var retryBtn = el('button', {
            class: 'btn dl-job-action dl-job-retry', type: 'button',
            onclick: function () {
              try { card.remove(); refreshDownloadsCount(tray); } catch (e) {}
              try { opts.retry(); } catch (e) {}
            }
          }, M.render.icon('refresh-cw'), ' Retry');
          card.appendChild(retryBtn);
          if (M.render && M.render.refreshIcons) M.render.refreshIcons();
        }
      }
    };
  }

  // Fetch a paper PDF and upload it to Drive. Tries direct fetch
  // first; falls back to the configured CORS proxy on failure (arXiv
  // PDFs typically lack CORS headers). Returns the resulting Drive
  // fileId on success, '' on any failure.
  async function uploadPaperPdfToDrive(pdfUrl, suggestedName) {
    if (!pdfUrl) return '';
    var resp;
    try {
      resp = await fetch(pdfUrl);
      if (!resp.ok) throw new Error('direct ' + resp.status);
    } catch (e) {
      var prefix = (readConfig().corsProxy || '').trim();
      if (!prefix) throw new Error('PDF fetch blocked by CORS and no proxy configured');
      resp = await fetch(prefix + encodeURIComponent(pdfUrl));
      if (!resp.ok) throw new Error('proxy ' + resp.status);
    }
    var blob = await resp.blob();
    var name = String(suggestedName || 'paper').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return await uploadOfflineToDrive(blob, name);
  }

  // Optional secondary upload of an offline blob to Drive. Idempotent
  // by name within a "Minerva offline" folder; failure is non-fatal
  // (the blob is already saved locally so playback still works).
  // Returns the Drive fileId on success, '' otherwise.
  async function uploadOfflineToDrive(blob, filename) {
    if (!M.auth || !M.sheets) return '';
    var c = readConfig();
    if (!c.clientId) return '';
    try {
      var token = await M.auth.getToken(c.clientId);
      var blobBytes = await blob.arrayBuffer();
      // Convert to base64 for the multipart upload (uploadDriveFile
      // expects a string body). Use chunked btoa to avoid call-stack
      // overflow on large blobs.
      var bytes = new Uint8Array(blobBytes);
      var chunks = [];
      var CHUNK = 0x8000;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
      }
      // Drive's multipart upload accepts raw bytes too, but the
      // existing helper concatenates strings. Use the lighter
      // resumable upload path inline to avoid corrupting binary
      // content via String.fromCharCode round-tripping.
      var initResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': blob.type || 'video/mp4',
          'X-Upload-Content-Length': String(blob.size)
        },
        body: JSON.stringify({ name: filename })
      });
      if (!initResp.ok) {
        console.warn('[Minerva drive-upload-init]', initResp.status);
        return '';
      }
      var sessionUri = initResp.headers.get('Location');
      if (!sessionUri) return '';
      var uploadResp = await fetch(sessionUri, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'video/mp4' },
        body: blob
      });
      if (!uploadResp.ok) {
        console.warn('[Minerva drive-upload-put]', uploadResp.status);
        return '';
      }
      var data = await uploadResp.json().catch(function () { return null; });
      return (data && data.id) || '';
    } catch (e) {
      console.warn('[Minerva drive-upload]', e);
      return '';
    }
  }

  // Shared "mirror this paper PDF to Drive" entry point. Every caller
  // that used to invoke downloadOfflineViaYtDlp on a paper-shaped URL
  // (table action, bulk grid action, kebab menu, keyboard shortcut)
  // now lands here when the URL looks like a paper, so the user
  // never sees yt-dlp's "Unsupported URL" again. Writes drive:<fileId>
  // back into row.offline so the next preview opens via the Drive
  // blob loader instead of trying to iframe arxiv.
  async function mirrorPaperRowToDrive(tab, row, refresh) {
    var rawUrl = String(row.url || '').trim();
    if (!rawUrl) {
      flash(document.body, 'No URL on this row to mirror.', 'error');
      return;
    }
    // Idempotency: if the row already has a drive:<fileId> breadcrumb,
    // don't re-upload. Tell the user it's already mirrored and surface
    // an "Open in Drive" affordance via flash. Same row's repeated
    // click otherwise produces duplicate Drive files.
    var existingMatch = String(row.offline || '').match(/drive:([\w-]{20,})/);
    if (existingMatch) {
      flash(document.body,
        'Already mirrored to Drive. Open the preview to read it.', 'ok');
      return existingMatch[1];
    }
    // Resolve to an actual PDF URL: prefer row.pdf when present,
    // otherwise translate arxiv abs → pdf so the fetch returns the
    // PDF bytes rather than the HTML abstract page.
    var pdfUrl = String(row.pdf || '').trim() || (function () {
      if (/arxiv\.org\/abs\//i.test(rawUrl)) {
        return rawUrl.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
      }
      return rawUrl;
    })();
    var job = addDownloadJob({
      title: row.title || row.id || 'PDF',
      retry: function () { mirrorPaperRowToDrive(tab, row, refresh); }
    });
    try {
      job.setStatus('Fetching PDF…');
      var fid = await uploadPaperPdfToDrive(pdfUrl, row.title || row.id);
      if (!fid) throw new Error('Drive upload returned no fileId.');
      var meta = await M.db.getMeta(tab);
      if (meta && (meta.headers || []).indexOf('offline') >= 0) {
        var fresh = await M.db.getRow(tab, row.id);
        if (fresh) {
          fresh.offline = 'drive:' + fid;
          fresh._dirty = 1;
          fresh._updated = new Date().toISOString();
          await M.db.upsertRow(tab, fresh);
          schedulePush();
        }
      }
      job.done('Mirrored to Drive', {
        label: 'Open',
        icon: 'cloud',
        run: function () {
          window.open(
            'https://drive.google.com/file/d/' + encodeURIComponent(fid) + '/view',
            '_blank', 'noopener'
          );
        }
      });
      if (refresh) await refresh();
    } catch (err) {
      job.fail('PDF mirror failed: ' + (err && err.message || err));
    }
  }

  // Persistent download queue. Each tile-click / bulk download
  // appends an intent here; if the page reloads mid-download, boot()
  // re-runs unfinished entries against the same row. The queue is
  // strictly localStorage state — IDB / Sheets are the source of
  // truth for what's actually saved. No partial-byte resume (yt-dlp
  // doesn't expose Range support today); instead we re-fetch from
  // scratch, which is fast enough for the typical 10–100 MB videos.
  var DOWNLOAD_QUEUE_KEY = 'minerva.downloadQueue.v1';
  function readDownloadQueue() {
    try { return JSON.parse(localStorage.getItem(DOWNLOAD_QUEUE_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function writeDownloadQueue(q) {
    try { localStorage.setItem(DOWNLOAD_QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }
  function enqueueDownloadIntent(tab, rowId, url) {
    var q = readDownloadQueue();
    // Drop any prior intent for the same tab+rowId so re-queue stays
    // idempotent if the user clicks Download twice.
    q = q.filter(function (e) { return !(e.tab === tab && e.rowId === rowId); });
    q.push({ tab: tab, rowId: rowId, url: url, status: 'inflight', at: Date.now() });
    writeDownloadQueue(q);
  }
  function markDownloadIntent(tab, rowId, status) {
    var q = readDownloadQueue();
    var changed = false;
    q = q.map(function (e) {
      if (e.tab === tab && e.rowId === rowId) {
        changed = true;
        return Object.assign({}, e, { status: status, updatedAt: Date.now() });
      }
      return e;
    });
    if (status === 'done') {
      q = q.filter(function (e) { return !(e.tab === tab && e.rowId === rowId); });
    } else {
      // Garbage-collect ancient entries (>24h, regardless of status).
      var cutoff = Date.now() - 24 * 3600 * 1000;
      q = q.filter(function (e) { return (e.updatedAt || e.at || 0) > cutoff; });
    }
    if (changed) writeDownloadQueue(q);
  }
  async function resumePendingDownloads() {
    var q = readDownloadQueue();
    if (!q.length) return;
    // Filter to genuinely pending entries (anything that didn't
    // reach 'done' before the page closed).
    var pending = q.filter(function (e) {
      return e.status === 'inflight' || e.status === 'queued' || e.status === 'error';
    });
    if (!pending.length) return;
    flash(document.body, 'Resuming ' + pending.length + ' interrupted download'
      + (pending.length === 1 ? '' : 's') + '…');
    for (var i = 0; i < pending.length; i++) {
      var intent = pending[i];
      try {
        var row = await M.db.getRow(intent.tab, intent.rowId);
        if (!row || row._deleted) {
          markDownloadIntent(intent.tab, intent.rowId, 'done');
          continue;
        }
        // If the row already has an offline marker, treat as done —
        // the previous run finished even though the queue didn't.
        if (String(row.offline || '').trim()) {
          markDownloadIntent(intent.tab, intent.rowId, 'done');
          continue;
        }
        await downloadOfflineViaYtDlp(intent.tab, row, null);
      } catch (e) {
        console.warn('[Minerva resume]', e);
      }
    }
  }

  async function downloadOfflineViaYtDlp(tab, row, refresh) {
    if (!row.url) {
      flash(document.body, 'No URL on this row to download.', 'error');
      return;
    }
    // Persist the intent before starting so a refresh mid-download
    // can pick up where this left off via resumePendingDownloads().
    enqueueDownloadIntent(tab, row.id, row.url);
    // Hand-off to the paper PDF mirror when the row's URL looks like
    // a paper (.pdf, arxiv abs/pdf, doi.org). yt-dlp can't ingest
    // arxiv abs URLs and returns "Unsupported URL: ..." with HTTP 500
    // — every caller of this function (table action, bulk download,
    // keyboard shortcut, kebab menu) used to fall into that trap.
    // Routing centrally so every entry-point inherits the fix.
    var paperUrl = String(row.url || '').trim();
    var looksLikePaper = /\.pdf(\?|#|$)/i.test(paperUrl)
      || /arxiv\.org\/(?:abs|pdf)\//i.test(paperUrl)
      || /doi\.org\//i.test(paperUrl);
    if (looksLikePaper) {
      return await mirrorPaperRowToDrive(tab, row, refresh);
    }
    // Skip when an offline blob is already cached for this row. Users
    // remove the blob explicitly via the row's trash icon (or the bulk
    // "Remove offline" action) before re-downloading.
    var alreadyHave = await M.db.getVideo(tab, row.id).catch(function () { return null; });
    if (alreadyHave && alreadyHave.blob) {
      if (refresh !== null) {
        flash(document.body,
          'Already saved offline (' + (alreadyHave.blob.size / (1024*1024)).toFixed(1)
          + ' MB). Remove the existing copy first if you want to re-download.');
      }
      return;
    }
    var cfg = readConfig();
    var endpoint = String(cfg.ytDlpServer || '').trim().replace(/\/+$/, '');
    if (!endpoint) {
      flash(document.body, 'Set a yt-dlp server URL in Settings first.', 'error');
      return;
    }
    var fmt = cfg.ytDlpFormat || 'mp4';
    var job = addDownloadJob({
      title: row.title || row.url,
      retry: function () { downloadOfflineViaYtDlp(tab, row, refresh); }
    });
    job.setStatus('Asking yt-dlp server…');

    try {
      var resp = await fetch(endpoint + '/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: row.url, format: fmt })
      });
      if (!resp.ok) {
        var body = await resp.text().catch(function () { return ''; });
        throw new Error('server ' + resp.status + (body ? ': ' + body.slice(0, 200) : ''));
      }
      job.setStatus('Downloading…');
      var total = parseInt(resp.headers.get('Content-Length') || '0', 10) || 0;
      var disposition = resp.headers.get('Content-Disposition') || '';
      var filename = (disposition.match(/filename="?([^"]+)"?/) || [])[1] || 'video.' + (fmt === 'mp3' ? 'mp3' : 'mp4');
      var contentType = resp.headers.get('Content-Type') || 'video/mp4';

      var reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      var chunks = [];
      var received = 0;
      if (reader) {
        while (true) {
          var step = await reader.read();
          if (step.done) break;
          chunks.push(step.value);
          received += step.value.length;
          job.setProgress(received, total);
        }
      } else {
        // No streaming — load whole blob.
        var direct = await resp.blob();
        chunks = [direct];
        received = direct.size;
      }
      var blob = new Blob(chunks, { type: contentType });

      job.setStatus('Saving locally…');
      var hostPath = '';
      var idbStored = false;
      try {
        await M.db.putVideo(tab, row.id, {
          blob: blob,
          name: filename,
          mime: contentType,
          size: blob.size
        });
        idbStored = true;
      } catch (idbErr) {
        // IndexedDB has hard quotas (varies by browser; Firefox is
        // ~50% of free disk). Big videos hit them. Fall back to the
        // helper's /file/save so the download succeeds anyway —
        // user will play the file via their OS player from
        // ~/Minerva/videos.
        var quotaLike = idbErr && (idbErr.name === 'QuotaExceededError'
          || /quota/i.test(idbErr.message || ''));
        if (!quotaLike) throw idbErr;
        job.setStatus('Browser storage full — saving to ~/Minerva/videos…');
        try {
          var saveResp = await fetch(
            endpoint + '/file/save?kind=videos&name=' + encodeURIComponent(filename),
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
              body: await blob.arrayBuffer() }
          );
          var saveJson = await saveResp.json();
          if (!saveJson.ok) throw new Error(saveJson.error || ('host save ' + saveResp.status));
          hostPath = saveJson.path;
        } catch (hostErr) {
          throw new Error('Browser storage full and host save failed: '
            + (hostErr && hostErr.message || hostErr));
        }
      }
      var meta = await M.db.getMeta(tab);
      var driveFileId = '';
      if (cfg.uploadOfflineToDrive && idbStored) {
        // Skip the Drive upload when the IDB store failed — we don't
        // want to double-store a multi-GB video.
        job.setStatus('Uploading to Drive…');
        driveFileId = await uploadOfflineToDrive(blob, filename);
      }
      if (meta && (meta.headers || []).indexOf('offline') >= 0) {
        // Re-fetch the canonical row before mutating to avoid clobbering
        // any other field that might have changed since the click. Only
        // the offline column is updated; url and friends are preserved.
        var fresh = await M.db.getRow(tab, row.id);
        if (fresh && !fresh._deleted) {
          pushUndo({ kind: 'edit', tab: tab, rowId: fresh.id, field: 'offline', prevValue: fresh.offline });
          var marker = idbStored
            ? ('yt-dlp · ' + (blob.size / (1024*1024)).toFixed(1) + ' MB')
            : ('host:' + hostPath);
          if (driveFileId) marker += ' · drive:' + driveFileId;
          fresh.offline = marker;
          fresh._updated = new Date().toISOString();
          fresh._dirty = 1;
          await M.db.upsertRow(tab, fresh);
          schedulePush();
        }
      }
      job.done(
        idbStored
          ? 'Saved ' + (blob.size / (1024*1024)).toFixed(1) + ' MB'
          : 'Saved to ' + hostPath,
        idbStored ? {
          label: 'Watch offline',
          icon: 'play-circle',
          run: function () {
            M.db.getVideo(tab, row.id).then(function (rec) {
              if (rec && rec.blob && M.preview && M.preview.showVideoBlob) {
                M.preview.showVideoBlob({
                  url: URL.createObjectURL(rec.blob),
                  title: row.title || filename,
                  sourceUrl: row.url || ''
                });
              }
            }).catch(function () {});
          }
        } : null
      );
      markDownloadIntent(tab, row.id, 'done');
      if (refresh) await refresh();
    } catch (err) {
      markDownloadIntent(tab, row.id, 'error');
      var msg = (err && err.message) || String(err);
      // Map known yt-dlp failure modes to actionable messages instead
      // of dumping the raw stderr to the user. The server appends a
      // [diagnostic] block when cookies are involved (no file mounted,
      // empty file, or YouTube rejected a populated file); pull it out.
      var lower = msg.toLowerCase();
      var friendly = '';
      var diag = '';
      var diagMatch = msg.match(/\[diagnostic\][^\n]*/);
      if (diagMatch) diag = diagMatch[0];
      if (lower.indexOf('sign in to confirm') >= 0
          || lower.indexOf("you're not a bot") >= 0
          || lower.indexOf('not a bot') >= 0
          || lower.indexOf('cookies') >= 0) {
        if (diag.indexOf('live browser profile') >= 0) {
          // Live profile is in use; --refresh-cookies won't help.
          friendly = 'YouTube rejected your live browser session. Open the browser '
                   + 'on your laptop, log in to youtube.com, play any video, then retry.';
        } else if (diag.indexOf('no cookies file') >= 0) {
          friendly = 'YouTube needs cookies. Run python3 docs/minerva-services.py up '
                   + 'once on your machine — it mounts your browser into the container.';
        } else if (diag.indexOf('size=0') >= 0 || diag.indexOf('empty') >= 0) {
          friendly = 'Cookies file is empty. Run python3 docs/minerva-services.py up '
                   + 'so the helper switches to live browser-profile mode.';
        } else if (diag) {
          friendly = 'Cookies snapshot is stale. Run python3 docs/minerva-services.py up '
                   + 'to switch to live browser-profile mode (no more snapshot rot).';
        } else {
          friendly = 'YouTube is gating this video behind a sign-in check. '
                   + 'Run python3 docs/minerva-services.py up on your machine.';
        }
      } else if (lower.indexOf('failed to fetch') >= 0
              || lower.indexOf('networkerror') >= 0
              || lower.indexOf('econnrefused') >= 0) {
        friendly = 'Local helper isn\'t reachable at ' + endpoint + '. '
                 + 'Start it with: cd docs && ./minerva-up.sh';
      } else if (lower.indexOf('http 5') >= 0 || lower.indexOf('server 5') >= 0) {
        friendly = 'Helper returned an error. ' + msg.split('\n')[0];
      } else {
        friendly = 'Download failed: ' + msg.split('\n')[0];
      }
      job.fail(friendly);
    }
  }

  async function downloadOfflineViaCobalt(tab, row, refresh) {
    if (!row.url) {
      flash(document.body, 'No URL on this row to download.', 'error');
      return;
    }
    var alreadyHave = await M.db.getVideo(tab, row.id).catch(function () { return null; });
    if (alreadyHave && alreadyHave.blob) {
      if (refresh !== null) {
        flash(document.body,
          'Already saved offline (' + (alreadyHave.blob.size / (1024*1024)).toFixed(1)
          + ' MB). Remove the existing copy first if you want to re-download.');
      }
      return;
    }
    var cfg = readConfig();
    if (!cfg.cobaltEndpoint) {
      flash(document.body, 'Set a Cobalt endpoint in Settings first.', 'error');
      return;
    }
    var quality = (cfg.offlineQuality || '720');
    var job = addDownloadJob({ title: row.title || row.url });
    job.setStatus('Resolving via Cobalt…');

    try {
      var result = await callCobalt(cfg.cobaltEndpoint, cfg.cobaltApiKey, {
        url: row.url,
        downloadMode: 'auto',
        videoQuality: quality,
        filenameStyle: 'classic'
      });
      if (result.status === 'redirect') {
        // Browsers can't fetch googlevideo redirects (no CORS).
        job.fail('Cobalt returned a direct YouTube URL (CORS-blocked). Self-host Cobalt or use a tunnel-mode instance.');
        try { window.open(result.url, '_blank'); } catch (e) {}
        return;
      }
      job.setStatus('Downloading…');
      var blob = await fetchAsBlobWithProgress(result.url, function (received, total) {
        job.setProgress(received, total);
      });
      job.setStatus('Saving locally…');
      await M.db.putVideo(tab, row.id, {
        blob: blob,
        name: result.filename || 'video.mp4',
        mime: blob.type || 'video/mp4',
        size: blob.size
      });
      // Breadcrumb in the spreadsheet so other devices know it's local.
      var meta = await M.db.getMeta(tab);
      var driveFileId = '';
      if (cfg.uploadOfflineToDrive) {
        job.setStatus('Uploading to Drive…');
        driveFileId = await uploadOfflineToDrive(blob, result.filename || 'video.mp4');
      }
      if (meta && (meta.headers || []).indexOf('offline') >= 0) {
        var fresh = await M.db.getRow(tab, row.id);
        if (fresh && !fresh._deleted) {
          pushUndo({ kind: 'edit', tab: tab, rowId: fresh.id, field: 'offline', prevValue: fresh.offline });
          fresh.offline = 'cobalt · ' + (blob.size / (1024*1024)).toFixed(1) + ' MB · ' + quality + 'p'
            + (driveFileId ? ' · drive:' + driveFileId : '');
          fresh._updated = new Date().toISOString();
          fresh._dirty = 1;
          await M.db.upsertRow(tab, fresh);
          schedulePush();
        }
      }
      job.done('Saved ' + (blob.size / (1024*1024)).toFixed(1) + ' MB', {
        label: 'Watch offline',
        icon: 'play-circle',
        run: function () {
          M.db.getVideo(tab, row.id).then(function (rec) {
            if (rec && rec.blob && M.preview && M.preview.showVideoBlob) {
              M.preview.showVideoBlob({
                url: URL.createObjectURL(rec.blob),
                title: row.title || (result.filename || 'video'),
                sourceUrl: row.url || ''
              });
            }
          }).catch(function () {});
        }
      });
      if (refresh) await refresh();
    } catch (err) {
      var msg = (err && err.message) || String(err);
      job.fail('Cobalt failed: ' + msg + ' — try the upload button to pick a file manually.');
    }
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
      },
      { tab: tab, rowId: row.id, col: col.name }
    );
    td.classList.add('editing');
    td.replaceChildren(editor);
    if (typeof editor.focus === 'function') editor.focus();
    if (typeof editor.select === 'function' && editor.tagName !== 'TEXTAREA') {
      try { editor.select(); } catch (e) { /* no-op for non-text inputs */ }
    }
  }

  function viewSettings(subId) {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };

    function collectFormConfig() {
      var f = new FormData(form);
      return {
        clientId:        String(f.get('clientId') || '').trim(),
        spreadsheetId:   String(f.get('spreadsheetId') || '').trim(),
        youtubeApiKey:   String(f.get('youtubeApiKey') || '').trim(),
        cobaltEndpoint:  String(f.get('cobaltEndpoint') || '').trim(),
        cobaltApiKey:    String(f.get('cobaltApiKey') || '').trim(),
        ytDlpServer:     String(f.get('ytDlpServer') || '').trim(),
        corsProxy:       String(f.get('corsProxy') || '').trim(),
        offlineQuality:  String(f.get('offlineQuality') || '720').trim(),
        uploadOfflineToDrive: f.get('uploadOfflineToDrive') === 'on',
        uploadPapersToDrive:  f.get('uploadPapersToDrive') === 'on'
      };
    }
    var autoSaveTimer = null;
    function scheduleAutoSave() {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(function () {
        autoSaveTimer = null;
        writeConfig(collectFormConfig());
      }, 500);
    }
    var form = el('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
      writeConfig(collectFormConfig());
      flash(form, 'Saved.');
    }, oninput: scheduleAutoSave, onchange: scheduleAutoSave },
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
      fieldWithTest('YouTube API key (optional)',
        el('input', { name: 'youtubeApiKey', type: 'password',
          placeholder: 'AIza…',
          value: cfg.youtubeApiKey || '', autocomplete: 'off', spellcheck: 'false' }),
        testYoutubeApiKey,
        'Only needed for playlist imports + duration auto-fill. Create one at console.cloud.google.com → APIs & Services → Library → YouTube Data API v3 → Enable → Credentials → Create API key. Stored locally; never leaves your browser except in calls to googleapis.com.',
        { healthPath: false, canStop: false, isCredential: true }
      ),
      el('div', { class: 'docker-tip' },
        el('h4', null, M.render.icon('container'), ' Prefer Docker?'),
        el('p', { class: 'small' },
          'Run the prebuilt image — no checkout, no Python:'
        ),
        el('pre', { class: 'docker-tip-cmd' },
          'docker run -d --name minerva-services --restart unless-stopped \\\n  -p 8765:8765 thefarshad/minerva-services:latest'
        ),
        el('p', { class: 'small' },
          'Then paste ',
          el('code', null, 'http://localhost:8765'),
          ' into yt-dlp server and ',
          el('code', null, 'http://localhost:8765/proxy?'),
          ' into CORS proxy below. ',
          el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-local-services.md',
            target: '_blank', rel: 'noopener' }, 'Full guide (compose, systemd, launchd, build-from-source)'),
          '.'
        )
      ),
      fieldWithTest('yt-dlp server (recommended)',
        el('input', { name: 'ytDlpServer', type: 'url',
          placeholder: 'http://localhost:8080',
          value: cfg.ytDlpServer || '', autocomplete: 'off', spellcheck: 'false' }),
        testYtDlpServer,
        el('span', null,
          'Local Python server for one-click YouTube downloads. ',
          el('button', { type: 'button', class: 'btn btn-ghost btn-inline',
            onclick: function (e) {
              e.preventDefault();
              downloadHelperScript('docs/minerva-services.py', 'minerva-services.py',
                'Save it anywhere, then run: python3 minerva-services.py — first run creates a venv and installs Flask + yt-dlp + requests automatically. The same script also serves the CORS proxy.');
            }
          }, M.render.icon('download'), ' Download minerva-services.py'),
          ' (combined yt-dlp + CORS proxy in one script). Run with ',
          el('code', null, 'python3 minerva-services.py'),
          ' — first run creates a venv and installs deps automatically. The status pill above turns green once the server answers /health.'
        )
      ),
      fieldWithTest('Cobalt downloader endpoint (optional)',
        el('input', { name: 'cobaltEndpoint', type: 'url',
          placeholder: 'https://api.cobalt.tools/  or  https://your-cobalt.example.com/',
          value: cfg.cobaltEndpoint || '', autocomplete: 'off', spellcheck: 'false' }),
        testCobaltEndpoint,
        'Alternative one-click download path via a Cobalt instance — github.com/imputnet/cobalt. Used as a fallback when no yt-dlp server is configured.'
      ),
      field('Cobalt API key (optional)',
        el('input', { name: 'cobaltApiKey', type: 'password',
          placeholder: 'leave blank for public/self-hosted Cobalt without auth',
          value: cfg.cobaltApiKey || '', autocomplete: 'off', spellcheck: 'false' }),
        'Some self-hosted Cobalt instances require an API key (sent as the Authorization: Api-Key header). Stored locally only.'
      ),
      fieldWithTest('CORS proxy (optional)',
        el('input', { name: 'corsProxy', type: 'url',
          placeholder: 'https://corsproxy.io/?',
          value: cfg.corsProxy != null ? cfg.corsProxy : 'https://corsproxy.io/?',
          autocomplete: 'off', spellcheck: 'false' }),
        testCorsProxy,
        el('span', null,
          'Bibliographic APIs (arXiv, CrossRef) do not return CORS headers. Failed direct fetches retry through this prefix (URL-encoded target appended). Default ',
          el('code', null, 'https://corsproxy.io/?'),
          ' is a public service. To self-host, ',
          el('button', { type: 'button', class: 'btn btn-ghost btn-inline',
            onclick: function (e) {
              e.preventDefault();
              downloadHelperScript('docs/minerva-services.py', 'minerva-services.py',
                'Save it anywhere, then run: python3 minerva-services.py — it auto-creates a venv and installs Flask + yt-dlp + requests on first run, then exposes both yt-dlp and the CORS proxy on one port.');
            }
          }, M.render.icon('download'), ' download minerva-services.py'),
          ' and run ',
          el('code', null, 'python3 minerva-services.py'),
          ' (one script for both services). Leave blank to disable the fallback.'
        ),
        { healthPath: false }
      ),
      field('Offline video quality',
        (function () {
          var sel = el('select', { name: 'offlineQuality' });
          ['144','240','360','480','720','1080','1440','2160','max'].forEach(function (q) {
            var o = el('option', { value: q }, q === 'max' ? 'max (best available)' : q + 'p');
            if (q === (cfg.offlineQuality || '720')) o.setAttribute('selected', '');
            sel.appendChild(o);
          });
          return sel;
        })(),
        'Max video resolution to request from Cobalt. Higher = bigger file. 720p is a sensible default for laptop / phone playback.'
      ),
      switchField('Mirror downloads to Drive',
        'uploadOfflineToDrive',
        !!cfg.uploadOfflineToDrive,
        'When on, the per-row Download flow uploads the resulting blob to a "Minerva offline" folder in your Google Drive after saving it locally. The row\'s offline column records the Drive fileId. Counts against your Drive storage quota.'
      ),
      switchField('Mirror imported paper PDFs to Drive',
        'uploadPapersToDrive',
        !!cfg.uploadPapersToDrive,
        'When on, every URL-imported paper that resolves to a PDF (arXiv, CrossRef when available) is fetched via your CORS proxy and uploaded to Drive. Counts against your Drive quota.'
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
      // Build the children list and filter out nullish entries before
      // handing them to replaceChildren — the native DOM API
      // stringifies non-Node values, so a `null` would render as the
      // literal text "null".
      var actions = el('div', { class: 'form-actions' });
      var actionKids = [
        ok
          ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
              if (confirm('Sign out? Your spreadsheet is not affected.')) {
                M.auth.signOut();
                paintStatus();
                paintLocal();
              }
            } }, 'Disconnect')
          : el('button', { class: 'btn', type: 'button',
              onclick: function () { void connect(); }
            }, 'Connect Google'),
        ok ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { void syncNow(); } }, 'Sync now') : null,
        ok ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { void connect(); } }, 'Re-run bootstrap') : null
      ];
      actionKids.filter(Boolean).forEach(function (k) { actions.appendChild(k); });

      var statusKids = [
        el('h3', null, 'Connection'),
        ok
          ? el('p', null,
              'Connected as ', el('em', null, state.email || 'your Google account'), '. ',
              el('a', { href: M.sheets.spreadsheetUrl(c.spreadsheetId), target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Open spreadsheet')
            )
          : el('p', { class: 'muted' },
              c.clientId
                ? 'Not connected yet — click Connect to authorize Minerva and create your spreadsheet.'
                : 'Save a Google OAuth Client ID above first. Then come back and click Connect.'
            ),
        stage && stageLabels[stage]
          ? el('p', { class: 'small muted' }, stageLabels[stage])
          : null,
        actions
      ];
      status.replaceChildren.apply(status, statusKids.filter(Boolean));
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
            } }, 'Clear local mirror'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            title: 'Drop the IndexedDB database entirely and reload. Use only if Clear local mirror does not help.',
            onclick: async function () {
              if (!confirm('Hard reset: delete the entire local database and reload?\n\nYour Google Sheet is NOT affected. The next sync after reload will repopulate everything from your sheet.')) return;
              try {
                await M.db.deleteDatabase();
                location.reload();
              } catch (err) {
                flash(localPanel, 'Reset failed: ' + (err && err.message || err), 'error');
              }
            } }, 'Hard reset (delete local DB)')
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
        setAuthError('Paste your Google OAuth Client ID below, click Save, then Connect Google again.');
        try {
          var input = document.querySelector('input[name="clientId"]');
          if (input) {
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            input.focus();
          }
        } catch (e) { /* best effort */ }
        flash(status, 'Save a Client ID first.', 'error');
        return;
      }
      try {
        paintStatus('auth');
        var token = await M.auth.requestToken(c.clientId, c.spreadsheetId ? '' : 'consent');
        paintStatus('bootstrap');
        var bs = await M.bootstrap(token);
        writeConfig({ spreadsheetId: bs.spreadsheetId });
        // After auth + spreadsheet bootstrap, attempt to pull any
        // previously-synced settings from Drive so a fresh device
        // inherits the user's API keys / endpoints / preferences.
        var loaded = false;
        try { loaded = await loadDriveConfigIfPresent(); }
        catch (e) { console.warn('[Minerva drive-config-load]', e); }
        paintStatus('syncing');
        await M.sync.pullAll(token, bs.spreadsheetId);
        await refreshConfig();
        paintStatus();
        await paintLocal();
        renderNav(navActive());
        var msg = bs.fresh ? 'Spreadsheet created, seeded, and pulled.' : 'Connected and synced.';
        if (loaded) msg += ' Settings restored from Drive.';
        clearAuthError();
        // Push a fresh copy of the local config back to Drive so any
        // values typed before connect (typically just the spreadsheet
        // id) become part of the canonical Drive snapshot.
        scheduleDriveConfigSync();
        // Re-render the Settings view if we're still on it — the form
        // inputs were mounted with the pre-load (often empty) values,
        // so without a re-route the user sees blank fields even though
        // localStorage now holds everything Drive returned.
        if (loaded && (location.hash || '').indexOf('#/settings') === 0) {
          try { route(); } catch (e) { /* fall through to the flash */ }
        }
        // Surface the confirmation on document.body so it survives the
        // re-render above.
        flash(document.body, msg);
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

    var pgPanel = el('div', { class: 'tg-panel' });
    paintPg();

    var diagPanel = el('div', { class: 'tg-panel' });
    paintDiag();

    function paintPg() {
      var stamp = readPgBackupStamp();
      var stateNow = (Minerva.pg && Minerva.pg.cachedState) ? Minerva.pg.cachedState() : { ok: false, configured: false };
      var configured = !!(cfg.ytDlpServer || '').trim();
      var live = stateNow.ok && configured;

      var pillClass = live ? 'svc-pill is-ok'
                    : configured ? 'svc-pill is-down'
                                 : 'svc-pill is-unset';
      var pillText = live ? 'Reachable'
                   : configured ? 'Offline'
                                : 'Not configured';

      var lastLine;
      if (stamp && stamp.at) {
        var ageMs = Date.now() - stamp.at;
        var ageStr;
        if (ageMs < 60 * 1000) ageStr = 'just now';
        else if (ageMs < 60 * 60 * 1000) ageStr = Math.round(ageMs / 60000) + ' min ago';
        else if (ageMs < 24 * 60 * 60 * 1000) ageStr = Math.round(ageMs / 3600000) + ' h ago';
        else ageStr = Math.round(ageMs / 86400000) + ' d ago';
        lastLine = el('p', { class: 'small muted' },
          'Last backup: ', ageStr,
          stamp.fileId ? ' · ' : null,
          stamp.fileId ? el('code', null, stamp.fileId.slice(0, 10) + '…') : null
        );
      } else {
        lastLine = el('p', { class: 'small muted' }, 'No backup yet.');
      }

      var btn = el('button', { type: 'button', class: 'btn btn-primary' },
        M.render.icon('upload-cloud'), ' Backup to Drive now');
      btn.onclick = function () { runPgBackup(btn); };

      var refreshBtn = el('button', { type: 'button', class: 'btn btn-ghost' },
        M.render.icon('refresh-cw'), ' Re-check');
      refreshBtn.onclick = function () {
        if (!Minerva.pg) return;
        Minerva.pg.probe(true).then(function () { paintPg(); });
      };

      var pgKids = [
        el('h3', null, 'Postgres mirror'),
        el('p', { class: 'small muted' },
          'Every successful Sheets push is mirrored into a local Postgres database (via ',
          el('code', null, 'minerva-services'),
          '). Sheets stays the source of truth; PG is the read-fast cache and the source for the Drive-backed pg_dump below.'
        ),
        el('div', { class: 'pg-status-row' },
          el('span', { class: pillClass }, pillText),
          refreshBtn,
          btn
        ),
        configured
          ? null
          : el('p', { class: 'small muted' },
              'Set the ', el('strong', null, 'yt-dlp server'),
              ' URL under Connection (e.g. ', el('code', null, 'http://localhost:8765'),
              ') to enable the mirror.'
            ),
        el('hr'),
        el('h4', null, 'Drive backup'),
        el('p', { class: 'small muted' },
          'The button above runs ', el('code', null, 'pg_dump'),
          ' on the local container and uploads the SQL file to Drive (rolling — same fileId is updated each time).'
        ),
        lastLine
      ];
      pgPanel.replaceChildren.apply(pgPanel, pgKids.filter(Boolean));
      // Async stats fetch — populates the panel below the static
      // children with per-tab row counts so the user can see PG is
      // actually receiving traffic.
      if (live && Minerva.pg && typeof Minerva.pg.stats === 'function') {
        Minerva.pg.stats().then(function (res) {
          if (!res || !res.ok || !res.tabs) return;
          var rows = res.tabs;
          var statsHost = el('div', { class: 'pg-stats' },
            el('h4', null, 'PG state'),
            el('p', { class: 'small muted' },
              'Total rows in PG: ', el('code', null, String(res.total_live)),
              ' (excluding soft-deletes)'
            )
          );
          if (rows.length) {
            var tbl = el('table', { class: 'pg-stats-table' });
            var tbody = el('tbody');
            tbl.appendChild(tbody);
            rows.forEach(function (r) {
              var when = r.last_write_ms
                ? new Date(r.last_write_ms).toLocaleString()
                : '—';
              tbody.appendChild(el('tr', null,
                el('td', null, r.tab),
                el('td', { class: 'num' }, String(r.live)),
                r.deleted
                  ? el('td', { class: 'small muted' }, '+' + r.deleted + ' deleted')
                  : el('td', null, ''),
                el('td', { class: 'small muted' }, 'last write: ' + when)
              ));
            });
            statsHost.appendChild(tbl);
          } else {
            statsHost.appendChild(el('p', { class: 'small muted' },
              'No rows yet — make any edit and the mirror will populate.'));
          }
          pgPanel.appendChild(statsHost);
        }).catch(function (err) {
          pgPanel.appendChild(el('p', { class: 'small muted' },
            'Could not fetch PG stats: ' + (err && err.message || err)));
        });
      }
    }

    var PG_BACKUP_KEY = 'minerva.pgBackup.v1';
    function readPgBackupStamp() {
      try { return JSON.parse(localStorage.getItem(PG_BACKUP_KEY) || 'null'); }
      catch (e) { return null; }
    }
    function writePgBackupStamp(patch) {
      var prev = readPgBackupStamp() || {};
      var next = Object.assign({}, prev, patch);
      localStorage.setItem(PG_BACKUP_KEY, JSON.stringify(next));
      return next;
    }

    async function runPgBackup(btn) {
      if (!Minerva.pg || !Minerva.pg.isLive()) {
        flash(document.body, 'Postgres mirror is not reachable — start minerva-services first.', 'error');
        return;
      }
      var token;
      try { token = await M.auth.getToken(); }
      catch (e) {
        flash(document.body, 'Connect Google before uploading the backup.', 'error');
        return;
      }
      var origLabel = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '';
      btn.appendChild(document.createTextNode('Dumping…'));
      try {
        var blob = await Minerva.pg.dump();
        btn.innerHTML = '';
        btn.appendChild(document.createTextNode('Uploading…'));
        var sql = await blob.text();
        var prev = readPgBackupStamp() || {};
        var name = 'minerva.sql';
        var resp;
        try {
          resp = await Minerva.sheets.uploadDriveFile(
            token, name, 'application/sql; charset=utf-8', sql, prev.fileId || null
          );
        } catch (e) {
          if (prev.fileId && (e.status === 404 || e.status === 403)) {
            // Stored fileId is gone or no longer ours — retry as a new file.
            resp = await Minerva.sheets.uploadDriveFile(
              token, name, 'application/sql; charset=utf-8', sql, null
            );
          } else {
            throw e;
          }
        }
        writePgBackupStamp({ at: Date.now(), fileId: resp.id, link: resp.webViewLink || null });
        flash(document.body, 'Backup uploaded to Drive.', 'ok');
        paintPg();
      } catch (e) {
        flash(document.body, 'Backup failed: ' + (e && e.message || e), 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = origLabel;
      }
    }

    function paintDiag() {
      diagPanel.replaceChildren(
        el('h3', null, 'Diagnostics'),
        el('p', { class: 'small muted' },
          'Run quick health checks across local storage, IndexedDB, service worker, and the configured Google / Telegram / AI endpoints. Useful when something feels off.'
        ),
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn', type: 'button',
            onclick: function () { void runDiag(); }
          }, 'Run diagnostics')
        )
      );
    }

    async function runDiag() {
      var results = el('ul', { class: 'diag-list' });
      diagPanel.replaceChildren(
        el('h3', null, 'Diagnostics'),
        el('p', { class: 'small muted' }, 'Running…'),
        results
      );

      function add(status, label, detail) {
        var icon = status === 'ok' ? 'check-circle' :
                   status === 'warn' ? 'alert-triangle' :
                   status === 'fail' ? 'x-circle' : 'circle';
        var li = el('li', { class: 'diag-item diag-' + status },
          M.render.icon(icon),
          el('span', { class: 'diag-label' }, label),
          detail ? el('span', { class: 'diag-detail small muted' }, detail) : null
        );
        results.appendChild(li);
        M.render.refreshIcons();
      }

      // 1. localStorage
      try {
        var n = 0;
        for (var k in localStorage) {
          if (k.indexOf('minerva.') === 0) n++;
        }
        add('ok', 'localStorage', n + ' Minerva keys present');
      } catch (e) {
        add('fail', 'localStorage', e.message || String(e));
      }

      // 2. IndexedDB
      try {
        var meta = await M.db.getAllMeta();
        var totalRows = 0;
        for (var m of meta) {
          if (!m || !m.tab) continue;
          totalRows += await M.db.countTab(m.tab);
        }
        add('ok', 'IndexedDB', meta.length + ' tabs · ' + totalRows + ' rows mirrored');
      } catch (e) {
        add('fail', 'IndexedDB', e.message || String(e));
      }

      // 3. Service worker
      if ('serviceWorker' in navigator) {
        try {
          var reg = await navigator.serviceWorker.getRegistration();
          if (reg) add('ok', 'Service worker', 'registered (scope ' + reg.scope + ')');
          else add('warn', 'Service worker', 'not registered — offline reads disabled');
        } catch (e) {
          add('warn', 'Service worker', e.message || String(e));
        }
      } else {
        add('warn', 'Service worker', 'not supported by this browser');
      }

      // 4. Online status
      add(navigator.onLine ? 'ok' : 'warn', 'Network',
        navigator.onLine ? 'online' : 'offline (queued edits will flush on reconnect)');

      // 5. Google APIs
      var c = readConfig();
      if (!c.clientId) {
        add('warn', 'Google API', 'no OAuth client configured');
      } else {
        try {
          var token = await M.auth.getToken(c.clientId);
          var resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + token }
          });
          if (resp.ok) {
            var data = await resp.json();
            add('ok', 'Google API', 'reachable as ' + (data.email || 'authorized user'));
          } else {
            add('fail', 'Google API', 'userinfo returned ' + resp.status);
          }
        } catch (e) {
          add('fail', 'Google API', e.message || String(e));
        }
      }

      // 6. Telegram
      var tg = (function () { try { return JSON.parse(localStorage.getItem('minerva.telegram.v1') || '{}'); } catch (e) { return {}; } })();
      if (!tg.token) {
        add('warn', 'Telegram', 'no bot token configured');
      } else {
        try {
          var me = await M.telegram.getMe(tg.token);
          add('ok', 'Telegram', 'bot reachable as @' + (me.username || me.first_name));
        } catch (e) {
          add('fail', 'Telegram', e.message || String(e));
        }
      }

      // 7. AI
      var ai = M.ai && M.ai.readCfg();
      if (!ai || !ai.provider) {
        add('warn', 'AI assistant', 'no provider configured');
      } else if (!ai.apiKey && ai.provider !== 'ollama') {
        add('warn', 'AI assistant', 'no API key set for ' + ai.provider);
      } else {
        try {
          var r = await M.ai.ask([
            { role: 'system', content: 'Reply with exactly the word OK.' },
            { role: 'user', content: 'OK' }
          ], { maxTokens: 8 });
          add('ok', 'AI assistant', ai.provider + ' replied (' + (r.text || '').trim().slice(0, 32) + ')');
        } catch (e) {
          add('fail', 'AI assistant', e.message || String(e));
        }
      }

      diagPanel.replaceChildren(
        el('h3', null, 'Diagnostics'),
        el('p', { class: 'small muted' }, 'Run again any time. Failed checks include the underlying error.'),
        results,
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn btn-ghost', type: 'button',
            onclick: function () { void runDiag(); }
          }, 'Run again'),
          el('button', { class: 'btn btn-ghost', type: 'button',
            title: 'Unregister the service worker, clear all caches, and hard-reload. Use when "Connect Google" or other features stop responding because an old build is still running.',
            onclick: function () { void forceUpdate(); }
          }, M.render.icon('refresh-cw'), ' Force update')
        )
      );
    }

    // Defer to the global helper so the same flow is reachable from
    // either the Diagnostics button or `Minerva.forceUpdate()` in the
    // console (handy when something keeps the page from ever
    // reaching Settings).
    function forceUpdate() { return forceUpdateAll(); }

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
        // A preset is "taken" when its _config row exists AND is enabled.
        // A row that exists but is disabled (the user hit Remove) shows the
        // Add button — addPreset re-uses the existing row by flipping
        // enabled back to TRUE rather than creating a duplicate.
        var enabledSlugs = (configCache || [])
          .filter(function (r) { return isEnabled(r); })
          .map(function (r) { return r.slug; });
        var grid = el('div', { class: 'preset-grid' });
        (M.presets || []).forEach(function (p) {
          var taken = enabledSlugs.indexOf(p.slug) >= 0;
          var presetIconEl = el('div', { class: 'preset-icon' });
          if (p.icon) presetIconEl.appendChild(M.render.icon(p.icon));
          var card = el('div', { class: 'preset-card' + (taken ? ' preset-taken' : '') },
            presetIconEl,
            el('div', { class: 'preset-body' },
              el('h4', null, p.title),
              el('p', { class: 'small muted' }, p.description),
              taken
                ? (function () {
                    var actions = el('div', { class: 'preset-actions' });
                    var tag = el('span', { class: 'small muted preset-status' });
                    tag.appendChild(M.render.icon('check'));
                    tag.appendChild(document.createTextNode(' already added'));
                    actions.appendChild(tag);
                    var rmBtn = el('button', { class: 'btn btn-ghost preset-remove', type: 'button',
                      title: 'Hide this section from the nav (data is preserved in your sheet)',
                      onclick: async function () {
                        if (!confirm('Hide "' + p.title + '" from the nav? Your data stays in your sheet — you can re-add it later from this gallery.')) return;
                        try {
                          flash(presetsPanel, 'Hiding ' + p.title + '…');
                          await removePreset(p.slug);
                          await refreshConfig();
                          renderNav(navActive());
                          paintPresets();
                          flash(presetsPanel, 'Hid ' + p.title + '.');
                        } catch (err) {
                          flash(presetsPanel, 'Failed: ' + (err && err.message || err), 'error');
                        }
                      }
                    });
                    rmBtn.appendChild(M.render.icon('eye-off'));
                    rmBtn.appendChild(document.createTextNode(' Remove'));
                    actions.appendChild(rmBtn);
                    return actions;
                  })()
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

    // addPreset / removePreset live at module scope (defined above) so
    // that saveMeetPoll and any other module-level callers can use them
    // too. Earlier they were nested inside viewSettings, which was why
    // saveMeetPoll threw "addPreset is not defined".

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
                desktopNotify('Minerva', 'Test notification — looks good');
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
                await M.telegram.sendMessage(t.token, t.chatId, '*Minerva connected*');
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
                    target: '_blank', rel: 'noopener' }, 'Setup walkthrough')
        ),
        tgForm
      );
    }

    // Wrap each panel in a <details> so the page collapses to a list
    // of section headers. The TOC links open the target details and
    // scroll to it. Connection stays open by default; the rest are
    // collapsed so the page is short on first load.
    function panel(id, label, content, openByDefault) {
      var attrs = { class: 'settings-section', id: id };
      if (openByDefault) attrs.open = '';
      var det = el('details', attrs);
      var summary = el('summary', { class: 'settings-section-head' },
        el('span', { class: 'settings-section-title' }, label)
      );
      det.appendChild(summary);
      if (Array.isArray(content)) content.forEach(function (c) { if (c) det.appendChild(c); });
      else if (content) det.appendChild(content);
      return det;
    }

    var connectionPanel = el('div');
    connectionPanel.appendChild(form);
    connectionPanel.appendChild(status);

    // Each section is its own subroute — only one section's content
    // shows at a time. The sidebar's role is navigation, not summary.
    // `id` becomes the trailing path segment in #/settings/<id>.
    var sections = [
      { id: 'connection', label: 'Connection',    content: connectionPanel, primary: true },
      { id: 'store',      label: 'Local store',   content: localPanel },
      { id: 'pgsync',     label: 'Postgres mirror', content: pgPanel },
      { id: 'add',        label: 'Add a section', content: presetsPanel },
      { id: 'notify',     label: 'Notifications', content: notifyPanel },
      { id: 'ical',       label: 'Calendar feed', content: icalPanel },
      { id: 'telegram',   label: 'Telegram bot',  content: tgPanel },
      { id: 'ai',         label: 'AI assistant',  content: aiPanel },
      { id: 'bookmarklet', label: 'Bookmarklet',  content: bookmarkletPanel },
      { id: 'theme',      label: 'Custom theme',  content: themePanel },
      { id: 'diag',       label: 'Diagnostics',   content: diagPanel }
    ];

    // Resolve the active section from the subroute. Default to the
    // first section when no subId or an unknown id was passed.
    var activeId = subId || sections[0].id;
    var active = sections.find(function (s) { return s.id === activeId; });
    if (!active) { activeId = sections[0].id; active = sections[0]; }

    var toc = el('aside', { class: 'settings-toc', 'aria-label': 'Settings sections' });
    var tocList = el('ul');
    sections.forEach(function (s) {
      var a = el('a', {
        href: '#/settings/' + s.id,
        class: s.id === activeId ? 'is-active' : ''
      }, s.label);
      tocList.appendChild(el('li', null, a));
    });
    toc.appendChild(el('h3', null, 'Sections'));
    toc.appendChild(tocList);

    var body = el('div', { class: 'settings-body' });
    var pane = el('section', { class: 'settings-section settings-section-active' },
      el('h3', { class: 'settings-section-title' }, active.label)
    );
    if (Array.isArray(active.content)) active.content.forEach(function (c) { if (c) pane.appendChild(c); });
    else if (active.content) pane.appendChild(active.content);
    body.appendChild(pane);

    return el('section', { class: 'view view-settings' },
      el('div', { class: 'settings-head' },
        el('h2', null, 'Settings'),
        renderVersionBadge()
      ),
      renderAuthErrorBanner(),
      // The lead + setup checklist only render on the first (default)
      // section; deeper pages skip them so the user sees just what
      // they navigated to.
      activeId === sections[0].id
        ? el('p', { class: 'lead' },
            'Minerva keeps no secrets in its repo. The OAuth client is yours; remembered in this browser. ',
            el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-google-oauth.md', target: '_blank', rel: 'noopener' }, 'Detailed setup walkthrough')
          )
        : null,
      activeId === sections[0].id ? renderSetupChecklist(cfg) : null,
      el('div', { class: 'settings-layout' },
        toc,
        body
      )
    );
  }

  // Periodic health probe for the configured local services. Updates a
  // small status pill in place: ●  reachable / ○  offline / spinner
  // while in flight. The probe is a single GET to the endpoint's
  // /health (yt-dlp / cors-proxy / minerva-services all expose it).
  function attachStatusPill(pill, endpoint, healthPath) {
    if (!endpoint) {
      pill.className = 'svc-pill is-unset';
      pill.title = 'Not configured';
      pill.textContent = 'not set';
      return;
    }
    pill.className = 'svc-pill is-checking';
    pill.title = 'Pinging ' + endpoint + ' …';
    pill.textContent = 'checking…';
    var url = endpoint.replace(/\/+$/, '') + (healthPath || '/health');
    fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      pill.className = 'svc-pill is-ok';
      pill.title = endpoint + ' is reachable';
      pill.textContent = 'online';
    }).catch(function () {
      pill.className = 'svc-pill is-down';
      pill.title = endpoint + ' is not responding — start the server first';
      pill.textContent = 'offline';
    });
  }

  // Sticky error banner rendered above the Settings checklist when
  // the most recent sign-in attempt failed. Stays on screen until the
  // user dismisses it or a successful Connect clears the state.
  function renderAuthErrorBanner() {
    var msg = getAuthError();
    if (!msg) return null;
    var box = el('div', {
      class: 'auth-error-banner',
      role: 'alert'
    });
    var head = el('div', { class: 'auth-error-head' },
      M.render.icon('alert-triangle'),
      el('strong', null, 'Sign-in error'),
      el('button', {
        type: 'button',
        class: 'auth-error-dismiss',
        title: 'Dismiss',
        'aria-label': 'Dismiss',
        onclick: function (e) {
          e.preventDefault();
          clearAuthError();
        }
      }, '×')
    );
    box.appendChild(head);
    box.appendChild(el('pre', { class: 'auth-error-msg' }, msg.slice(0, 1000)));
    return box;
  }

  // Numbered first-run checklist for the Settings page. Required steps
  // sit at the top; optional ones (downloads, metadata fetch) follow.
  // Each entry shows a status pill (Done / Optional / Pending) computed
  // from the current config so the page is self-describing.
  function renderSetupChecklist(cfg) {
    function step(n, statusClass, statusLabel, title, body) {
      return el('li', { class: 'setup-step ' + statusClass },
        el('span', { class: 'setup-step-num' }, String(n)),
        el('div', { class: 'setup-step-body' },
          el('div', { class: 'setup-step-title' },
            el('strong', null, title),
            el('span', { class: 'setup-step-status' }, statusLabel)
          ),
          el('div', { class: 'setup-step-detail small muted' }, body)
        )
      );
    }
    var connected = !!(cfg.clientId && cfg.spreadsheetId);
    var hasYtKey = !!(cfg.youtubeApiKey || '').trim();
    var hasYtDlp = !!(cfg.ytDlpServer || '').trim();
    var hasCors = (cfg.corsProxy != null) ? !!String(cfg.corsProxy).trim() : true;

    return el('details', { class: 'setup-checklist', open: !connected ? '' : null },
      el('summary', null, 'Setup checklist',
        el('span', { class: 'small muted' },
          ' — ' + (connected ? 'connected' : 'not connected'))
      ),
      el('ol', { class: 'setup-steps' },
        step(1,
          connected ? 'is-done' : 'is-pending',
          connected ? 'Done' : 'Required',
          'Connect Google',
          el('span', null,
            'Paste your OAuth ',
            el('a', { href: '#oauth' }, 'Client ID'),
            ' below, click Save, then Connect Google. ',
            el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-google-oauth.md', target: '_blank', rel: 'noopener' }, 'How to get one'),
            '. The Client ID is the only credential that has to be entered on each new device — every other setting below syncs to your Drive once connected.'
          )
        ),
        step(2,
          (hasYtDlp || hasCors) ? 'is-done' : 'is-optional',
          (hasYtDlp || hasCors) ? 'Done' : 'Optional · for downloads + papers',
          'Run minerva-services',
          el('span', null,
            'One Python script (or one Docker container) runs both the yt-dlp downloader and the CORS proxy. Run ',
            el('code', null, 'python docs/minerva-services.py'),
            ', then paste ',
            el('code', null, 'http://localhost:8765'),
            ' into the yt-dlp server field and ',
            el('code', null, 'http://localhost:8765/proxy?'),
            ' into the CORS proxy field below. ',
            el('a', { href: 'https://github.com/the-farshad/Minerva/blob/main/docs/setup-local-services.md', target: '_blank', rel: 'noopener' }, 'Full guide'),
            ' (Python / Docker / systemd / launchd).'
          )
        ),
        step(3,
          hasYtKey ? 'is-done' : 'is-optional',
          hasYtKey ? 'Done' : 'Optional · for playlists',
          'YouTube Data API key',
          el('span', null,
            'Required only when importing whole playlists or @channels. Without it, single-video import still works. Get one in ~3 minutes from ',
            el('a', { href: 'https://console.cloud.google.com/apis/api/youtube.googleapis.com', target: '_blank', rel: 'noopener' }, 'Google Cloud Console'),
            '.'
          )
        )
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
          el('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Open public view')
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
        el('p', null, el('a', { href: '#/share' }, 'Create a new one'))
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
      el('p', null, el('a', { href: '#/' }, 'Go home'))
    );
  }

  async function viewGraph(hash) {
    var view = el('section', { class: 'view view-graph' });
    var h2 = el('h2');
    h2.appendChild(M.render.icon('network'));
    h2.appendChild(document.createTextNode(' Graph'));
    view.appendChild(h2);
    view.appendChild(el('p', { class: 'small muted' },
      'Cross-tab links between rows. Each ',
      el('code', null, 'ref'), ' column becomes an edge. Drag to pan, scroll to zoom, click a node to open it.'));

    var host = el('div', {
      class: 'graph-host-shell', role: 'region',
      'aria-label': 'Cross-tab graph'
    });
    view.appendChild(host);

    if (!(M.graph && M.graph.buildGraphFromAll && M.graph.renderGraph)) {
      host.appendChild(el('p', { class: 'muted' }, 'Graph module unavailable.'));
      return view;
    }

    // Parse #/graph?focus=<rowId>
    var focusId = '';
    var qIdx = (hash || '').indexOf('?');
    if (qIdx >= 0) {
      var qs = (hash || '').slice(qIdx + 1).split('&');
      for (var qi = 0; qi < qs.length; qi++) {
        var pair = qs[qi].split('=');
        if (pair[0] === 'focus' && pair[1]) {
          try { focusId = decodeURIComponent(pair[1]); } catch (e) { focusId = pair[1]; }
        }
      }
    }

    try {
      var data = await M.graph.buildGraphFromAll();
      // Empty state: no section has a ref column at all.
      if (!data.hasRefColumns || !data.nodes.length) {
        host.appendChild(el('p', { class: 'muted graph-empty-msg' },
          'No connections — add a ref column to a section to see the cross-tab graph.'));
        return view;
      }
      if (focusId) data.focus = focusId;
      M.graph.renderGraph(host, data);
    } catch (e) {
      console.warn('viewGraph: build failed', e);
      host.appendChild(el('p', { class: 'muted' }, 'Could not build graph.'));
    }
    return view;
  }

  // ---- router ----

  async function route() {
    setBusy(true);
    var hash = location.hash || '#/';
    var view, active = '';
    var sectionMatch;
    // Clear keyboard context every navigation; viewSection re-installs.
    sectionCtx = null;
    // Same for the YouTube playlist context registered on M.preview.
    if (M.preview && typeof M.preview.clearPlaylistContext === 'function') {
      M.preview.clearPlaylistContext();
    }

    try {
      if (hash === '#/' || hash === '' || hash === '#') {
        view = await viewHome(); active = '#/';
      } else if (hash === '#/settings' || /^#\/settings\//.test(hash)) {
        var subId = hash === '#/settings' ? '' : hash.replace(/^#\/settings\//, '');
        view = viewSettings(subId); active = '#/settings';
      } else if (/^#\/share(\/.*)?$/.test(hash)) {
        view = viewShare(); active = '#/share';
      } else if (/^#\/p\/.+/.test(hash)) {
        view = viewPublic(hash.replace(/^#\/p\//, ''));
      } else if (hash === '#/today') {
        // Today is folded into Home; redirect any remaining /today
        // links back to /. The home view already renders today's
        // tasks, habits, and events inline.
        location.replace(location.origin + location.pathname + '#/');
        return;
      } else if (hash === '#/graph' || hash.indexOf('#/graph?') === 0) {
        view = await viewGraph(hash); active = '#/graph';
      } else if (hash === '#/schedule') {
        view = await viewSchedule(); active = '#/schedule';
      } else if ((sectionMatch = hash.match(/^#\/avail\/(.+)$/))) {
        view = viewAvailability(sectionMatch[1]); active = '';
      } else if (hash === '#/meet/new') {
        view = viewMeetNew(); active = '#/schedule';
      } else if ((sectionMatch = hash.match(/^#\/meet\/([^/]+)\/([^?]+)$/))) {
        view = viewMeetAggregate(sectionMatch[1], sectionMatch[2]); active = '';
      } else if ((sectionMatch = hash.match(/^#\/meet\/([^/?]+)(?:\?.*)?$/))) {
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
        // Deprecated sections forward to the surface that absorbed
        // their data. The user's spreadsheet rows are preserved; only
        // the navigation entry is gone.
        var dep = DEPRECATED_SECTIONS[slug];
        if (dep && dep.redirect) {
          location.replace(location.origin + location.pathname + dep.redirect);
          return;
        }
        view = await viewSection(slug);
        active = '#/s/' + encodeURIComponent(slug);
      } else if ((sectionMatch = hash.match(/^#\/draw\/([^/]+)\/([^?]+)(?:\?(.*))?$/))) {
        // Sketch editor — `M.draw.openEditor` mounts directly into #content
        // because the canvas needs to size against the live viewport, not a
        // detached subtree. Return null and let the post-route logic skip
        // replaceChildren (handled below).
        var drawTab = decodeURIComponent(sectionMatch[1]);
        var drawRowId = decodeURIComponent(sectionMatch[2]);
        var qs = sectionMatch[3] || '';
        var drawCol = '';
        qs.split('&').forEach(function (kv) {
          var p = kv.split('=');
          if (decodeURIComponent(p[0] || '') === 'col') drawCol = decodeURIComponent(p[1] || '');
        });
        if (!drawCol) {
          view = viewNotFound(hash);
        } else {
          renderNav('');
          M.draw.openEditor(drawTab, drawRowId, drawCol);
          setBusy(false);
          return;
        }
      } else {
        view = viewNotFound(hash);
      }
    } catch (err) {
      view = el('section', { class: 'view' },
        el('h2', null, 'Something went wrong'),
        el('p', null, 'Render error: ', el('code', null, String(err && err.message || err))),
        el('p', null, el('a', { href: '#/' }, 'Go home'))
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

  // ---- "+ Add row" form modal --------------------------------------
  // For non-YouTube sections that don't have a natural URL workflow.
  // Replaces the old behavior of dropping an empty row onto the table —
  // the user fills in fields *first*, and the row is only created when
  // they click Save. Cancel/Esc creates nothing.
  async function showAddRowForm(tab, meta, onCreated) {
    if (document.querySelector('.add-row-overlay')) return;
    if (!meta || !meta.headers) {
      flash(document.body, 'No schema cached — Sync first.', 'error');
      return;
    }
    var draft = { id: M.db.ulid(), _localOnly: 1, _dirty: 1, _deleted: 0, _rowIndex: null };
    meta.headers.forEach(function (h) {
      if (h === 'id') return;
      if (h === '_updated') draft[h] = new Date().toISOString();
      else draft[h] = '';
    });

    var overlay = el('div', { class: 'modal-overlay add-row-overlay',
      onclick: function () { overlay.remove(); }
    });
    var panel = el('div', { class: 'modal-panel add-row-panel',
      onclick: function (e) { e.stopPropagation(); }
    });

    panel.appendChild(el('div', { class: 'row-detail-head' },
      el('h3', null, 'Add row to ', el('code', null, tab)),
      el('button', { class: 'icon-btn', type: 'button', title: 'Close',
        onclick: function () { overlay.remove(); } }, '×')
    ));
    panel.appendChild(el('p', { class: 'small muted' },
      'Fill in any fields you want. Empty fields stay blank. Click Save to create the row, or Cancel to discard.'
    ));

    var grid = el('div', { class: 'row-detail-grid' });
    panel.appendChild(grid);

    // First non-internal, non-id, non-_updated column gets autofocus.
    var focusTarget = null;

    meta.headers.forEach(function (h, i) {
      if (M.render.isInternal(h)) return;
      if (h === 'id') return;
      var type = meta.types[i] || 'text';
      var labelEl = el('div', { class: 'row-detail-label' }, h);
      var valueEl = el('div', { class: 'row-detail-value add-row-input' });
      var parsed = M.render.parseType(type);
      // Drawing fields can't be filled inline before creation. Skip.
      if (parsed.kind === 'drawing') {
        valueEl.appendChild(el('span', { class: 'muted small' }, '— add later from row detail —'));
        grid.appendChild(labelEl);
        grid.appendChild(valueEl);
        return;
      }
      var ed = M.editors.make('', type, function (v) { draft[h] = v; }, function () { /* cancel */ }, { tab: tab, rowId: draft.id, col: h });
      valueEl.appendChild(ed);
      grid.appendChild(labelEl);
      grid.appendChild(valueEl);
      if (!focusTarget && ed && (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA')) focusTarget = ed;
    });

    var saveBtn = el('button', { class: 'btn btn-primary', type: 'button',
      onclick: async function () {
        // Pull final values from any open editors so trailing edits land.
        grid.querySelectorAll('input, textarea, select').forEach(function (n) {
          var col = n.closest('.add-row-input') ? n.closest('.add-row-input').previousSibling.textContent : null;
          if (!col) return;
          if (n.type === 'checkbox') draft[col] = n.checked ? 'TRUE' : 'FALSE';
          else if (draft[col] === '') draft[col] = n.value;
        });
        // Discard if nothing was actually filled in (other than auto fields).
        var hasContent = meta.headers.some(function (h) {
          if (h === 'id' || h === '_updated' || M.render.isInternal(h)) return false;
          var v = draft[h];
          return v != null && String(v).trim() !== '';
        });
        if (!hasContent) {
          flash(panel, 'Fill at least one field before saving.', 'error');
          return;
        }
        await M.db.upsertRow(tab, draft);
        pushUndo({ kind: 'add', tab: tab, rowId: draft.id });
        schedulePush();
        overlay.remove();
        flash(document.body, 'Added row to ' + tab + '.');
        if (onCreated) onCreated();
      }
    }, 'Save');

    panel.appendChild(el('div', { class: 'form-actions' },
      saveBtn,
      el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: function () { overlay.remove(); } }, 'Cancel')
    ));

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    M.render.refreshIcons();
    if (focusTarget) setTimeout(function () { try { focusTarget.focus(); } catch (e) {} }, 30);
  }

  // PDF drop / pick zone for the URL Import modal. Reads a dropped or
  // picked PDF, runs M.import.pdfFile to extract an arXiv id / DOI /
  // title, then injects the identifier into the input field so the
  // existing debounced lookup picks it up. No text extraction libraries
  // — pure regex on the first 256KB of bytes.
  function renderPdfDropZone(input, triggerLookup) {
    var zone = el('div', { class: 'url-import-pdfzone' });
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,application/pdf';
    fileInput.style.display = 'none';

    var status = el('span', { class: 'small muted' },
      'Drop a PDF here or ',
      el('button', { type: 'button', class: 'url-import-pdfpick',
        onclick: function () { fileInput.click(); }
      }, 'pick a file'),
      ' — Minerva pulls out the arXiv id / DOI to auto-fill.'
    );
    zone.appendChild(status);
    zone.appendChild(fileInput);

    async function handleFile(file) {
      if (!file) return;
      if (!/pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        flash(zone, 'Not a PDF — drop a .pdf file.', 'error');
        return;
      }
      status.replaceChildren(document.createTextNode('Reading "' + file.name + '"…'));
      try {
        var meta = await M.import.pdfFile(file);
        if (!meta) {
          status.replaceChildren(document.createTextNode(
            'Couldn\'t find an arXiv id or DOI in "' + file.name + '". Type a URL above instead.'
          ));
          return;
        }
        if (meta.identifier && meta.identifierKind === 'arxiv') {
          input.value = meta.identifier;
          status.replaceChildren(document.createTextNode(
            'Found arXiv id ' + meta.identifier + ' — fetching metadata…'
          ));
          triggerLookup();
        } else if (meta.identifier && meta.identifierKind === 'doi') {
          input.value = meta.identifier;
          status.replaceChildren(document.createTextNode(
            'Found DOI ' + meta.identifier + ' — fetching metadata…'
          ));
          triggerLookup();
        } else if (meta.title) {
          // No identifier but we got a title from the PDF info dict.
          // Surface it so the user can complete the row manually.
          status.replaceChildren(document.createTextNode(
            'No DOI / arXiv id in "' + file.name + '". Title from PDF metadata: "' + meta.title + '". Type a URL above to fetch full data, or save manually.'
          ));
        }
      } catch (err) {
        status.replaceChildren(el('span', { class: 'error' },
          'PDF read failed: ' + (err && err.message || err)));
      }
    }

    fileInput.addEventListener('change', function () {
      handleFile(fileInput.files && fileInput.files[0]);
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-dragover');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });
    return zone;
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
    // Tailor the placeholder so a YouTube section doesn't advertise arXiv
    // and vice-versa. Library / generic sections still see everything.
    var sectionKind = tab === 'youtube' ? 'youtube'
      : (tab === 'papers' ? 'papers' : 'mixed');
    if (sectionKind === 'youtube') {
      input.placeholder = 'YouTube video URL · playlist URL · @channel URL';
    } else if (sectionKind === 'papers') {
      input.placeholder = 'arXiv id (e.g. 2401.12345) · DOI (10.xxxx/yyy) · paper URL';
    } else {
      input.placeholder = 'arXiv ID · DOI (10.xxxx/...) · YouTube video / playlist / @channel · any other URL';
    }
    input.autocomplete = 'off';
    input.spellcheck = false;

    var preview = el('div', { class: 'url-import-preview' });
    var addBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'Add to ' + tab);
    var fetched = null;
    var debounce = null;

    // Category picker — only when the section has a `category` column.
    // Builds a multi-tag widget combining: (1) the schema's predefined
    // options (from select(...) / multiselect(...)), (2) every category
    // already in use across the section's rows, and (3) free-typed new
    // ones. Each click toggles a tag in/out of the selection. The chosen
    // set applies to single-video, playlist, and channel imports.
    var categoryColIdx = (meta.headers || []).indexOf('category');
    var categoryFieldNode = null;
    var selectedCategories = [];
    var renderCategoryChips = function () { /* set below */ };
    if (categoryColIdx >= 0) {
      var catType = M.render.parseType((meta.types || [])[categoryColIdx] || 'text');
      var predefined = (catType.options && catType.options.length)
        ? catType.options.slice()
        : [];
      // Auto-detect categories already in use so re-importing under an
      // existing label is one click.
      var existingRows = await M.db.getAllRows(tab);
      var seenCat = Object.create(null);
      var detected = [];
      existingRows.forEach(function (r) {
        if (r._deleted) return;
        String(r.category || '').split(',').forEach(function (raw) {
          var v = raw.trim();
          if (!v || seenCat[v]) return;
          seenCat[v] = 1;
          detected.push(v);
        });
      });
      // Merge — predefined first (in declared order), then detected
      // extras the user added themselves.
      var allCats = predefined.slice();
      detected.forEach(function (v) { if (allCats.indexOf(v) < 0) allCats.push(v); });

      var chipsHost = el('div', { class: 'url-import-cat-chips' });
      var newInput = document.createElement('input');
      newInput.type = 'text';
      newInput.className = 'editor url-import-cat-new';
      newInput.placeholder = 'Add new category…';
      newInput.autocomplete = 'off';
      newInput.spellcheck = false;

      function commitNew() {
        var v = newInput.value.trim();
        newInput.value = '';
        if (!v) return;
        if (allCats.indexOf(v) < 0) allCats.push(v);
        if (selectedCategories.indexOf(v) < 0) selectedCategories.push(v);
        renderCategoryChips();
      }
      newInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commitNew();
        }
      });
      newInput.addEventListener('blur', commitNew);

      renderCategoryChips = function () {
        chipsHost.replaceChildren();
        allCats.forEach(function (cat) {
          var on = selectedCategories.indexOf(cat) >= 0;
          var chip = el('button', {
            type: 'button',
            class: 'url-import-cat-chip' + (on ? ' is-active' : ''),
            onclick: function () {
              var idx = selectedCategories.indexOf(cat);
              if (idx >= 0) selectedCategories.splice(idx, 1);
              else selectedCategories.push(cat);
              renderCategoryChips();
            }
          }, cat);
          chipsHost.appendChild(chip);
        });
      };
      renderCategoryChips();

      categoryFieldNode = el('div', { class: 'url-import-category-row' },
        el('span', { class: 'small muted url-import-cat-label' }, 'Category'),
        el('div', { class: 'url-import-cat-stack' },
          chipsHost,
          newInput
        )
      );
    }

    function fmtAge(ms) {
      var s = Math.round(ms / 1000);
      if (s < 60) return s + 's ago';
      var m = Math.round(s / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.round(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.round(h / 24) + 'd ago';
    }

    function renderField(label, value) {
      if (!value) return null;
      return el('div', { class: 'url-import-field' },
        el('strong', null, label),
        el('span', null, String(value).slice(0, 600))
      );
    }

    function setBtnLabel(s) { addBtn.textContent = s; }

    async function lookup(opts) {
      opts = opts || {};
      var raw = input.value.trim();
      fetched = null;
      // Stay enabled whenever the input looks like a URL, even before
      // metadata returns. The user can save a URL-only row immediately;
      // the lookup result, when it arrives, populates the preview and
      // any matching columns. This avoids a "Looking up…" stall.
      var looksLikeUrl = /^https?:\/\//i.test(raw) || /^\d{4}\.\d{4,5}/.test(raw)
        || /^10\.\d{4,9}\//.test(raw);
      if (looksLikeUrl) {
        fetched = /^https?:\/\//i.test(raw) ? { kind: 'article', url: raw }
          : { kind: 'paper', url: raw };
        addBtn.disabled = false;
        setBtnLabel('Add to ' + tab + ' (metadata loading…)');
      } else {
        addBtn.disabled = true;
        setBtnLabel('Add to ' + tab);
      }
      if (!raw) { preview.replaceChildren(); return; }
      preview.replaceChildren(el('p', { class: 'small muted' }, opts.noCache ? 'Refreshing…' : 'Looking up…'));
      try {
        var data = await M.import.lookup(raw, { noCache: !!opts.noCache });
        if (!data) {
          preview.replaceChildren(el('p', { class: 'small muted' },
            'Not recognized as arXiv, YouTube, or a URL. Either paste a real URL or use ',
            el('em', null, '+ Add row'), ' to enter manually.'));
          return;
        }
        fetched = data;

        // No API key + playlist/channel URL → surface a clear "set up your key"
        // hint with a one-click jump to Settings, instead of silently
        // falling through to a single-video import.
        if (data.kind === 'playlist-needs-key' || data.kind === 'channel-needs-key') {
          fetched = null; // disable Add button
          preview.replaceChildren(el('div', { class: 'preview-needs-key' },
            el('p', { class: 'small' }, data.message),
            el('p', { class: 'small' },
              el('a', {
                href: '#/settings',
                class: 'btn btn-ghost',
                onclick: function () { overlay.remove(); }
              }, M.render.icon('settings'), ' Open Settings')
            )
          ));
          return;
        }

        // Playlist branch — preview N items, "Import N videos" button.
        // Channel imports use the same shape (kind: 'channel' is a thin
        // wrapper over a playlist enumeration of the channel's uploads).
        if (data.kind === 'playlist' || data.kind === 'channel') {
          var n = (data.items || []).length;
          if (!n) {
            preview.replaceChildren(el('p', { class: 'error small' },
              (data.kind === 'channel' ? 'Channel ' : 'Playlist ') + 'enumerated, but contained no playable videos.'));
            return;
          }
          // Tally how many incoming videos already exist in this section
          // so the preview can show a per-import dedup count up front.
          var existingDup = await M.db.getAllRows(tab);
          var dupSet = new Set();
          existingDup.forEach(function (r) {
            if (r._deleted) return;
            var u = r.url && String(r.url).trim();
            if (u) dupSet.add(u);
          });
          var dupCount = 0;
          (data.items || []).forEach(function (it) {
            if (it.url && dupSet.has(String(it.url).trim())) dupCount++;
          });
          var plNodes = [];
          var sourceLabel = data.kind === 'channel'
            ? el('span', null, 'channel ', el('strong', null, data.channelTitle || data.channelId || '(unknown)'))
            : el('span', null, 'playlist ', el('code', null, data.playlistId));
          plNodes.push(el('p', { class: 'small' },
            'Will import ', el('strong', null, n + ' video' + (n === 1 ? '' : 's')),
            ' from ', sourceLabel,
            data.truncated ? ' (capped at ' + data.max + ' — more available)' : '',
            ' to ', el('code', null, tab), '.'
          ));
          if (typeof data._cachedAgeMs === 'number') {
            plNodes.push(el('p', { class: 'small muted url-import-cache-line' },
              'Loaded from cache (' + fmtAge(data._cachedAgeMs) + '). ',
              el('a', {
                href: '#',
                class: 'url-import-refresh',
                onclick: function (e) { e.preventDefault(); lookup({ noCache: true }); }
              }, 'Refresh from YouTube')
            ));
          }
          if (dupCount > 0) {
            var newCount = n - dupCount;
            plNodes.push(el('p', { class: 'small url-import-dup-line' + (newCount === 0 ? ' is-warning' : '') },
              dupCount + ' of ' + n + ' already in ', el('code', null, tab),
              newCount === 0 ? ' — nothing new to import.' : ' — only ' + newCount + ' new will be added.'
            ));
          }
          var listNode = el('div', { class: 'url-import-playlist' });
          var SHOW = 10;
          var preview_n = Math.min(n, SHOW);
          for (var pi = 0; pi < preview_n; pi++) {
            var pit = data.items[pi];
            var rowNode = el('div', { class: 'url-import-playlist-row' });
            if (pit.thumbnail) {
              var pimg = document.createElement('img');
              pimg.src = pit.thumbnail;
              pimg.className = 'url-import-playlist-thumb';
              pimg.alt = '';
              rowNode.appendChild(pimg);
            }
            rowNode.appendChild(el('div', { class: 'url-import-playlist-meta' },
              el('div', { class: 'url-import-playlist-title' }, pit.title || '(no title)'),
              el('div', { class: 'small muted' }, pit.channel || '')
            ));
            listNode.appendChild(rowNode);
          }
          if (n > SHOW) {
            listNode.appendChild(el('p', { class: 'small muted' },
              '+ ' + (n - SHOW) + ' more video' + (n - SHOW === 1 ? '' : 's') + '…'));
          }
          plNodes.push(listNode);
          preview.replaceChildren.apply(preview, plNodes);
          setBtnLabel('Import ' + n + ' video' + (n === 1 ? '' : 's') + ' to ' + tab);
          addBtn.disabled = false;
          return;
        }

        var matches = Object.keys(data).filter(function (k) {
          return meta.headers.indexOf(k) >= 0 && data[k];
        });
        var unmappable = Object.keys(data).filter(function (k) {
          return meta.headers.indexOf(k) < 0 && data[k];
        });

        // Duplicate check — surface "already in section" before the user
        // adds a second row pointing at the same URL.
        var dupRow = null;
        if (data.url) {
          var rowsForDup = await M.db.getAllRows(tab);
          var inUrl = String(data.url).trim();
          for (var di = 0; di < rowsForDup.length; di++) {
            var rd = rowsForDup[di];
            if (rd._deleted) continue;
            if (String(rd.url || '').trim() === inUrl) { dupRow = rd; break; }
          }
        }

        var nodes = [];
        if (dupRow) {
          nodes.push(el('p', { class: 'small url-import-dup-line is-warning' },
            'Already in ', el('code', null, tab), ': ',
            el('strong', null, dupRow.title || dupRow.url || dupRow.id),
            '. Adding would create a duplicate row.'
          ));
        }
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
        // Bibliographic fields in roughly bibtex order. Only fields the
        // current section has a column for will actually persist on Add,
        // but we surface everything the lookup returned so the user can
        // see what got fetched.
        [
          'kind', 'title', 'authors', 'year', 'month',
          'venue', 'volume', 'pages',
          'publisher', 'issn', 'language', 'type',
          'doi', 'url', 'pdf',
          'tags', 'abstract', 'comment', 'affiliation'
        ].forEach(function (k) {
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
        addBtn.disabled = matches.length === 0 || !!dupRow;
        if (dupRow) setBtnLabel('Already in ' + tab);
      } catch (err) {
        // Soft-fail: surface the error inline but still let the user
        // save the row with whatever they typed. The fallback record
        // carries only the URL (no metadata); the user fills the rest
        // by hand. A CORS-proxy hint is shown when the failure looks
        // like a network / CORS problem so the user knows the obvious
        // recovery path.
        var raw = input.value.trim();
        var errMsg = (err && err.message ? err.message : String(err));
        var looksLikeCors = /NetworkError|Failed to fetch|CORS|TypeError/i.test(errMsg);
        fetched = /^https?:\/\//i.test(raw)
          ? { kind: 'article', url: raw }
          : null;
        addBtn.disabled = !fetched;
        if (fetched) setBtnLabel('Add to ' + tab + ' (URL only)');
        preview.replaceChildren(
          el('p', { class: 'error small' }, 'Lookup failed: ' + errMsg),
          looksLikeCors
            ? el('p', { class: 'small muted' },
                'Looks like a CORS / network issue. Set a CORS proxy in ',
                el('a', { href: '#/settings', onclick: function () { overlay.remove(); } }, 'Settings'),
                ' (default https://corsproxy.io/? works) and try again.'
              )
            : null,
          fetched
            ? el('p', { class: 'small muted' },
                'Metadata couldn\'t be fetched. You can still save the URL and fill the row by hand — click ',
                el('strong', null, 'Add to ' + tab + ' (URL only)'), '.'
              )
            : null
        );
      }
    }

    input.addEventListener('input', function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(lookup, 350);
    });

    addBtn.addEventListener('click', async function () {
      if (!fetched) return;
      addBtn.disabled = true;
      var prevLabel = addBtn.textContent;
      // Flush any partially-typed new category before reading selection.
      if (categoryColIdx >= 0) {
        try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); }
        catch (e) { /* ignore */ }
      }
      var chosenCategory = selectedCategories.length ? selectedCategories.join(',') : '';
      // Playlist / channel branch — fan out into N rows.
      if (fetched.kind === 'playlist' || fetched.kind === 'channel') {
        setBtnLabel('Importing…');
        try {
          await importYoutubePlaylist(tab, fetched, null, { category: chosenCategory });
          overlay.remove();
        } catch (err) {
          flash(preview, 'Import failed: ' + (err && err.message ? err.message : err), 'error');
          addBtn.disabled = false;
          setBtnLabel(prevLabel);
        }
        return;
      }
      setBtnLabel('Adding…');
      try {
        var row = await addRow(tab, meta.headers);
        Object.keys(fetched).forEach(function (k) {
          if (meta.headers.indexOf(k) >= 0) row[k] = fetched[k];
        });
        if (chosenCategory && meta.headers.indexOf('category') >= 0) {
          row.category = chosenCategory;
        }
        if (meta.headers.indexOf('read') >= 0) row.read = 'FALSE';
        row._dirty = 1;
        await M.db.upsertRow(tab, row);
        schedulePush();
        overlay.remove();
        flash(document.body, 'Added: ' + (fetched.title || fetched.url || 'row'));
        // Mirror the PDF to Drive when the user opted in. Best-effort:
        // failures are surfaced as a quiet flash so the row save still
        // counts. Uses fetchCors() (configured proxy) to dodge arXiv's
        // missing CORS headers.
        if (readConfig().uploadPapersToDrive
            && fetched.kind === 'paper' && fetched.pdf) {
          uploadPaperPdfToDrive(fetched.pdf, fetched.title || row.id)
            .then(async function (fid) {
              if (!fid) return;
              // Record the Drive fileId on the row so preview.js can
              // mount the Drive viewer instead of the arXiv URL (which
              // arxiv refuses to allow inside an iframe). Re-read the
              // row to avoid clobbering any edits made between save
              // and upload completion.
              try {
                var meta2 = await M.db.getMeta(tab);
                if (meta2 && (meta2.headers || []).indexOf('offline') >= 0) {
                  var fresh = await M.db.getRow(tab, row.id);
                  if (fresh) {
                    fresh.offline = 'drive:' + fid;
                    fresh._dirty = 1;
                    fresh._updated = new Date().toISOString();
                    await M.db.upsertRow(tab, fresh);
                    schedulePush();
                  }
                }
              } catch (e) { /* non-fatal */ }
              flash(document.body, 'PDF saved to Drive.');
            })
            .catch(function (err) {
              flash(document.body, 'Drive upload skipped: ' + (err && err.message || err), 'error');
            });
        }
        await route();
      } catch (err) {
        flash(preview, 'Add failed: ' + (err && err.message ? err.message : err), 'error');
        addBtn.disabled = false;
        setBtnLabel('Add to ' + tab);
      }
    });

    var hasYtKey = !!(readConfig().youtubeApiKey || '').trim();
    // Section-tailored help paragraphs. YouTube section hides arXiv/DOI;
    // Papers hides YouTube. Library / generic shows everything.
    var helpNodes = [];
    if (sectionKind === 'youtube') {
      helpNodes.push(el('p', { class: 'small muted' },
        'Paste a ', el('strong', null, 'YouTube'),
        ' video URL to auto-fetch title, channel, duration, and publish date.'
      ));
      helpNodes.push(el('p', { class: 'small muted' },
        hasYtKey
          ? 'Playlist (?list=…) and channel (youtube.com/@handle, /channel/UC…) URLs enumerate every video — capped at 200 per import.'
          : 'Playlist or @channel URLs add every video — requires a free YouTube Data API key in Settings.'
      ));
    } else if (sectionKind === 'papers') {
      helpNodes.push(el('p', { class: 'small muted' },
        'Auto-fetches metadata from ',
        el('strong', null, 'arXiv'), ' (paste 2401.12345 or any arxiv URL) and ',
        el('strong', null, 'DOI'), ' (10.xxxx/yyy or doi.org URL — uses CrossRef). Title, authors, year, abstract, and PDF link populate automatically.'
      ));
    } else {
      helpNodes.push(el('p', { class: 'small muted' },
        'Auto-fetches metadata from ',
        el('strong', null, 'arXiv'), ' (paste 2401.12345 or any arxiv URL), ',
        el('strong', null, 'DOI'), ' (10.xxxx/yyy or doi.org URL — uses CrossRef), and ',
        el('strong', null, 'YouTube'), ' (any watch / youtu.be URL). Other URLs are added with title-only when CORS allows, or just the URL otherwise.'
      ));
      helpNodes.push(el('p', { class: 'small muted' },
        hasYtKey
          ? 'YouTube playlist URLs (?list=…) and channel URLs (youtube.com/@handle, /channel/UC…, /c/, /user/) enumerate every video — capped at 200 per import.'
          : 'Paste a YouTube playlist or @channel URL to add every video — requires a free YouTube Data API key in Settings.'
      ));
    }
    var panel = el('div', { class: 'modal-panel url-import-panel',
      onclick: function (e) { e.stopPropagation(); }
    },
      el('h3', null, 'Add from URL — ', el('code', null, tab)),
      helpNodes,
      input,
      categoryFieldNode,
      // PDF drop/pick zone — only for paper-style sections. Drag a
      // local PDF onto the modal (or click to pick) and Minerva pulls
      // out the arXiv id / DOI / title and auto-fills the form.
      sectionKind === 'papers' || tab === 'library'
        ? renderPdfDropZone(input, function () { lookup(); })
        : null,
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

  function tabHasRefColumn(meta) {
    if (!meta || !meta.types) return false;
    for (var i = 0; i < meta.types.length; i++) {
      var t = M.render.parseType(meta.types[i]);
      if (t && t.kind === 'ref') return true;
    }
    return false;
  }

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
      var parsed = M.render.parseType(type);
      if (parsed.kind === 'drawing') {
        var raw = String(row[h] || '').trim();
        if (raw && raw !== 'pending') {
          var src = /^(https?:|data:)/i.test(raw)
            ? raw
            : 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(raw) + '&sz=w800';
          var big = el('img', {
            class: 'cell-drawing row-detail-drawing',
            loading: 'lazy',
            alt: '',
            src: src
          });
          big.onerror = function () {
            var fb = el('span', { class: 'muted small cell-drawing-fallback' }, '[' + raw + ']');
            if (big.parentNode) big.parentNode.replaceChild(fb, big);
          };
          valueEl.appendChild(big);
        } else if (raw === 'pending') {
          valueEl.appendChild(el('span', { class: 'muted small' }, 'Sketch saved locally — uploads on next sync.'));
        } else {
          valueEl.appendChild(el('span', { class: 'muted small' }, '— no sketch yet —'));
        }
        var actions = el('div', { class: 'row-detail-draw-actions' });
        var editBtn = el('button', {
          class: 'btn btn-ghost row-detail-draw-edit',
          type: 'button',
          onclick: function (e) {
            e.preventDefault();
            e.stopPropagation();
            location.hash = '#/draw/' + encodeURIComponent(tab) +
                            '/' + encodeURIComponent(rowId) +
                            '?col=' + encodeURIComponent(h);
          }
        });
        editBtn.appendChild(M.render.icon('pencil-line'));
        editBtn.appendChild(document.createTextNode(' ' + (raw ? 'Edit sketch' : 'Draw sketch')));
        actions.appendChild(editBtn);

        if (raw && raw !== 'pending') {
          var exportBtn = el('button', {
            class: 'btn btn-ghost row-detail-draw-export',
            type: 'button',
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (M.draw && typeof M.draw.exportPdf === 'function') {
                M.draw.exportPdf(tab, rowId, h).catch(function (err) {
                  console.warn('[Minerva draw] export failed', err);
                  flash(panel, 'Export failed: ' + (err && err.message ? err.message : err), 'error');
                });
              }
            }
          });
          exportBtn.appendChild(M.render.icon('file-down'));
          exportBtn.appendChild(document.createTextNode(' Export PDF'));
          actions.appendChild(exportBtn);

          var exportMdBtn = el('button', {
            class: 'btn btn-ghost row-detail-draw-export-md',
            type: 'button',
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (M.draw && typeof M.draw.exportMarkdown === 'function') {
                M.draw.exportMarkdown(tab, rowId, h).catch(function (err) {
                  console.warn('[Minerva draw] export failed', err);
                  flash(panel, 'Export failed: ' + (err && err.message ? err.message : err), 'error');
                });
              }
            }
          });
          exportMdBtn.appendChild(M.render.icon('file-text'));
          exportMdBtn.appendChild(document.createTextNode(' Export MD'));
          actions.appendChild(exportMdBtn);

          var exportTexBtn = el('button', {
            class: 'btn btn-ghost row-detail-draw-export-tex',
            type: 'button',
            onclick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (M.draw && typeof M.draw.exportLatex === 'function') {
                M.draw.exportLatex(tab, rowId, h).catch(function (err) {
                  console.warn('[Minerva draw] export failed', err);
                  flash(panel, 'Export failed: ' + (err && err.message ? err.message : err), 'error');
                });
              }
            }
          });
          exportTexBtn.appendChild(M.render.icon('file-code-2'));
          exportTexBtn.appendChild(document.createTextNode(' Export TeX'));
          actions.appendChild(exportTexBtn);
        }

        valueEl.appendChild(actions);
      } else {
        valueEl.appendChild(M.render.renderCell(row[h], type));
      }

      function startEditField() {
        if (valueEl.classList.contains('editing')) return;
        // Drawings are opened via the explicit Edit button — not inline.
        if (parsed.kind === 'drawing') {
          location.hash = '#/draw/' + encodeURIComponent(tab) +
                          '/' + encodeURIComponent(rowId) +
                          '?col=' + encodeURIComponent(h);
          return;
        }
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
          },
          { tab: tab, rowId: rowId, col: h }
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

    // "Show in graph" — only when this section participates in the cross-tab
    // graph (i.e. has at least one ref column). Sits with primary actions
    // so it's the obvious next move after viewing a row's fields.
    var graphBtn = null;
    if (tabHasRefColumn(meta)) {
      graphBtn = el('button', { class: 'btn btn-ghost row-detail-graph-link', type: 'button',
        onclick: function () {
          overlay.remove();
          location.hash = '#/graph?focus=' + encodeURIComponent(rowId);
        }
      });
      graphBtn.appendChild(M.render.icon('network'));
      graphBtn.appendChild(document.createTextNode(' Show in graph'));
    }

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
      graphBtn,
      bibtexBtn,
      readConfig().spreadsheetId
        ? el('a', { class: 'btn btn-ghost',
            href: M.sheets.spreadsheetUrl(readConfig().spreadsheetId),
            target: '_blank', rel: 'noopener' }, M.render.icon('external-link'), ' Open in Sheets')
        : null
    ));

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    M.render.refreshIcons();

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
            el('a', { href: '#/settings', onclick: function () { overlay.remove(); } }, 'Open Settings')
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
      voiceBtn ? 'Click the mic button for voice capture (Web Speech API).' : null);

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
      ['n', 'Focus the home quick-add (jumps home if needed)'],
      ['1 – 9', 'Open the Nth section'],
      ['#/graph', 'Cross-tab graph view'],
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
    if (e.key === 'n') {
      // Jump cursor to the home quick-add (or take you home first)
      e.preventDefault();
      var qa = document.querySelector('.home-quick-add');
      if (qa) { qa.focus(); return; }
      location.hash = '#/';
      setTimeout(function () {
        var qa2 = document.querySelector('.home-quick-add');
        if (qa2) qa2.focus();
      }, 80);
      return;
    }

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
    var refreshing = false;
    function reloadOnce(reason) {
      if (refreshing) return;
      refreshing = true;
      console.log('[Minerva sw] reloading for fresh code:', reason);
      // Tiny delay so any in-flight DOM work completes; then reload
      // once. The new SW is now controlling all clients, so the next
      // GET serves the fresh shell.
      setTimeout(function () { location.reload(); }, 50);
    }
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (!reg) return;
      // Eagerly check for an updated SW on every page load. When a new
      // worker is found, it activates immediately (it ships with
      // skipWaiting + clients.claim) and we trigger one transparent
      // reload so the user gets fresh code without manual hard-refresh.
      reg.update().catch(function () { /* offline is fine */ });
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        reloadOnce('controllerchange');
      });
    }).catch(function (e) {
      console.warn('[Minerva sw]', e);
    });
    // Belt-and-braces: the SW also broadcasts a message on activate. If
    // controllerchange somehow doesn't fire in this browser, the message
    // path still triggers the reload.
    navigator.serviceWorker.addEventListener('message', function (e) {
      var data = e && e.data;
      if (data && data.type === 'minerva-sw-activated') {
        reloadOnce('sw-message:' + (data.version || 'unknown'));
      }
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

  // Public surface for sibling modules (graph view, etc.) that want to
  // hand off into existing app flows.
  M.app = M.app || {};
  M.app.showRowDetail = showRowDetail;
  M.app.tabTitle = function (tab) {
    var rows = configCache || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].tab === tab && rows[i].title) return rows[i].title;
    }
    return '';
  };

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

    // Auto-mark watched: when a YouTube URL plays in the preview modal,
    // scan rows across all sections for one whose link cell matches and
    // whose section has watched + watched_at columns; flip them.
    window.addEventListener('minerva:videoplay', function (ev) {
      var url = ev && ev.detail && ev.detail.url;
      if (!url) return;
      markRowWatchedByUrl(url).then(function (changed) {
        // Refresh the section view so the row's `watched` cell visibly
        // flips and the unwatched-only filter (if engaged) drops the row
        // from sight without the user having to navigate away first.
        if (changed && typeof route === 'function') {
          try { route(); } catch (e) { /* ignore */ }
        }
      }).catch(function (e) {
        console.warn('[Minerva markWatched]', e);
      });
    });

    registerServiceWorker();
    // Pre-warm the URL → row index so previews opened from non-
    // section contexts (search, graph, home, deep links) still
    // resolve their offline / Drive-mirror status. The full IDB
    // walk runs once at boot; section views top up as the user
    // navigates.
    rebuildGlobalUrlIndex().catch(function () { /* best-effort */ });
    // Resume any download intents that didn't finish before the
    // last reload — best effort, deferred so the rest of boot
    // doesn't wait on potentially slow re-fetches.
    setTimeout(function () {
      resumePendingDownloads().catch(function (e) {
        console.warn('[Minerva resume]', e);
      });
    }, 1500);
    // Warm the Postgres-mirror probe so the first push has a cached
    // verdict instead of waiting for a network round-trip mid-flush.
    if (Minerva.pg && Minerva.pg.probe) {
      Minerva.pg.probe().catch(function () { /* probe is best-effort */ });
    }
    // Hand the preview module a Drive-backed PDF blob loader so paper
    // rows with a `drive:<fileId>` breadcrumb open the original PDF in
    // the browser's native viewer (with #page=N resume) instead of
    // Drive's preview iframe (which ignores the page fragment).
    if (M.preview && typeof M.preview.setPdfBlobLoader === 'function') {
      M.preview.setPdfBlobLoader(async function (fileId) {
        var c = readConfig();
        if (!c.clientId) throw new Error('Sign in to load Drive-mirrored PDFs.');
        var token = await M.auth.getToken(c.clientId);
        var resp = await fetch(
          'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media',
          { headers: { Authorization: 'Bearer ' + token } }
        );
        if (!resp.ok) throw new Error('Drive PDF fetch ' + resp.status);
        return resp.blob();
      });
    }
    // PDF highlights pane — same dispatch as notes, against
    // row.highlights. Stored as JSON-encoded text; the viewer parses
    // on read and serializes on write so Sheets sees one cell.
    // Resolve a row from (in order of preference):
    //   1. Passed-in ctx — captured by preview at open time, survives
    //      section nav.
    //   2. Section's byUrl + the cross-section globalUrlIndex.
    //   3. A one-shot IDB scan for any row with matching url. The
    //      scan is async so callers must `await` resolveRowCtx in
    //      the new contract; existing sync callers fall through to
    //      whatever the lookup gave them.
    async function resolveRowCtx(url, ctx) {
      if (ctx && ctx.tab && ctx.rowId) return { tab: ctx.tab, rowId: ctx.rowId };
      var lookup = currentOfflineLookup;
      if (lookup) {
        var hit = lookup(url);
        if (hit && hit.tab && hit.rowId) return { tab: hit.tab, rowId: hit.rowId };
      }
      // Last-ditch: walk every section once to find a row with this url.
      try {
        var u = String(url || '').trim();
        var allMeta = await M.db.getAllMeta();
        for (var i = 0; i < allMeta.length; i++) {
          var t = allMeta[i].tab;
          if (t && t.charAt(0) === '_') continue;
          var headers = allMeta[i].headers || [];
          if (headers.indexOf('url') < 0) continue;
          var rows = await M.db.getAllRows(t);
          for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            if (r._deleted) continue;
            if (String(r.url || '').trim() === u) {
              // Top up globalUrlIndex so future lookups skip the scan.
              try {
                var driveMatch = String(r.offline || '').match(/drive:([\w-]{20,})/);
                globalUrlIndex[u] = {
                  tab: t, rowId: r.id, title: r.title || '',
                  driveFileId: driveMatch ? driveMatch[1] : ''
                };
              } catch (e) {}
              return { tab: t, rowId: r.id };
            }
          }
        }
      } catch (e) { /* tolerate */ }
      return null;
    }
    if (M.preview && typeof M.preview.setHighlightsProvider === 'function') {
      M.preview.setHighlightsProvider(async function (url, ctx) {
        var ref = await resolveRowCtx(url, ctx);
        if (!ref) return '';
        var row = await M.db.getRow(ref.tab, ref.rowId);
        return (row && row.highlights) || '';
      });
      M.preview.setHighlightsSaver(async function (url, jsonString, ctx) {
        var ref = await resolveRowCtx(url, ctx);
        if (!ref) throw new Error('No row context for highlights.');
        var row = await M.db.getRow(ref.tab, ref.rowId);
        if (!row) throw new Error('Row gone.');
        if ((row.highlights || '') === (jsonString || '')) return;
        row.highlights = jsonString || '';
        row._dirty = 1;
        row._updated = new Date().toISOString();
        await M.db.upsertRow(ref.tab, row);
        schedulePush();
      });
    }
    // PDF notes pane — bound to the active row's `notes` column.
    // Lookups go through the same byUrl map registerOfflineLookup
    // builds, so both YouTube and Papers sections plug in for free.
    if (M.preview && typeof M.preview.setNotesProvider === 'function') {
      M.preview.setNotesProvider(async function (url, ctx) {
        var ref = await resolveRowCtx(url, ctx);
        if (!ref) return '';
        var row = await M.db.getRow(ref.tab, ref.rowId);
        return (row && row.notes) || '';
      });
      M.preview.setNotesSaver(async function (url, markdown, ctx) {
        var ref = await resolveRowCtx(url, ctx);
        if (!ref) throw new Error('No row context for these notes.');
        var row = await M.db.getRow(ref.tab, ref.rowId);
        if (!row) throw new Error('Row gone.');
        if ((row.notes || '') === (markdown || '')) return;
        row.notes = markdown || '';
        row._dirty = 1;
        row._updated = new Date().toISOString();
        await M.db.upsertRow(ref.tab, row);
        schedulePush();
      });
    }
    // PDF manual-attach. The X-Frame fallback panel offers a "I
    // have a local copy" file picker; that ends up here. Upload the
    // chosen File blob to Drive (using the existing offline-blob
    // pipeline), persist drive:<fileId> back to row.offline so the
    // next preview-open routes through the Drive blob loader.
    if (M.preview && typeof M.preview.setPdfAttachLocal === 'function') {
      M.preview.setPdfAttachLocal(async function (tab, rowId, file) {
        if (!file) throw new Error('No file selected.');
        var name = String(file.name || 'paper.pdf').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        var fid = await uploadOfflineToDrive(file, name);
        if (!fid) throw new Error('Drive upload failed.');
        var meta = await M.db.getMeta(tab);
        if (meta && (meta.headers || []).indexOf('offline') >= 0) {
          var row = await M.db.getRow(tab, rowId);
          if (row) {
            row.offline = 'drive:' + fid;
            row._dirty = 1;
            row._updated = new Date().toISOString();
            await M.db.upsertRow(tab, row);
            schedulePush();
          }
        }
        return fid;
      });
    }
    // Async URL → row resolver. Preview falls through to this when
    // its sync lookup misses; we walk every IDB-backed section and
    // top up the global URL index so future hits are fast.
    if (M.preview && typeof M.preview.setRowResolver === 'function') {
      M.preview.setRowResolver(async function (url) {
        var ref = await resolveRowCtx(url, null);
        if (!ref) return null;
        var row = await M.db.getRow(ref.tab, ref.rowId);
        if (!row) return null;
        var driveMatch = String(row.offline || '').match(/drive:([\w-]{20,})/);
        return {
          tab: ref.tab,
          rowId: ref.rowId,
          title: row.title || '',
          driveFileId: driveMatch ? driveMatch[1] : ''
        };
      });
    }
    // Cross-row link picker for the notes pane. Renders a small
    // overlay with a search input that filters rows from every tab
    // (using the global URL index plus a one-shot DB scan for rows
    // without a URL). Returns a row dict on click, null on cancel.
    if (M.preview && typeof M.preview.setRowPicker === 'function') {
      M.preview.setRowPicker(function () {
        return new Promise(function (resolve) {
          (async function () {
            // Aggregate every row from every section once.
            var pool = [];
            try {
              var allMeta = await M.db.getAllMeta();
              for (var i = 0; i < allMeta.length; i++) {
                var t = allMeta[i].tab;
                if (t && t.charAt(0) === '_') continue;
                var rows = await M.db.getAllRows(t);
                rows.forEach(function (r) {
                  if (r._deleted) return;
                  pool.push({
                    tab: t,
                    id: r.id,
                    title: r.title || r.name || r.id,
                    url: r.url || ''
                  });
                });
              }
            } catch (e) { /* tolerate */ }
            var overlay = el('div', { class: 'modal-overlay row-picker-overlay',
              onclick: function (e) { if (e.target === overlay) { overlay.remove(); resolve(null); } }
            });
            var panel = el('div', { class: 'modal-panel row-picker-panel',
              onclick: function (e) { e.stopPropagation(); }
            });
            var input = el('input', { type: 'text', class: 'row-picker-input',
              placeholder: 'Search every section… (type a few characters)' });
            var list = el('div', { class: 'row-picker-list' });
            function paint(filter) {
              while (list.firstChild) list.removeChild(list.firstChild);
              var q = String(filter || '').toLowerCase().trim();
              var hits = pool;
              if (q) {
                hits = pool.filter(function (p) {
                  return (p.title || '').toLowerCase().indexOf(q) >= 0
                      || (p.url || '').toLowerCase().indexOf(q) >= 0
                      || (p.tab || '').toLowerCase().indexOf(q) >= 0;
                });
              }
              hits.slice(0, 100).forEach(function (p) {
                var row = el('button', { type: 'button', class: 'row-picker-item',
                  onclick: function () { overlay.remove(); resolve(p); }
                });
                row.appendChild(el('span', { class: 'row-picker-tab' }, p.tab));
                row.appendChild(el('span', { class: 'row-picker-title' }, p.title));
                if (p.url) row.appendChild(el('span', { class: 'row-picker-url small muted' }, p.url));
                list.appendChild(row);
              });
              if (!hits.length) {
                list.appendChild(el('p', { class: 'small muted', style: 'padding:0.6rem' },
                  q ? 'No matches.' : 'Loading…'));
              }
            }
            input.addEventListener('input', function () { paint(input.value); });
            input.addEventListener('keydown', function (e) {
              if (e.key === 'Escape') { overlay.remove(); resolve(null); }
            });
            panel.appendChild(input);
            panel.appendChild(list);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            paint('');
            input.focus();
          })();
        });
      });
    }
    // Save-to-host. Visible in preview when the helper is reachable
    // and the active item is a PDF or an offline-blob video. Pulls
    // the bytes (Drive blob loader for PDFs, IDB videos store for
    // YouTube), POSTs to /file/save, then asks /file/reveal to open
    // the host file manager.
    if (M.preview && typeof M.preview.setSaveToHost === 'function') {
      M.preview.setSaveToHost(async function (kind, suggestedName, sourceUrl) {
        var endpoint = String(readConfig().ytDlpServer || '').trim().replace(/\/+$/, '');
        if (!endpoint) throw new Error('Set the helper URL in Settings first.');
        var lookup = currentOfflineLookup;
        var hit = lookup ? lookup(sourceUrl) : null;
        var bytes = null;
        var ext = '';
        if (hit && hit.driveFileId) {
          var c = readConfig();
          if (!c.clientId) throw new Error('Sign in first.');
          var token = await M.auth.getToken(c.clientId);
          var resp = await fetch(
            'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(hit.driveFileId) + '?alt=media',
            { headers: { Authorization: 'Bearer ' + token } }
          );
          if (!resp.ok) throw new Error('Drive fetch ' + resp.status);
          bytes = await resp.arrayBuffer();
          ext = '.pdf';
        } else if (hit && hit.tab && hit.rowId) {
          var rec = await M.db.getVideo(hit.tab, hit.rowId);
          if (!rec || !rec.blob) throw new Error('No offline blob to save.');
          bytes = await rec.blob.arrayBuffer();
          ext = (rec.mime && /mp4/i.test(rec.mime)) ? '.mp4' : '';
        } else {
          throw new Error('No source data on this row.');
        }
        var name = suggestedName + (ext && !suggestedName.toLowerCase().endsWith(ext) ? ext : '');
        var saveResp = await fetch(
          endpoint + '/file/save?kind=' + encodeURIComponent(kind)
            + '&name=' + encodeURIComponent(name),
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
        );
        var saveJson = await saveResp.json();
        if (!saveJson.ok) throw new Error(saveJson.error || ('save ' + saveResp.status));
        var revealResp = await fetch(endpoint + '/file/reveal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: saveJson.path })
        });
        var revealJson = {};
        try { revealJson = await revealResp.json(); } catch (e) {}
        return {
          path: saveJson.path,
          in_container: !!revealJson.in_container
        };
      });
    }
    // PDF auto-mirror on demand. Lets preview.js trigger a Drive
    // upload + breadcrumb-write the moment the user opens a paper
    // without an offline copy yet, so the preview ends up showing
    // the offline PDF instead of trying to iframe an X-Frame-blocked
    // arxiv URL.
    if (M.preview && typeof M.preview.setPdfMirrorOnDemand === 'function') {
      M.preview.setPdfMirrorOnDemand(async function (tab, rowId) {
        var meta = await M.db.getMeta(tab);
        if (!meta || (meta.headers || []).indexOf('offline') < 0) {
          throw new Error('Section has no offline column.');
        }
        var row = await M.db.getRow(tab, rowId);
        if (!row) throw new Error('Row gone.');
        // Re-check whether another flow already populated the
        // breadcrumb between when the preview opened and when we
        // got here — avoid a duplicate upload.
        var existing = String(row.offline || '').match(/drive:([\w-]{20,})/);
        if (existing) return existing[1];
        var pdfUrl = String(row.pdf || '').trim() || (function () {
          var u = String(row.url || '').trim();
          if (/arxiv\.org\/abs\//i.test(u)) {
            return u.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
          }
          return u;
        })();
        if (!pdfUrl) throw new Error('No PDF URL on row.');
        var fid = await uploadPaperPdfToDrive(pdfUrl, row.title || row.id);
        if (!fid) throw new Error('Drive upload returned no fileId.');
        var fresh = await M.db.getRow(tab, rowId);
        if (fresh) {
          fresh.offline = 'drive:' + fid;
          fresh._dirty = 1;
          fresh._updated = new Date().toISOString();
          await M.db.upsertRow(tab, fresh);
          schedulePush();
        }
        return fid;
      });
    }
    // PDF extractor → Drive sibling. Uploads the extracted JSON to
    // Drive next to the original PDF (same scope as the offline blob
    // mirror) so structured data round-trips through the user's own
    // storage. Returns { id, link } so the modal can render the
    // open-in-Drive link.
    if (M.preview && typeof M.preview.setPdfExtractDriveSaver === 'function') {
      M.preview.setPdfExtractDriveSaver(async function (pdfUrl, payload) {
        if (!M.auth || !M.sheets) {
          throw new Error('Sign in first.');
        }
        var c = readConfig();
        if (!c.clientId) throw new Error('Sign in first.');
        var token = await M.auth.getToken(c.clientId);
        // Pretty-print the JSON; fall back to raw_text if we got one.
        var body;
        if (payload && typeof payload === 'object') {
          try { body = JSON.stringify(payload, null, 2); }
          catch (e) { body = String(payload.raw_text || payload); }
        } else {
          body = String(payload || '');
        }
        // Derive a name from the URL's last segment so the Drive
        // listing is at least vaguely identifiable.
        var stem = (function () {
          try {
            var u = new URL(pdfUrl);
            var last = (u.pathname.split('/').pop() || 'paper').replace(/\.pdf$/i, '');
            return last || 'paper';
          } catch (e) { return 'paper'; }
        })();
        var name = stem.replace(/[^\w.\- ]+/g, '_').slice(0, 80) + '.extract.json';
        var resp = await M.sheets.uploadDriveFile(
          token, name, 'application/json; charset=utf-8', body, null
        );
        return { id: resp.id, link: resp.webViewLink || null };
      });
    }
    // PDF data extractor — wraps minerva-services' /pdf/extract route
    // (opendataloader-pdf). The endpoint lives on the same container
    // the user already pointed `ytDlpServer` at, so reuse that URL.
    if (M.preview && typeof M.preview.setPdfExtractor === 'function') {
      M.preview.setPdfExtractor(async function (pdfUrl) {
        var endpoint = String((readConfig().ytDlpServer || '')).trim().replace(/\/+$/, '');
        if (!endpoint) {
          throw new Error('Set a yt-dlp / minerva-services URL in Settings first.');
        }
        var resp = await fetch(endpoint + '/pdf/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: pdfUrl })
        });
        var json;
        try { json = await resp.json(); }
        catch (e) {
          var txt = await resp.text();
          throw new Error('Non-JSON response: ' + txt.slice(0, 300));
        }
        if (!resp.ok || !json.ok) {
          throw new Error(json.error || ('HTTP ' + resp.status));
        }
        return json.data;
      });
    }
    // Consume an OAuth implicit-flow callback fragment (#access_token=…)
    // if the URL carries one. On success the call cleans the URL and
    // the user lands back at the route they kicked off Connect from.
    var redirectToken = null;
    if (M.auth && typeof M.auth.consumeRedirectCode === 'function') {
      try { redirectToken = await M.auth.consumeRedirectCode(); }
      catch (err) {
        console.warn('[Minerva oauth-redirect]', err);
        setAuthError('Sign-in failed: ' + (err && err.message || err));
      }
    }
    // Finish the rest of the connect flow before any subsequent code
    // can call M.auth.getToken() — otherwise an unsynced token state
    // races with loadDriveConfigIfPresent() and triggers a fresh
    // redirect-to-Google, looping the page back into another sign-in.
    if (redirectToken) {
      try { await finishOAuthBootstrap(redirectToken); }
      catch (err) {
        console.warn('[Minerva post-redirect-bootstrap]', err);
        setAuthError('Connect failed after sign-in: ' + (err && err.message || err));
      }
    }
    await refreshConfig();
    // Skip the cold-boot Drive-config probe when we just ran the full
    // bootstrap above; finishOAuthBootstrap already pulled the file.
    if (!redirectToken) {
      loadDriveConfigIfPresent().catch(function () { /* ignore */ });
    }

    // Restore last view if the user landed on a bare URL. Settings is
    // a configuration surface — never the user's "home" — so we
    // explicitly skip it: typing the bare host should always land on
    // the actual home page, not bounce you back into a settings sub-
    // section just because that's where you last clicked. Same for
    // share/auth/draw transient flows.
    if (!location.hash || location.hash === '' || location.hash === '#') {
      var s = readUi();
      var skip = !s || !s.hash
        || s.hash === '#/' || s.hash === '#'
        || /^#\/(settings|share|p|capture|search|draw|meet|avail)/.test(s.hash);
      if (!skip && (!s.when || Date.now() - s.when < 7 * 86400000)) {
        location.hash = s.hash;
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
