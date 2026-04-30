/* Minerva — hand-rolled SVG charts.
 *
 * Tiny primitives used by the home dashboard (and anything else that
 * wants a chart without pulling a library). All SVG is built via
 * createElementNS — no innerHTML, no CDN. Colors resolve from CSS
 * variables so theme swaps Just Work.
 *
 * Public surface:
 *   M.charts.donut(value, max, opts)     -> <svg>
 *   M.charts.sparkline(values, opts)     -> <svg>
 */
(function () {
  'use strict';

  var M = window.Minerva || (window.Minerva = {});
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    return n;
  }

  function clamp(n, lo, hi) {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // ---- donut ------------------------------------------------------------

  function donut(value, max, opts) {
    opts = opts || {};
    var size = num(opts.size) || 56;
    var thickness = num(opts.thickness) || 8;
    var accent = opts.accent || 'var(--accent)';
    var trackColor = opts.track || 'var(--surface-2)';

    var v = num(value);
    var m = num(max);
    var pct = m > 0 ? clamp(v / m, 0, 1) : 0;
    var labelText;
    if (typeof opts.label === 'string') {
      labelText = opts.label;
    } else {
      labelText = Math.round(pct * 100) + '%';
    }

    var cx = size / 2;
    var cy = size / 2;
    var r = (size - thickness) / 2;
    var circ = 2 * Math.PI * r;

    var svg = svgEl('svg', {
      class: 'chart-donut',
      width: size,
      height: size,
      viewBox: '0 0 ' + size + ' ' + size,
      role: 'img',
      'aria-label': 'Goal progress: ' + Math.round(pct * 100) + '%'
    });

    // Background ring.
    svg.appendChild(svgEl('circle', {
      cx: cx, cy: cy, r: r,
      fill: 'none',
      stroke: trackColor,
      'stroke-width': thickness
    }));

    // Foreground arc — start at 12 o'clock by rotating -90deg about center.
    var dash = circ * pct;
    var gap = circ - dash;
    var fg = svgEl('circle', {
      cx: cx, cy: cy, r: r,
      fill: 'none',
      stroke: accent,
      'stroke-width': thickness,
      'stroke-linecap': pct > 0 && pct < 1 ? 'round' : 'butt',
      'stroke-dasharray': dash + ' ' + gap,
      'stroke-dashoffset': 0,
      transform: 'rotate(-90 ' + cx + ' ' + cy + ')'
    });
    svg.appendChild(fg);

    // Centered label.
    var fontSize = Math.max(10, Math.round(size * 0.28));
    var text = svgEl('text', {
      x: cx,
      y: cy,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': fontSize,
      'font-weight': 600,
      fill: 'currentColor'
    });
    text.appendChild(document.createTextNode(labelText));
    svg.appendChild(text);

    return svg;
  }

  // ---- sparkline --------------------------------------------------------

  function sparkline(values, opts) {
    opts = opts || {};
    var width = num(opts.width) || 120;
    var height = num(opts.height) || 28;
    var accent = opts.accent || 'var(--accent)';
    var fill = opts.fill !== false;
    var pad = 2;

    var arr = (values || []).map(num);
    var total = 0;
    for (var i = 0; i < arr.length; i++) total += arr[i];

    var aria = opts.ariaLabel;
    if (!aria) aria = arr.length + '-point sparkline, total ' + total;

    var svg = svgEl('svg', {
      class: 'chart-sparkline',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': aria
    });

    // Empty / all-zero — flat dashed midline.
    var max = 0;
    for (var j = 0; j < arr.length; j++) if (arr[j] > max) max = arr[j];
    if (arr.length === 0 || max === 0) {
      var midY = height / 2;
      svg.appendChild(svgEl('line', {
        x1: pad, y1: midY, x2: width - pad, y2: midY,
        stroke: 'var(--border)',
        'stroke-width': 1,
        'stroke-dasharray': '3 3'
      }));
      return svg;
    }

    var n = arr.length;
    var innerW = width - pad * 2;
    var innerH = height - pad * 2;
    var stepX = n > 1 ? innerW / (n - 1) : 0;

    var pts = [];
    for (var k = 0; k < n; k++) {
      var x = pad + (n > 1 ? stepX * k : innerW / 2);
      var y = pad + innerH - (arr[k] / max) * innerH;
      pts.push(x.toFixed(2) + ',' + y.toFixed(2));
    }

    if (fill) {
      var areaPts = pts.slice();
      var lastX = (pad + (n > 1 ? stepX * (n - 1) : innerW / 2)).toFixed(2);
      var firstX = (pad + (n > 1 ? 0 : innerW / 2)).toFixed(2);
      var floorY = (height - pad).toFixed(2);
      areaPts.push(lastX + ',' + floorY);
      areaPts.push(firstX + ',' + floorY);
      svg.appendChild(svgEl('polygon', {
        points: areaPts.join(' '),
        fill: accent,
        'fill-opacity': 0.18,
        stroke: 'none'
      }));
    }

    svg.appendChild(svgEl('polyline', {
      points: pts.join(' '),
      fill: 'none',
      stroke: accent,
      'stroke-width': 1.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    }));

    return svg;
  }

  M.charts = { donut: donut, sparkline: sparkline };
})();
