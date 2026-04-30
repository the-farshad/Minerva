/* Minerva — section graph view (slices A-1, A-2, A-3).
 *
 * Hand-rolled SVG graph for sections that have a self-referential
 * ref(<self>) column (today: goals.parent), and a top-level cross-tab
 * graph that unions every ref column across every section. Builds a
 * {nodes, edges} graph and renders with one of two layouts:
 *  - Layered DAG (default): synchronous, longest-path layering.
 *  - Force-directed: lazy-loads d3-force from jsDelivr on first use,
 *    runs a tick-bounded simulation, mutates node x/y in place.
 *
 * Public surface:
 *   M.graph.buildGraphFromTab(tab)    -> Promise<{nodes, edges, cycleEdges}>
 *   M.graph.buildGraphFromAll()       -> Promise<{nodes, edges, cycleEdges, tabs}>
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

  var D3_FORCE_URL = 'https://cdn.jsdelivr.net/npm/d3-force@3.0.0/dist/d3-force.min.js';
  var LAYOUT_PREF_KEY = 'minerva.graph.layout';

  // Tick-bounded force simulation parameters (per planner). 150 ticks at
  // alpha decay 0.05 converges in well under 2s for ~200 nodes.
  var FORCE_MAX_TICKS = 150;
  var FORCE_TICKS_PER_FRAME = 5;
  var FORCE_ALPHA_DECAY = 0.05;
  var FORCE_ALPHA_MIN = 0.01;
  var FORCE_LINK_DISTANCE = 80;
  var FORCE_CHARGE = -260;
  var FORCE_COLLIDE_R = NODE_R + 8;
  var FORCE_COLLIDE_DROP_THRESHOLD = 200; // skip collide above this node count

  // ---- lazy-loaded d3-force --------------------------------------------
  var d3ForceLoader = null;
  function loadD3Force() {
    if (d3ForceLoader) return d3ForceLoader;
    d3ForceLoader = new Promise(function (resolve, reject) {
      if (window.d3 && window.d3.forceSimulation) { resolve(window.d3); return; }
      var s = document.createElement('script');
      s.src = D3_FORCE_URL;
      s.onload = function () {
        if (window.d3 && window.d3.forceSimulation) resolve(window.d3);
        else reject(new Error('d3-force loaded but global missing'));
      };
      s.onerror = function () {
        d3ForceLoader = null; // allow retry after a transient failure
        reject(new Error('d3-force CDN unreachable'));
      };
      document.head.appendChild(s);
    });
    return d3ForceLoader;
  }

  function readLayoutPref() {
    try {
      var v = localStorage.getItem(LAYOUT_PREF_KEY);
      if (v === 'force' || v === 'layered') return v;
    } catch (e) { /* ignore */ }
    return 'layered';
  }
  function writeLayoutPref(v) {
    try { localStorage.setItem(LAYOUT_PREF_KEY, v); }
    catch (e) { /* ignore */ }
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

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

  function tabLabel(tab) {
    var t = String(tab || '');
    if (!t) return '';
    // Try to look up the section title from cached config.
    try {
      if (window.Minerva && window.Minerva.app && typeof window.Minerva.app.tabTitle === 'function') {
        var title = window.Minerva.app.tabTitle(t);
        if (title) return title;
      }
    } catch (e) { /* ignore */ }
    // Fallback: capitalize the slug.
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ---- cycle detection (shared) ----------------------------------------
  // DFS coloring: White=0, Gray=1, Black=2. Edges to a Gray node are
  // back-edges; we move them to cycleEdges so the rest forms a DAG.
  // Iterative to avoid stack overflow on long chains.
  function splitCycleEdges(nodes, rawEdges) {
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    rawEdges.forEach(function (e) {
      if (adj[e.from]) adj[e.from].push(e.to);
    });

    var color = {};
    nodes.forEach(function (n) { color[n.id] = 0; });
    var cycleSet = {};

    function visit(start) {
      var stack = [{ id: start, i: 0 }];
      color[start] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1];
        var children = adj[top.id] || [];
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
          cycleSet[top.id + '->' + next] = true;
        }
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
    return { edges: edges, cycleEdges: cycleEdges };
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

    var split = splitCycleEdges(nodes, rawEdges);
    return { nodes: nodes, edges: split.edges, cycleEdges: split.cycleEdges };
  }

  // ---- build graph from every section with ref columns -----------------
  // Returns the union of cross-tab edges. Self-ref columns
  // (e.g. goals.parent -> goals) are still included. Habit-tab nodes
  // get a synthetic self-loop as a schema-level signal of "recurring."

  async function buildGraphFromAll() {
    var allMeta = [];
    try { allMeta = (await M.db.getAllMeta()) || []; }
    catch (e) { allMeta = []; }

    var nodes = [];
    var byId = {};
    var rawEdges = [];
    var tabsSet = {};

    function ensureNode(rowId, tab, row) {
      if (!rowId) return null;
      var key = String(rowId);
      var existing = byId[key];
      if (existing) {
        if (!existing.row && row) existing.row = row;
        if ((!existing.label || existing.label === existing.id) && row) {
          existing.label = rowLabel(row) || existing.label;
        }
        return existing;
      }
      var n = {
        id: key,
        label: row ? rowLabel(row) : key,
        tab: tab,
        row: row || null
      };
      nodes.push(n);
      byId[key] = n;
      if (tab) tabsSet[tab] = true;
      return n;
    }

    // Pass 1: register every alive row as a node (so dangling refs that
    // happen to point at a known row still resolve).
    for (var i = 0; i < allMeta.length; i++) {
      var m = allMeta[i];
      if (!m || !m.tab) continue;
      // Skip _config / _prefs / _log and any internal tab.
      if (m.tab.charAt(0) === '_') continue;
      var rows;
      try { rows = await M.db.getAllRows(m.tab); }
      catch (e) { rows = []; }
      (rows || []).forEach(function (r) {
        if (!r || r._deleted) return;
        ensureNode(r.id, m.tab, r);
      });
    }

    // Pass 2: walk every ref column on every section and emit edges.
    var hasRefColumns = false;
    for (var j = 0; j < allMeta.length; j++) {
      var meta = allMeta[j];
      if (!meta || !meta.tab || !meta.headers || !meta.types) continue;
      if (meta.tab.charAt(0) === '_') continue;

      var refCols = [];
      for (var k = 0; k < meta.headers.length; k++) {
        var t = M.render.parseType(meta.types[k]);
        if (t.kind === 'ref' && t.refTab) {
          refCols.push({ name: meta.headers[k], refTab: t.refTab, multi: !!t.multi });
        }
      }
      if (!refCols.length) continue;
      hasRefColumns = true;

      var rows2;
      try { rows2 = await M.db.getAllRows(meta.tab); }
      catch (e) { rows2 = []; }
      (rows2 || []).forEach(function (r) {
        if (!r || r._deleted) return;
        var fromId = String(r.id || '');
        if (!fromId) return;
        refCols.forEach(function (c) {
          var raw = r[c.name];
          if (raw == null || raw === '') return;
          var ids = c.multi
            ? String(raw).split(',').map(function (x) { return x.trim(); }).filter(Boolean)
            : [String(raw).trim()];
          ids.forEach(function (toId) {
            if (!toId) return;
            // If the target row hasn't been seen, register a stub node so
            // dangling cross-tab refs still surface in the graph.
            if (!byId[toId]) ensureNode(toId, c.refTab, null);
            rawEdges.push({
              from: fromId,
              to: toId,
              fromTab: meta.tab,
              toTab: c.refTab
            });
          });
        });
      });
    }

    // Strip self-edges out of the cycle/DAG split so they don't bleed
    // into the dashed cycle arcs; the renderer treats e.from === e.to
    // as a self-loop badge instead.
    var nonSelf = [];
    var selfFromData = [];
    rawEdges.forEach(function (e) {
      if (e.from === e.to) selfFromData.push(e);
      else nonSelf.push(e);
    });

    var split = splitCycleEdges(nodes, nonSelf);

    // Habit-tab nodes get a synthetic self-loop. This is the schema-
    // level signal of "recurring" — the renderer draws the loop indicator
    // when it sees an edge with from === to.
    var selfLoopEdges = selfFromData.slice();
    var habitSeen = {};
    selfFromData.forEach(function (e) { habitSeen[e.from] = true; });
    nodes.forEach(function (n) {
      if (n.tab === 'habits' && !habitSeen[n.id]) {
        selfLoopEdges.push({
          from: n.id, to: n.id, selfLoop: true,
          fromTab: 'habits', toTab: 'habits'
        });
      }
    });

    var tabs = Object.keys(tabsSet).sort();
    return {
      nodes: nodes,
      edges: split.edges.concat(selfLoopEdges),
      cycleEdges: split.cycleEdges,
      tabs: tabs,
      hasRefColumns: hasRefColumns
    };
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
      if (e.from === e.to) return; // self-loops don't affect layering
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

  // ---- force-directed layout (d3-force) --------------------------------
  // Mutates a copy of `nodes` with x/y attributes and returns
  // { positions, width, height } in the same shape as layoutGraph.
  // Tick-bounded so we never freeze the UI.

  function runSimulationTicks(simulation, totalTicks, perFrame, useAnimation) {
    return new Promise(function (resolve) {
      var ticked = 0;

      if (!useAnimation) {
        // Reduced-motion path: run synchronously, but yield once via
        // setTimeout so the host can paint a "loading" state first.
        setTimeout(function () {
          while (ticked < totalTicks && simulation.alpha() >= FORCE_ALPHA_MIN) {
            simulation.tick();
            ticked++;
          }
          simulation.stop();
          resolve();
        }, 0);
        return;
      }

      function step() {
        var budget = perFrame;
        while (budget-- > 0 && ticked < totalTicks &&
               simulation.alpha() >= FORCE_ALPHA_MIN) {
          simulation.tick();
          ticked++;
        }
        if (ticked >= totalTicks || simulation.alpha() < FORCE_ALPHA_MIN) {
          simulation.stop();
          resolve();
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  async function applyForceLayout(nodes, edges, cycleEdges) {
    var d3 = await loadD3Force();
    if (!nodes.length) return { positions: {}, width: 320, height: 200 };

    // d3-force mutates the input objects, so copy the bare positional
    // shells to keep the source data structures clean.
    var simNodes = nodes.map(function (n) {
      return { id: n.id };
    });
    var byId = {};
    simNodes.forEach(function (n) { byId[n.id] = n; });

    var allEdges = (edges || []).concat(cycleEdges || []);
    var simLinks = [];
    allEdges.forEach(function (e) {
      if (e.from === e.to) return; // self-loops don't participate in layout
      if (!byId[e.from] || !byId[e.to]) return;
      simLinks.push({ source: e.from, target: e.to });
    });

    var sim = d3.forceSimulation(simNodes)
      .alphaDecay(FORCE_ALPHA_DECAY)
      .force('link', d3.forceLink(simLinks)
        .id(function (d) { return d.id; })
        .distance(FORCE_LINK_DISTANCE))
      .force('charge', d3.forceManyBody().strength(FORCE_CHARGE))
      .force('center', d3.forceCenter(0, 0));

    if (simNodes.length <= FORCE_COLLIDE_DROP_THRESHOLD) {
      sim.force('collide', d3.forceCollide(FORCE_COLLIDE_R));
    }

    // Halt the auto-running simulation; we'll drive it ourselves.
    sim.stop();

    var useAnimation = !prefersReducedMotion();
    await runSimulationTicks(sim, FORCE_MAX_TICKS, FORCE_TICKS_PER_FRAME, useAnimation);

    // Translate so the bounding box starts at (PAD, PAD).
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    simNodes.forEach(function (n) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 320; maxY = 200; }

    var positions = {};
    simNodes.forEach(function (n) {
      positions[n.id] = { x: n.x - minX + PAD, y: n.y - minY + PAD };
    });
    var width = Math.max(320, (maxX - minX) + PAD * 2);
    var height = Math.max(200, (maxY - minY) + PAD * 2);
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

    var nodes = (data && data.nodes) || [];
    var edges = (data && data.edges) || [];
    var cycleEdges = (data && data.cycleEdges) || [];
    var tab = data && data.tab;
    var tabsList = (data && data.tabs) || null;
    var focusId = data && data.focus ? String(data.focus) : '';
    var emptyMsg = (data && data.emptyMessage) ||
      'No nodes — create some rows in this section to see the graph.';

    // ---- chrome (toggle row + chip filter row + canvas host) -----------
    host.classList.remove('graph-host');
    host.classList.add('graph-wrap');

    var toggleRow = document.createElement('div');
    toggleRow.className = 'graph-layout-toggle';
    var armLayered = document.createElement('button');
    armLayered.type = 'button';
    armLayered.className = 'graph-layout-arm';
    armLayered.setAttribute('data-mode', 'layered');
    armLayered.textContent = 'Layered';
    var armForce = document.createElement('button');
    armForce.type = 'button';
    armForce.className = 'graph-layout-arm';
    armForce.setAttribute('data-mode', 'force');
    armForce.textContent = 'Force';
    toggleRow.appendChild(armLayered);
    toggleRow.appendChild(armForce);
    host.appendChild(toggleRow);

    var chipsRow = null;
    if (tabsList && tabsList.length) {
      chipsRow = document.createElement('div');
      chipsRow.className = 'graph-chips';
      host.appendChild(chipsRow);
    }

    var canvasHost = document.createElement('div');
    canvasHost.className = 'graph-host';
    host.appendChild(canvasHost);

    var graphHost = canvasHost;

    if (!nodes.length) {
      armLayered.classList.add('is-active');
      var empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = emptyMsg;
      graphHost.appendChild(empty);
      return;
    }

    // ---- layout-mode wiring --------------------------------------------
    var mode = readLayoutPref();

    function paintArms() {
      if (mode === 'force') {
        armForce.classList.add('is-active');
        armLayered.classList.remove('is-active');
      } else {
        armLayered.classList.add('is-active');
        armForce.classList.remove('is-active');
      }
    }

    function showLoading() {
      graphHost.innerHTML = '';
      var msg = document.createElement('div');
      msg.className = 'graph-loading';
      msg.textContent = 'Loading force layout…';
      graphHost.appendChild(msg);
    }

    function showFlash(text, kind) {
      var f = document.createElement('div');
      f.className = 'flash';
      f.setAttribute('role', 'status');
      if (kind === 'error') f.style.color = 'var(--error)';
      f.textContent = text;
      host.appendChild(f);
      setTimeout(function () {
        if (f.parentNode) f.parentNode.removeChild(f);
      }, 3500);
    }

    function paintLayout(layout) {
      // Replace canvasHost with a fresh node so per-render listeners
      // (wheel, pointer*) don't stack across mode toggles.
      var fresh = document.createElement('div');
      fresh.className = 'graph-host';
      host.replaceChild(fresh, canvasHost);
      canvasHost = fresh;
      graphHost = fresh;
      paintCanvas(layout);
    }

    function renderForMode() {
      paintArms();
      if (mode === 'force') {
        showLoading();
        applyForceLayout(nodes, edges, cycleEdges).then(function (layout) {
          paintLayout(layout);
        }).catch(function (err) {
          console.warn('graph: force layout unavailable —', err && err.message ? err.message : err);
          showFlash('Force layout unavailable — falling back to layered.', 'error');
          mode = 'layered';
          writeLayoutPref('layered');
          paintArms();
          paintLayout(layoutGraph(nodes, edges, cycleEdges));
        });
      } else {
        paintLayout(layoutGraph(nodes, edges, cycleEdges));
      }
    }

    function onArm(target) {
      var nextMode = target.getAttribute('data-mode');
      if (nextMode !== 'layered' && nextMode !== 'force') return;
      if (nextMode === mode) return;
      mode = nextMode;
      writeLayoutPref(mode);
      renderForMode();
    }
    armLayered.addEventListener('click', function () { onArm(armLayered); });
    armForce.addEventListener('click', function () { onArm(armForce); });

    // ---- canvas painter (ran after each layout decision) ---------------
    function paintCanvas(layout) {
    if (chipsRow) chipsRow.innerHTML = ''; // chips re-bind to fresh SVG groups

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
      if (e.from === e.to) return; // self-loops drawn as node badges
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
        'marker-end': 'url(#minerva-graph-arrow)',
        'data-from-tab': e.fromTab || '',
        'data-to-tab': e.toTab || ''
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
        'marker-end': 'url(#minerva-graph-arrow)',
        'data-from-tab': e.fromTab || '',
        'data-to-tab': e.toTab || ''
      });
      edgesG.appendChild(path);
    });

    // Habit nodes get a self-loop badge as a schema-level signal of
    // "recurring." Other tabs only get a self-loop when the row's own
    // data points at itself.
    var singleHabitTab = tab === 'habits';

    nodes.forEach(function (n) {
      var p = positions[n.id];
      if (!p) return;
      var nodeTab = n.tab || tab || '';
      var nodeClass = 'graph-node';
      if (focusId && String(n.id) === focusId) nodeClass += ' is-focused';
      var g = svgEl('g', {
        class: nodeClass,
        tabindex: '0',
        'data-row-id': n.id,
        'data-tab': nodeTab,
        transform: 'translate(' + p.x + ',' + p.y + ')'
      });
      g.appendChild(svgEl('circle', { r: NODE_R, cx: 0, cy: 0 }));

      // Self-loop indicator (small circle to the right).
      var selfRef = false;
      edges.concat(cycleEdges).forEach(function (e) {
        if (e.from === n.id && e.to === n.id) selfRef = true;
      });
      var isHabit = singleHabitTab || nodeTab === 'habits';
      if (isHabit || selfRef) {
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
        var detailTab = nodeTab;
        if (M.app && typeof M.app.showRowDetail === 'function') {
          M.app.showRowDetail(detailTab, rowId);
        } else {
          // Fall back to URL hash so the existing router can pick it up.
          location.hash = '#/s/' + detailTab + '?row=' + encodeURIComponent(rowId);
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

    graphHost.appendChild(svg);

    // ---- chip filter -----------------------------------------------------
    if (chipsRow) {
      var hidden = {}; // tab => true when hidden
      function applyVisibility() {
        // Hide nodes whose tab is hidden.
        var nodeEls = nodesG.querySelectorAll('.graph-node');
        for (var i = 0; i < nodeEls.length; i++) {
          var t = nodeEls[i].getAttribute('data-tab') || '';
          nodeEls[i].style.display = hidden[t] ? 'none' : '';
        }
        // Hide edges whose endpoint tab is hidden.
        var edgeEls = edgesG.querySelectorAll('.graph-edge');
        for (var j = 0; j < edgeEls.length; j++) {
          var ft = edgeEls[j].getAttribute('data-from-tab') || '';
          var tt = edgeEls[j].getAttribute('data-to-tab') || '';
          edgeEls[j].style.display = (hidden[ft] || hidden[tt]) ? 'none' : '';
        }
      }
      tabsList.forEach(function (t) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'graph-chip is-active';
        btn.setAttribute('data-tab', t);
        btn.textContent = tabLabel(t);
        btn.addEventListener('click', function () {
          if (hidden[t]) {
            delete hidden[t];
            btn.classList.add('is-active');
            btn.classList.remove('is-hidden');
          } else {
            hidden[t] = true;
            btn.classList.remove('is-active');
            btn.classList.add('is-hidden');
          }
          applyVisibility();
        });
        chipsRow.appendChild(btn);
      });
    }

    // ---- pan + zoom via viewBox manipulation -----------------------------
    var view = { x: 0, y: 0, w: W, h: H };
    function applyView() {
      svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    }

    // If we were asked to focus a node, slight zoom-in and recenter on it.
    if (focusId && positions[focusId]) {
      var fp = positions[focusId];
      var zoom = 0.6; // 0.6x of natural extent — i.e. zoomed in
      view.w = W * zoom;
      view.h = H * zoom;
      view.x = fp.x - view.w / 2;
      view.y = fp.y - view.h / 2;
      applyView();
    }

    var dragging = false;
    var dragId = null;
    var lastX = 0, lastY = 0;
    var didDrag = false;

    graphHost.addEventListener('wheel', function (ev) {
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

    graphHost.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('.graph-node')) return;
      dragging = true;
      didDrag = false;
      dragId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      try { graphHost.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      graphHost.classList.add('is-panning');
    });
    graphHost.addEventListener('pointermove', function (ev) {
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
      try { graphHost.releasePointerCapture(dragId); } catch (e) { /* ignore */ }
      graphHost.classList.remove('is-panning');
    }
    graphHost.addEventListener('pointerup', endDrag);
    graphHost.addEventListener('pointercancel', endDrag);
    graphHost.addEventListener('pointerleave', function (ev) { if (dragging) endDrag(ev); });
    } // end paintCanvas

    renderForMode();
  }

  M.graph = {
    buildGraphFromTab: buildGraphFromTab,
    buildGraphFromAll: buildGraphFromAll,
    renderGraph: renderGraph
  };
})();
