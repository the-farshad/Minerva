/* Minerva — hand-rolled SVG charts.
 *
 * Tiny primitives used by the home dashboard (and anything else that
 * wants a chart without pulling a library). All SVG is built via
 * createElementNS — no innerHTML, no CDN. Colors resolve from CSS
 * variables so theme swaps Just Work.
 *
 * Public surface:
 *   M.charts.donut(value, max, opts)         -> <svg>
 *   M.charts.sparkline(values, opts)         -> <svg>
 *   M.charts.stackedBar(segments, opts)      -> <svg>
 *   M.charts.heatmapStrip(daily, opts)       -> <svg>
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

  // ---- stackedBar -------------------------------------------------------

  function stackedBar(segments, opts) {
    opts = opts || {};
    var width = num(opts.width) || 200;
    var height = num(opts.height) || 14;
    var trackColor = opts.track || 'var(--surface-2)';
    var defaultAccent = opts.accent || 'var(--accent)';
    var radius = num(opts.radius);
    if (!isFinite(radius) || radius < 0) radius = Math.min(height / 2, 4);

    var segs = (segments || []).map(function (s) {
      return {
        label: s && s.label ? String(s.label) : '',
        value: Math.max(0, num(s && s.value)),
        accent: s && s.accent ? s.accent : defaultAccent
      };
    });

    var total = 0;
    for (var i = 0; i < segs.length; i++) total += segs[i].value;

    var aria = opts.ariaLabel;
    if (!aria) {
      if (total > 0) {
        var parts = [];
        for (var ai = 0; ai < segs.length; ai++) {
          if (segs[ai].value > 0) {
            parts.push(segs[ai].value + ' ' + (segs[ai].label || 'segment'));
          }
        }
        aria = 'Stacked bar: ' + parts.join(', ');
      } else {
        aria = 'Stacked bar: empty';
      }
    }

    var svg = svgEl('svg', {
      class: 'chart-stacked-bar',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': aria
    });

    // Always render a track rect for shape consistency.
    svg.appendChild(svgEl('rect', {
      x: 0, y: 0, width: width, height: height,
      rx: radius, ry: radius,
      fill: trackColor
    }));

    if (total <= 0) return svg;

    var x = 0;
    for (var k = 0; k < segs.length; k++) {
      var s = segs[k];
      if (s.value <= 0) continue;
      var w = (s.value / total) * width;
      // Last visible segment: snap to the right edge to avoid sub-pixel gap.
      var isLast = true;
      for (var n = k + 1; n < segs.length; n++) {
        if (segs[n].value > 0) { isLast = false; break; }
      }
      if (isLast) w = width - x;
      svg.appendChild(svgEl('rect', {
        x: x.toFixed(2),
        y: 0,
        width: w.toFixed(2),
        height: height,
        fill: s.accent
      }));
      x += w;
    }

    return svg;
  }

  // ---- heatmapStrip -----------------------------------------------------

  function heatmapStrip(daily, opts) {
    opts = opts || {};
    var cellSize = num(opts.cellSize) || 14;
    var gap = num(opts.gap);
    if (!isFinite(gap) || gap < 0) gap = 2;
    var accent = opts.accent || 'var(--accent)';
    var trackColor = opts.track || 'var(--surface-2)';
    var radius = num(opts.radius);
    if (!isFinite(radius) || radius < 0) radius = 2;

    var arr = (daily || []).map(num);
    var n = arr.length;
    var width = n > 0 ? (cellSize * n + gap * Math.max(0, n - 1)) : cellSize;
    var height = cellSize;

    var max = 0;
    var total = 0;
    for (var i = 0; i < n; i++) {
      if (arr[i] > max) max = arr[i];
      total += arr[i];
    }

    var aria = opts.ariaLabel;
    if (!aria) aria = n + '-day heatmap, ' + total + ' total';

    var svg = svgEl('svg', {
      class: 'chart-heatmap-strip',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': aria
    });

    for (var k = 0; k < n; k++) {
      var x = k * (cellSize + gap);
      var v = arr[k];
      var attrs = {
        x: x,
        y: 0,
        width: cellSize,
        height: cellSize,
        rx: radius,
        ry: radius
      };
      if (v <= 0 || max <= 0) {
        attrs.fill = trackColor;
      } else {
        // Scale opacity 0.3 → 1.0 so even small values are visible.
        var op = 0.3 + (v / max) * 0.7;
        if (op > 1) op = 1;
        attrs.fill = accent;
        attrs['fill-opacity'] = op.toFixed(3);
      }
      svg.appendChild(svgEl('rect', attrs));
    }

    return svg;
  }

  M.charts = {
    donut: donut,
    sparkline: sparkline,
    stackedBar: stackedBar,
    heatmapStrip: heatmapStrip
  };
})();
