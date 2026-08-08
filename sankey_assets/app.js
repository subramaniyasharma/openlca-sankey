/*
 * app.js — the drop-in build's controller.
 *
 * Reads a dropped workbook with xlsx.js, turns it into a payload with
 * parse.js, and hands that to LCADashboard.start().  Everything below that
 * point is the same code the per-workbook build runs, so the two cannot drift.
 *
 * The whole job happens in the page: no upload, no server, nothing to install
 * for whoever you send the file to.  That is the point of the exercise, and it
 * is also why the parser had to be ported rather than called.
 */
(function (global) {
  'use strict';

  var INITIAL = {
    levels: 2,
    threshold: 2.0,
    maxNodes: 0,
    smallMode: 'all',
    balance: false,
    negativeColor: '#d03b3b'
  };

  function $(id) { return document.getElementById(id); }

  var state = {
    sheets: [],          // [{name, rows}]
    sheetIndex: 0,
    source: '',
    panelHtml: null      // pristine control markup, see restart()
  };

  function showDrop(show) {
    $('drop').hidden = !show;
    $('source-bar').hidden = show;
    // the empty stage and panel would otherwise sit under the drop screen
    var app = document.querySelector('.app');
    if (app) app.hidden = show;
  }

  function errorText(err) {
    var text = String(err && err.message ? err.message : err || 'Unknown error');
    return text.length > 320 ? text.slice(0, 317) + '…' : text;
  }

  function fail(message) {
    var box = $('drop-error');
    var detail = $('drop-error-message');
    box.hidden = false;
    if (detail) detail.textContent = message;
    else box.textContent = message;
    showDrop(true);
  }

  function clearError() {
    $('drop-error').hidden = true;
    var detail = $('drop-error-message');
    if (detail) detail.textContent = '';
  }

  function exitToLoader() {
    try { if (global.Plotly) Plotly.purge($('chart')); } catch (err) { /* best effort */ }
    $('chart').innerHTML = '';
    $('drop-file').value = '';
    $('src-sheet').innerHTML = '';
    state.sheets = [];
    state.sheetIndex = 0;
    state.source = '';
    $('drop-note').textContent = 'Everything is read and drawn in this browser. The file is never uploaded.';
    clearError();
    showDrop(true);
  }

  /* Keep the branded theme buttons useful before a workbook is opened.  The
     dashboard controller takes over the same controls after start(), but the
     drop screen must not leave them decorative. */
  function paintBrandTheme() {
    var light = $('brand-light'), dark = $('brand-dark');
    if (!light || !dark) return;
    var mode = global.__lcaTheme || 'auto';
    var active = mode === 'auto' && window.matchMedia
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    light.setAttribute('aria-pressed', active === 'light' ? 'true' : 'false');
    dark.setAttribute('aria-pressed', active === 'dark' ? 'true' : 'false');
  }

  function setBrandTheme(mode) {
    global.__lcaTheme = mode;
    document.documentElement.setAttribute('data-theme', mode === 'auto' ? '' : mode);
    paintBrandTheme();
  }

  function wireBrandTheme() {
    var light = $('brand-light'), dark = $('brand-dark');
    if (!light || !dark) return;
    light.addEventListener('click', function () { setBrandTheme('light'); });
    dark.addEventListener('click', function () { setBrandTheme('dark'); });
    paintBrandTheme();
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () {
        if ((global.__lcaTheme || 'auto') === 'auto') paintBrandTheme();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  }

  function placeBrandMark() {
    var logo = $('brand-logo'), drop = $('drop-inner');
    if (logo && drop && logo.parentNode !== drop) {
      drop.insertBefore(logo, drop.firstChild);
    }
  }

  /* Rebuild the control panel from its original markup before each start.
     wire() attaches listeners to every control, and a second file would
     otherwise bind them twice over — dropping the nodes drops the listeners
     with them, which is cheaper and more reliable than unbinding by hand. */
  function restart(payload) {
    var panel = $('panel');
    if (state.panelHtml === null) {
      state.panelHtml = panel.innerHTML;
    } else {
      panel.innerHTML = state.panelHtml;
      try { if (global.Plotly) Plotly.purge($('chart')); } catch (err) { /* fresh div */ }
      $('chart').innerHTML = '';
    }
    global.LCADashboard.start(payload, INITIAL, global.PALETTES);
  }

  function buildFrom(sheetIndex) {
    var sheet = state.sheets[sheetIndex];
    if (!sheet) return fail('That sheet is empty.');

    var maxDepth = parseInt($('src-maxdepth').value, 10);
    if (!(maxDepth >= 1)) maxDepth = 6;
    var payloadMin = parseFloat($('src-payloadmin').value);
    if (!(payloadMin >= 0)) payloadMin = 0;

    var built;
    try {
      built = LCAParse.build(sheet.rows, {
        maxDepth: maxDepth,
        payloadMin: payloadMin,
        source: state.source
      });
    } catch (err) {
      return fail(String(err && err.message ? err.message : err));
    }

    clearError();
    showDrop(false);
    state.sheetIndex = sheetIndex;
    $('src-name').textContent = state.source;

    // the payload cap is also the ceiling for the Levels slider
    $('src-maxdepth').value = maxDepth;
    try {
      restart(built.payload);
    } catch (err) {
      return fail('The workbook was read, but the dashboard could not render it.\n\n' + errorText(err));
    }

    var s = built.stats;
    var note = [s.links + ' links', s.nodes + ' processes',
                'depth 0–' + s.maxDepth];
    if (s.negatives) note.push(s.negatives + ' negative');
    if (s.pruned) note.push(s.pruned + ' pruned');
    $('src-name').title = state.source + ' — ' + note.join(', ');
    return built;
  }

  function loadSheets(sheets, name) {
    var usable = sheets.filter(function (s) { return s.rows.length; });
    if (!usable.length) return fail('No readable sheets in that workbook.');

    state.sheets = usable;
    state.source = name;

    var picker = $('src-sheet');
    picker.innerHTML = '';
    usable.forEach(function (s, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.name;
      picker.appendChild(opt);
    });
    picker.parentNode.style.display = usable.length > 1 ? '' : 'none';
    picker.value = '0';

    // Prefer a sheet that actually looks like a contribution tree, so a
    // workbook whose first tab is a cover sheet still opens on the right one.
    var pick = 0;
    for (var i = 0; i < usable.length; i++) {
      var head = LCAParse.readSheet(usable[i].rows);
      if (head.headerIndex >= 0) { pick = i; break; }
    }
    picker.value = String(pick);
    buildFrom(pick);
  }

  function readFile(file) {
    if (!file) return;
    clearError();
    $('drop-note').textContent = 'Reading ' + file.name + ' …';

    file.arrayBuffer().then(function (buffer) {
      return LCAXlsx.read(buffer);
    }).then(function (book) {
      $('drop-note').textContent = 'Everything is read and drawn in this ' +
        'browser. The file is never uploaded.';
      loadSheets(book.sheets, file.name);
    }).catch(function (err) {
      $('drop-note').textContent = 'Everything is read and drawn in this ' +
        'browser. The file is never uploaded.';
      var message = String(err && err.message ? err.message : err);
      if (/zip|workbook\.xml/i.test(message)) {
        message += '  (An .xls saved by an old Excel is a different format — ' +
                   're-save it as .xlsx.)';
      }
      fail('Could not read ' + file.name + ': ' + errorText(message));
    });
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */
  function wire() {
    placeBrandMark();
    wireBrandTheme();
    var picker = $('drop-file');
    $('drop-pick').addEventListener('click', function () { picker.click(); });
    $('drop-retry').addEventListener('click', function () {
      clearError();
      picker.click();
    });
    $('drop-dismiss').addEventListener('click', clearError);
    $('src-open').addEventListener('click', function () { picker.click(); });
    $('src-exit').addEventListener('click', exitToLoader);
    picker.addEventListener('change', function () {
      readFile(this.files && this.files[0]);
      this.value = '';                 // so the same file can be re-opened
    });

    // the whole window is the target, not just the panel, so a mis-aimed drop
    // still works
    ['dragenter', 'dragover'].forEach(function (type) {
      window.addEventListener(type, function (ev) {
        ev.preventDefault();
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (ev) {
        ev.preventDefault();
        if (type === 'drop' || ev.target === document.documentElement) {
          document.body.classList.remove('dragging');
        }
      });
    });
    window.addEventListener('drop', function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) readFile(files[0]);
    });

    $('src-sheet').addEventListener('change', function () {
      buildFrom(parseInt(this.value, 10) || 0);
    });
    // max depth and the payload floor are build-time flags in the script; here
    // the workbook is still in memory, so they can just re-parse
    ['src-maxdepth', 'src-payloadmin'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (state.sheets.length) buildFrom(state.sheetIndex);
      });
    });

    window.addEventListener('error', function (ev) {
      if (ev.error) {
        fail('The dashboard encountered an unexpected error. You can choose the workbook again.\n\n' + errorText(ev.error));
      }
    });
    window.addEventListener('unhandledrejection', function (ev) {
      fail('The dashboard could not finish loading. You can choose the workbook again.\n\n' + errorText(ev.reason));
    });

    showDrop(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  /* ── parity harness ───────────────────────────────────────────────────── */
  /* Prints the digests tools/verify_parse.py prints for the same workbook.  A
     port is only worth having if something keeps checking it, and every line
     of these two outputs has to match. */
  function sha16(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buffer) {
      var out = '';
      new Uint8Array(buffer).forEach(function (b) {
        out += (b < 16 ? '0' : '') + b.toString(16);
      });
      return out.slice(0, 16);
    });
  }

  /* Python's %.11e, reproduced: JavaScript writes a one-digit exponent where
     Python pads to two, and that difference is not a parsing bug. */
  function canon(x) {
    return Number(x).toExponential(11).replace(/e([+-])(\d)$/, 'e$10$2');
  }

  global.__lcaParityDigest = function (url, maxDepth, payloadMin) {
    return global.__lcaDumpPayload(url, maxDepth, payloadMin)
      .then(function (built) {
        var p = built.payload, l = p.links;
        var parts = {
          names: p.names.join('\n'),
          shorts: p.shorts.join('\n'),
          s: l.s.join(','),
          t: l.t.join(','),
          d: l.d.join(','),
          n: l.n.join(','),
          v: l.v.map(canon).join(',')
        };
        var keys = Object.keys(parts);
        return Promise.all(keys.map(function (k) { return sha16(parts[k]); }))
          .then(function (hashes) {
            var out = { nodes: String(p.names.length),
                        links: String(l.s.length) };
            keys.forEach(function (k, i) { out[k] = hashes[i]; });
            out.rootValue = canon(p.meta.rootValue || 0);
            out.unit = p.meta.unit;
            out.impact = p.meta.impact;
            out.maxDepth = String(p.meta.maxDepth);
            return out;
          });
      });
  };

  /* Parse a workbook fetched by URL, without going through the drop UI. */
  global.__lcaDumpPayload = function (url, maxDepth, payloadMin) {
    return fetch(url).then(function (r) { return r.arrayBuffer(); })
      .then(function (buffer) { return LCAXlsx.read(buffer); })
      .then(function (book) {
        var name = url.split('/').pop();
        var sheets = book.sheets.filter(function (s) { return s.rows.length; });
        var pick = 0;
        for (var i = 0; i < sheets.length; i++) {
          if (LCAParse.readSheet(sheets[i].rows).headerIndex >= 0) { pick = i; break; }
        }
        return LCAParse.build(sheets[pick].rows, {
          maxDepth: maxDepth === undefined ? 6 : maxDepth,
          payloadMin: payloadMin || 0,
          source: decodeURIComponent(name)
        });
      });
  };
}(this));
