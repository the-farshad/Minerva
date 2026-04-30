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
 *   M.charts.histogram(values, opts)         -> <svg>
 *   M.charts.gantt(items, opts)              -> <svg>
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

  // ---- histogram --------------------------------------------------------

  function histogram(values, opts) {
    opts = opts || {};
    var bins = num(opts.bins) || 10;
    if (bins < 1) bins = 1;
    var width = num(opts.width) || 240;
    var height = num(opts.height) || 60;
    var accent = opts.accent || 'var(--accent)';
    var trackColor = opts.track || 'var(--surface-2)';
    var radius = num(opts.radius);
    if (!isFinite(radius) || radius < 0) radius = 2;
    var pad = 2;
    var gap = 2;

    var arr = (values || []).map(num);
    var max = num(opts.max);
    if (!(max > 0)) {
      max = 0;
      for (var mi = 0; mi < arr.length; mi++) if (arr[mi] > max) max = arr[mi];
      if (!(max > 0)) max = 1;
    }

    var counts = new Array(bins);
    for (var bi = 0; bi < bins; bi++) counts[bi] = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v < 0) v = 0;
      if (v > max) v = max;
      var idx = Math.floor((v / max) * bins);
      if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }

    var peak = 0;
    for (var pi = 0; pi < bins; pi++) if (counts[pi] > peak) peak = counts[pi];

    var aria = opts.ariaLabel;
    if (!aria) aria = bins + '-bin histogram of ' + arr.length + ' values';

    var svg = svgEl('svg', {
      class: 'chart-histogram',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': aria
    });

    var innerW = width - pad * 2;
    var innerH = height - pad * 2;
    var totalGap = gap * (bins - 1);
    var binW = (innerW - totalGap) / bins;
    if (binW < 1) binW = 1;

    for (var k = 0; k < bins; k++) {
      var x = pad + k * (binW + gap);
      // Track underlay — visible even for empty bins.
      svg.appendChild(svgEl('rect', {
        x: x.toFixed(2),
        y: pad,
        width: binW.toFixed(2),
        height: innerH,
        rx: radius,
        ry: radius,
        fill: trackColor
      }));
      var c = counts[k];
      if (c <= 0 || peak <= 0) continue;
      var h = (c / peak) * innerH;
      if (h < 1) h = 1;
      svg.appendChild(svgEl('rect', {
        x: x.toFixed(2),
        y: (pad + (innerH - h)).toFixed(2),
        width: binW.toFixed(2),
        height: h.toFixed(2),
        rx: radius,
        ry: radius,
        fill: accent
      }));
    }

    return svg;
  }

  // ---- gantt ------------------------------------------------------------

  function toMs(v) {
    if (v == null || v === '') return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var d = new Date(String(v));
    var t = d.getTime();
    return isFinite(t) ? t : NaN;
  }

  function gantt(items, opts) {
    opts = opts || {};
    var rowHeight = num(opts.rowHeight) || 14;
    var rowGap = num(opts.gap);
    if (!isFinite(rowGap) || rowGap < 0) rowGap = 2;
    var width = num(opts.width) || 320;
    var accent = opts.accent || 'var(--accent)';
    var trackColor = opts.track || 'var(--surface-2)';
    var radius = num(opts.radius);
    if (!isFinite(radius) || radius < 0) radius = 2;
    var pad = 2;

    var arr = (items || []).map(function (it) {
      return {
        label: it && it.label != null ? String(it.label) : '',
        start: toMs(it && it.start),
        end: toMs(it && it.end),
        accent: it && it.color ? it.color : accent
      };
    }).filter(function (it) {
      return isFinite(it.start) && isFinite(it.end);
    });

    var n = arr.length;
    var height = num(opts.height);
    if (!(height > 0)) {
      height = Math.max(rowHeight, n * rowHeight + Math.max(0, n - 1) * rowGap);
    }

    var aria = opts.ariaLabel;
    if (!aria) aria = 'Gantt with ' + n + ' bar' + (n === 1 ? '' : 's');

    var svg = svgEl('svg', {
      class: 'chart-gantt',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': aria
    });

    if (!n) return svg;

    var minMs = Infinity;
    var maxMs = -Infinity;
    for (var i = 0; i < n; i++) {
      var s = arr[i].start;
      var e = arr[i].end;
      if (e < s) { var swap = s; s = e; e = swap; arr[i].start = s; arr[i].end = e; }
      if (s < minMs) minMs = s;
      if (e > maxMs) maxMs = e;
    }
    var span = maxMs - minMs;
    var innerW = width - pad * 2;

    for (var k = 0; k < n; k++) {
      var y = pad + k * (rowHeight + rowGap);
      // Row track behind the bar so the time-window shape is legible.
      svg.appendChild(svgEl('rect', {
        x: pad,
        y: y,
        width: innerW,
        height: rowHeight,
        rx: radius,
        ry: radius,
        fill: trackColor
      }));
      var item = arr[k];
      var bx, bw;
      if (span <= 0) {
        bx = pad;
        bw = 1;
      } else {
        bx = pad + ((item.start - minMs) / span) * innerW;
        bw = ((item.end - item.start) / span) * innerW;
        if (bw < 1) bw = 1;
        if (bx + bw > pad + innerW) bw = (pad + innerW) - bx;
      }
      var rect = svgEl('rect', {
        x: bx.toFixed(2),
        y: y,
        width: bw.toFixed(2),
        height: rowHeight,
        rx: radius,
        ry: radius,
        fill: item.accent
      });
      if (item.label) {
        var titleEl = document.createElementNS(SVG_NS, 'title');
        titleEl.textContent = item.label;
        rect.appendChild(titleEl);
      }
      svg.appendChild(rect);
    }

    return svg;
  }

  M.charts = {
    donut: donut,
    sparkline: sparkline,
    stackedBar: stackedBar,
    heatmapStrip: heatmapStrip,
    histogram: histogram,
    gantt: gantt
  };
})();
