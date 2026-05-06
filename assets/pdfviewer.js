/* Minerva — PDF.js wrapper for paper preview with highlight support.
 *
 * Loaded lazily on first use (the library + worker are ~1MB combined,
 * so we don't pull them in for sections that don't need them). The
 * preview module calls Minerva.pdfviewer.mount(host, blob, opts) and
 * gets back a small controller it can talk to:
 *
 *     var view = await Minerva.pdfviewer.mount(host, blob, {
 *       startPage: 7,
 *       initialHighlights: [...],
 *       onHighlightsChange: function (next) { ... },
 *       onPageChange: function (n) { ... }
 *     });
 *     view.addHighlight(color);   // persists current text selection
 *     view.goToPage(n);
 *     view.destroy();
 *
 * Highlights are stored as { page, rect:{x,y,w,h}, text, color, ts }
 * with rect coordinates as page-relative fractions (0–1). That keeps
 * them resolution-independent so a re-rendered viewer at a different
 * scale lays them in the same spot.
 */
(function () {
  'use strict';

  // Pin the version so a sudden upstream major doesn't break the
  // shape of getDocument / renderTextLayer at us.
  var PDFJS_VERSION = '4.7.76';
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/';
  var PDFJS_LIB = PDFJS_BASE + 'pdf.min.mjs';
  var PDFJS_WORKER = PDFJS_BASE + 'pdf.worker.min.mjs';

  var libPromise = null;
  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = (async function () {
      var mod = await import(PDFJS_LIB);
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return mod;
    })();
    return libPromise;
  }

  async function mount(host, blob, opts) {
    opts = opts || {};
    var pdfjs = await loadLib();
    var arrayBuffer = await blob.arrayBuffer();
    var pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

    var state = {
      pdfjs: pdfjs,
      pdf: pdf,
      scale: opts.scale || 1.4,
      currentPage: Math.min(Math.max(opts.startPage || 1, 1), pdf.numPages),
      highlights: (opts.initialHighlights || []).slice(),
      onHighlightsChange: opts.onHighlightsChange || function () {},
      onPageChange: opts.onPageChange || function () {},
      pageEls: []
    };

    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.add('pdfjs-host');

    for (var i = 1; i <= pdf.numPages; i++) {
      var pageEl = document.createElement('div');
      pageEl.className = 'pdfjs-page';
      pageEl.dataset.pageNumber = String(i);
      host.appendChild(pageEl);
      state.pageEls.push(pageEl);
    }

    // Render pages sequentially. For very large PDFs an IntersectionObserver
    // would be better; for typical paper-length docs (<50 pages) sequential
    // render is simpler and finishes in a few seconds.
    for (var p = 1; p <= pdf.numPages; p++) {
      try { await renderPage(state, p); }
      catch (err) { console.warn('[Minerva pdfviewer] page', p, err); }
    }

    if (state.currentPage > 1) {
      requestAnimationFrame(function () {
        var el = state.pageEls[state.currentPage - 1];
        if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    }

    var io = new IntersectionObserver(function (entries) {
      var maxVisible = 0; var top = state.currentPage;
      entries.forEach(function (e) {
        if (e.intersectionRatio > maxVisible) {
          maxVisible = e.intersectionRatio;
          top = parseInt(e.target.dataset.pageNumber, 10) || 1;
        }
      });
      if (top !== state.currentPage) {
        state.currentPage = top;
        try { state.onPageChange(top); } catch (e) {}
      }
    }, { root: host, threshold: [0.25, 0.5, 0.75] });
    state.pageEls.forEach(function (el) { io.observe(el); });

    return {
      addHighlight: function (color) { return addHighlightFromSelection(state, color); },
      goToPage: function (n) {
        var el = state.pageEls[Math.max(1, Math.min(state.pdf.numPages, n)) - 1];
        if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
      destroy: function () {
        try { io.disconnect(); } catch (e) {}
        try { state.pdf.destroy(); } catch (e) {}
        while (host.firstChild) host.removeChild(host.firstChild);
        host.classList.remove('pdfjs-host');
      },
      get currentPage() { return state.currentPage; },
      get pageCount() { return state.pdf.numPages; }
    };
  }

  async function renderPage(state, pageNum) {
    var pageEl = state.pageEls[pageNum - 1];
    if (!pageEl || pageEl.dataset.rendered === '1') return;
    var page = await state.pdf.getPage(pageNum);
    var viewport = page.getViewport({ scale: state.scale });

    pageEl.style.width = viewport.width + 'px';
    pageEl.style.height = viewport.height + 'px';
    pageEl.style.position = 'relative';

    var canvas = document.createElement('canvas');
    canvas.className = 'pdfjs-canvas';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageEl.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;

    var textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'pdfjs-text-layer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    pageEl.appendChild(textLayerDiv);

    try {
      var textContent = await page.getTextContent();
      // pdfjs 4.x renderTextLayer takes an options object.
      await state.pdfjs.renderTextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: viewport,
        textDivs: []
      }).promise;
    } catch (err) {
      // Older API fallback.
      try {
        state.pdfjs.renderTextLayer({
          textContent: await page.getTextContent(),
          container: textLayerDiv,
          viewport: viewport,
          textDivs: []
        });
      } catch (err2) {
        console.warn('[Minerva pdfviewer] text layer page', pageNum, err2);
      }
    }

    var hlLayer = document.createElement('div');
    hlLayer.className = 'pdfjs-highlight-layer';
    pageEl.appendChild(hlLayer);

    pageEl.dataset.rendered = '1';

    state.highlights
      .filter(function (h) { return h.page === pageNum; })
      .forEach(function (h) { drawHighlight(state, h); });
  }

  function pageOfElement(el) {
    var p = el && el.closest && el.closest('.pdfjs-page');
    return p ? parseInt(p.dataset.pageNumber, 10) || 0 : 0;
  }

  function addHighlightFromSelection(state, color) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var anchor = range.startContainer.parentElement || range.startContainer;
    var pageNum = pageOfElement(anchor);
    if (!pageNum) return null;
    var pageEl = state.pageEls[pageNum - 1];
    var pageRect = pageEl.getBoundingClientRect();

    // A selection can span multiple boxes (e.g. wrapped lines). Capture
    // every client rect and store one highlight per rect so the visual
    // restores accurately on reload.
    var rects = Array.prototype.slice.call(range.getClientRects()).filter(function (r) {
      return r.width > 1 && r.height > 1;
    });
    if (!rects.length) {
      var br = range.getBoundingClientRect();
      if (br.width < 1 || br.height < 1) return null;
      rects = [br];
    }
    var fullText = sel.toString();
    var added = [];
    rects.forEach(function (r) {
      var hl = {
        page: pageNum,
        rect: {
          x: (r.left - pageRect.left) / pageRect.width,
          y: (r.top - pageRect.top) / pageRect.height,
          w: r.width / pageRect.width,
          h: r.height / pageRect.height
        },
        text: fullText,
        color: color || '#ffeb3b',
        ts: Date.now()
      };
      state.highlights.push(hl);
      drawHighlight(state, hl);
      added.push(hl);
    });
    sel.removeAllRanges();
    try { state.onHighlightsChange(state.highlights); } catch (e) {}
    return added;
  }

  function drawHighlight(state, hl) {
    var pageEl = state.pageEls[hl.page - 1];
    if (!pageEl) return;
    var hlLayer = pageEl.querySelector('.pdfjs-highlight-layer');
    if (!hlLayer) return;
    var node = document.createElement('div');
    node.className = 'pdfjs-highlight';
    node.style.left = (hl.rect.x * 100) + '%';
    node.style.top = (hl.rect.y * 100) + '%';
    node.style.width = (hl.rect.w * 100) + '%';
    node.style.height = (hl.rect.h * 100) + '%';
    node.style.background = hl.color || '#ffeb3b';
    node.title = hl.text;
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!confirm('Remove this highlight?')) return;
      state.highlights = state.highlights.filter(function (h) { return h !== hl; });
      node.remove();
      try { state.onHighlightsChange(state.highlights); } catch (er) {}
    });
    hlLayer.appendChild(node);
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.pdfviewer = { mount: mount };
})();
