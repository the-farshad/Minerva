/* Minerva — QR (SVG) helper.
 * Wraps the global `qrcode` from qrcode-generator (loaded via CDN in index.html).
 * Returns a crisp <svg> element you can insert into the DOM.
 *
 * Usage:
 *   const svg = Minerva.qr("https://example.com", { ec: "M", margin: 2 });
 *   document.body.appendChild(svg);
 */
(function () {
  'use strict';

  function makeSvg(text, opts) {
    opts = opts || {};
    var ec = opts.ec || 'M';                  // L | M | Q | H
    var margin = opts.margin == null ? 2 : opts.margin;
    var fg = opts.fg || '#000000';
    var bg = opts.bg || '#ffffff';

    if (typeof qrcode !== 'function') {
      throw new Error('qrcode-generator not loaded');
    }

    // pick the smallest type number that fits the data
    var qr;
    var fit = false;
    for (var v = 4; v <= 40; v++) {
      try {
        qr = qrcode(v, ec);
        qr.addData(text);
        qr.make();
        fit = true;
        break;
      } catch (e) {
        if (v === 40) throw e;
      }
    }
    if (!fit) throw new Error('QR data too large');

    var count = qr.getModuleCount();
    var size = count + margin * 2;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', ns);
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    if (bg && bg !== 'transparent') {
      var rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('width', size);
      rect.setAttribute('height', size);
      rect.setAttribute('fill', bg);
      svg.appendChild(rect);
    }

    var d = '';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          d += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
        }
      }
    }
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fg);
    svg.appendChild(path);

    return svg;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.qr = makeSvg;
})();
