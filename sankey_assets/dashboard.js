/*
 * dashboard.js — controls, figure building and export for the Sankey dashboard.
 *
 * Reads the inlined PAYLOAD/INITIAL/PALETTES globals, runs LCAFlows.buildFlows
 * on every data change, and re-renders through Plotly.react when only the
 * styling moved — which keeps drag and hover state — or Plotly.newPlot when the
 * node set itself changed, which is the only way to stop Plotly stranding the
 * previous set's nodes in the DOM.  Written in ES5 so the generated file works
 * in older browsers and can be exercised by a plain script host.
 */
(function (global) {
  'use strict';

  /* Each start() supersedes the one before it.  A dropped file rebuilds the
     control panel from scratch, which drops that panel's listeners with the
     nodes they were on, but a previous instance can still be holding a theme
     listener or a pending retry — so every closure checks that it is still the
     current generation before it draws anything. */
  var generation = 0;

  function start(PAYLOAD, INITIAL, PALETTES) {
  var myGeneration = ++generation;
  var gd = document.getElementById('chart');
  var META = PAYLOAD.meta || {};
  var STORE_KEY = 'lca-sankey:' + (META.source || 'default');

  /* ── defaults ─────────────────────────────────────────────────────────── */
  function defaults() {
    return {
      // data
      levels: INITIAL.levels,
      smallMode: INITIAL.smallMode,
      threshold: INITIAL.threshold,
      maxNodes: INITIAL.maxNodes,
      balance: INITIAL.balance,
      // typography
      font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 13,
      labelSize: 12,
      labelColor: null,          // null = follow theme
      hoverSize: 12,
      title: META.title || '',
      titleSize: 17,
      titleAlign: 'center',
      titleBold: true,
      // labels
      labelMode: 'name',
      labelSource: 'short',
      wrap: 30,
      truncate: 0,               // 0 = no truncation
      labelCutoff: 0,            // % below which a node goes unlabelled
      align: 'justify',
      labelSide: 'auto',         // auto | right | left — which side of the node
      labelAngle: 0,             // degrees, clockwise; 0 = horizontal
      decimals: 1,
      // colours
      theme: 'auto',
      palette: 'legaci',
      depthColors: null,         // null = take from the palette preset
      linkMode: 'depth',
      linkColor: '#2a78d6',
      linkAlpha: 0.32,
      negativeColor: INITIAL.negativeColor,
      borderColor: null,         // null = follow theme
      borderWidth: 0.5,
      background: null,          // null = follow theme
      // layout
      // Plotly's own Sankey layout is the one that keeps a child inside the
      // span of the ribbon feeding it; the column-at-a-time placements below
      // stack each column against its own total instead, which is what turns
      // the near columns into a fan.  See README_sankey.md.
      placement: 'auto',
      arrangement: 'snap',
      pad: 18,
      thickness: 18,
      autoHeight: true,
      height: 900,
      fitWidth: true,
      width: 1400,
      marginX: 24,
      marginTop: 64,
      // extras
      scale: 2,
      nodeOverrides: {},         // label -> {label, color, hidden}
      nodePos: {},               // label -> {x, y} from dragging
      annotations: []
    };
  }

  var state = defaults();
  var view = null;               // latest buildFlows result
  var selected = null;           // label of the node in the inspector
  var suspendSync = false;

  /* ── tiny helpers ─────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text).replace(/&/g, '&amp;')
                       .replace(/</g, '&lt;')
                       .replace(/>/g, '&gt;');
  }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) +
                            h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length !== 6) return [0, 0, 0];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16)];
  }

  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  function mixHex(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b), out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(x[i] + (y[i] - x[i]) * t).toString(16);
      out += v.length < 2 ? '0' + v : v;
    }
    return out;
  }

  /* Greedy wrap, matching Python's textwrap closely enough for label work. */
  function wrapText(text, width) {
    if (!(width > 0)) return [String(text)];
    var words = String(text).split(/\s+/);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function fmtPct(v) {
    return (v == null ? 0 : v).toFixed(state.decimals) + '%';
  }

  function fmtAbs(pct) {
    if (!META.rootValue) return '';
    var v = pct / 100 * META.rootValue;
    var text = Math.abs(v) >= 1e-4 && Math.abs(v) < 1e6
      ? v.toPrecision(4) : v.toExponential(3);
    return text + (META.unit ? ' ' + META.unit : '');
  }

  /* ── theme ────────────────────────────────────────────────────────────── */
  function activeTheme() {
    if (state.theme !== 'auto') return state.theme;
    return (window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }

  function themeInk() { return activeTheme() === 'dark' ? '#ffffff' : '#0b0b0b'; }
  function themeSurface() { return activeTheme() === 'dark' ? '#1a1a19' : '#fcfcfb'; }
  function themeBorder() {
    return activeTheme() === 'dark' ? 'rgba(255,255,255,0.18)'
                                    : 'rgba(11,11,11,0.15)';
  }

  function columnCount() { return (META.maxDepth || 1) + 1; }

  function presetColors() {
    var preset = PALETTES[state.palette] || PALETTES.categorical;
    var base = (preset[activeTheme()] || preset.light).slice();
    // Never cycle a palette: a column past the last slot folds into it.
    while (base.length < columnCount()) base.push(base[base.length - 1]);
    return base.slice(0, columnCount());
  }

  function depthColors() {
    if (state.depthColors && state.depthColors.length >= columnCount()) {
      return state.depthColors;
    }
    return presetColors();
  }

  function colorForDepth(depth) {
    var colors = depthColors();
    return colors[Math.min(Math.max(depth, 0), colors.length - 1)];
  }

  function nodeColor(label, depth) {
    var over = state.nodeOverrides[label];
    if (over && over.color) return over.color;
    return colorForDepth(depth);
  }

  /* ── figure ───────────────────────────────────────────────────────────── */
  function fullNameOf(label) {
    var i = PAYLOAD.shorts.indexOf(label);
    return i >= 0 ? PAYLOAD.names[i] : label;
  }

  function orderedNodes(v) {
    var names = Object.keys(v.depthOf);
    names.sort(function (a, b) {
      var da = v.depthOf[a], db = v.depthOf[b];
      if (da !== db) return da - db;
      var wa = v.nodeTotals[a] || 0, wb = v.nodeTotals[b] || 0;
      if (wa !== wb) return wb - wa;
      return a < b ? -1 : 1;
    });
    return names;
  }

  /* Even columns reproduce the original layout; value-weighted stacks each
     column by share so a column of forty hairlines no longer demands 1400px
     of height.  A push-apart pass keeps the tiniest nodes from colliding. */
  function positions(v, nodes, innerHeight, extents) {
    if (state.placement === 'auto') return null;

    var byDepth = {};
    nodes.forEach(function (name) {
      var d = v.depthOf[name];
      (byDepth[d] || (byDepth[d] = [])).push(name);
    });

    var maxDepth = Math.max.apply(null, nodes.map(function (n) {
      return v.depthOf[n];
    })) || 1;

    var xs = {}, ys = {};
    Object.keys(byDepth).forEach(function (key) {
      var column = byDepth[key];
      var depth = Number(key);
      var x = Math.min(Math.max(depth / maxDepth, 0.001), 0.999);

      var raw;
      if (state.placement === 'even') {
        raw = column.map(function (_, i) { return (i + 0.5) / column.length; });
      } else {
        var total = column.reduce(function (sum, n) {
          return sum + (v.nodeTotals[n] || 0);
        }, 0) || 1;
        var cum = 0;
        raw = column.map(function (n) {
          var w = v.nodeTotals[n] || 0;
          var mid = (cum + w / 2) / total;
          cum += w;
          return mid;
        });
        // Push apart by however much room each label actually needs.  This used
        // to be one gap for the whole column, sized for a single line — so a
        // column of twenty wrapped ecoinvent names stacked them 24px apart with
        // 32px of text in each, and the last column came out as a pile of
        // overlapping labels.  Two neighbours need half of each of their own
        // blocks between their centres, not a constant.
        var span = Math.max(innerHeight, 1);
        var room = column.map(function (n) {
          return Math.max((extents && extents[n]) || 0, state.thickness);
        });
        // Clearance on top of the two half-blocks.  labelExtent counts line
        // advances in ems, which lands a few px under the box the browser
        // actually draws (the first line's ascent and the last one's descent
        // sit outside the advance), so measured neighbours still touched at 6.
        var CLEARANCE = 10;
        var gaps = [];
        var wanted = 0;
        for (var i = 1; i < column.length; i++) {
          var g = (room[i - 1] + room[i]) / 2 + CLEARANCE;
          gaps.push(g);
          wanted += g;
        }
        // A column that cannot hold its labels at full size gets them evenly
        // squeezed rather than pushed off the bottom; the label cutoff and the
        // wrap width are the real fixes and the status bar says so.
        var squeeze = wanted > span * 0.98 ? (span * 0.98) / wanted : 1;
        for (i = 1; i < raw.length; i++) {
          var need = gaps[i - 1] * squeeze / span;
          if (raw[i] < raw[i - 1] + need) raw[i] = raw[i - 1] + need;
        }
        var over = raw[raw.length - 1] - 1;
        if (over > 0) {
          for (var j = 0; j < raw.length; j++) raw[j] -= over;
        }
      }

      column.forEach(function (name, i) {
        xs[name] = x;
        ys[name] = Math.min(Math.max(raw[i], 0.001), 0.999);
        var saved = state.nodePos[name];
        if (saved) { xs[name] = saved.x; ys[name] = saved.y; }
      });
    });

    return { xs: xs, ys: ys };
  }

  /* Numbered mode: nodes wear "1", "2", … and the full names move to a key
     below the diagram.  Long ecoinvent names never fit a figure column, and a
     numbered reference list is what a paper wants anyway. */
  var numberOf = {};

  function labelFor(name, v) {
    var over = state.nodeOverrides[name];
    if (over && over.hidden) return '';
    if (state.labelMode === 'none') return '';

    var pct = v.nodeTotals[name] || 0;
    // A label-only cutoff: the node and its flows still draw at full value.
    if (state.labelCutoff > 0 && pct < state.labelCutoff) return '';
    if (state.labelMode === 'number') return String(numberOf[name] || '');
    if (state.labelMode === 'pct') return fmtPct(pct);

    var text = (over && over.label != null) ? over.label
             : (state.labelSource === 'full' ? fullNameOf(name) : name);
    if (state.truncate > 0 && text.length > state.truncate) {
      text = text.slice(0, Math.max(1, state.truncate - 1)) + '…';
    }
    var body = wrapText(text, state.wrap).map(esc).join('<br>');
    return state.labelMode === 'both' ? body + '<br>' + fmtPct(pct) : body;
  }

  function linkColors(v) {
    var values = v.flows.map(function (f) { return f.value; });
    var lo = Math.min.apply(null, values.concat([0]));
    var hi = Math.max.apply(null, values.concat([1]));

    return v.flows.map(function (f) {
      if (f.negative) return rgba(state.negativeColor, Math.min(1, state.linkAlpha + 0.2));
      var hex;
      switch (state.linkMode) {
        case 'uniform':   hex = state.linkColor; break;
        case 'source':    hex = nodeColor(f.source, v.depthOf[f.source]); break;
        case 'target':    hex = nodeColor(f.target, v.depthOf[f.target]); break;
        case 'magnitude':
          var t = hi > lo ? (f.value - lo) / (hi - lo) : 0.5;
          hex = mixHex('#cde2fb', '#0d366b', t);
          break;
        default:          hex = colorForDepth(f.depth - 1);
      }
      return rgba(hex, state.linkAlpha);
    });
  }

  /* Vertical room a label block occupies once it is turned by labelAngle.
     Un-rotated this is just the line stack, so a horizontal diagram sizes
     exactly as it did before the orientation control existed; turned towards
     the vertical the block's *width* is what starts eating the column, which
     is why a rotated diagram needs a taller canvas rather than the same one. */
  function labelExtent(label) {
    var lines = label.split('<br>');
    var longest = 0;
    for (var i = 0; i < lines.length; i++) {
      longest = Math.max(longest, lines[i].length);
    }
    var blockH = lines.length * state.labelSize * 1.3;
    if (!state.labelAngle) return blockH;
    // ~0.55 em per character is the usual average for a proportional face; the
    // figure only has to be close enough to keep neighbours from touching.
    var blockW = longest * state.labelSize * 0.55;
    var rad = Math.abs(state.labelAngle) * Math.PI / 180;
    return blockH * Math.cos(rad) + blockW * Math.sin(rad);
  }

  /* Horizontal room the outermost column's labels need once they are pushed
     outside their nodes.  Plotly reserves nothing for label text — it lets the
     names run off the edge of the figure — so forcing a side means widening
     the margin to match.  Capped at 45% of the width: on a narrow window it is
     better to clip a long name than to leave no room for the diagram. */
  function labelRoom(v, nodes, labels) {
    var edge = 0;
    nodes.forEach(function (n) { edge = Math.max(edge, v.depthOf[n]); });
    if (state.labelSide === 'left') edge = 0;

    var widest = 0, tallest = 1;
    nodes.forEach(function (name, i) {
      if (v.depthOf[name] !== edge || !labels[i]) return;
      var lines = labels[i].split('<br>');
      tallest = Math.max(tallest, lines.length);
      for (var j = 0; j < lines.length; j++) {
        widest = Math.max(widest, lines[j].length);
      }
    });
    if (!widest) return state.marginX;

    // Turned labels lie down, so the room they need swaps between the axes —
    // the same box the height estimate uses, read the other way round.
    var rad = Math.abs(state.labelAngle || 0) * Math.PI / 180;
    var blockW = widest * state.labelSize * 0.55;
    var blockH = tallest * state.labelSize * 1.3;
    var wide = blockW * Math.cos(rad) + blockH * Math.sin(rad);

    var figureWidth = state.fitWidth ? (gd.clientWidth || state.width)
                                     : state.width;
    return Math.min(wide + state.thickness + 12,
                    Math.max(80, figureWidth * 0.45));
  }

  /* Plotly's Sankey lays each column out itself and treats node.y as a hint —
     ask for 41px between two nodes in a dense column and it will still draw
     them 18px apart.  What it does honour is node.pad, the minimum gap it
     leaves between node rectangles.  So the room a label needs has to be
     expressed as pad, or a column of wrapped ecoinvent names collapses to the
     default gap and the labels sit on top of each other no matter what
     positions() asked for.

     The Node gap control stays the floor; this only ever raises it, and only
     as far as the tallest label actually on the diagram. */
  function effectivePad(labels) {
    var tallest = 0;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i]) tallest = Math.max(tallest, labelExtent(labels[i]));
    }
    return Math.max(state.pad, Math.ceil(tallest) + 6);
  }

  function marginFor(v, nodes, labels) {
    var margin = {
      l: state.marginX, r: state.marginX,
      t: state.marginTop, b: 36
    };
    if (state.labelSide === 'right') {
      margin.r = Math.max(margin.r, labelRoom(v, nodes, labels));
    } else if (state.labelSide === 'left') {
      margin.l = Math.max(margin.l, labelRoom(v, nodes, labels));
    }
    return margin;
  }

  /* Size to the tallest column's actual label stack, not just its node count:
     a two-line wrapped label needs twice the room of a one-line one, and
     guessing on node count alone is what produced the old 6840px files that
     still had labels touching. */
  function autoHeight(v, nodes, labels, pad) {
    var perColumn = {};
    nodes.forEach(function (name, i) {
      var d = v.depthOf[name];
      var need = labels[i]
        ? Math.max(labelExtent(labels[i]), state.thickness) + pad
        // an unlabelled node only needs to be visible, not readable
        : Math.min(pad, 6) + 2;
      perColumn[d] = (perColumn[d] || 0) + need;
    });
    var tallest = Math.max.apply(null, Object.keys(perColumn).map(function (k) {
      return perColumn[k];
    }).concat([0]));
    var needed = tallest + state.marginTop + 48;
    return Math.max(480, Math.min(8000, Math.round(needed)));
  }

  function buildFigure(v) {
    var nodes = orderedNodes(v);
    var index = {};
    nodes.forEach(function (n, i) { index[n] = i; });

    var ink = state.labelColor || themeInk();
    var surface = state.background || themeSurface();

    numberOf = {};
    nodes.forEach(function (n, i) { numberOf[n] = i + 1; });

    // labels first: both the height and the node spacing depend on how many
    // lines each one wraps to
    var labels = nodes.map(function (n) { return labelFor(n, v); });
    var extents = {};
    nodes.forEach(function (n, i) {
      extents[n] = labels[i] ? labelExtent(labels[i]) : 0;
    });
    var pad = effectivePad(labels);
    var height = state.autoHeight ? autoHeight(v, nodes, labels, pad)
                                  : state.height;
    var pos = positions(v, nodes, height - state.marginTop - 36, extents);

    var node = {
      label: labels,
      customdata: nodes.map(function (n) {
        var pct = v.nodeTotals[n] || 0;
        return [esc(fullNameOf(n)), fmtAbs(pct)];
      }),
      color: nodes.map(function (n) { return nodeColor(n, v.depthOf[n]); }),
      pad: pad,
      thickness: state.thickness,
      align: state.align,
      line: {
        color: state.borderColor || themeBorder(),
        width: state.borderWidth
      },
      hovertemplate: '<b>%{customdata[0]}</b><br>' +
                     '%{value:.3g}% of total' +
                     (META.rootValue ? '<br>%{customdata[1]}' : '') +
                     '<extra></extra>'
    };
    if (pos) {
      node.x = nodes.map(function (n) { return pos.xs[n]; });
      node.y = nodes.map(function (n) { return pos.ys[n]; });
    }

    var link = {
      source: v.flows.map(function (f) { return index[f.source]; }),
      target: v.flows.map(function (f) { return index[f.target]; }),
      value: v.flows.map(function (f) { return f.value; }),
      color: linkColors(v),
      customdata: v.flows.map(function (f) {
        return [esc(fullNameOf(f.source)) + ' &#8594; ' + esc(fullNameOf(f.target)),
                fmtAbs(f.value)];
      }),
      hovertemplate: '%{customdata[0]}<br><b>%{value:.3g}%</b>' +
                     (META.rootValue ? '<br>%{customdata[1]}' : '') +
                     '<extra></extra>'
    };

    var trace = {
      type: 'sankey',
      arrangement: state.arrangement,
      textfont: { family: state.font, size: state.labelSize, color: ink },
      node: node,
      link: link
    };

    var layout = {
      title: {
        text: state.titleBold ? '<b>' + esc(state.title) + '</b>' : esc(state.title),
        font: { family: state.font, size: state.titleSize, color: ink },
        x: state.titleAlign === 'left' ? 0.01
         : state.titleAlign === 'right' ? 0.99 : 0.5,
        xanchor: state.titleAlign === 'center' ? 'center' : state.titleAlign
      },
      font: { family: state.font, size: state.fontSize, color: ink },
      hoverlabel: { font: { family: state.font, size: state.hoverSize } },
      paper_bgcolor: surface,
      plot_bgcolor: surface,
      margin: marginFor(v, nodes, labels),
      height: height,
      annotations: state.annotations.map(function (a) {
        return {
          text: a.text, x: a.x, y: a.y,
          xref: 'paper', yref: 'paper',
          showarrow: false,
          // annotations carry their own angle — a label detached while the
          // diagram was turned keeps the orientation it was detached at, and
          // later moves of the Orientation slider leave it where it was put
          textangle: a.angle || 0,
          font: { family: state.font, size: a.size || state.labelSize,
                  color: a.color || ink },
          align: 'left',
          bgcolor: a.bgcolor || 'rgba(0,0,0,0)',
          captureevents: true
        };
      })
    };
    if (!state.fitWidth) layout.width = state.width;

    var config = {
      responsive: state.fitWidth,
      // Granular rather than `editable: true`: the blanket flag also turns on
      // title editing, which makes Plotly draw a "Click to enter Plot subtitle"
      // placeholder under every title.  Annotations are what need to be
      // draggable and retypable on the canvas; the title has a panel field.
      edits: {
        annotationPosition: true,
        annotationTail: true,
        annotationText: true
      },
      displaylogo: false,
      scrollZoom: false,
      // The modebar camera calls Plotly's own toImage, which rebuilds the
      // figure from its spec and so cannot know about a label rotation that
      // lives in the SVG.  Rather than let it hand out a silently un-rotated
      // PNG, take it away while the labels are turned: the panel's Export
      // buttons go through the rotation-aware path below.
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'zoom2d', 'pan2d',
                               'zoomIn2d', 'zoomOut2d', 'autoScale2d']
                              .concat(labelsRestyled() ? ['toImage'] : []),
      toImageButtonOptions: {
        format: 'png',
        filename: (META.source || 'sankey').replace(/\.[^.]+$/, '') + '-sankey',
        scale: state.scale
      }
    };

    return { data: [trace], layout: layout, config: config, nodes: nodes };
  }

  /* ── label orientation ────────────────────────────────────────────────── */
  /* Plotly's Sankey has no label angle of its own.  It draws each label as a
     <text x="0" y="0"> carrying a translate() to the point where the label
     meets its node, so appending a rotate() to that transform turns the label
     about exactly the right pivot: however far it swings it stays pinned to
     its node.  Multi-line labels come through as tspans inside that same
     <text>, so the whole stack turns together.

     Plotly rewrites the transform on every draw — including node drags — so
     this has to run again after each one. */
  function angleTransform(base, angle) {
    var clean = String(base || '').replace(/\s*rotate\([^)]*\)/g, '');
    return angle ? (clean + ' rotate(' + angle + ')') : clean;
  }

  /* Which side of its node a label sits on is Plotly's decision, and it makes
     it on x alone: past the middle of the figure the label flips inward. For a
     contribution tree that is the wrong call — the deepest column is where the
     long ecoinvent names are, and inward means straight over the diagram. So
     the side is overridable, and buildFigure widens the margin to receive it. */
  var TEXT_PAD = 3.25;                 // Plotly's own gap between node and text

  function sideTransform(group, text) {
    var side = state.labelSide;
    if (side !== 'right' && side !== 'left') return null;
    var rect = group.querySelector('rect.node-rect');
    var w = rect ? parseFloat(rect.getAttribute('width')) : NaN;
    if (!(w > 0)) w = state.thickness;
    var m = /translate\(\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)\s*\)/.exec(
      text.getAttribute('transform') || '');
    var y = m ? m[2] : '0';
    text.setAttribute('text-anchor', side === 'right' ? 'start' : 'end');
    // the tspans of a wrapped label are positioned relative to the anchor
    var spans = text.querySelectorAll('tspan');
    for (var i = 0; i < spans.length; i++) spans[i].setAttribute('x', '0');
    return 'translate(' + (side === 'right' ? (w + TEXT_PAD) : -TEXT_PAD) +
           ',' + y + ')';
  }

  /* Never restyle a half-drawn diagram.  Plotly removes the node groups of the
     previous data set from an end-of-transition callback, and that transition
     animates the very attribute we write — so touching `transform` while it is
     running cancels it, the callback never fires, and the old nodes are left
     stacked on top of the new ones.  Dropping the Levels slider from 4 to 3 on
     a large tree left 215 stale labels piled over a 35-node diagram.

     The node group count matching the figure we just built is the signal that
     Plotly has finished; until it does, wait and look again. */
  var styleRetry = null;

  function applyLabelStyling() {
    if (styleRetry) { clearTimeout(styleRetry); styleRetry = null; }
    if (!labelsRestyled()) return;      // nothing to do, so touch nothing

    var groups = gd.querySelectorAll('g.sankey-node');
    var expected = lastFigure ? lastFigure.nodes.length : -1;
    if (expected >= 0 && groups.length !== expected) {
      styleRetry = setTimeout(applyLabelStyling, 60);
      return;
    }

    var angle = state.labelAngle || 0;
    for (var i = 0; i < groups.length; i++) {
      var text = groups[i].querySelector('text.node-label');
      if (!text) continue;
      // side first: it rewrites the transform outright, which would drop a
      // rotate() already sitting on it
      var base = sideTransform(groups[i], text) ||
                 text.getAttribute('transform');
      text.setAttribute('transform', angleTransform(base, angle));
    }
  }

  function labelsRestyled() {
    return state.labelSide === 'right' || state.labelSide === 'left' ||
           !!state.labelAngle;
  }

  /* The same two moves, applied to an exported SVG string.  Export cannot reuse
     the live DOM: Plotly.toImage redraws the figure from its spec into a
     throwaway div, which is a faithful copy of everything Plotly knows about
     and nothing it doesn't.  Both export paths therefore patch the string. */
  function restyleLabelsInSvg(svgText) {
    var side = state.labelSide;
    var angle = state.labelAngle || 0;
    if (!labelsRestyled()) return svgText;
    var flip = side === 'right' || side === 'left';
    var x = side === 'right' ? (state.thickness + TEXT_PAD) : -TEXT_PAD;

    return svgText.replace(/<text\b[^>]*>/g, function (tag) {
      if (tag.indexOf('node-label') < 0) return tag;
      var out = tag;
      if (flip) {
        out = out.replace(/text-anchor="[^"]*"/,
                          'text-anchor="' + (side === 'right' ? 'start' : 'end') + '"');
        out = out.replace(/\stransform="([^"]*)"/, function (all, tf) {
          var m = /translate\(\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)\s*\)/.exec(tf);
          return ' transform="translate(' + x + ',' + (m ? m[2] : '0') + ')"';
        });
      }
      if (angle) {
        if (/\stransform="/.test(out)) {
          out = out.replace(/\stransform="([^"]*)"/, function (all, tf) {
            return ' transform="' + angleTransform(tf, angle) + '"';
          });
        } else {
          out = out.replace(/<text\b/, '<text transform="rotate(' + angle + ')"');
        }
      }
      return out;
    });
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  var lastFigure = null;
  var drawnSignature = null;

  /* Re-attached after every full redraw, because newPlot purges the div's
     listeners along with its old contents.  Miss this and node selection
     silently stops working after the first data change. */
  function bindPlotEvents() {
    if (!gd.on) return;
    gd.on('plotly_click', function (ev) {
      var pt = ev && ev.points && ev.points[0];
      if (!pt) return;
      // Sankey node points carry link lists; link points carry source/target.
      if (pt.sourceLinks === undefined && pt.targetLinks === undefined) return;
      var nodes = lastFigure ? lastFigure.nodes : [];
      var name = nodes[pt.index != null ? pt.index : pt.pointNumber];
      if (name) {
        selectNode(name);
        $('group-node').open = true;
      }
    });
    gd.on('plotly_relayout', syncFromRelayout);
    gd.on('plotly_restyle', syncFromRestyle);
    // catches the draws we do not drive ourselves — node drags, resizes
    gd.on('plotly_afterplot', applyLabelStyling);
  }

  /* Plotly.react does not clear a Sankey's old node groups when the node set
     changes under it: it removes them from an end-of-transition callback, and
     a second react arriving before that callback runs strands them in the DOM
     for good.  Dragging the Levels slider is exactly that — one render per
     input event — and on a large tree it leaves hundreds of stale labels
     piled over the real diagram, while the status bar honestly reports the
     small number the pipeline produced.

     react does not re-run the Sankey layout either: hand it new node.x /
     node.y and it keeps the positions it worked out on the first draw, so
     switching Placement appeared to do nothing at all until something else
     happened to change the node count.

     Only a full redraw fixes either one.  react is still what we want for
     changes that touch nothing but paint, where it is worth keeping for the
     hover and drag state it preserves — so the signature below covers the node
     set and the geometry, and anything outside it stays on react. */
  function figureSignature(figure) {
    var node = figure.data[0].node;
    var xy = '';
    if (node.x && node.y) {
      for (var i = 0; i < node.x.length; i++) {
        xy += Math.round(node.x[i] * 1e4) + ',' + Math.round(node.y[i] * 1e4) + ';';
      }
    }
    return figure.nodes.join('\u0001') + '|' + node.pad + '|' + xy;
  }

  function draw(figure) {
    var signature = figureSignature(figure);
    if (signature === drawnSignature) {
      Plotly.react(gd, figure.data, figure.layout, figure.config);
      return;
    }
    Plotly.newPlot(gd, figure.data, figure.layout, figure.config);
    drawnSignature = signature;
    bindPlotEvents();          // newPlot drops every listener on the div
  }

  function render() {
    if (myGeneration !== generation) return;
    view = LCAFlows.buildFlows(PAYLOAD, {
      levels: state.levels,
      smallMode: state.smallMode,
      threshold: state.threshold,
      maxNodes: state.maxNodes,
      balance: state.balance
    });

    lastFigure = null;
    if (!view.flows.length) {
      gd.innerHTML = '<p style="padding:32px;color:#898781">Nothing to draw at ' +
                     'these settings — raise the level count or lower the ' +
                     'threshold.</p>';
      // the div no longer holds a plot, so the next draw has to build one
      drawnSignature = null;
      updateStats();
      refreshInspector();
      buildKey();
      save();
      return;
    }

    lastFigure = buildFigure(view);
    draw(lastFigure);
    applyLabelStyling();
    updateStats();
    refreshInspector();
    buildKey();
    save();
  }

  function buildKey() {
    var show = state.labelMode === 'number' && lastFigure;
    $('node-key').hidden = !show;
    if (!show) return;

    var list = $('key-list');
    list.innerHTML = '';
    lastFigure.nodes.forEach(function (name) {
      var over = state.nodeOverrides[name] || {};
      var shown = over.label != null ? over.label : name;
      var li = document.createElement('li');
      li.value = numberOf[name];
      var b = document.createElement('b');
      b.textContent = shown;
      var span = document.createElement('span');
      span.className = 'pct';
      span.textContent = '  ' + fmtPct(view.nodeTotals[name] || 0);
      li.appendChild(b);
      li.appendChild(span);
      // the full ecoinvent name only when it says something the short one didn't
      var full = fullNameOf(name);
      if (full !== name) li.title = full;
      list.appendChild(li);
    });
  }

  function keyAsText() {
    return ['no\tlabel\tpercent_of_total\tfull_name'].concat(
      lastFigure.nodes.map(function (name) {
        var over = state.nodeOverrides[name] || {};
        return [numberOf[name],
                over.label != null ? over.label : name,
                (view.nodeTotals[name] || 0).toFixed(state.decimals),
                fullNameOf(name)].join('\t');
      })).join('\n');
  }

  function updateStats() {
    var s = view.stats;
    $('stat-flows').textContent = s.flows + ' flows';
    $('stat-nodes').textContent = s.nodes + ' nodes';

    var extra = [];
    if (s.pooled) {
      extra.push(s.pooled + ' ' + (state.smallMode === 'pool'
        ? 'pooled into ' + s.otherNodes + ' "other"' : 'hidden'));
    }
    if (s.overCap) extra.push(s.overCap + ' below the node cap');
    if (s.detached) extra.push(s.detached + ' detached from the root');
    if (s.cyclesDropped) extra.push(s.cyclesDropped + ' cycle-forming dropped');
    $('stat-extra').innerHTML = extra.length
      ? '<span class="sep">|</span> ' + esc(extra.join(' · ')) : '';

    var gapText = 'root balance: ' + s.gap.toFixed(1) + '% unaccounted';
    if (state.balance) gapText += ' (drawn)';
    $('stat-gap').innerHTML = s.nodes > 400
      ? '<span class="warn">' + s.nodes + ' nodes — try a label cutoff, ' +
        'or fewer levels</span> <span class="sep">|</span> ' + esc(gapText)
      : esc(gapText);

    $('balance-hint').textContent = s.gap > 0.05
      ? 'Depth-1 children account for ' + (100 - s.gap).toFixed(1) +
        '% of the root; ' + s.gap.toFixed(1) + '% is direct emissions or ' +
        'unresolved.'
      : 'Depth-1 children already account for the whole root.';
  }

  /* ── persistence ──────────────────────────────────────────────────────── */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      $('save-note').textContent = 'Could not save to this browser.';
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      Object.keys(state).forEach(function (k) {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
    } catch (err) { /* corrupt or unavailable — fall back to defaults */ }
  }

  /* ── brand header ─────────────────────────────────────────────────────── */
  /* The header's Light/Dark pair is a second face on the panel's Theme select
     rather than its own setting, so the two can never disagree. */
  function paintBrandTheme() {
    var light = $('brand-light'), dark = $('brand-dark');
    if (!light || !dark) return;
    var mode = activeTheme();
    light.setAttribute('aria-pressed', mode === 'light' ? 'true' : 'false');
    dark.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
  }

  function afterThemeChange() {
    document.documentElement.setAttribute(
      'data-theme', state.theme === 'auto' ? '' : state.theme);
    state.depthColors = null;
    state.labelColor = null;
    state.background = null;
    state.borderColor = null;
    $('c-labelcolor').value = themeInk();
    $('c-bg').value = themeSurface();
    buildDepthColors();
    paintBrandTheme();
  }

  function wireBrandHeader() {
    var source = $('brand-source');
    if (source) source.textContent = META.source || '';
    if (META.title) document.title = META.title + ' - openLCA Sankey';

    // the builders leave src empty when the mark is missing from gui_assets
    var logo = $('brand-logo');
    if (logo && !logo.getAttribute('src')) logo.hidden = true;

    var light = $('brand-light'), dark = $('brand-dark');
    if (!light || !dark) return;
    function pick(mode) {
      return function () {
        state.theme = mode;
        var sel = $('c-theme');
        if (sel) sel.value = mode;
        afterThemeChange();
        render();
      };
    }
    light.addEventListener('click', pick('light'));
    dark.addEventListener('click', pick('dark'));
    paintBrandTheme();
  }

  /* ── control binding ──────────────────────────────────────────────────── */
  function setValueLabel(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  // remembered so Reset / Load style can redraw the readouts properly rather
  // than falling back to the raw number
  var rangeFormat = {};

  function bindRange(id, key, format, after) {
    var el = $(id);
    rangeFormat[id] = format;
    el.value = state[key];
    setValueLabel('v-' + id.slice(2), format(state[key]));
    el.addEventListener('input', function () {
      state[key] = parseFloat(el.value);
      setValueLabel('v-' + id.slice(2), format(state[key]));
      if (after) after();
      render();
    });
  }

  function bindSelect(id, key, after) {
    var el = $(id);
    el.value = state[key];
    el.addEventListener('change', function () {
      state[key] = el.value;
      if (after) after();
      render();
    });
  }

  function bindCheck(id, key, after) {
    var el = $(id);
    el.checked = !!state[key];
    el.addEventListener('change', function () {
      state[key] = el.checked;
      if (after) after();
      render();
    });
  }

  function bindColor(id, key, fallback) {
    var el = $(id);
    el.value = state[key] || fallback();
    el.addEventListener('input', function () {
      state[key] = el.value;
      render();
    });
  }

  function bindSeg(id, key, after) {
    var wrapEl = $(id);
    var buttons = wrapEl.querySelectorAll('button');
    function paint() {
      for (var i = 0; i < buttons.length; i++) {
        var v = buttons[i].getAttribute('data-value');
        var on = key === 'balance'
          ? (v === 'on') === !!state[key] : state[key] === v;
        buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var v = this.getAttribute('data-value');
        state[key] = key === 'balance' ? (v === 'on') : v;
        paint();
        if (after) after();
        render();
      });
    }
    paint();
    return paint;
  }

  var repaintSeg = {};

  function syncConditionalRows() {
    $('row-threshold').className = 'row' +
      (state.smallMode === 'all' ? ' disabled' : '');
    $('row-linkcolor').className = 'row' +
      (state.linkMode === 'uniform' ? '' : ' disabled');
    $('row-height').className = 'row' + (state.autoHeight ? ' disabled' : '');
    $('row-width').className = 'row' + (state.fitWidth ? ' disabled' : '');
    $('levels-hint').textContent = 'Showing ' + state.levels + ' node columns ' +
      '(depth 0–' + (state.levels - 1) + ') of 0–' + META.maxDepth + '.';
  }

  /* ── depth colour pickers ─────────────────────────────────────────────── */
  function buildDepthColors() {
    var host = $('depth-colors');
    host.innerHTML = '';
    var colors = depthColors();
    var counts = {};
    if (view) {
      Object.keys(view.depthOf).forEach(function (n) {
        counts[view.depthOf[n]] = (counts[view.depthOf[n]] || 0) + 1;
      });
    }

    colors.forEach(function (hex, depth) {
      var row = document.createElement('div');
      row.className = 'depth-row';

      var input = document.createElement('input');
      input.type = 'color';
      input.value = hex;
      input.addEventListener('input', function () {
        var next = depthColors().slice();
        next[depth] = input.value;
        state.depthColors = next;
        render();
      });

      var name = document.createElement('span');
      name.className = 'swatch-label';
      name.textContent = depth === 0 ? 'Depth 0 (root)' : 'Depth ' + depth;

      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = counts[depth] ? counts[depth] + ' nodes' : '—';

      row.appendChild(input);
      row.appendChild(name);
      row.appendChild(count);
      host.appendChild(row);
    });

    var preset = PALETTES[state.palette] || PALETTES.categorical;
    var slots = (preset[activeTheme()] || preset.light).length;
    var note = [];
    if (state.palette === 'legacy') {
      note.push('The original palette fails the colourblind-safety and ' +
                'lightness checks — kept only to reproduce older figures.');
    }
    if (slots < columnCount()) {
      note.push('This palette has ' + slots + ' steps for ' + columnCount() +
                ' columns; the deepest columns reuse the last step.');
    }
    $('palette-hint').textContent = note.join(' ');
  }

  /* ── node inspector ───────────────────────────────────────────────────── */
  function selectNode(label) {
    selected = label;
    refreshInspector();
  }

  function refreshInspector() {
    var has = selected && view && (selected in view.depthOf);
    $('inspector').hidden = !has;
    $('inspector-empty').hidden = !!has;
    if (!has) return;

    var over = state.nodeOverrides[selected] || {};
    var pct = view.nodeTotals[selected] || 0;
    $('i-full').textContent = fullNameOf(selected);
    $('i-stat').innerHTML = 'Depth <b>' + view.depthOf[selected] + '</b> · ' +
      '<b>' + fmtPct(pct) + '</b> of total' +
      (META.rootValue ? ' · <b>' + esc(fmtAbs(pct)) + '</b>' : '');
    $('i-label').value = over.label != null ? over.label : selected;
    $('i-color').value = nodeColor(selected, view.depthOf[selected]);
    $('i-hide').checked = !!over.hidden;
  }

  function editSelected(patch) {
    if (!selected) return;
    var over = state.nodeOverrides[selected] || {};
    Object.keys(patch).forEach(function (k) { over[k] = patch[k]; });
    state.nodeOverrides[selected] = over;
    render();
  }

  /* ── annotations ──────────────────────────────────────────────────────── */
  /* Plotly renders each Sankey node as a <g> with the D3 datum still bound, so
     we can read the drawn rectangle and convert it to paper coordinates — which
     is what lets a detached label start exactly where its node is. */
  function nodePaperPos(label) {
    try {
      var fl = gd._fullLayout;
      var box = gd.getBoundingClientRect();
      var scale = fl.width / box.width;
      var groups = gd.querySelectorAll('g.sankey-node');
      for (var i = 0; i < groups.length; i++) {
        var datum = groups[i].__data__;
        var node = datum && (datum.node || datum);
        if (!node || node.label == null) continue;
        if (node.label !== labelFor(label, view)) continue;
        var r = groups[i].getBoundingClientRect();
        var cx = (r.left + r.width / 2 - box.left) * scale;
        var cy = (r.top + r.height / 2 - box.top) * scale;
        var innerW = fl.width - fl.margin.l - fl.margin.r;
        var innerH = fl.height - fl.margin.t - fl.margin.b;
        return {
          x: Math.min(1, Math.max(0, (cx - fl.margin.l) / innerW)),
          y: Math.min(1, Math.max(0, 1 - (cy - fl.margin.t) / innerH))
        };
      }
    } catch (err) { /* fall through to the centre */ }
    return { x: 0.5, y: 0.5 };
  }

  function addAnnotation(text, pos, size, angle) {
    state.annotations.push({
      text: text,
      x: pos.x, y: pos.y,
      size: size || state.labelSize + 1,
      angle: angle || 0,
      color: state.labelColor || themeInk()
    });
    render();
  }

  /* Plotly's editable mode writes drags and in-place retypes straight into the
     layout, then tells us about it — mirror those back into state so they
     survive the next render. */
  function syncFromRelayout(ev) {
    if (suspendSync) return;
    var touched = false;
    Object.keys(ev).forEach(function (key) {
      var m = /^annotations\[(\d+)\]\.(x|y|text)$/.exec(key);
      if (m && state.annotations[+m[1]]) {
        state.annotations[+m[1]][m[2]] = ev[key];
        touched = true;
        return;
      }
      if (key === 'title.text' || key === 'title') {
        var text = typeof ev[key] === 'string' ? ev[key] : (ev[key] || {}).text;
        if (typeof text === 'string') {
          state.title = text.replace(/<\/?b>/g, '');
          $('c-title').value = state.title;
          touched = true;
        }
      }
    });
    if (touched) save();
  }

  function syncFromRestyle() {
    if (suspendSync || !lastFigure) return;
    try {
      var node = gd.data[0].node;
      if (!node || !node.x || !node.y) return;
      lastFigure.nodes.forEach(function (name, i) {
        if (node.x[i] != null && node.y[i] != null) {
          state.nodePos[name] = { x: node.x[i], y: node.y[i] };
        }
      });
      save();
    } catch (err) { /* nothing to capture */ }
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function baseName() {
    return (META.source || 'sankey').replace(/\.[^.]+$/, '') + '-sankey';
  }

  /* Rasterise an SVG string the way Plotly's own PNG path does — through an
     <img> and a canvas.  The source is a data: URI rather than a blob: one so
     the canvas stays untainted on file:// as well as over http. */
  function rasterize(svgText, width, height, scale, done, fail) {
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        var ctx = canvas.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, width, height);
        if (canvas.toBlob) canvas.toBlob(done, 'image/png');
        else done(canvas.toDataURL('image/png'));
      } catch (err) { fail(); }
    };
    img.onerror = fail;
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svgText);
  }

  function exportImage(format) {
    var width = gd._fullLayout.width;
    var height = gd._fullLayout.height;
    var scale = format === 'svg' ? 1 : state.scale;

    function plotlyDownload() {
      Plotly.downloadImage(gd, {
        format: format, filename: baseName(),
        scale: scale, width: width, height: height
      });
    }

    // Nothing to patch when the labels are level — keep Plotly's own path.
    if (!labelsRestyled()) return plotlyDownload();

    function giveUp() {
      $('save-note').textContent =
        'Could not export the rotated labels — saved the level version instead.';
      plotlyDownload();
    }

    Plotly.toImage(gd, { format: 'svg', width: width, height: height })
      .then(function (uri) {
        var svg = restyleLabelsInSvg(
          decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, '')));
        if (format === 'svg') {
          download(baseName() + '.svg', svg, 'image/svg+xml');
          return;
        }
        rasterize(svg, width, height, scale, function (out) {
          if (out && out.type) {                       // a Blob from toBlob
            var url = URL.createObjectURL(out);
            var a = document.createElement('a');
            a.href = url;
            a.download = baseName() + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          } else if (out) {                            // a data URI fallback
            var link = document.createElement('a');
            link.href = out;
            link.download = baseName() + '.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          } else {
            giveUp();
          }
        }, giveUp);
      }, giveUp);
  }

  function exportCsv() {
    var rows = [['source', 'target', 'depth', 'percent_of_total', 'absolute',
                 'unit', 'negative', 'synthetic']];
    view.flows.forEach(function (f) {
      rows.push([f.source, f.target, f.depth, f.value,
                 META.rootValue ? f.value / 100 * META.rootValue : '',
                 META.unit || '', f.negative ? 'yes' : 'no', f.synthetic || '']);
    });
    var csv = rows.map(function (r) {
      return r.map(function (cell) {
        var s = String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
    download(baseName() + '-flows.csv', csv, 'text/csv');
  }

  /* ── dump hook (verification) ─────────────────────────────────────────── */
  /* Produces the same JSON shape as tools/verify_flows.py so the two flow
     pipelines can be diffed.  See README_sankey.md. */
  window.dumpFlows = function (levels, threshold, smallMode, balance, prune) {
    var v = LCAFlows.buildFlows(PAYLOAD, {
      levels: levels,
      threshold: threshold,
      smallMode: smallMode || 'pool',
      balance: balance === undefined ? true : balance,
      // off by default here: the reference pipeline never pruned, so leaving it
      // on would make the regression diff test two things at once
      prune: prune === true
    });
    var flows = v.flows.map(function (f) {
      return { source: f.source, target: f.target, depth: f.depth,
               value: Math.round(f.value * 1e9) / 1e9 };
    }).sort(function (a, b) {
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      if (a.target !== b.target) return a.target < b.target ? -1 : 1;
      return a.depth - b.depth;
    });
    var depthOf = {};
    Object.keys(v.depthOf).sort().forEach(function (k) { depthOf[k] = v.depthOf[k]; });
    return {
      settings: { levels: levels, threshold: threshold },
      stats: { pooled: v.stats.pooled, otherNodes: v.stats.otherNodes,
               gap: v.stats.gap, cyclesDropped: v.stats.cyclesDropped,
               flows: v.stats.flows, nodes: v.stats.nodes },
      flows: flows,
      depthOf: depthOf
    };
  };

  /* ── wiring ───────────────────────────────────────────────────────────── */
  function wire() {
    var maxLevels = (META.maxDepth || 1) + 1;
    $('c-levels').max = maxLevels;
    if (state.levels > maxLevels) state.levels = maxLevels;
    $('meta-source').textContent = META.source || '';

    // palette dropdown
    var sel = $('c-palette');
    Object.keys(PALETTES).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PALETTES[key].label;
      sel.appendChild(opt);
    });

    // data
    bindRange('c-levels', 'levels', function (v) { return String(v); },
              syncConditionalRows);
    repaintSeg.small = bindSeg('c-small', 'smallMode', syncConditionalRows);
    bindRange('c-threshold', 'threshold', function (v) { return v.toFixed(1) + '%'; });
    bindRange('c-maxnodes', 'maxNodes', function (v) { return v ? String(v) : 'all'; });
    repaintSeg.balance = bindSeg('c-balance', 'balance');

    // typography
    bindSelect('c-font', 'font');
    bindRange('c-fontsize', 'fontSize', function (v) { return v + 'px'; });
    bindRange('c-labelsize', 'labelSize', function (v) { return v + 'px'; });
    bindColor('c-labelcolor', 'labelColor', themeInk);
    $('c-labelcolor-auto').addEventListener('click', function () {
      state.labelColor = null;
      $('c-labelcolor').value = themeInk();
      render();
    });
    bindRange('c-hoversize', 'hoverSize', function (v) { return v + 'px'; });
    $('c-title').value = state.title;
    $('c-title').addEventListener('input', function () {
      state.title = this.value;
      render();
    });
    bindRange('c-titlesize', 'titleSize', function (v) { return v + 'px'; });
    bindSelect('c-titlealign', 'titleAlign');
    bindCheck('c-titlebold', 'titleBold');

    // labels
    repaintSeg.labelMode = bindSeg('c-labelmode', 'labelMode');
    bindSelect('c-labelsource', 'labelSource');
    bindRange('c-wrap', 'wrap', function (v) { return String(v); });
    bindRange('c-truncate', 'truncate', function (v) {
      return v ? String(v) : 'off';
    });
    bindRange('c-labelcutoff', 'labelCutoff', function (v) {
      return v ? v.toFixed(1) + '%' : 'all';
    });
    bindSelect('c-align', 'align');
    bindSelect('c-labelside', 'labelSide');
    bindRange('c-labelangle', 'labelAngle', function (v) {
      return (v > 0 ? '+' : '') + v + '°';
    });
    bindRange('c-decimals', 'decimals', function (v) { return String(v); });
    $('c-addtext').addEventListener('click', function () {
      // No prompt(): modal dialogs are blocked in sandboxed contexts, and the
      // annotation is editable on the canvas anyway, which is the better flow.
      addAnnotation('Double-click to edit',
                    { x: 0.5, y: 0.5 - 0.03 * state.annotations.length });
    });
    $('c-clearann').addEventListener('click', function () {
      state.annotations = [];
      render();
    });

    // colours
    bindSelect('c-theme', 'theme', afterThemeChange);
    bindSelect('c-palette', 'palette', function () {
      state.depthColors = null;
      buildDepthColors();
    });
    bindSelect('c-linkmode', 'linkMode', syncConditionalRows);
    bindColor('c-linkcolor', 'linkColor', function () { return '#2a78d6'; });
    bindRange('c-linkalpha', 'linkAlpha', function (v) { return v.toFixed(2); });
    bindColor('c-negcolor', 'negativeColor', function () {
      return INITIAL.negativeColor;
    });
    bindColor('c-bordercolor', 'borderColor', function () { return '#000000'; });
    bindRange('c-borderwidth', 'borderWidth', function (v) { return v.toFixed(1); });
    bindColor('c-bg', 'background', themeSurface);
    $('c-bg-auto').addEventListener('click', function () {
      state.background = null;
      $('c-bg').value = themeSurface();
      render();
    });

    // layout
    bindSelect('c-placement', 'placement');
    bindSelect('c-arrangement', 'arrangement');
    bindRange('c-pad', 'pad', function (v) { return String(v); });
    bindRange('c-thickness', 'thickness', function (v) { return String(v); });
    bindCheck('c-autoheight', 'autoHeight', syncConditionalRows);
    bindRange('c-height', 'height', function (v) { return v + 'px'; });
    bindCheck('c-fitwidth', 'fitWidth', syncConditionalRows);
    bindRange('c-width', 'width', function (v) { return v + 'px'; });
    bindRange('c-marginx', 'marginX', function (v) { return String(v); });
    bindRange('c-margintop', 'marginTop', function (v) { return String(v); });
    $('c-resetpos').addEventListener('click', function () {
      state.nodePos = {};
      render();
    });

    // inspector
    $('i-label').addEventListener('input', function () {
      editSelected({ label: this.value });
    });
    $('i-color').addEventListener('input', function () {
      editSelected({ color: this.value });
    });
    $('i-color-reset').addEventListener('click', function () {
      editSelected({ color: null });
    });
    $('i-hide').addEventListener('change', function () {
      editSelected({ hidden: this.checked });
    });
    $('i-detach').addEventListener('click', function () {
      if (!selected) return;
      var text = labelFor(selected, view) || selected;
      var pos = nodePaperPos(selected);
      editSelected({ hidden: true });
      addAnnotation(text, pos, null, state.labelAngle);
    });
    $('i-reset').addEventListener('click', function () {
      if (!selected) return;
      delete state.nodeOverrides[selected];
      delete state.nodePos[selected];
      render();
    });

    // export
    bindRange('c-scale', 'scale', function (v) { return v + '×'; });
    $('c-png').addEventListener('click', function () { exportImage('png'); });
    $('c-svg').addEventListener('click', function () { exportImage('svg'); });
    $('c-csv').addEventListener('click', exportCsv);
    $('c-save').addEventListener('click', function () {
      download(baseName() + '-style.json', JSON.stringify(state, null, 2),
               'application/json');
    });
    $('c-load').addEventListener('click', function () { $('c-loadfile').click(); });
    $('c-loadfile').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var saved = JSON.parse(reader.result);
          Object.keys(state).forEach(function (k) {
            if (saved[k] !== undefined) state[k] = saved[k];
          });
          applyStateToControls();
          render();
          $('save-note').textContent = 'Loaded ' + file.name + '.';
        } catch (err) {
          $('save-note').textContent = file.name + ' is not a saved style.';
        }
      };
      reader.readAsText(file);
      this.value = '';
    });
    $('c-copykey').addEventListener('click', function () {
      var text = keyAsText();
      var btn = this;
      var done = function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy as table'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          download(baseName() + '-key.tsv', text, 'text/tab-separated-values');
        });
      } else {
        download(baseName() + '-key.tsv', text, 'text/tab-separated-values');
      }
    });
    $('c-publication').addEventListener('click', function () {
      state.theme = 'light';
      state.palette = 'print';
      state.depthColors = null;
      state.background = '#ffffff';
      state.labelColor = '#000000';
      state.borderColor = '#000000';
      state.borderWidth = 0.5;
      state.labelMode = 'number';
      state.font = 'Arial, Helvetica, sans-serif';
      state.linkAlpha = 0.45;
      state.titleBold = false;
      applyStateToControls();
      render();
    });
    $('c-reset').addEventListener('click', function () {
      if (!window.confirm('Reset every control to its default?')) return;
      try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
      state = defaults();
      applyStateToControls();
      render();
    });

    wireBrandHeader();

    // panel visibility
    $('c-hidepanel').addEventListener('click', function () {
      document.body.classList.add('panel-hidden');
      $('panel-toggle').setAttribute('aria-expanded', 'false');
      setTimeout(function () { Plotly.Plots.resize(gd); }, 50);
    });
    $('panel-toggle').addEventListener('click', function () {
      document.body.classList.remove('panel-hidden');
      this.setAttribute('aria-expanded', 'true');
      setTimeout(function () { Plotly.Plots.resize(gd); }, 50);
    });
  }

  /* Push the whole state back into the DOM — used after Reset and after
     loading a saved style, where every control may have changed at once. */
  function applyStateToControls() {
    suspendSync = true;
    var pairs = [
      ['c-levels', 'levels'], ['c-threshold', 'threshold'],
      ['c-maxnodes', 'maxNodes'],
      ['c-fontsize', 'fontSize'], ['c-labelsize', 'labelSize'],
      ['c-hoversize', 'hoverSize'], ['c-titlesize', 'titleSize'],
      ['c-wrap', 'wrap'], ['c-truncate', 'truncate'], ['c-decimals', 'decimals'],
      ['c-labelcutoff', 'labelCutoff'], ['c-labelangle', 'labelAngle'],
      ['c-linkalpha', 'linkAlpha'], ['c-borderwidth', 'borderWidth'],
      ['c-pad', 'pad'], ['c-thickness', 'thickness'], ['c-height', 'height'],
      ['c-width', 'width'], ['c-marginx', 'marginX'],
      ['c-margintop', 'marginTop'], ['c-scale', 'scale'],
      ['c-font', 'font'], ['c-titlealign', 'titleAlign'],
      ['c-labelsource', 'labelSource'], ['c-align', 'align'],
      ['c-labelside', 'labelSide'],
      ['c-theme', 'theme'], ['c-palette', 'palette'],
      ['c-linkmode', 'linkMode'], ['c-placement', 'placement'],
      ['c-arrangement', 'arrangement']
    ];
    pairs.forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      el.value = state[p[1]];
      var valId = 'v-' + p[0].slice(2);
      if ($(valId) && rangeFormat[p[0]]) {
        $(valId).textContent = rangeFormat[p[0]](state[p[1]]);
      }
    });
    $('c-title').value = state.title;
    $('c-titlebold').checked = !!state.titleBold;
    $('c-autoheight').checked = !!state.autoHeight;
    $('c-fitwidth').checked = !!state.fitWidth;
    $('c-labelcolor').value = state.labelColor || themeInk();
    $('c-bg').value = state.background || themeSurface();
    $('c-linkcolor').value = state.linkColor;
    $('c-negcolor').value = state.negativeColor;
    $('c-bordercolor').value = state.borderColor || '#000000';
    document.documentElement.setAttribute(
      'data-theme', state.theme === 'auto' ? '' : state.theme);
    Object.keys(repaintSeg).forEach(function (k) { repaintSeg[k](); });
    syncConditionalRows();
    buildDepthColors();
    paintBrandTheme();
    suspendSync = false;
  }

  /* ── init ─────────────────────────────────────────────────────────────── */
  load();
  wire();
  applyStateToControls();
  render();                    // draw() binds the plot events on the first plot
  buildDepthColors();

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { if (state.theme === 'auto') render(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  if (typeof global.__lcaOnStarted === 'function') global.__lcaOnStarted();

  if (/[?&]dumpFlows=1/.test(location.search)) {
    var qs = function (name, fallback) {
      var m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.search);
      return m ? parseFloat(m[1]) : fallback;
    };
    var mode = (/[?&]smallMode=(\w+)/.exec(location.search) || [])[1];
    var bal = /[?&]balance=1/.test(location.search) ? true
            : /[?&]balance=0/.test(location.search) ? false : undefined;
    var dump = JSON.stringify(
      window.dumpFlows(qs('levels', state.levels), qs('threshold', state.threshold),
                       mode, bal),
      null, 2);
    /* eslint-disable no-console */
    console.log(dump);
    // also into the DOM, so `chrome --headless --dump-dom` can read it back
    $('flow-dump').textContent = dump;
  }
  }

  global.LCADashboard = { start: start };

  /* A per-workbook build inlines its data as globals and starts straight away;
     the drop-in app leaves PAYLOAD null and calls start() itself. */
  if (typeof PAYLOAD !== 'undefined' && PAYLOAD && PAYLOAD.names) {
    start(PAYLOAD, INITIAL, PALETTES);
  }
}(this));
