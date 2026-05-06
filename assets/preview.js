/* Minerva — link preview modal.
 *
 * Embeds PDFs and YouTube videos inline so you don't have to leave the
 * app to glance at a paper or recap a video. Two strategies:
 *
 *   PDF  — Google's docs viewer (https://docs.google.com/viewer?url=…
 *          &embedded=true) iframes any public PDF without CORS issues.
 *          Falls back to a direct <iframe> when the URL is same-origin.
 *
 *   YouTube — standard embed at youtube.com/embed/<id>.
 *
 * Esc closes; click outside the iframe closes; the modal exposes
 * 'Open in new tab' for cases where the embed fails.
 *
 * showPlaylist(items, startIndex) wraps a list of {title, url} entries
 * and adds previous/next nav inside the modal — used for YouTube siblings
 * inside a section view.
 */
(function () {
  'use strict';

  function isPdf(s) {
    return /\.pdf(\?|#|$)/i.test(String(s || '')) || /arxiv\.org\/pdf\//i.test(String(s || ''));
  }
  function ytId(s) {
    var m = String(s || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/);
    return m ? m[1] : null;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return url; }
  }

  // Persisted last-read page per PDF URL. The native PDF viewer
  // honours #page=N on the iframe src, so resume is implemented as a
  // hash fragment write at mount time. Cross-origin guards prevent
  // observing the live scroll position; the value is updated only when
  // the page-jumper input commits.
  var PDF_PAGE_KEY = 'minerva.pdf.page';
  function readPdfPage(url) {
    try {
      var raw = JSON.parse(localStorage.getItem(PDF_PAGE_KEY) || '{}');
      var n = parseInt(raw[url], 10);
      return n > 0 ? n : 1;
    } catch (e) { return 1; }
  }
  function writePdfPage(url, page) {
    try {
      var raw = JSON.parse(localStorage.getItem(PDF_PAGE_KEY) || '{}');
      var n = parseInt(page, 10);
      if (n > 0) raw[url] = n; else delete raw[url];
      localStorage.setItem(PDF_PAGE_KEY, JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }

  // Per-URL bookmark store. Each bookmark is { kind, ref, label, ts }
  // where kind is 'video' (ref = seconds) or 'pdf' (ref = page number).
  // Stored as a map keyed by URL in localStorage.
  var BOOKMARK_KEY = 'minerva.bookmarks';
  function readBookmarks(url) {
    try {
      var raw = JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '{}');
      return Array.isArray(raw[url]) ? raw[url] : [];
    } catch (e) { return []; }
  }
  function writeBookmarks(url, list) {
    try {
      var raw = JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '{}');
      if (!list || !list.length) delete raw[url];
      else raw[url] = list;
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }
  function addBookmark(url, mark) {
    var list = readBookmarks(url);
    list.push(mark);
    writeBookmarks(url, list);
    return list;
  }
  function removeBookmark(url, idx) {
    var list = readBookmarks(url);
    list.splice(idx, 1);
    writeBookmarks(url, list);
    return list;
  }

  // YouTube resume — captured via the IFrame Player API. The API script
  // loads on demand the first time we open a YouTube preview; thereafter
  // each YouTube iframe is created with `enablejsapi=1` and we attach
  // a YT.Player instance so we can call getCurrentTime() on close.
  var YT_RESUME_KEY = 'minerva.video.resume';
  function readVideoResume(url) {
    try {
      var raw = JSON.parse(localStorage.getItem(YT_RESUME_KEY) || '{}');
      var n = parseFloat(raw[url]);
      return n > 0 ? Math.floor(n) : 0;
    } catch (e) { return 0; }
  }
  function writeVideoResume(url, seconds) {
    try {
      var raw = JSON.parse(localStorage.getItem(YT_RESUME_KEY) || '{}');
      var n = Math.floor(seconds);
      // Don't bother saving "almost finished" states — anything within
      // 5s of zero or within 10s of the end is treated as "done".
      if (n > 5) raw[url] = n; else delete raw[url];
      localStorage.setItem(YT_RESUME_KEY, JSON.stringify(raw));
    } catch (e) { /* ignore */ }
  }
  // Lazy-load the YT IFrame Player API. Returns a promise that resolves
  // when window.YT.Player is available.
  var ytApiPromise = null;
  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    if (window.YT && window.YT.Player) {
      ytApiPromise = Promise.resolve();
      return ytApiPromise;
    }
    ytApiPromise = new Promise(function (resolve) {
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) {} }
        resolve();
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  function buildIframeForUrl(url, pdfPage, ytStartSec) {
    var iframe = document.createElement('iframe');
    iframe.className = 'preview-frame';
    iframe.referrerPolicy = 'no-referrer';
    iframe.allow = 'fullscreen; autoplay; encrypted-media';
    var yt = ytId(url);
    if (yt) {
      // enablejsapi=1 lets the IFrame Player API attach for resume.
      // origin pins postMessage so the player only talks to this page.
      var qp = ['enablejsapi=1', 'origin=' + encodeURIComponent(location.origin)];
      if (ytStartSec > 0) qp.push('start=' + ytStartSec);
      iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(yt)
        + '?' + qp.join('&');
    } else if (isPdf(url)) {
      // Native browser PDF viewer — supports #page=N for resume. Falls
      // back to Google Docs viewer if the PDF host blocks framing.
      var page = pdfPage > 0 ? pdfPage : 1;
      iframe.src = url + (url.indexOf('#') >= 0 ? '&' : '#') + 'page=' + page;
    } else {
      iframe.src = url;
    }
    return iframe;
  }

  // Debounce window before dispatching minerva:videoplay (the auto-
  // mark-watched signal). Closing or navigating away within this
  // window cancels the dispatch.
  var WATCH_MARK_DELAY_MS = 8000;

  function openModal(items, startIndex) {
    if (document.querySelector('.preview-overlay')) return;

    var idx = Math.max(0, Math.min(items.length - 1, startIndex || 0));
    var watchTimer = null;
    function clearWatchTimer() {
      if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
    }

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay preview-overlay';
    overlay.addEventListener('click', function () { close(); });

    var panel = document.createElement('div');
    panel.className = 'modal-panel preview-panel';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    var head = document.createElement('div');
    head.className = 'preview-head';

    // Prev/next show only when there's more than one item; sit on the
    // left of the head so the title remains the focal element.
    var prevBtn = null;
    var nextBtn = null;
    if (items.length > 1) {
      prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'btn btn-ghost preview-nav preview-nav-prev';
      prevBtn.title = 'Previous (←)';
      var ip = document.createElement('i');
      ip.setAttribute('data-lucide', 'chevron-left');
      prevBtn.appendChild(ip);
      prevBtn.addEventListener('click', function () { go(idx - 1); });

      nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn btn-ghost preview-nav preview-nav-next';
      nextBtn.title = 'Next (→)';
      var inext = document.createElement('i');
      inext.setAttribute('data-lucide', 'chevron-right');
      nextBtn.appendChild(inext);
      nextBtn.addEventListener('click', function () { go(idx + 1); });

      head.appendChild(prevBtn);
      head.appendChild(nextBtn);
    }

    var titleEl = document.createElement('span');
    titleEl.className = 'preview-title';

    var openA = document.createElement('a');
    openA.target = '_blank';
    openA.rel = 'noopener';
    openA.className = 'btn';
    var openLabel = document.createTextNode(' Open');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      openA.appendChild(Minerva.render.icon('external-link'));
      openA.appendChild(openLabel);
    } else {
      openA.textContent = 'Open';
    }

    // Fullscreen toggle — uses the Fullscreen API on the panel (works
    // for both PDF iframes and YouTube embeds, since the iframe is
    // mounted inside the panel and inherits the size).
    var fsBtn = document.createElement('button');
    fsBtn.className = 'icon-btn preview-fs-btn';
    fsBtn.type = 'button';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.setAttribute('aria-label', 'Toggle fullscreen');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      fsBtn.appendChild(Minerva.render.icon('maximize'));
    } else { fsBtn.textContent = '⛶'; }
    fsBtn.addEventListener('click', function () {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      } else if (panel.requestFullscreen) {
        panel.requestFullscreen().catch(function () {});
      }
    });

    // Page-jumper input. Visible only when the active item is a PDF.
    // The value is persisted via writePdfPage() and re-mounts the
    // iframe with the new #page=N fragment.
    var pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.className = 'preview-page-input';
    pageInput.title = 'Page';
    var pageLabel = document.createElement('span');
    pageLabel.className = 'preview-page-label small muted';
    pageLabel.textContent = 'Page';
    var pageWrap = document.createElement('label');
    pageWrap.className = 'preview-page-wrap';
    pageWrap.appendChild(pageLabel);
    pageWrap.appendChild(pageInput);
    pageWrap.style.display = 'none';
    pageInput.addEventListener('change', function () {
      var item = items[idx]; if (!item) return;
      var n = parseInt(pageInput.value, 10);
      if (!(n > 0)) return;
      writePdfPage(item.url, n);
      // Re-mount the iframe at the new page (browser doesn't auto-jump
      // when you only update the hash on a same-document iframe).
      while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
      frameHost.appendChild(buildIframeForUrl(item.url, n));
    });

    var closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      closeBtn.appendChild(Minerva.render.icon('x'));
    } else {
      closeBtn.textContent = 'Close';
    }
    closeBtn.addEventListener('click', function () { close(); });

    head.appendChild(titleEl);
    head.appendChild(pageWrap);
    head.appendChild(openA);

    // PDF data extractor button — only meaningful when the active item
    // is a PDF and the app registered an extractor callback. Hidden
    // otherwise; render() flips its visibility per-item.
    var extractBtn = document.createElement('button');
    extractBtn.type = 'button';
    extractBtn.className = 'btn btn-ghost preview-extract-btn';
    extractBtn.title = 'Run opendataloader-pdf on this PDF';
    extractBtn.textContent = 'Extract';
    extractBtn.style.display = 'none';
    extractBtn.addEventListener('click', async function () {
      var item = items[idx]; if (!item || !pdfExtractor) return;
      var origLabel = extractBtn.textContent;
      extractBtn.disabled = true;
      extractBtn.textContent = 'Extracting…';
      try {
        var result = await pdfExtractor(item.url);
        openExtractionModal(item.url, result);
      } catch (e) {
        openExtractionModal(item.url, 'Extraction failed: ' + (e && e.message || e));
      } finally {
        extractBtn.disabled = false;
        extractBtn.textContent = origLabel;
      }
    });
    head.appendChild(extractBtn);

    // Highlight button — only meaningful when a PDF.js viewer is
    // mounted (set in render() when it succeeds). Captures the
    // current text selection as a stored highlight on the row.
    var highlightBtn = document.createElement('button');
    highlightBtn.type = 'button';
    highlightBtn.className = 'btn btn-ghost preview-highlight-btn';
    highlightBtn.title = 'Highlight the current selection';
    highlightBtn.textContent = 'Highlight';
    highlightBtn.style.display = 'none';
    highlightBtn.addEventListener('click', function () {
      if (!activePdfView) return;
      activePdfView.addHighlight('#ffeb3b');
    });
    head.appendChild(highlightBtn);

    var activePdfView = null;

    // Notes toggle — opens the side pane bound to the row's notes
    // column. Visible only for PDFs when the section registered the
    // notes provider/saver hooks.
    var notesBtn = document.createElement('button');
    notesBtn.type = 'button';
    notesBtn.className = 'btn btn-ghost preview-notes-btn';
    notesBtn.title = 'Show notes pane';
    notesBtn.textContent = 'Notes';
    notesBtn.style.display = 'none';
    notesBtn.addEventListener('click', function () {
      var open = panel.classList.toggle('preview-notes-open');
      notesBtn.title = open ? 'Hide notes pane' : 'Show notes pane';
      if (open) setTimeout(function () { notesArea.focus(); }, 50);
    });
    head.appendChild(notesBtn);
    head.appendChild(fsBtn);

    // Bookmark button — adds a bookmark at the current playback time
    // (videos) or page (PDFs). The list lives in a small drawer beneath
    // the head and is rebuilt from localStorage on each render.
    var bmBtn = document.createElement('button');
    bmBtn.className = 'icon-btn preview-bm-btn';
    bmBtn.type = 'button';
    bmBtn.title = 'Add bookmark';
    bmBtn.setAttribute('aria-label', 'Add bookmark');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      bmBtn.appendChild(Minerva.render.icon('bookmark-plus'));
    } else { bmBtn.textContent = '+ '; }
    head.appendChild(bmBtn);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var bmDrawer = document.createElement('div');
    bmDrawer.className = 'preview-bookmarks';
    panel.appendChild(bmDrawer);

    function paintBookmarks() {
      var item = items[idx]; if (!item) return;
      var list = readBookmarks(item.url);
      bmDrawer.replaceChildren();
      if (!list.length) { bmDrawer.style.display = 'none'; return; }
      bmDrawer.style.display = '';
      list.forEach(function (mk, i) {
        var label;
        if (mk.kind === 'video') {
          var s = Math.max(0, mk.ref | 0);
          label = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        } else if (mk.kind === 'pdf') {
          label = 'p.' + mk.ref;
        } else { label = String(mk.ref); }
        var chip = document.createElement('button');
        chip.className = 'preview-bm';
        chip.type = 'button';
        chip.title = 'Jump to ' + label + (mk.label ? ' — ' + mk.label : '');
        chip.textContent = label + (mk.label ? ' · ' + mk.label : '');
        chip.addEventListener('click', function () {
          if (mk.kind === 'video' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
            try { ytPlayer.seekTo(mk.ref, true); ytPlayer.playVideo && ytPlayer.playVideo(); } catch (e) {}
          } else if (mk.kind === 'pdf') {
            pageInput.value = String(mk.ref);
            writePdfPage(item.url, mk.ref);
            while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
            frameHost.appendChild(buildIframeForUrl(item.url, mk.ref));
          }
        });
        var rm = document.createElement('button');
        rm.className = 'preview-bm-rm';
        rm.type = 'button';
        rm.title = 'Remove bookmark';
        rm.textContent = '×';
        rm.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          removeBookmark(item.url, i);
          paintBookmarks();
        });
        chip.appendChild(rm);
        bmDrawer.appendChild(chip);
      });
    }
    bmBtn.addEventListener('click', function () {
      var item = items[idx]; if (!item) return;
      var url = item.url;
      var isYt = !!ytId(url);
      var isPdfNow = isPdf(url);
      if (isYt) {
        var t = 0;
        try { if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') t = Math.floor(ytPlayer.getCurrentTime() || 0); }
        catch (e) {}
        var label = window.prompt('Bookmark label (optional):', '') || '';
        addBookmark(url, { kind: 'video', ref: t, label: label.trim(), ts: Date.now() });
        paintBookmarks();
      } else if (isPdfNow) {
        var p = parseInt(pageInput.value, 10) || 1;
        var lbl = window.prompt('Bookmark label for page ' + p + ' (optional):', '') || '';
        addBookmark(url, { kind: 'pdf', ref: p, label: lbl.trim(), ts: Date.now() });
        paintBookmarks();
      }
    });

    var frameHost = document.createElement('div');
    frameHost.className = 'preview-frame-host';

    // Notes pane — opens beside the PDF when the active item is a paper
    // row whose section registered a notes provider/saver pair. The
    // textarea binds to the row's `notes` markdown column; the helper
    // button stamps a `## p.<currentPage>` heading at the cursor so
    // notes stay anchored to where the user was reading.
    var notesPanel = document.createElement('aside');
    notesPanel.className = 'preview-notes';
    var notesHead = document.createElement('div');
    notesHead.className = 'preview-notes-head';
    var notesTitle = document.createElement('strong');
    notesTitle.textContent = 'Notes';
    var notesStamp = document.createElement('button');
    notesStamp.type = 'button';
    notesStamp.className = 'btn btn-ghost btn-inline preview-notes-stamp';
    notesStamp.title = 'Insert "## p.<current>" at the cursor';
    notesStamp.textContent = '+ p.';
    var notesStatus = document.createElement('span');
    notesStatus.className = 'preview-notes-status small muted';
    notesHead.appendChild(notesTitle);
    notesHead.appendChild(notesStamp);
    notesHead.appendChild(notesStatus);
    var notesArea = document.createElement('textarea');
    notesArea.className = 'preview-notes-area';
    notesArea.placeholder = 'Markdown notes — auto-saves to the row';
    notesArea.spellcheck = true;
    notesPanel.appendChild(notesHead);
    notesPanel.appendChild(notesArea);

    var content = document.createElement('div');
    content.className = 'preview-content';
    content.appendChild(frameHost);
    content.appendChild(notesPanel);
    panel.appendChild(content);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Notes lifecycle: load on render, save on debounced input + on close.
    var notesSaveTimer = null;
    var notesDirty = false;
    var notesUrlAtLoad = null;
    function setNotesStatus(text, cls) {
      notesStatus.textContent = text || '';
      notesStatus.classList.toggle('is-saved', cls === 'saved');
      notesStatus.classList.toggle('is-error', cls === 'error');
    }
    async function loadNotes(url) {
      notesUrlAtLoad = url;
      notesArea.value = '';
      notesDirty = false;
      setNotesStatus('');
      if (!notesProvider) return;
      try {
        var md = await notesProvider(url);
        if (notesUrlAtLoad !== url) return;
        notesArea.value = md || '';
        setNotesStatus('Saved', 'saved');
      } catch (e) {
        setNotesStatus('Couldn\'t load notes', 'error');
      }
    }
    async function flushNotes() {
      if (!notesDirty || !notesSaver || !notesUrlAtLoad) return;
      var url = notesUrlAtLoad;
      var value = notesArea.value;
      notesDirty = false;
      setNotesStatus('Saving…');
      try {
        await notesSaver(url, value);
        if (notesUrlAtLoad === url) setNotesStatus('Saved', 'saved');
      } catch (e) {
        notesDirty = true;
        setNotesStatus('Save failed', 'error');
      }
    }
    notesArea.addEventListener('input', function () {
      notesDirty = true;
      setNotesStatus('Editing…');
      if (notesSaveTimer) clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(function () { flushNotes(); }, 800);
    });
    notesArea.addEventListener('blur', function () {
      if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
      flushNotes();
    });
    notesStamp.addEventListener('click', function () {
      var p = parseInt(pageInput && pageInput.value, 10) || 1;
      var insert = (notesArea.value && !notesArea.value.endsWith('\n') ? '\n' : '')
                 + '## p.' + p + '\n';
      var pos = notesArea.selectionStart || notesArea.value.length;
      var before = notesArea.value.slice(0, pos);
      var after  = notesArea.value.slice(pos);
      notesArea.value = before + insert + after;
      notesArea.focus();
      var caret = (before + insert).length;
      notesArea.setSelectionRange(caret, caret);
      notesDirty = true;
      setNotesStatus('Editing…');
      if (notesSaveTimer) clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(function () { flushNotes(); }, 800);
    });

    var ytPlayer = null;
    // Monotonic counter incremented at the start of each render() so
    // an in-flight async blob lookup that resolves after the user
    // already navigated to a different item is ignored.
    var currentRenderEpoch = 0;
    var blobVideoEl = null;
    var blobObjectUrl = null;

    function mountRemoteIframe(url, savedPage, resumeAt, isYt) {
      cleanupBlobVideo();
      var iframe = buildIframeForUrl(url, savedPage, resumeAt);
      frameHost.appendChild(iframe);
      if (isYt) {
        loadYouTubeApi().then(function () {
          if (!iframe.parentNode) return;
          try { ytPlayer = new window.YT.Player(iframe, { events: {} }); }
          catch (e) { /* iframe not ready yet, harmless */ }
        });
        var note = document.createElement('p');
        note.className = 'small muted preview-yt-note';
        var noteText = resumeAt > 0
          ? ('Resuming at ' + Math.floor(resumeAt / 60) + ':' + String(resumeAt % 60).padStart(2, '0') + '. ')
          : '';
        note.textContent = noteText + 'Player shows "Error 153"? The video owner blocked embedding. Click "Watch on YouTube" above.';
        frameHost.appendChild(note);
      }
    }

    function mountBlobVideo(blob, sourceUrl, resumeAt) {
      cleanupBlobVideo();
      blobObjectUrl = URL.createObjectURL(blob);
      var video = document.createElement('video');
      video.className = 'preview-frame preview-blob-video';
      video.src = blobObjectUrl;
      video.controls = true;
      video.autoplay = true;
      video.style.width = '100%';
      video.style.height = '100%';
      if (resumeAt > 0) {
        video.addEventListener('loadedmetadata', function () {
          try { video.currentTime = resumeAt; } catch (e) {}
        }, { once: true });
      }
      // Keep the saved time fresh so the next open resumes correctly.
      video.addEventListener('timeupdate', function () {
        try {
          if (isFinite(video.currentTime) && video.currentTime > 1) {
            writeVideoResume(sourceUrl, video.currentTime);
          }
        } catch (e) {}
      });
      blobVideoEl = video;
      frameHost.appendChild(video);
      var note = document.createElement('p');
      note.className = 'small muted preview-yt-note';
      note.textContent = 'Playing your locally-saved copy. Click "Watch on YouTube" above to open the original.';
      frameHost.appendChild(note);
    }

    function cleanupBlobVideo() {
      if (blobVideoEl) {
        try { blobVideoEl.pause(); } catch (e) {}
        blobVideoEl = null;
      }
      if (blobObjectUrl) {
        try { URL.revokeObjectURL(blobObjectUrl); } catch (e) {}
        blobObjectUrl = null;
      }
    }

    function render() {
      // Snapshot the previous URL's video position before mounting the
      // next iframe — switching to next/prev shouldn't lose progress.
      captureVideoResume();
      ytPlayer = null;

      var item = items[idx];
      var url = item.url;
      // Title shows position + item title (or hostname fallback).
      var label = item.title && String(item.title).trim() ? String(item.title) : hostOf(url);
      while (titleEl.firstChild) titleEl.removeChild(titleEl.firstChild);
      if (items.length > 1) {
        var pos = document.createElement('span');
        pos.className = 'preview-pos';
        pos.textContent = (idx + 1) + ' of ' + items.length;
        titleEl.appendChild(pos);
        titleEl.appendChild(document.createTextNode(' · '));
      }
      titleEl.appendChild(document.createTextNode(label));
      titleEl.title = url;

      openA.href = url;
      // Relabel for YouTube so users have a clear escape hatch when the
      // embedded player throws "Error 153 — video player configuration"
      // (the video owner disabled embeds on other sites).
      var isYt = !!ytId(url);
      while (openLabel.parentNode) { openLabel.parentNode.removeChild(openLabel); }
      openLabel = document.createTextNode(isYt ? ' Watch on YouTube' : ' Open');
      openA.appendChild(openLabel);

      // PDF page jumper — show only for PDFs; pre-fill from saved page.
      var isPdfNow = isPdf(url);
      var savedPage = isPdfNow ? readPdfPage(url) : 1;
      pageWrap.style.display = isPdfNow ? '' : 'none';
      extractBtn.style.display = (isPdfNow && pdfExtractor) ? '' : 'none';
      var notesAvailable = isPdfNow && (notesProvider || notesSaver);
      notesBtn.style.display = notesAvailable ? '' : 'none';
      if (!notesAvailable) panel.classList.remove('preview-notes-open');
      if (notesAvailable) loadNotes(url);
      if (isPdfNow) pageInput.value = String(savedPage);

      // Adjust the panel aspect to the content kind. YouTube embeds
      // are 16:9 and look squashed in the tall PDF-shaped panel; PDFs
      // keep the original full-height layout. The class is applied to
      // both overlay and panel so align-items overrides reliably win
      // without depending on :has() selector support.
      panel.classList.toggle('preview-panel-yt', isYt);
      panel.classList.toggle('preview-panel-pdf', isPdfNow);
      overlay.classList.toggle('preview-overlay-yt', isYt);
      overlay.classList.toggle('preview-overlay-pdf', isPdfNow);

      revokeBlobIframes();
      if (activePdfView) {
        try { activePdfView.destroy(); } catch (e) {}
        activePdfView = null;
      }
      if (highlightBtn) highlightBtn.style.display = 'none';
      while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
      var resumeAt = isYt ? readVideoResume(url) : 0;

      // Offline-first lookup. Both YouTube and PDF rows may have a
      // Drive-mirrored copy whose breadcrumb (drive:<fileId>) was
      // attached to the row. For YouTube we prefer the local IDB blob
      // when present; for PDFs we route the iframe at Drive's preview
      // host, which (unlike arxiv.org) allows third-party embedding.
      var renderEpoch = ++currentRenderEpoch;
      var hit = null;
      if (offlineLookup && (isYt || isPdfNow)) {
        try { hit = offlineLookup(url); } catch (e) { hit = null; }
      }
      if (isYt && hit && hit.tab && hit.rowId && window.Minerva && Minerva.db && Minerva.db.getVideo) {
        Minerva.db.getVideo(hit.tab, hit.rowId).then(function (rec) {
          if (renderEpoch !== currentRenderEpoch) return;
          if (rec && rec.blob) {
            mountBlobVideo(rec.blob, url, resumeAt);
          } else {
            mountRemoteIframe(url, savedPage, resumeAt, isYt);
          }
        }).catch(function () {
          if (renderEpoch !== currentRenderEpoch) return;
          mountRemoteIframe(url, savedPage, resumeAt, isYt);
        });
      } else if (isPdfNow && hit && hit.driveFileId && pdfBlobLoader) {
        var loading = document.createElement('div');
        loading.className = 'preview-loading muted small';
        loading.textContent = 'Loading PDF…';
        frameHost.appendChild(loading);
        pdfBlobLoader(hit.driveFileId).then(async function (blob) {
          if (renderEpoch !== currentRenderEpoch) return;
          var savedPageNum = readPdfPage(url) || 1;
          // When the section + app supply highlight read/write hooks
          // *and* PDF.js is available, render through pdfviewer so the
          // text layer + selection-based highlighting work. Otherwise
          // fall back to the native browser PDF viewer via blob URL —
          // it doesn't have highlights but still respects #page=N.
          var canHighlight = highlightsProvider && highlightsSaver
            && window.Minerva && Minerva.pdfviewer && Minerva.pdfviewer.mount;
          if (canHighlight) {
            try {
              var initialHl = [];
              try {
                var raw = await highlightsProvider(url);
                if (raw) initialHl = JSON.parse(raw);
              } catch (e) { initialHl = []; }
              if (renderEpoch !== currentRenderEpoch) return;
              while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
              var pdfHost = document.createElement('div');
              pdfHost.className = 'preview-pdfjs';
              frameHost.appendChild(pdfHost);
              var view = await Minerva.pdfviewer.mount(pdfHost, blob, {
                startPage: savedPageNum,
                initialHighlights: initialHl,
                onHighlightsChange: function (next) {
                  try { highlightsSaver(url, JSON.stringify(next)); } catch (e) {}
                },
                onPageChange: function (n) {
                  try { writePdfPage(url, n); } catch (e) {}
                  if (pageInput) pageInput.value = String(n);
                }
              });
              activePdfView = view;
              if (highlightBtn) highlightBtn.style.display = '';
              return;
            } catch (err) {
              console.warn('[Minerva pdfviewer]', err);
              // Drop through to the iframe fallback below.
            }
          }
          if (renderEpoch !== currentRenderEpoch) return;
          var objUrl = URL.createObjectURL(blob);
          var iframe = document.createElement('iframe');
          iframe.className = 'preview-frame';
          iframe.referrerPolicy = 'no-referrer';
          iframe.allow = 'fullscreen';
          iframe.src = objUrl + '#page=' + savedPageNum;
          iframe.title = 'PDF (Drive copy of original)';
          while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
          frameHost.appendChild(iframe);
          iframe.dataset.objUrl = objUrl;
        }).catch(function (err) {
          if (renderEpoch !== currentRenderEpoch) return;
          console.warn('[Minerva pdf-blob-load]', err);
          while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
          mountRemoteIframe(url, savedPage, resumeAt, isYt);
        });
      } else {
        mountRemoteIframe(url, savedPage, resumeAt, isYt);
      }
      // Notify any listener that a URL is being played — the section view
      // uses this to auto-mark a matching row as watched. Delayed so a
      // quick glance / wrong-video click doesn't immediately flip the row.
      clearWatchTimer();
      watchTimer = setTimeout(function () {
        try {
          window.dispatchEvent(new CustomEvent('minerva:videoplay', {
            detail: { url: url, isYouTube: isYt }
          }));
        } catch (e) { /* ignore */ }
      }, WATCH_MARK_DELAY_MS);

      if (prevBtn) prevBtn.disabled = idx <= 0;
      if (nextBtn) nextBtn.disabled = idx >= items.length - 1;

      paintBookmarks();

      if (window.Minerva && Minerva.render && Minerva.render.refreshIcons) {
        Minerva.render.refreshIcons();
      }
    }

    function go(next) {
      if (next < 0 || next >= items.length) return;
      idx = next;
      render();
    }

    // Pull the YT player's currentTime() (if attached) and persist it
    // for the current item's URL. Used on close + on next/prev nav.
    function captureVideoResume() {
      try {
        if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
        var item = items[idx]; if (!item) return;
        var t = ytPlayer.getCurrentTime();
        if (t && isFinite(t)) writeVideoResume(item.url, t);
      } catch (e) { /* ignore */ }
    }

    function revokeBlobIframes() {
      try {
        var iframes = frameHost.querySelectorAll('iframe[data-obj-url]');
        Array.prototype.forEach.call(iframes, function (n) {
          var u = n.dataset.objUrl;
          if (u) try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
    }
    function close() {
      captureVideoResume();
      if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
      flushNotes();
      if (activePdfView) {
        try { activePdfView.destroy(); } catch (e) {}
        activePdfView = null;
      }
      cleanupBlobVideo();
      revokeBlobIframes();
      clearWatchTimer();
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }

    var onKey = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowLeft' && items.length > 1) {
        e.preventDefault();
        go(idx - 1);
      } else if (e.key === 'ArrowRight' && items.length > 1) {
        e.preventDefault();
        go(idx + 1);
      } else if (e.key === 'f' || e.key === 'F') {
        // Quick fullscreen shortcut — matches typical media player UX.
        e.preventDefault();
        if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
        else if (panel.requestFullscreen) { panel.requestFullscreen().catch(function () {}); }
      }
    };
    document.addEventListener('keydown', onKey);

    render();
  }

  function show(url) {
    // openModal now handles the offline-first path itself, so the
    // single-URL entry point is a thin wrapper. Keeping the function
    // for back-compat with callers around the codebase.
    openModal([{ title: '', url: url }], 0);
  }

  function showPlaylist(items, startIndex) {
    if (!items || !items.length) return;
    var clean = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.url) continue;
      clean.push({ title: it.title || '', url: it.url });
    }
    if (!clean.length) return;
    openModal(clean, startIndex || 0);
  }

  // Open a locally-stored video blob in its own modal — bypasses iframe
  // (blob URLs in iframes hit cross-origin guards) by mounting a native
  // <video> element. Cleans up the object URL when the modal closes.
  function showVideoBlob(opts) {
    opts = opts || {};
    if (!opts.url) return;
    if (document.querySelector('.preview-overlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay preview-overlay preview-overlay-video';
    overlay.addEventListener('click', function () { close(); });

    var panel = document.createElement('div');
    panel.className = 'modal-panel preview-panel preview-panel-video';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    var head = document.createElement('div');
    head.className = 'preview-head';
    var titleEl = document.createElement('span');
    titleEl.className = 'preview-title';
    titleEl.textContent = opts.title || 'Offline video';
    head.appendChild(titleEl);

    var openA = document.createElement('a');
    openA.target = '_blank';
    openA.rel = 'noopener';
    openA.className = 'btn';
    openA.href = opts.sourceUrl || opts.url;
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      openA.appendChild(Minerva.render.icon('external-link'));
      openA.appendChild(document.createTextNode(opts.sourceUrl ? ' Watch on YouTube' : ' Open file'));
    } else {
      openA.textContent = opts.sourceUrl ? 'Watch on YouTube' : 'Open file';
    }
    head.appendChild(openA);

    // Fullscreen toggle for offline blob video too.
    var fsBtn = document.createElement('button');
    fsBtn.className = 'icon-btn preview-fs-btn';
    fsBtn.type = 'button';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.setAttribute('aria-label', 'Toggle fullscreen');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      fsBtn.appendChild(Minerva.render.icon('maximize'));
    } else { fsBtn.textContent = '⛶'; }
    fsBtn.addEventListener('click', function () {
      if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
      else if (panel.requestFullscreen) { panel.requestFullscreen().catch(function () {}); }
    });
    head.appendChild(fsBtn);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      closeBtn.appendChild(Minerva.render.icon('x'));
    } else { closeBtn.textContent = 'Close'; }
    closeBtn.addEventListener('click', function () { close(); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var frameHost = document.createElement('div');
    frameHost.className = 'preview-frame-host';
    var video = document.createElement('video');
    video.className = 'preview-video';
    video.src = opts.url;
    video.controls = true;
    video.autoplay = true;
    video.style.width = '100%';
    video.style.height = '100%';
    // Resume — for offline blobs we key by sourceUrl when present (so a
    // file uploaded for a YouTube row picks up the same resume position
    // as the streamed version) and fall back to the blob's filename.
    var resumeKeyUrl = opts.sourceUrl || opts.url;
    var resumeAt = readVideoResume(resumeKeyUrl);
    if (resumeAt > 0) {
      video.addEventListener('loadedmetadata', function () {
        try { video.currentTime = resumeAt; } catch (e) {}
      }, { once: true });
    }
    // Keep the saved time fresh while the video plays — every 5s of
    // playback persists the current time. Less write traffic than ontimeupdate.
    var resumeTick = null;
    video.addEventListener('play', function () {
      if (resumeTick) return;
      resumeTick = setInterval(function () {
        if (!isFinite(video.currentTime) || video.duration && video.currentTime > video.duration - 5) return;
        writeVideoResume(resumeKeyUrl, video.currentTime);
      }, 5000);
    });
    video.addEventListener('pause', function () {
      if (resumeTick) { clearInterval(resumeTick); resumeTick = null; }
      writeVideoResume(resumeKeyUrl, video.currentTime);
    });
    frameHost.appendChild(video);
    panel.appendChild(frameHost);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Surface the same auto-watch event so the section view can flip
    // watched=TRUE the same way as embedded YouTube playback. Delayed so
    // a quick close doesn't accidentally mark the row watched.
    var blobWatchTimer = setTimeout(function () {
      try {
        window.dispatchEvent(new CustomEvent('minerva:videoplay', {
          detail: { url: opts.sourceUrl || opts.url, isYouTube: !!(opts.sourceUrl && /youtube\.com|youtu\.be/i.test(opts.sourceUrl)), offline: true }
        }));
      } catch (e) { /* ignore */ }
    }, WATCH_MARK_DELAY_MS);

    function close() {
      if (blobWatchTimer) { clearTimeout(blobWatchTimer); blobWatchTimer = null; }
      if (resumeTick) { clearInterval(resumeTick); resumeTick = null; }
      try {
        if (isFinite(video.currentTime)) writeVideoResume(resumeKeyUrl, video.currentTime);
      } catch (e) {}
      try { video.pause(); } catch (e) { /* ignore */ }
      try { URL.revokeObjectURL(opts.url); } catch (e) { /* ignore */ }
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    var onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
        else if (panel.requestFullscreen) { panel.requestFullscreen().catch(function () {}); }
      }
    };
    document.addEventListener('keydown', onKey);
    if (window.Minerva && Minerva.render && Minerva.render.refreshIcons) {
      Minerva.render.refreshIcons();
    }
  }

  // Optional context provider, set by callers (e.g. the section view) so
  // a click on the eye-icon next to a YouTube URL can pull in sibling
  // videos from the same context. Default is unset → single-URL preview.
  var playlistContext = null;
  function setPlaylistContext(fn) { playlistContext = (typeof fn === 'function') ? fn : null; }
  function clearPlaylistContext() { playlistContext = null; }

  // Offline-blob lookup. Section renders register a function that maps
  // a URL to { tab, rowId } when an offline blob is known to exist for
  // it; show() consults this and plays the local copy instead of the
  // remote iframe.
  var offlineLookup = null;
  function setOfflineLookup(fn) { offlineLookup = (typeof fn === 'function') ? fn : null; }
  function clearOfflineLookup() { offlineLookup = null; }

  // Fetcher for Drive-mirrored PDFs. The app registers a function that
  // takes a Drive fileId and resolves to a Blob (using the OAuth token
  // it holds). Mounting via blob: URL keeps the browser's native PDF
  // viewer in play, so #page=N for resume keeps working — Drive's own
  // viewer (drive.google.com/file/<id>/preview) ignores the fragment.
  var pdfBlobLoader = null;
  function setPdfBlobLoader(fn) { pdfBlobLoader = (typeof fn === 'function') ? fn : null; }

  // Notes provider + saver. Section render registers these so the
  // preview's notes pane can read and write the row's `notes` markdown
  // column. Both are async so they can hit IDB / Drive without blocking
  // the UI thread. Either may be null — when missing, the notes pane
  // stays hidden.
  var notesProvider = null;
  var notesSaver = null;
  function setNotesProvider(fn) { notesProvider = (typeof fn === 'function') ? fn : null; }
  function setNotesSaver(fn)    { notesSaver    = (typeof fn === 'function') ? fn : null; }

  // Highlights provider + saver. App registers these so the PDF.js
  // path can persist the user's highlights to row.highlights as a
  // JSON-encoded array. Same pattern as notes; missing → no PDF.js
  // mount, fall back to the native iframe.
  var highlightsProvider = null;
  var highlightsSaver = null;
  function setHighlightsProvider(fn) { highlightsProvider = (typeof fn === 'function') ? fn : null; }
  function setHighlightsSaver(fn)    { highlightsSaver    = (typeof fn === 'function') ? fn : null; }

  // Optional structured-data extractor (opendataloader-pdf). When set,
  // the preview head renders an "Extract" button for PDFs that calls
  // this callback with the current PDF URL and expects a Promise that
  // resolves to either a JSON object or a string. The caller decides
  // how to present it — see openExtractionModal below.
  var pdfExtractor = null;
  function setPdfExtractor(fn) { pdfExtractor = (typeof fn === 'function') ? fn : null; }

  // Optional "Save extracted JSON to Drive" sink. The app registers a
  // function that takes (url, payload) and resolves to { id, link } so
  // the modal can offer a one-click upload alongside Save-to-notes.
  var pdfExtractDriveSaver = null;
  function setPdfExtractDriveSaver(fn) {
    pdfExtractDriveSaver = (typeof fn === 'function') ? fn : null;
  }

  function openExtractionModal(url, payload) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay extract-overlay';
    overlay.addEventListener('click', function () { overlay.remove(); });
    var panel = document.createElement('div');
    panel.className = 'modal-panel extract-panel';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    var head = document.createElement('div');
    head.className = 'extract-head';
    var title = document.createElement('strong');
    title.textContent = 'Extracted PDF data';
    var status = document.createElement('span');
    status.className = 'extract-status small muted';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn';
    saveBtn.textContent = 'Save to notes';
    var driveBtn = document.createElement('button');
    driveBtn.type = 'button';
    driveBtn.className = 'btn btn-ghost';
    driveBtn.textContent = 'Save to Drive';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-ghost';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    head.appendChild(title);
    head.appendChild(status);
    head.appendChild(saveBtn);
    head.appendChild(driveBtn);
    head.appendChild(closeBtn);
    var body = document.createElement('pre');
    body.className = 'extract-body';
    var text;
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.raw_text === 'string' && payload.raw_text) {
        text = payload.raw_text;
      } else {
        try { text = JSON.stringify(payload, null, 2); }
        catch (e) { text = String(payload); }
      }
    } else {
      text = String(payload || '');
    }
    body.textContent = text;
    panel.appendChild(head);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Wire Save → notes column. We need both the saver (to write back)
    // and the provider (to read existing notes so we append rather than
    // clobber). When either is missing, hide the button.
    if (!notesSaver || !notesProvider) {
      saveBtn.style.display = 'none';
    }
    if (!pdfExtractDriveSaver) {
      driveBtn.style.display = 'none';
    }
    driveBtn.addEventListener('click', async function () {
      if (!pdfExtractDriveSaver) return;
      driveBtn.disabled = true;
      var orig = driveBtn.textContent;
      driveBtn.textContent = 'Uploading…';
      try {
        var resp = await pdfExtractDriveSaver(url, payload);
        if (resp && resp.link) {
          status.textContent = 'Uploaded';
          status.classList.add('is-saved');
          var a = document.createElement('a');
          a.href = resp.link;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'Open in Drive';
          a.style.marginLeft = '0.5rem';
          status.appendChild(a);
        } else {
          status.textContent = 'Uploaded';
          status.classList.add('is-saved');
        }
      } catch (e) {
        status.textContent = 'Upload failed: ' + (e && e.message || e);
        status.classList.add('is-error');
      } finally {
        driveBtn.disabled = false;
        driveBtn.textContent = orig;
      }
    });
    if (!notesSaver || !notesProvider) {
      return;
    }
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      var origLabel = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        var existing = '';
        try { existing = (await notesProvider(url)) || ''; } catch (e) { /* tolerate */ }
        var stamp = new Date().toISOString().slice(0, 10);
        var section = '## Extracted (' + stamp + ')\n\n' + text + '\n';
        var merged = existing
          ? (existing.replace(/\s+$/, '') + '\n\n' + section)
          : section;
        await notesSaver(url, merged);
        status.textContent = 'Saved to notes';
        status.classList.add('is-saved');
        setTimeout(function () { overlay.remove(); }, 700);
      } catch (e) {
        status.textContent = 'Save failed: ' + (e && e.message || e);
        status.classList.add('is-error');
        saveBtn.disabled = false;
        saveBtn.textContent = origLabel;
      }
    });
  }
  // Open the row's Drive mirror in a new tab if the offline lookup
  // resolves a driveFileId for this URL. Returns true when handled,
  // false when no Drive copy is known so the caller can fall back.
  function openInDrive(url) {
    if (!offlineLookup) return false;
    try {
      var hit = offlineLookup(url);
      if (hit && hit.driveFileId) {
        window.open('https://drive.google.com/file/d/' + encodeURIComponent(hit.driveFileId) + '/view',
          '_blank', 'noopener');
        return true;
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  function getPlaylistContext(url) {
    if (!playlistContext) return null;
    try { return playlistContext(url) || null; }
    catch (e) { return null; }
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.preview = {
    show: show,
    showPlaylist: showPlaylist,
    showVideoBlob: showVideoBlob,
    isPdf: isPdf,
    ytId: ytId,
    setPlaylistContext: setPlaylistContext,
    clearPlaylistContext: clearPlaylistContext,
    getPlaylistContext: getPlaylistContext,
    setOfflineLookup: setOfflineLookup,
    clearOfflineLookup: clearOfflineLookup,
    setPdfBlobLoader: setPdfBlobLoader,
    setPdfExtractor: setPdfExtractor,
    setPdfExtractDriveSaver: setPdfExtractDriveSaver,
    setNotesProvider: setNotesProvider,
    setNotesSaver: setNotesSaver,
    setHighlightsProvider: setHighlightsProvider,
    setHighlightsSaver: setHighlightsSaver,
    openInDrive: openInDrive
  };
})();
