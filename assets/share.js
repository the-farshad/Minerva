/* Minerva — share encode/decode + PNG export.
 * Public-share payload travels in the URL hash, so anyone with the link
 * sees the same card. No backend, no upload.
 *
 * Encoding: base64url(JSON.stringify(payload)) — UTF-8 safe.
 * Limits: ~2KB payload (browsers tolerate longer URLs but Twitter/SMS shorten).
 */
(function () {
  'use strict';

  function utf8Encode(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function utf8Decode(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    var pad = b64.length % 4;
    if (pad) b64 += '===='.slice(pad);
    return decodeURIComponent(escape(atob(b64)));
  }

  function encode(payload) {
    return utf8Encode(JSON.stringify(payload));
  }

  function decode(token) {
    return JSON.parse(utf8Decode(token));
  }

  function shareUrl(payload) {
    return location.origin + location.pathname + '#/p/' + encode(payload);
  }

  // Render an SVG QR code into a PNG blob at higher resolution (default 16×).
  function svgToPngBlob(svg, scale) {
    return new Promise(function (resolve, reject) {
      var xml = new XMLSerializer().serializeToString(svg);
      // ensure xmlns is present even if browser stripped it
      if (!/xmlns="/.test(xml)) {
        xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      var img = new Image();
      var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var s = scale || 16;
      var box = svg.viewBox && svg.viewBox.baseVal;
      var w = (box && box.width) || 256;

      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = c.height = Math.round(w * s);
        var ctx = c.getContext('2d');
        // white background so PNG looks right on dark backgrounds
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob failed')); }, 'image/png');
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('image load failed'));
      };
      img.src = url;
    });
  }

  async function downloadPng(svg, filename) {
    var blob = await svgToPngBlob(svg, 16);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'minerva-qr.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  window.Minerva = window.Minerva || {};
  Object.assign(window.Minerva, { encode: encode, decode: decode, shareUrl: shareUrl, downloadPng: downloadPng });
})();
