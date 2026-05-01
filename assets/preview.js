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

  function buildIframeForUrl(url) {
    var iframe = document.createElement('iframe');
    iframe.className = 'preview-frame';
    iframe.referrerPolicy = 'no-referrer';
    iframe.allow = 'fullscreen; autoplay; encrypted-media';
    var yt = ytId(url);
    if (yt) {
      iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(yt);
    } else if (isPdf(url)) {
      iframe.src = 'https://docs.google.com/viewer?url=' + encodeURIComponent(url) + '&embedded=true';
    } else {
      iframe.src = url;
    }
    return iframe;
  }

  function openModal(items, startIndex) {
    if (document.querySelector('.preview-overlay')) return;

    var idx = Math.max(0, Math.min(items.length - 1, startIndex || 0));

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
    head.appendChild(openA);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var frameHost = document.createElement('div');
    frameHost.className = 'preview-frame-host';
    panel.appendChild(frameHost);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function render() {
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

      while (frameHost.firstChild) frameHost.removeChild(frameHost.firstChild);
      frameHost.appendChild(buildIframeForUrl(url));
      if (isYt) {
        var note = document.createElement('p');
        note.className = 'small muted preview-yt-note';
        note.textContent = 'Player shows "Error 153"? The video owner blocked embedding. Click "Watch on YouTube" above.';
        frameHost.appendChild(note);
      }

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

    function close() {
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
    isPdf: isPdf,
    ytId: ytId,
    setPlaylistContext: setPlaylistContext,
    clearPlaylistContext: clearPlaylistContext,
    getPlaylistContext: getPlaylistContext
  };
})();
