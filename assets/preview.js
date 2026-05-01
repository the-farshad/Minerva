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

  function show(url) {
    if (document.querySelector('.preview-overlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay preview-overlay';
    overlay.addEventListener('click', function () { overlay.remove(); });

    var panel = document.createElement('div');
    panel.className = 'modal-panel preview-panel';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    var head = document.createElement('div');
    head.className = 'preview-head';
    var titleEl = document.createElement('span');
    titleEl.className = 'preview-title';
    var hostName = '';
    try { hostName = new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { hostName = url; }
    titleEl.textContent = hostName;

    var openA = document.createElement('a');
    openA.href = url;
    openA.target = '_blank';
    openA.rel = 'noopener';
    openA.className = 'btn btn-ghost';
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      openA.appendChild(Minerva.render.icon('external-link'));
      openA.appendChild(document.createTextNode(' Open'));
    } else {
      openA.textContent = 'Open';
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { overlay.remove(); });

    head.appendChild(titleEl);
    head.appendChild(openA);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var iframe = document.createElement('iframe');
    iframe.className = 'preview-frame';
    iframe.referrerPolicy = 'no-referrer';
    iframe.allow = 'fullscreen; autoplay; encrypted-media';

    var yt = ytId(url);
    if (yt) {
      iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(yt);
    } else if (isPdf(url)) {
      // Google's universal docs viewer renders any public PDF without
      // hitting CORS. For arxiv pdf links it works directly.
      iframe.src = 'https://docs.google.com/viewer?url=' + encodeURIComponent(url) + '&embedded=true';
    } else {
      iframe.src = url;
    }
    panel.appendChild(iframe);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var onKey = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.preview = { show: show, isPdf: isPdf, ytId: ytId };
})();
