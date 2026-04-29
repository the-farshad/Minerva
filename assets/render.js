/* Minerva — schema parsing + type-aware cell rendering.
 *
 * The "schema language" is a tiny shape — see ROADMAP §1a for the long
 * version. A type hint is one of:
 *   text | longtext | markdown | number | date | datetime | duration |
 *   check | select(a,b,c) | multiselect(a,b,c) | link | email | tel |
 *   ref(tab) | ref(tab,multi) | drive | image | progress(0..100) |
 *   rating(0..5) | color | code(lang) | json
 *
 * Phase 2 uses these only for *display*. Phase 3 will dispatch on the same
 * parsed shape to pick the right inline editor.
 */
(function () {
  'use strict';

  // ---- type parsing -----------------------------------------------------

  function parseType(raw) {
    var s = String(raw || 'text').trim().toLowerCase();
    var m = s.match(/^([a-z]+)(?:\(([^)]*)\))?$/);
    if (!m) return { kind: 'text', raw: raw };
    var kind = m[1];
    var args = (m[2] || '').trim();
    var t = { kind: kind, raw: raw };
    if (kind === 'select' || kind === 'multiselect') {
      t.options = args.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    } else if (kind === 'progress') {
      var p = (args || '0..100').split('..');
      t.min = +p[0] || 0;
      t.max = +p[1] || 100;
    } else if (kind === 'rating') {
      var r = (args || '0..5').split('..');
      t.min = +r[0] || 0;
      t.max = +r[1] || 5;
    } else if (kind === 'ref') {
      var parts = args.split(',').map(function (x) { return x.trim(); });
      t.refTab = parts[0] || '';
      t.multi = parts.indexOf('multi') >= 0;
    } else if (kind === 'code') {
      t.lang = args;
    }
    return t;
  }

  function isInternal(headerName) {
    return !headerName || headerName.charAt(0) === '_';
  }

  // ---- helpers ----------------------------------------------------------

  function span(cls, text) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }

  function renderMarkdown(value) {
    if (value == null || value === '') return document.createTextNode('');
    var src = String(value);
    if (typeof marked === 'undefined' || !marked.parse) {
      return span(null, truncate(src, 140));
    }
    var div = document.createElement('div');
    div.className = 'md-cell';
    try {
      // marked sanitizes raw HTML out by default in v12 (sanitize was removed
      // but raw HTML rendering is still off without explicit options). Good
      // enough — this is the user's own data anyway.
      div.innerHTML = marked.parse(src, { breaks: true, gfm: true });
      // open external links in a new tab.
      div.querySelectorAll('a[href^="http"]').forEach(function (a) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
    } catch (e) {
      div.textContent = truncate(src, 140);
    }
    return div;
  }

  function renderLatex(value) {
    if (value == null || value === '') return document.createTextNode('');
    var src = String(value);
    var s = document.createElement('span');
    s.className = 'latex-cell';
    if (typeof katex !== 'undefined' && katex.render) {
      try {
        // Display math when the source contains a newline; inline otherwise.
        var displayMode = /\n/.test(src);
        katex.render(src, s, {
          throwOnError: false,
          displayMode: displayMode,
          output: 'html'
        });
        return s;
      } catch (e) {
        // fall through to text fallback
      }
    }
    s.textContent = truncate(src, 140);
    s.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    return s;
  }

  function slugify(v) {
    return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function truncate(v, n) {
    if (v == null) return '';
    var s = String(v);
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  function formatDate(v) {
    if (v == null || v === '') return '';
    var s = String(v);
    // Sheets often returns ISO YYYY-MM-DD as text under USER_ENTERED; pass through.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return s;
  }

  function formatDateTime(v) {
    if (v == null || v === '') return '';
    var s = String(v);
    var d = new Date(s);
    if (!isNaN(d)) {
      // 2026-04-28 14:32
      var iso = d.toISOString();
      return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
    }
    return s;
  }

  function relativeTime(ts) {
    if (!ts) return '';
    var d = Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts));
    if (isNaN(d)) return '';
    if (d < 5000) return 'just now';
    if (d < 60000) return Math.round(d / 1000) + 's ago';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    if (d < 7 * 86400000) return Math.round(d / 86400000) + 'd ago';
    return formatDate(ts);
  }

  // ---- per-type renderers ----------------------------------------------

  function renderProgress(value, t) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    var pct = Math.max(0, Math.min(100, ((n - t.min) / (t.max - t.min)) * 100));
    var wrap = document.createElement('span');
    wrap.className = 'pbar';
    var fill = document.createElement('span');
    fill.className = 'pbar-fill';
    fill.style.width = pct + '%';
    wrap.appendChild(fill);
    var label = document.createElement('span');
    label.className = 'pbar-label';
    label.textContent = Math.round(pct) + '%';
    wrap.appendChild(label);
    return wrap;
  }

  function renderRating(value, t) {
    var n = Math.max(t.min, Math.min(t.max, Number(value) || 0));
    var s = span('stars');
    var filled = '★'.repeat(n);
    var empty = '☆'.repeat(t.max - n);
    s.textContent = filled + empty;
    s.title = n + ' / ' + t.max;
    return s;
  }

  function renderChip(value) {
    if (value == null || value === '') return document.createTextNode('');
    var c = span('chip chip-' + slugify(value), String(value));
    return c;
  }

  function renderMultiChips(value) {
    var arr = String(value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!arr.length) return document.createTextNode('');
    var wrap = document.createElement('span');
    wrap.className = 'chips';
    arr.forEach(function (v) { wrap.appendChild(renderChip(v)); });
    return wrap;
  }

  function renderCheck(value) {
    var on = value === true || value === 'TRUE' || value === 'true' || value === 1 || value === '1';
    var s = span('check' + (on ? ' check-on' : ' check-off'), on ? '☑' : '☐');
    return s;
  }

  function isPdfUrl(s) {
    return /\.pdf(\?|#|$)/i.test(String(s || '')) || /arxiv\.org\/pdf\//i.test(String(s || ''));
  }

  function isYouTubeUrl(s) {
    return /youtube\.com\/watch|youtu\.be\//i.test(String(s || ''));
  }

  function renderLink(value) {
    if (!value) return document.createTextNode('');
    var raw = String(value);
    var wrap = document.createElement('span');
    wrap.className = 'cell-link-wrap';

    var a = document.createElement('a');
    a.href = raw;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'cell-link';
    var host = '';
    try { host = new URL(raw).hostname.replace(/^www\./, ''); } catch (e) { host = raw; }
    a.textContent = '↗ ' + host;
    a.title = raw;
    wrap.appendChild(a);

    var canPreview = isPdfUrl(raw) || isYouTubeUrl(raw);
    if (canPreview && window.Minerva && window.Minerva.preview) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell-preview';
      btn.title = 'Preview ' + (isPdfUrl(raw) ? 'PDF' : 'video');
      btn.textContent = '👁';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.Minerva.preview.show(raw);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function renderRef(value, t) {
    if (!value) return document.createTextNode('');
    if (!t.multi) {
      var a = document.createElement('a');
      a.href = '#/s/' + encodeURIComponent(t.refTab);
      a.className = 'cell-ref';
      a.textContent = String(value);
      a.title = 'Open ' + t.refTab;
      return a;
    }
    var ids = String(value).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!ids.length) return document.createTextNode('');
    var wrap = document.createElement('span');
    wrap.className = 'chips';
    ids.forEach(function (id) {
      var a = document.createElement('a');
      a.href = '#/s/' + encodeURIComponent(t.refTab);
      a.className = 'chip chip-ref';
      a.textContent = id;
      wrap.appendChild(a);
    });
    return wrap;
  }

  function renderColor(value) {
    if (!value) return document.createTextNode('');
    var sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = String(value);
    sw.title = String(value);
    var w = document.createElement('span');
    w.className = 'color-cell';
    w.appendChild(sw);
    w.appendChild(document.createTextNode(' ' + value));
    return w;
  }

  function renderImage(value) {
    if (!value) return document.createTextNode('');
    var img = document.createElement('img');
    img.src = String(value);
    img.alt = '';
    img.className = 'cell-img';
    img.loading = 'lazy';
    return img;
  }

  // ---- dispatch ---------------------------------------------------------

  function renderCell(value, type) {
    var t = (type && typeof type === 'object') ? type : parseType(type);
    switch (t.kind) {
      case 'check':       return renderCheck(value);
      case 'date':        return span(null, formatDate(value));
      case 'datetime':    return span(null, formatDateTime(value));
      case 'progress':    return renderProgress(value, t);
      case 'rating':      return renderRating(value, t);
      case 'select':      return renderChip(value);
      case 'multiselect': return renderMultiChips(value);
      case 'link':        return renderLink(value);
      case 'ref':         return renderRef(value, t);
      case 'color':       return renderColor(value);
      case 'image':       return renderImage(value);
      case 'number':      return span('num', value == null ? '' : String(value));
      case 'markdown':
        return renderMarkdown(value);
      case 'latex':
        return renderLatex(value);
      case 'longtext': {
        // longtext is treated as plain prose with paragraph breaks preserved.
        var s = String(value == null ? '' : value);
        if (!s) return document.createTextNode('');
        var pre = document.createElement('div');
        pre.className = 'md-cell';
        pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = s;
        return pre;
      }
      case 'json':
      case 'code':
      case 'text':
      default:
        return span(null, truncate(value == null ? '' : String(value), 140));
    }
  }

  // ---- sort + filter (driven by _config) -------------------------------

  function applySort(rows, sortSpec) {
    if (!sortSpec) return rows;
    var parts = String(sortSpec).split(':');
    var col = parts[0];
    var desc = parts[1] === 'desc';
    return rows.slice().sort(function (a, b) {
      var av = a[col];
      var bv = b[col];
      if (av == null) av = '';
      if (bv == null) bv = '';
      var cmp;
      var an = Number(av), bn = Number(bv);
      if (av !== '' && bv !== '' && isFinite(an) && isFinite(bn)) cmp = an - bn;
      else cmp = String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });
  }

  function applyFilter(rows, filterSpec) {
    if (!filterSpec) return rows;
    var parsed = String(filterSpec).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return rows.filter(function (r) {
      return parsed.every(function (clause) {
        var m = clause.match(/^([A-Za-z_][A-Za-z0-9_]*):(!=|=)?(.*)$/);
        if (!m) return true;
        var col = m[1];
        var op = m[2] || '=';
        var val = m[3];
        var v = r[col] == null ? '' : String(r[col]);
        return op === '!=' ? v !== val : v === val;
      });
    });
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.render = {
    parseType: parseType,
    isInternal: isInternal,
    renderCell: renderCell,
    applySort: applySort,
    applyFilter: applyFilter,
    relativeTime: relativeTime
  };
})();
