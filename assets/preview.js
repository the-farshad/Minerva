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
    head.appendChild(fsBtn);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var frameHost = document.createElement('div');
    frameHost.className = 'preview-frame-host';
    panel.appendChild(frameHost);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var ytPlayer = null;
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

      while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
      var resumeAt = isYt ? readVideoResume(url) : 0;
      var iframe = buildIframeForUrl(url, savedPage, resumeAt);
      frameHost.appendChild(iframe);
      if (isYt) {
        // Attach a YT.Player instance so close() can grab currentTime().
        loadYouTubeApi().then(function () {
          if (!iframe.parentNode) return; // re-rendered already
          try {
            ytPlayer = new window.YT.Player(iframe, { events: {} });
          } catch (e) { /* iframe might not be ready; harmless */ }
        });
        var note = document.createElement('p');
        note.className = 'small muted preview-yt-note';
        var noteText = resumeAt > 0
          ? ('Resuming at ' + Math.floor(resumeAt / 60) + ':' + String(resumeAt % 60).padStart(2, '0') + '. ')
          : '';
        note.textContent = noteText + 'Player shows "Error 153"? The video owner blocked embedding. Click "Watch on YouTube" above.';
        frameHost.appendChild(note);
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

    function close() {
      captureVideoResume();
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
    overlay.className = 'modal-overlay preview-overlay';
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
    getPlaylistContext: getPlaylistContext
  };
})();
