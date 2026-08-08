/*
 * dashboard.js — controls, figure building and export for the Sankey dashboard.
 *
 * Reads the inlined PAYLOAD/INITIAL/PALETTES globals, runs LCAFlows.buildFlows
 * on every data change, and re-renders through Plotly.react so drags and hover
 * state survive.  Written in ES5 so the generated file works in older browsers
 * and can be exercised by a plain script host during verification.
 */
(function () {
  'use strict';

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
      labelAngle: 0,             // degrees, clockwise; 0 = horizontal
      decimals: 1,
      // colours
      theme: 'auto',
      palette: 'categorical',
      depthColors: null,         // null = take from the palette preset
      linkMode: 'depth',
      linkColor: '#2a78d6',
      linkAlpha: 0.32,
      negativeColor: INITIAL.negativeColor,
      borderColor: null,         // null = follow theme
      borderWidth: 0.5,
      background: null,          // null = follow theme
      // layout
      placement: 'weighted',
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
  function positions(v, nodes, innerHeight) {
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
        // Push apart by however much room a label actually needs, in fractions
        // of the plot height — a fixed 2% collided as soon as labels wrapped.
        var gap = (state.labelSize * 1.5 + 6) / Math.max(innerHeight, 1);
        if (gap * column.length > 0.98) gap = 0.98 / Math.max(column.length, 1);
        for (var i = 1; i < raw.length; i++) {
          if (raw[i] < raw[i - 1] + gap) raw[i] = raw[i - 1] + gap;
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

  /* Size to the tallest column's actual label stack, not just its node count:
     a two-line wrapped label needs twice the room of a one-line one, and
     guessing on node count alone is what produced the old 6840px files that
     still had labels touching. */
  function autoHeight(v, nodes, labels) {
    var perColumn = {};
    nodes.forEach(function (name, i) {
      var d = v.depthOf[name];
      var need = labels[i]
        ? Math.max(labelExtent(labels[i]), state.thickness) + state.pad
        // an unlabelled node only needs to be visible, not readable
        : Math.min(state.pad, 6) + 2;
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
    var height = state.autoHeight ? autoHeight(v, nodes, labels) : state.height;
    var pos = positions(v, nodes, height - state.marginTop - 36);

    var node = {
      label: labels,
      customdata: nodes.map(function (n) {
        var pct = v.nodeTotals[n] || 0;
        return [esc(fullNameOf(n)), fmtAbs(pct)];
      }),
      color: nodes.map(function (n) { return nodeColor(n, v.depthOf[n]); }),
      pad: state.pad,
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
      margin: {
        l: state.marginX, r: state.marginX,
        t: state.marginTop, b: 36
      },
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
                              .concat(state.labelAngle ? ['toImage'] : []),
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

  function applyLabelAngle() {
    var angle = state.labelAngle || 0;
    var texts = gd.querySelectorAll('text.node-label');
    for (var i = 0; i < texts.length; i++) {
      texts[i].setAttribute(
        'transform', angleTransform(texts[i].getAttribute('transform'), angle));
    }
  }

  /* Same rotation, applied to an exported SVG string.  Export cannot reuse the
     live DOM: Plotly.toImage redraws the figure from its spec into a throwaway
     div, which is a faithful copy of everything Plotly knows about and nothing
     it doesn't.  Both export paths therefore patch the string instead. */
  function rotateLabelsInSvg(svgText) {
    var angle = state.labelAngle || 0;
    if (!angle) return svgText;
    return svgText.replace(/<text\b[^>]*>/g, function (tag) {
      if (tag.indexOf('node-label') < 0) return tag;
      if (/\stransform="/.test(tag)) {
        return tag.replace(/\stransform="([^"]*)"/, function (all, tf) {
          return ' transform="' + angleTransform(tf, angle) + '"';
        });
      }
      return tag.replace(/<text\b/, '<text transform="rotate(' + angle + ')"');
    });
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  var lastFigure = null;
  var afterPlotBound = false;

  function render() {
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
      updateStats();
      refreshInspector();
      buildKey();
      save();
      return;
    }

    lastFigure = buildFigure(view);
    Plotly.react(gd, lastFigure.data, lastFigure.layout, lastFigure.config);
    applyLabelAngle();
    if (!afterPlotBound && gd.on) {
      // catches the draws we do not drive ourselves — node drags, resizes
      afterPlotBound = true;
      gd.on('plotly_afterplot', applyLabelAngle);
    }
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
    if (!state.labelAngle) return plotlyDownload();

    function giveUp() {
      $('save-note').textContent =
        'Could not export the rotated labels — saved the level version instead.';
      plotlyDownload();
    }

    Plotly.toImage(gd, { format: 'svg', width: width, height: height })
      .then(function (uri) {
        var svg = rotateLabelsInSvg(
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
    bindSelect('c-theme', 'theme', function () {
      document.documentElement.setAttribute(
        'data-theme', state.theme === 'auto' ? '' : state.theme);
      state.depthColors = null;
      state.labelColor = null;
      state.background = null;
      state.borderColor = null;
      $('c-labelcolor').value = themeInk();
      $('c-bg').value = themeSurface();
      buildDepthColors();
    });
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

    // panel visibility
    $('c-hidepanel').addEventListener('click', function () {
      document.body.classList.add('panel-hidden');
      setTimeout(function () { Plotly.Plots.resize(gd); }, 50);
    });
    $('panel-toggle').addEventListener('click', function () {
      document.body.classList.remove('panel-hidden');
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
    suspendSync = false;
  }

  /* ── init ─────────────────────────────────────────────────────────────── */
  load();
  wire();
  applyStateToControls();
  render();
  buildDepthColors();

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

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { if (state.theme === 'auto') render(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

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
}());
