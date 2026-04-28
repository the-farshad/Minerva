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

  function renderNav(active) {
    var items = [
      { hash: '#/',         label: 'Home' },
      { hash: '#/share',    label: 'Quick share' },
      { hash: '#/settings', label: 'Settings' }
    ];
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

  function viewHome() {
    var cfg = readConfig();
    var st = M.auth ? M.auth.getState() : { hasToken: false, email: null };
    var connected = st.hasToken && cfg.spreadsheetId;

    var primaryCta = connected
      ? el('a', { class: 'btn', href: M.sheets.spreadsheetUrl(cfg.spreadsheetId), target: '_blank', rel: 'noopener' }, 'Open your spreadsheet ↗')
      : (cfg.clientId
          ? el('a', { class: 'btn', href: '#/settings' }, 'Connect your Google account →')
          : el('a', { class: 'btn', href: '#/settings' }, 'Set up in Settings →'));

    return el('section', { class: 'view' },
      el('h2', null, connected ? 'Welcome back' + (st.email ? ', ' + st.email : '') : 'Welcome to Minerva'),
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
      ),
      el('p', { class: 'small muted' }, connected
        ? 'Phase 1 connected. Dynamic sections (Phase 2) read straight from your `_config` tab — coming next.'
        : 'Phase 1 — auth + spreadsheet bootstrap. Dynamic sections from the spreadsheet land next.'
      )
    );
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
    function paintStatus(stage) {
      var c = readConfig();
      var state = M.auth ? M.auth.getState() : { hasToken: false, email: null };
      var ok = state.hasToken && c.spreadsheetId;
      var stageLabels = {
        auth: 'Opening Google sign-in…',
        bootstrap: 'Setting up your Minerva spreadsheet…',
        done: ''
      };
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
                }
              } }, 'Disconnect')
            : el('button', { class: 'btn', type: 'button',
                disabled: !c.clientId,
                onclick: function () { void connect(); }
              }, 'Connect Google'),
          ok
            ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () { void connect(); } }, 'Re-run bootstrap')
            : null
        )
      );
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
        paintStatus('done');
        flash(status, bs.fresh ? 'Spreadsheet created and seeded.' : 'Connected to your existing Minerva spreadsheet.');
      } catch (err) {
        paintStatus();
        flash(status, 'Connect failed: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    paintStatus();

    return el('section', { class: 'view' },
      el('h2', null, 'Settings'),
      el('p', { class: 'lead' },
        'Minerva keeps no secrets in its repo. You bring your own Google OAuth client; Minerva remembers it locally. ',
        el('a', { href: 'https://github.com/the-farshad/Minerva#phase-1--bring-your-own-google-oauth-client', target: '_blank', rel: 'noopener' }, 'Setup walkthrough →')
      ),
      form,
      status
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

  function route() {
    setBusy(true);
    var hash = location.hash || '#/';
    var view, active = '';

    if (hash === '#/' || hash === '' || hash === '#') {
      view = viewHome(); active = '#/';
    } else if (hash === '#/settings') {
      view = viewSettings(); active = '#/settings';
    } else if (/^#\/share(\/.*)?$/.test(hash)) {
      view = viewShare(); active = '#/share';
    } else if (/^#\/p\/.+/.test(hash)) {
      view = viewPublic(hash.replace(/^#\/p\//, ''));
    } else {
      view = viewNotFound(hash);
    }

    renderNav(active);
    content.replaceChildren(view);
    setBusy(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ---- keyboard shortcuts ----

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'g') location.hash = '#/';
    else if (e.key === 's') location.hash = '#/settings';
    else if (e.key === 'q') location.hash = '#/share';
  });

  // ---- boot ----

  function boot() {
    bindPicker();
    route();
  }

  window.addEventListener('hashchange', route);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
