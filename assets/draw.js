/* Minerva — touch-screen sketch editor.
 *
 * Mounts a full-screen canvas into #content. Pointer Events drive a single
 * stroke at a time; finger and Apple-Pencil pressure share the same code
 * path, branching on `pointerType` for the variable-width curve.
 *
 * Strokes are kept locally in IndexedDB (the `drawings` store) until sync
 * runs, at which point the SVG is multipart-uploaded to Drive and the
 * resulting fileId is written into the row cell. The cell holds the literal
 * string 'pending' between save and successful upload so renderCell shows a
 * placeholder rather than a broken image.
 *
 * Public surface: openEditor, upsertBlob, flushPending, refreshIcons.
 */
(function () {
  'use strict';

  var M = window.Minerva || (window.Minerva = {});

  // ---- DOM helpers (local copies — house style) -----------------------

  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var k2 = arguments[i];
      if (k2 == null || k2 === false) continue;
      if (typeof k2 === 'string') n.appendChild(document.createTextNode(k2));
      else n.appendChild(k2);
    }
    return n;
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (e) { /* ignore */ }
    }
  }

  // ---- palette + widths -----------------------------------------------

  // Five swatches that stay legible on every Minerva theme. The first uses
  // currentColor so it tracks the foreground (black on light, near-white on
  // dark, deep brown on sepia); the rest are mid-saturation hues that pass
  // contrast on both light and dark backgrounds.
  var COLORS = [
    { id: 'fg',     value: 'currentColor', label: 'Default' },
    { id: 'red',    value: '#d83b3b',      label: 'Red'    },
    { id: 'amber',  value: '#d18a1a',      label: 'Amber'  },
    { id: 'green',  value: '#2f8a4a',      label: 'Green'  },
    { id: 'blue',   value: '#3a72c2',      label: 'Blue'   }
  ];

  var WIDTHS = [
    { id: 'thin',   value: 1.5, label: 'Thin'   },
    { id: 'medium', value: 3.0, label: 'Medium' },
    { id: 'thick',  value: 6.0, label: 'Thick'  }
  ];

  // ---- editor state ----------------------------------------------------

  function newState() {
    return {
      tab: '',
      rowId: '',
      col: '',
      title: '',
      width: WIDTHS[1].value,
      colorId: 'fg',
      colorValue: COLORS[0].value,
      strokes: [],          // [{ color, baseWidth, pointerType, points: [{x,y,p}, ...] }]
      undone: [],
      current: null,
      W: 0,
      H: 0,
      dpr: 1,
      canvas: null,
      ctx: null,
      headerEl: null
    };
  }

  // ---- SVG serialization ----------------------------------------------

  // Build a path `d` string from a stroke's points. Plain `M / L` segments
  // are good enough for slice 2; the smoothing pass is a slice-6 polish.
  function pathD(points) {
    if (!points || !points.length) return '';
    var d = 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
    for (var i = 1; i < points.length; i++) {
      d += ' L ' + fmt(points[i].x) + ' ' + fmt(points[i].y);
    }
    return d;
  }

  function fmt(n) {
    // Trim to 2 decimal places — keeps SVG bytes reasonable without visibly
    // losing fidelity at 1× canvas resolution.
    return (Math.round(n * 100) / 100).toString();
  }

  // For pen strokes (variable width) we approximate with multiple short
  // sub-paths, each at the average width of its endpoints. Touch / mouse
  // strokes emit a single path at base width.
  function strokesToSvg(strokes, width, height) {
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
               '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      var pts = s.points || [];
      if (pts.length < 1) continue;
      // Single-point stroke → emit a tiny dot via line-of-zero-length.
      if (pts.length === 1) {
        var p0 = pts[0];
        var w0 = s.baseWidth * (s.pointerType === 'pen' ? (0.3 + 0.7 * (p0.p || 0.5)) : 1);
        parts.push(svgPath('M ' + fmt(p0.x) + ' ' + fmt(p0.y) + ' L ' + fmt(p0.x + 0.01) + ' ' + fmt(p0.y), s.color, w0));
        continue;
      }
      if (s.pointerType === 'pen') {
        // Per-segment width using the pressure curve.
        for (var j = 1; j < pts.length; j++) {
          var a = pts[j - 1], b = pts[j];
          var pa = (a.p == null ? 0.5 : a.p);
          var pb = (b.p == null ? 0.5 : b.p);
          var avg = (pa + pb) / 2;
          var w = s.baseWidth * (0.3 + 0.7 * avg);
          parts.push(svgPath(
            'M ' + fmt(a.x) + ' ' + fmt(a.y) + ' L ' + fmt(b.x) + ' ' + fmt(b.y),
            s.color, w
          ));
        }
      } else {
        parts.push(svgPath(pathD(pts), s.color, s.baseWidth));
      }
    }
    parts.push('</svg>');
    return parts.join('');
  }

  function svgPath(d, stroke, width) {
    var color = stroke;
    // currentColor in saved SVG falls back to black inside Drive's previewer
    // (it has no inherited color). Resolve it to an explicit hex at save time
    // by reading the canvas-resolved foreground.
    if (color === 'currentColor') color = resolvedFg();
    return '<path d="' + d + '" stroke="' + escapeAttr(color) +
           '" stroke-width="' + fmt(width) +
           '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  var _fgCache = null;
  function resolvedFg() {
    if (_fgCache) return _fgCache;
    var probe = document.createElement('span');
    probe.style.color = 'var(--fg, #1a1a1a)';
    document.body.appendChild(probe);
    var c = window.getComputedStyle(probe).color || '#1a1a1a';
    document.body.removeChild(probe);
    _fgCache = rgbToHex(c) || '#1a1a1a';
    return _fgCache;
  }

  function rgbToHex(s) {
    var m = String(s).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    function h(n) { var x = parseInt(n, 10).toString(16); return x.length === 1 ? '0' + x : x; }
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ---- canvas drawing --------------------------------------------------

  function resizeCanvas(state) {
    var c = state.canvas;
    if (!c) return;
    var rect = c.getBoundingClientRect();
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    state.W = Math.max(1, Math.floor(rect.width));
    state.H = Math.max(1, Math.floor(rect.height));
    state.dpr = dpr;
    c.width = Math.floor(state.W * dpr);
    c.height = Math.floor(state.H * dpr);
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    state.ctx = ctx;
    repaint(state);
  }

  function repaint(state) {
    var ctx = state.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, state.W, state.H);
    var i;
    for (i = 0; i < state.strokes.length; i++) drawStroke(ctx, state.strokes[i]);
    if (state.current) drawStroke(ctx, state.current);
  }

  function drawStroke(ctx, s) {
    var pts = s.points;
    if (!pts || !pts.length) return;
    var color = s.color === 'currentColor' ? resolvedFg() : s.color;
    if (s.pointerType === 'pen' && pts.length > 1) {
      // Variable-width preview: draw segment-by-segment.
      for (var j = 1; j < pts.length; j++) {
        var a = pts[j - 1], b = pts[j];
        var pa = (a.p == null ? 0.5 : a.p);
        var pb = (b.p == null ? 0.5 : b.p);
        var avg = (pa + pb) / 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = s.baseWidth * (0.3 + 0.7 * avg);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pts.length === 1) {
        // Lone point — draw a small dot.
        ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = s.baseWidth;
      ctx.stroke();
    }
  }

  // ---- pointer handling ------------------------------------------------

  function pointFromEvent(e, canvas) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      p: (e.pressure != null && e.pressure > 0) ? e.pressure : 0.5,
      t: e.timeStamp
    };
  }

  function bindPointer(state) {
    var c = state.canvas;
    c.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      state.current = {
        color: state.colorValue,
        baseWidth: state.width,
        pointerType: e.pointerType || 'mouse',
        points: [pointFromEvent(e, c)]
      };
      state.undone = [];
      repaint(state);
    });
    c.addEventListener('pointermove', function (e) {
      if (!state.current) return;
      e.preventDefault();
      var pt = pointFromEvent(e, c);
      state.current.points.push(pt);
      repaint(state);
    });
    function endStroke(e) {
      if (!state.current) return;
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      state.strokes.push(state.current);
      state.current = null;
      repaint(state);
    }
    c.addEventListener('pointerup', endStroke);
    c.addEventListener('pointercancel', endStroke);
    c.addEventListener('pointerleave', function (e) {
      if (state.current) endStroke(e);
    });
  }

  function undo(state) {
    if (!state.strokes.length) return;
    state.undone.push(state.strokes.pop());
    repaint(state);
  }

  // ---- toolbar ---------------------------------------------------------

  function buildToolbar(state, onSave, onDiscard) {
    var bar = el('div', { class: 'draw-toolbar', role: 'toolbar', 'aria-label': 'Sketch tools' });

    var titleEl = el('span', { class: 'draw-title' }, state.title || 'Untitled sketch');
    bar.appendChild(titleEl);

    // Color swatches
    var colorWrap = el('span', { class: 'draw-colors', role: 'group', 'aria-label': 'Color' });
    COLORS.forEach(function (c) {
      var b = el('button', {
        class: 'draw-color' + (c.id === state.colorId ? ' is-active' : ''),
        type: 'button',
        title: c.label,
        'aria-label': c.label,
        'aria-pressed': c.id === state.colorId ? 'true' : 'false',
        'data-color': c.id
      });
      // Swatch fill — set as background. currentColor would leak text decor
      // colors so we resolve to fg explicitly for the default swatch.
      b.style.background = c.value;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        state.colorId = c.id;
        state.colorValue = c.value;
        var btns = colorWrap.querySelectorAll('.draw-color');
        for (var i = 0; i < btns.length; i++) {
          var on = btns[i].getAttribute('data-color') === c.id;
          btns[i].classList.toggle('is-active', on);
          btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      });
      colorWrap.appendChild(b);
    });
    bar.appendChild(colorWrap);

    // Width buttons
    var widthWrap = el('span', { class: 'draw-widths', role: 'group', 'aria-label': 'Width' });
    WIDTHS.forEach(function (w) {
      var b = el('button', {
        class: 'draw-width' + (w.value === state.width ? ' is-active' : ''),
        type: 'button',
        title: w.label,
        'aria-label': w.label,
        'aria-pressed': w.value === state.width ? 'true' : 'false',
        'data-width': w.id
      });
      var dot = el('span', { class: 'draw-width-dot' });
      dot.style.width = (w.value * 2) + 'px';
      dot.style.height = (w.value * 2) + 'px';
      b.appendChild(dot);
      b.addEventListener('click', function (e) {
        e.preventDefault();
        state.width = w.value;
        var btns = widthWrap.querySelectorAll('.draw-width');
        for (var i = 0; i < btns.length; i++) {
          var on = btns[i].getAttribute('data-width') === w.id;
          btns[i].classList.toggle('is-active', on);
          btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      });
      widthWrap.appendChild(b);
    });
    bar.appendChild(widthWrap);

    // Undo
    var undoBtn = el('button', {
      class: 'btn btn-ghost draw-undo',
      type: 'button',
      title: 'Undo last stroke',
      'aria-label': 'Undo last stroke',
      onclick: function (e) { e.preventDefault(); undo(state); }
    });
    undoBtn.appendChild(M.render.icon('undo-2'));
    undoBtn.appendChild(document.createTextNode(' Undo'));
    bar.appendChild(undoBtn);

    // Discard / Save
    var discardBtn = el('button', {
      class: 'btn btn-ghost draw-discard',
      type: 'button',
      title: 'Discard sketch',
      'aria-label': 'Discard sketch',
      onclick: function (e) { e.preventDefault(); onDiscard(); }
    });
    discardBtn.appendChild(M.render.icon('x'));
    discardBtn.appendChild(document.createTextNode(' Discard'));
    bar.appendChild(discardBtn);

    var saveBtn = el('button', {
      class: 'btn draw-save',
      type: 'button',
      title: 'Save sketch',
      'aria-label': 'Save sketch',
      onclick: function (e) { e.preventDefault(); onSave(); }
    });
    saveBtn.appendChild(M.render.icon('check'));
    saveBtn.appendChild(document.createTextNode(' Save'));
    bar.appendChild(saveBtn);

    return bar;
  }

  // ---- existing-content load ------------------------------------------

  function fetchSvgIfPossible(value) {
    // Best-effort: try the public Drive download URL. Many drawings will be
    // private so this fetch will 403 — that's expected. Returns null on any
    // failure so the editor opens blank.
    if (!value) return Promise.resolve(null);
    var raw = String(value).trim();
    if (!raw) return Promise.resolve(null);
    var url;
    if (/^data:image\/svg/i.test(raw)) {
      try {
        var b64 = raw.replace(/^data:image\/svg\+xml;base64,/i, '');
        if (b64 !== raw) return Promise.resolve(atob(b64));
        var prefix = 'data:image/svg+xml,';
        if (raw.indexOf(prefix) === 0) return Promise.resolve(decodeURIComponent(raw.slice(prefix.length)));
      } catch (e) { return Promise.resolve(null); }
      return Promise.resolve(null);
    }
    if (/^https?:/i.test(raw)) {
      url = raw;
    } else if (raw === 'pending') {
      return Promise.resolve(null);
    } else {
      url = 'https://drive.google.com/uc?id=' + encodeURIComponent(raw) + '&export=download';
    }
    return fetch(url, { mode: 'cors' }).then(function (resp) {
      if (!resp.ok) return null;
      return resp.text();
    }).catch(function () { return null; });
  }

  // ---- editor mount ----------------------------------------------------

  async function openEditor(tab, rowId, col) {
    var content = document.getElementById('content');
    if (!content) return;

    var state = newState();
    state.tab = tab;
    state.rowId = rowId;
    state.col = col;

    var row = null;
    try { row = await M.db.getRow(tab, rowId); } catch (e) { /* ignore */ }
    state.title = (row && (row.title || row.name)) ? String(row.title || row.name) : 'Untitled sketch';

    // Try to resume from a pending local payload first.
    var existing = null;
    try { existing = await M.db.getDrawing(tab, rowId, col); } catch (e) { /* ignore */ }
    if (existing && existing.strokes && existing.strokes.length) {
      state.strokes = existing.strokes.slice();
    } else if (row && row[col]) {
      // No pending; try loading the saved SVG from Drive (best-effort).
      // Strokes can't be reconstructed from the SVG; we only display the
      // existing image as a backdrop using a foreignObject would be tricky,
      // so for slice 2 we simply start blank — the existing image stays in
      // the cell until save replaces it. This keeps the editor predictable.
      // (Slice 6 polish can revisit re-edit fidelity.)
    }

    // Build UI.
    var canvas = el('canvas', { class: 'draw-canvas', 'aria-label': 'Drawing surface' });
    state.canvas = canvas;

    var saving = { busy: false };
    function onSave() {
      if (saving.busy) return;
      saving.busy = true;
      saveAndExit(state).catch(function (err) {
        saving.busy = false;
        console.warn('[Minerva draw] save failed', err);
        alert('Save failed: ' + (err && err.message ? err.message : err));
      });
    }
    function onDiscard() {
      if (state.strokes.length && !confirm('Discard this sketch?')) return;
      goBack(state);
    }

    var toolbar = buildToolbar(state, onSave, onDiscard);
    state.headerEl = toolbar;

    var editor = el('div', { class: 'draw-editor' }, toolbar, canvas);
    content.replaceChildren(editor);

    // Layout pass — must happen after the canvas is in the DOM.
    requestAnimationFrame(function () {
      resizeCanvas(state);
      bindPointer(state);
    });

    var onResize = function () { resizeCanvas(state); };
    window.addEventListener('resize', onResize);
    // Detach when the route changes.
    var onHash = function () {
      if (!document.body.contains(editor)) {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('hashchange', onHash);
      }
    };
    window.addEventListener('hashchange', onHash);

    refreshIcons();
  }

  function goBack(state) {
    // Try to land back on the section view; fall back to home. _config maps
    // tab → slug, but reading it is async — do a best-effort lookup and
    // fall back to home immediately if nothing matches.
    findSectionSlug(state.tab).then(function (slug) {
      if (slug) location.hash = '#/s/' + encodeURIComponent(slug);
      else location.hash = '#/';
    }).catch(function () { location.hash = '#/'; });
  }

  async function findSectionSlug(tab) {
    try {
      var rows = await M.db.getAllRows('_config');
      for (var i = 0; i < (rows || []).length; i++) {
        if (rows[i].tab === tab && rows[i].slug) return rows[i].slug;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function saveAndExit(state) {
    var W = state.W || 800;
    var H = state.H || 600;
    var svg = strokesToSvg(state.strokes, W, H);
    var payload = {
      strokes: state.strokes,
      svg: svg,
      _dirty: 1,
      _updated: new Date().toISOString(),
      width: W,
      height: H
    };
    // Preserve any existing _fileId so the next push patches the same file.
    var existing = await M.db.getDrawing(state.tab, state.rowId, state.col);
    if (existing && existing._fileId) payload._fileId = existing._fileId;

    await upsertBlob(state.tab, state.rowId, state.col, payload);

    // Mark the row as having a pending sketch. Sentinel value — the next
    // push will overwrite it with the real Drive fileId. If a fileId already
    // existed we keep it (so the cell still renders an image until upload
    // succeeds); otherwise drop in 'pending'.
    var row = await M.db.getRow(state.tab, state.rowId);
    if (row) {
      var prev = row[state.col];
      if (!prev) row[state.col] = 'pending';
      row._updated = new Date().toISOString();
      row._dirty = 1;
      await M.db.upsertRow(state.tab, row);
    }

    if (typeof window.MinervaSchedulePush === 'function') {
      try { window.MinervaSchedulePush(); } catch (e) { /* ignore */ }
    }

    goBack(state);
  }

  async function upsertBlob(tab, rowId, col, payload) {
    return M.db.putDrawing(tab, rowId, col, payload);
  }

  // ---- sync hook -------------------------------------------------------

  // Called by sync.js before pushing a row. Uploads any pending drawings
  // belonging to this row and writes the resulting fileId into the row cell.
  // Throws on any drawing's upload failure so the caller can leave the row
  // dirty for the next retry.
  async function flushPending(tab, rowId, token) {
    if (!M.db || !M.db.getDirtyDrawingsForRow) return;
    var dirty = await M.db.getDirtyDrawingsForRow(tab, rowId);
    if (!dirty || !dirty.length) return;

    if (!token) {
      var cfg = (function () {
        try { return JSON.parse(localStorage.getItem('minerva.config.v1')) || {}; }
        catch (e) { return {}; }
      })();
      if (!cfg.clientId) throw new Error('No OAuth client configured.');
      token = await M.auth.getToken(cfg.clientId);
    }

    for (var i = 0; i < dirty.length; i++) {
      var d = dirty[i];
      var name = 'minerva-sketch-' + d.tab + '-' + d.rowId + '-' + d.col + '.svg';
      var resp = await M.sheets.uploadDriveFile(
        token, name, 'image/svg+xml', d.svg || '', d._fileId || null
      );
      var fileId = (resp && resp.id) || d._fileId;
      if (!fileId) throw new Error('Drive returned no file id for sketch.');

      // Update the row cell with the real fileId. Don't bump _dirty
      // independently — the row is already dirty and about to be pushed.
      var row = await M.db.getRow(d.tab, d.rowId);
      if (row) {
        row[d.col] = fileId;
        row._updated = new Date().toISOString();
        row._dirty = 1;
        await M.db.upsertRow(d.tab, row);
      }

      // Clear dirty flag on the drawing; keep the payload so re-edit can
      // resume without re-fetching.
      d._dirty = 0;
      d._fileId = fileId;
      await M.db.putDrawing(d.tab, d.rowId, d.col, d);
    }
  }

  // ---- public API ------------------------------------------------------

  M.draw = {
    openEditor: openEditor,
    upsertBlob: upsertBlob,
    flushPending: flushPending,
    refreshIcons: refreshIcons
  };
})();
