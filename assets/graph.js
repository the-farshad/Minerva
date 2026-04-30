/* Minerva — section graph view (slice A-1).
 *
 * Hand-rolled SVG graph for sections that have a self-referential
 * ref(<self>) column (today: goals.parent). Builds a {nodes, edges}
 * graph from the section's rows, computes a layered-DAG layout via
 * longest-path layering, and renders straight/curved edges with
 * cycle-tolerant DFS coloring. No library, no force layout — those
 * arrive in slice A-3.
 *
 * Public surface:
 *   M.graph.buildGraphFromTab(tab)    -> Promise<{nodes, edges, cycleEdges}>
 *   M.graph.renderGraph(host, data)   -> void  (mounts SVG, wires events)
 */
(function () {
  'use strict';

  var M = window.Minerva || (window.Minerva = {});
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ROW_SPACING = 90;   // px between layer rows
  var COL_SPACING = 150;  // px between siblings within a layer
  var PAD = 40;           // outer padding inside the SVG viewBox
  var NODE_R = 7;         // node circle radius
  var LABEL_MAX = 24;     // truncated label length
  var COMP_GAP = 60;      // horizontal gap between disconnected components

  // ---- helpers ----------------------------------------------------------

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

  function truncate(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  function rowLabel(row) {
    if (!row) return '';
    return String(row.title || row.name || row.question || row.decision || row.id || '');
  }

  // ---- build graph from a section's rows --------------------------------

  async function buildGraphFromTab(tab) {
    var meta = await M.db.getMeta(tab);
    var rows = await M.db.getAllRows(tab);
    var visible = (rows || []).filter(function (r) { return !r._deleted; });

    var parentCol = null;
    if (meta && meta.headers && meta.types) {
      for (var i = 0; i < meta.headers.length; i++) {
        var t = M.render.parseType(meta.types[i]);
        if (t.kind === 'ref' && t.refTab === tab && !t.multi) {
          parentCol = meta.headers[i];
          break;
        }
      }
    }

    var nodes = [];
    var byId = {};
    visible.forEach(function (r) {
      var n = { id: String(r.id), label: rowLabel(r), tab: tab, row: r };
      nodes.push(n);
      byId[n.id] = n;
    });

    var rawEdges = [];
    if (parentCol) {
      visible.forEach(function (r) {
        var pid = r[parentCol];
        if (pid == null || pid === '') return;
        pid = String(pid).trim();
        if (!pid) return;
        if (!byId[pid]) return; // dangling parent ref — skip
        // Direction: parent -> child (parent is layer above child).
        rawEdges.push({ from: pid, to: String(r.id) });
      });
    }

    // ---- DFS coloring to detect back-edges (cycles) -------------------
    // White = 0 (unvisited), Gray = 1 (in current stack), Black = 2 (done).
    // An edge to a Gray node is a back-edge; move it to cycleEdges so the
    // remaining edges form a DAG.
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    rawEdges.forEach(function (e) { adj[e.from].push(e.to); });

    var color = {};
    nodes.forEach(function (n) { color[n.id] = 0; });

    var cycleSet = {}; // key "from->to" => true if back-edge
    var stack;

    function visit(start) {
      // Iterative DFS to avoid stack-overflow on very long chains.
      stack = [{ id: start, i: 0 }];
      color[start] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1];
        var children = adj[top.id];
        if (top.i >= children.length) {
          color[top.id] = 2;
          stack.pop();
          continue;
        }
        var next = children[top.i++];
        var c = color[next];
        if (c === 0) {
          color[next] = 1;
          stack.push({ id: next, i: 0 });
        } else if (c === 1) {
          // back-edge — cycle
          cycleSet[top.id + '->' + next] = true;
        }
        // c === 2: cross/forward edge in DAG terms — keep as-is
      }
    }

    for (var ni = 0; ni < nodes.length; ni++) {
      if (color[nodes[ni].id] === 0) visit(nodes[ni].id);
    }

    var edges = [];
    var cycleEdges = [];
    rawEdges.forEach(function (e) {
      if (cycleSet[e.from + '->' + e.to]) cycleEdges.push(e);
      else edges.push(e);
    });

    return { nodes: nodes, edges: edges, cycleEdges: cycleEdges };
  }

  // ---- layered-DAG layout ----------------------------------------------

  function computeLayers(nodes, edges) {
    // Longest-path layering on the DAG. layer[v] = 1 + max layer[u] for u->v.
    var inAdj = {};
    var outAdj = {};
    var indeg = {};
    nodes.forEach(function (n) {
      inAdj[n.id] = [];
      outAdj[n.id] = [];
      indeg[n.id] = 0;
    });
    edges.forEach(function (e) {
      if (!inAdj[e.to] || !outAdj[e.from]) return;
      inAdj[e.to].push(e.from);
      outAdj[e.from].push(e.to);
      indeg[e.to]++;
    });

    // Kahn-style topological order, then assign layers.
    var queue = [];
    nodes.forEach(function (n) { if (indeg[n.id] === 0) queue.push(n.id); });
    var layer = {};
    nodes.forEach(function (n) { layer[n.id] = 0; });
    var topo = [];
    var seen = {};
    var qi = 0;
    while (qi < queue.length) {
      var id = queue[qi++];
      if (seen[id]) continue;
      seen[id] = true;
      topo.push(id);
      var outs = outAdj[id];
      for (var j = 0; j < outs.length; j++) {
        var v = outs[j];
        indeg[v]--;
        if (indeg[v] === 0) queue.push(v);
      }
    }
    // Anything not in topo (shouldn't happen on a DAG) — append so layout
    // doesn't drop them.
    nodes.forEach(function (n) { if (!seen[n.id]) topo.push(n.id); });

    topo.forEach(function (id) {
      var ins = inAdj[id] || [];
      var max = -1;
      for (var k = 0; k < ins.length; k++) {
        if (layer[ins[k]] > max) max = layer[ins[k]];
      }
      layer[id] = max + 1;
    });

    return layer;
  }

  function findComponents(nodes, edges, cycleEdges) {
    // Treat the graph as undirected for component grouping so that cycle-only
    // links keep their members in the same band.
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    function add(e) {
      if (!adj[e.from] || !adj[e.to]) return;
      adj[e.from].push(e.to);
      adj[e.to].push(e.from);
    }
    edges.forEach(add);
    (cycleEdges || []).forEach(add);

    var seen = {};
    var comps = [];
    nodes.forEach(function (n) {
      if (seen[n.id]) return;
      var comp = [];
      var stack = [n.id];
      seen[n.id] = true;
      while (stack.length) {
        var id = stack.pop();
        comp.push(id);
        var nbrs = adj[id];
        for (var i = 0; i < nbrs.length; i++) {
          if (!seen[nbrs[i]]) {
            seen[nbrs[i]] = true;
            stack.push(nbrs[i]);
          }
        }
      }
      comps.push(comp);
    });
    return comps;
  }

  function layoutGraph(nodes, edges, cycleEdges) {
    if (!nodes.length) return { positions: {}, width: 320, height: 200 };

    var layer = computeLayers(nodes, edges);
    var nodeById = {};
    nodes.forEach(function (n) { nodeById[n.id] = n; });

    var comps = findComponents(nodes, edges, cycleEdges);
    var positions = {};
    var xOffset = PAD;
    var maxHeight = 0;

    comps.forEach(function (compIds) {
      // Group component's nodes by layer.
      var byLayer = {};
      var maxLayer = 0;
      compIds.forEach(function (id) {
        var L = layer[id] || 0;
        if (L > maxLayer) maxLayer = L;
        if (!byLayer[L]) byLayer[L] = [];
        byLayer[L].push(id);
      });

      // Stable sort within each layer by label.
      var widest = 0;
      for (var L = 0; L <= maxLayer; L++) {
        var arr = byLayer[L] || [];
        arr.sort(function (a, b) {
          var la = (nodeById[a].label || '').toLowerCase();
          var lb = (nodeById[b].label || '').toLowerCase();
          if (la < lb) return -1;
          if (la > lb) return 1;
          return 0;
        });
        if (arr.length > widest) widest = arr.length;
      }

      var compWidth = Math.max(1, widest) * COL_SPACING;
      var compHeight = (maxLayer + 1) * ROW_SPACING;

      for (var L2 = 0; L2 <= maxLayer; L2++) {
        var row = byLayer[L2] || [];
        var n = row.length;
        // Center the row within compWidth.
        var rowWidth = n * COL_SPACING;
        var startX = xOffset + (compWidth - rowWidth) / 2 + COL_SPACING / 2;
        for (var k = 0; k < n; k++) {
          var id = row[k];
          positions[id] = {
            x: startX + k * COL_SPACING,
            y: PAD + L2 * ROW_SPACING
          };
        }
      }

      xOffset += compWidth + COMP_GAP;
      if (compHeight > maxHeight) maxHeight = compHeight;
    });

    var width = Math.max(320, xOffset - COMP_GAP + PAD);
    var height = Math.max(200, maxHeight + PAD * 2);
    return { positions: positions, width: width, height: height };
  }

  // ---- SVG rendering ----------------------------------------------------

  function buildEdgePath(p1, p2) {
    // Same column → straight line; otherwise a soft quadratic Bezier.
    if (Math.abs(p1.x - p2.x) < 0.5) {
      return 'M' + p1.x + ',' + p1.y + ' L' + p2.x + ',' + p2.y;
    }
    var midY = (p1.y + p2.y) / 2;
    return 'M' + p1.x + ',' + p1.y +
      ' C' + p1.x + ',' + midY + ' ' + p2.x + ',' + midY + ' ' + p2.x + ',' + p2.y;
  }

  function buildCyclePath(p1, p2) {
    // Dashed back-arc that bows away from the column to make it visually
    // distinct from forward edges.
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    // perpendicular offset
    var ox = -dy / dist * 40;
    var oy = dx / dist * 40;
    var cx = (p1.x + p2.x) / 2 + ox;
    var cy = (p1.y + p2.y) / 2 + oy;
    return 'M' + p1.x + ',' + p1.y + ' Q' + cx + ',' + cy + ' ' + p2.x + ',' + p2.y;
  }

  function renderGraph(host, data) {
    if (!host) return;
    host.innerHTML = '';
    host.classList.add('graph-host');

    var nodes = (data && data.nodes) || [];
    var edges = (data && data.edges) || [];
    var cycleEdges = (data && data.cycleEdges) || [];
    var tab = data && data.tab;

    if (!nodes.length) {
      var empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = 'No nodes — create some rows in this section to see the graph.';
      host.appendChild(empty);
      return;
    }

    var layout = layoutGraph(nodes, edges, cycleEdges);
    var W = layout.width;
    var H = layout.height;
    var positions = layout.positions;

    var svg = svgEl('svg', {
      class: 'minerva-graph',
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet'
    });

    // Arrowhead marker for forward edges.
    var defs = svgEl('defs');
    var marker = svgEl('marker', {
      id: 'minerva-graph-arrow',
      viewBox: '0 0 10 10',
      refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6',
      orient: 'auto-start-reverse'
    });
    marker.appendChild(svgEl('path', {
      d: 'M0,0 L10,5 L0,10 z',
      fill: 'currentColor',
      class: 'graph-arrow'
    }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var edgesG = svgEl('g', { class: 'graph-edges' });
    var nodesG = svgEl('g', { class: 'graph-nodes' });
    svg.appendChild(edgesG);
    svg.appendChild(nodesG);

    // Forward edges.
    edges.forEach(function (e) {
      var p1 = positions[e.from];
      var p2 = positions[e.to];
      if (!p1 || !p2) return;
      // Trim endpoints toward node circle so the arrow doesn't sit inside.
      var dx = p2.x - p1.x, dy = p2.y - p1.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var t = NODE_R + 2;
      var p1t = { x: p1.x + dx / len * t, y: p1.y + dy / len * t };
      var p2t = { x: p2.x - dx / len * t, y: p2.y - dy / len * t };
      var path = svgEl('path', {
        class: 'graph-edge',
        d: buildEdgePath(p1t, p2t),
        'marker-end': 'url(#minerva-graph-arrow)'
      });
      edgesG.appendChild(path);
    });

    // Cycle (back-edge) arcs — dashed.
    cycleEdges.forEach(function (e) {
      var p1 = positions[e.from];
      var p2 = positions[e.to];
      if (!p1 || !p2) return;
      var path = svgEl('path', {
        class: 'graph-edge graph-edge-cycle',
        d: buildCyclePath(p1, p2),
        'marker-end': 'url(#minerva-graph-arrow)'
      });
      edgesG.appendChild(path);
    });

    // Habit nodes (whole habits tab) get a self-loop badge as a schema-level
    // signal of "recurring." Other tabs only get a self-loop when the row's
    // own data points at itself.
    var habitTab = tab === 'habits';

    nodes.forEach(function (n) {
      var p = positions[n.id];
      if (!p) return;
      var g = svgEl('g', {
        class: 'graph-node',
        tabindex: '0',
        'data-row-id': n.id,
        transform: 'translate(' + p.x + ',' + p.y + ')'
      });
      g.appendChild(svgEl('circle', { r: NODE_R, cx: 0, cy: 0 }));

      // Self-loop indicator (small circle to the right).
      var selfRef = false;
      edges.concat(cycleEdges).forEach(function (e) {
        if (e.from === n.id && e.to === n.id) selfRef = true;
      });
      if (habitTab || selfRef) {
        g.appendChild(svgEl('circle', {
          class: 'graph-self-loop',
          cx: NODE_R + 6, cy: -NODE_R - 2, r: 4,
          fill: 'none'
        }));
      }

      var label = svgEl('text', {
        x: 0, y: NODE_R + 14,
        'text-anchor': 'middle'
      });
      label.textContent = truncate(n.label || n.id, LABEL_MAX);
      g.appendChild(label);

      // Title tooltip with full label on hover.
      var titleEl = svgEl('title');
      titleEl.textContent = n.label || n.id;
      g.appendChild(titleEl);

      var openDetail = function () {
        var rowId = n.id;
        if (M.app && typeof M.app.showRowDetail === 'function') {
          M.app.showRowDetail(tab, rowId);
        } else {
          // Fall back to URL hash so the existing router can pick it up.
          location.hash = '#/s/' + tab + '?row=' + encodeURIComponent(rowId);
        }
      };
      g.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openDetail();
      });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openDetail();
        }
      });

      nodesG.appendChild(g);
    });

    host.appendChild(svg);

    // ---- pan + zoom via viewBox manipulation -----------------------------
    var view = { x: 0, y: 0, w: W, h: H };
    function applyView() {
      svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    }

    var dragging = false;
    var dragId = null;
    var lastX = 0, lastY = 0;
    var didDrag = false;

    host.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) / rect.width;
      var py = (ev.clientY - rect.top) / rect.height;
      var factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      var newW = view.w * factor;
      var newH = view.h * factor;
      // Clamp so we don't zoom past [0.25x, 4x] of the natural extent.
      if (newW < W / 4 || newW > W * 4) return;
      var ax = view.x + view.w * px;
      var ay = view.y + view.h * py;
      view.x = ax - newW * px;
      view.y = ay - newH * py;
      view.w = newW;
      view.h = newH;
      applyView();
    }, { passive: false });

    host.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('.graph-node')) return;
      dragging = true;
      didDrag = false;
      dragId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      try { host.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      host.classList.add('is-panning');
    });
    host.addEventListener('pointermove', function (ev) {
      if (!dragging || ev.pointerId !== dragId) return;
      var dx = ev.clientX - lastX;
      var dy = ev.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) didDrag = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      var rect = svg.getBoundingClientRect();
      var sx = view.w / rect.width;
      var sy = view.h / rect.height;
      view.x -= dx * sx;
      view.y -= dy * sy;
      applyView();
    });
    function endDrag(ev) {
      if (!dragging) return;
      if (ev && ev.pointerId !== dragId) return;
      dragging = false;
      try { host.releasePointerCapture(dragId); } catch (e) { /* ignore */ }
      host.classList.remove('is-panning');
    }
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('pointerleave', function (ev) { if (dragging) endDrag(ev); });
  }

  M.graph = {
    buildGraphFromTab: buildGraphFromTab,
    renderGraph: renderGraph
  };
})();
