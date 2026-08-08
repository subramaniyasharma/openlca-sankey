/*
 * parse.js — the contribution-tree parser, ported from generate_sankey.py.
 *
 * Turns the 2-D cell rectangle xlsx.js hands back into the same payload the
 * Python script builds, so the browser can do the whole job from a dropped
 * file and the dashboard downstream cannot tell the difference.
 *
 * This is a *port*, not a reimplementation, and the order of operations is
 * load-bearing in a few places that look arbitrary — they are marked below.
 * generate_sankey.py stays the reference: tools/verify_parse.py diffs the two
 * on real workbooks, and any change here should be checked against it.
 *
 *   LCAParse.build(rows, options) -> {payload, initial, stats} | throws
 */
(function (global) {
  'use strict';

  var MAX_DEPTH_SCAN = 10;
  var LOCATION_RE = /\s[-–]\s*([A-Za-z]{2,4}(?:-[A-Za-z0-9]{1,10})?)\s*$/;
  var UNIT_RE = /\[([^\]]+)\]/;

  function isText(value) {
    // Python checks isinstance(val, str): a number sitting in a name column is
    // not a node, and treating it as one invents a branch.
    return typeof value === 'string' && value.trim() !== '';
  }

  /* pandas' to_numeric(errors='coerce'), near enough: accept a real number or
     a string that is entirely numeric, otherwise NaN.  parseFloat alone is too
     eager — it reads '12 kg' as 12, which pandas would have dropped. */
  function toNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : NaN;
    if (typeof value !== 'string') return NaN;
    var text = value.trim();
    if (!text) return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return NaN;
    return parseFloat(text);
  }

  function cell(rows, r, c) {
    var row = rows[r];
    if (!row) return null;
    var value = row[c];
    return value === undefined ? null : value;
  }

  function width(rows) {
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].length > n) n = rows[i].length;
    }
    return n;
  }

  /* ── reading ──────────────────────────────────────────────────────────── */
  function findResultColumn(headerRow, columns) {
    if (headerRow) {
      for (var i = 0; i < headerRow.length; i++) {
        var v = headerRow[i];
        if (v !== null && v !== undefined &&
            String(v).toLowerCase().indexOf('result') >= 0) {
          return i;
        }
      }
    }
    return Math.min(8, columns - 1);
  }

  function readSheet(rows) {
    var impact = '';
    var first = cell(rows, 0, 0);
    if (first !== null && first !== undefined) {
      impact = String(first).trim()
        .replace(/^\s*upstream contributions to:\s*/i, '');
    }

    var headerIndex = -1;
    for (var r = 0; r < rows.length; r++) {
      var v = cell(rows, r, 0);
      if (v !== null && String(v).trim().toLowerCase() === 'processes') {
        headerIndex = r;
        break;
      }
    }

    var headerRow = null;
    var body = rows;
    if (headerIndex >= 0) {
      headerRow = rows[headerIndex];
      body = rows.slice(headerIndex + 1);
    }

    var unit = '';
    if (headerRow) {
      var resultCol = findResultColumn(headerRow, width(body));
      var match = UNIT_RE.exec(String(headerRow[resultCol] === undefined ||
                                      headerRow[resultCol] === null
                                      ? '' : headerRow[resultCol]));
      if (match) unit = match[1];
    }

    return { rows: body, headerRow: headerRow, impact: impact, unit: unit,
             headerIndex: headerIndex };
  }

  /* ── parsing ──────────────────────────────────────────────────────────── */
  function parseTree(rows, headerRow, maxDepth) {
    var columns = width(rows);
    var resultCol = findResultColumn(headerRow, columns);
    var scanCols = Math.min(MAX_DEPTH_SCAN, columns);

    var links = [], path = {};
    var rootValue = null, negatives = 0, deepest = 0;

    for (var r = 0; r < rows.length; r++) {
      var depth = -1, nodeName = null;
      for (var d = 0; d < scanCols; d++) {
        var v = cell(rows, r, d);
        if (isText(v)) { depth = d; nodeName = v; break; }
      }
      if (nodeName === null) continue;

      var result = toNumber(cell(rows, r, resultCol));
      if (isNaN(result) || result === 0) continue;

      // Only rows that survive the numeric check update the path — a skipped
      // row must not become the parent of the rows under it.
      path[depth] = nodeName;
      if (depth === 0 && rootValue === null) rootValue = Math.abs(result);
      if (depth > deepest) deepest = depth;

      if (depth > 0 && depth <= maxDepth) {
        var parent = path[depth - 1];
        if (parent && parent !== nodeName) {
          if (result < 0) negatives++;
          links.push({ source: parent, target: nodeName,
                       value: Math.abs(result), depth: depth,
                       negative: result < 0 });
        }
      }
    }

    return { links: links, rootValue: rootValue, negatives: negatives,
             deepest: deepest };
  }

  /* ── labels ───────────────────────────────────────────────────────────── */
  function splitName(fullName) {
    var text = String(fullName).split(/\s+/).filter(Boolean).join(' ');
    var location = '';
    var match = LOCATION_RE.exec(text);
    if (match) location = match[1];

    var short = text.split('|')[0].trim();
    var shortMatch = LOCATION_RE.exec(short);
    if (shortMatch) {
      if (!location) location = shortMatch[1];
      short = short.slice(0, shortMatch.index).trim();
    }
    return { short: short || text, location: location };
  }

  /* Only names that actually collide get a location suffix, and a numeric one
     if they still clash.  Iteration follows first-appearance order, the same
     as the Python dict, because that is what decides which of two identical
     labels keeps the plain form and which becomes "#2". */
  function resolveLabels(fullNames) {
    var parsed = {}, shorts = {};
    fullNames.forEach(function (name) {
      var split = splitName(name);
      parsed[name] = split;
      (shorts[split.short] || (shorts[split.short] = {}))[name] = true;
    });

    function count(map) { return Object.keys(map).length; }

    var labels = {}, used = {}, collided = 0;
    Object.keys(shorts).forEach(function (s) {
      if (count(shorts[s]) > 1) collided++;
    });

    fullNames.forEach(function (name) {
      var split = parsed[name];
      var label;
      if (count(shorts[split.short]) > 1) {
        label = split.location ? split.short + ' (' + split.location + ')'
                               : split.short;
      } else {
        label = split.short;
      }
      if (Object.prototype.hasOwnProperty.call(used, label) &&
          used[label] !== name) {
        var suffix = 2;
        while (Object.prototype.hasOwnProperty.call(used, label + ' #' + suffix)) {
          suffix++;
        }
        label = label + ' #' + suffix;
      }
      used[label] = name;
      labels[name] = label;
    });

    return { labels: labels, collided: collided };
  }

  /* ── payload ──────────────────────────────────────────────────────────── */
  function buildPayload(links, rootValue, meta, payloadMin) {
    var names = [], index = {};
    function idx(name) {
      if (!Object.prototype.hasOwnProperty.call(index, name)) {
        index[name] = names.length;
        names.push(name);
      }
      return index[name];
    }

    var scale = rootValue ? 100 / rootValue : 1;
    var s = [], t = [], v = [], d = [], n = [];
    var pruned = 0;

    links.forEach(function (link) {
      var value = link.value * scale;
      if (payloadMin && value < payloadMin) { pruned++; return; }
      s.push(idx(link.source));
      t.push(idx(link.target));
      // full precision on purpose — the browser sums these
      v.push(value);
      d.push(link.depth);
      n.push(link.negative ? 1 : 0);
    });

    var resolved = resolveLabels(names);
    var shorts = names.map(function (name) { return resolved.labels[name]; });

    return {
      payload: { meta: meta, names: names, shorts: shorts,
                 links: { s: s, t: t, v: v, d: d, n: n } },
      pruned: pruned,
      collided: resolved.collided
    };
  }

  /* ── entry point ──────────────────────────────────────────────────────── */
  function build(rows, options) {
    var opts = options || {};
    var maxDepth = opts.maxDepth === undefined ? 6 : opts.maxDepth;
    var payloadMin = opts.payloadMin || 0;
    var source = opts.source || 'workbook.xlsx';

    var sheet = readSheet(rows);
    var tree = parseTree(sheet.rows, sheet.headerRow, maxDepth);
    if (!tree.links.length) {
      throw new Error("No links parsed. Check the indentation and the " +
                      "'Result' column.");
    }

    var depth = Math.min(maxDepth, tree.deepest);
    var title = opts.title || (sheet.impact
      ? sheet.impact + ' — contribution tree'
      : source + ' — contribution tree');

    var meta = {
      source: source,
      impact: sheet.impact,
      unit: sheet.unit,
      rootValue: tree.rootValue ? Number(tree.rootValue) : null,
      maxDepth: depth,
      title: title,
      generated: new Date().toISOString().slice(0, 10)
    };

    var built = buildPayload(tree.links, tree.rootValue, meta, payloadMin);

    return {
      payload: built.payload,
      stats: {
        headerRow: sheet.headerIndex >= 0 ? sheet.headerIndex + 1 : null,
        links: built.payload.links.s.length,
        nodes: built.payload.names.length,
        maxDepth: depth,
        deepest: tree.deepest,
        negatives: tree.negatives,
        collided: built.collided,
        pruned: built.pruned,
        rootValue: tree.rootValue,
        unit: sheet.unit,
        impact: sheet.impact
      }
    };
  }

  global.LCAParse = {
    build: build,
    // exposed for the parity harness
    readSheet: readSheet,
    parseTree: parseTree,
    splitName: splitName,
    resolveLabels: resolveLabels
  };
}(this));
