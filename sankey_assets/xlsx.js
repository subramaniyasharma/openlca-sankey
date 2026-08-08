/*
 * xlsx.js — a small read-only .xlsx reader with no dependencies.
 *
 * An .xlsx is a ZIP of XML, and the browser can now do both halves on its own:
 * DecompressionStream('deflate-raw') for the archive entries, DOMParser for the
 * XML.  Shipping ~900 KB of a general-purpose spreadsheet library to read four
 * known files, in a page that already carries Plotly, is not a good trade.
 *
 * Deliberately partial.  It reads cell *values* — text and numbers — and
 * nothing else: no styles, no formulas beyond their cached result, no dates as
 * Date objects, no .xls (that is a completely different, pre-ZIP format).  A
 * contribution-tree export needs process names and one numeric column, and
 * anything past that is weight we would carry for nothing.
 *
 *   LCAXlsx.read(arrayBuffer) -> Promise<{ sheets: [{ name, rows }] }>
 *
 * `rows` is a dense 2-D array indexed from row 1 / column A, holding strings,
 * numbers or null — the same rectangle pandas hands back for
 * `read_excel(header=None)`, so the parser above it can be a direct port.
 */
(function (global) {
  'use strict';

  /* ── ZIP ──────────────────────────────────────────────────────────────── */
  /* Just enough of the format to find named entries and inflate them: the
     central directory at the tail, then each local header for the real data
     offset.  ZIP64 and encryption are not handled; neither appears in a
     spreadsheet export of this size, and both are reported rather than
     silently mis-read. */
  function findEndOfCentralDirectory(view) {
    // the EOCD is last, but a trailing comment can push it up to 64 KB back
    var min = Math.max(0, view.byteLength - 65557);
    for (var i = view.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function readEntries(buffer) {
    var view = new DataView(buffer);
    var eocd = findEndOfCentralDirectory(view);
    if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

    var count = view.getUint16(eocd + 10, true);
    var start = view.getUint32(eocd + 16, true);
    if (count === 0xffff || start === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported');
    }

    var decoder = new TextDecoder('utf-8');
    var entries = {};
    var p = start;
    for (var i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var flags = view.getUint16(p + 8, true);
      var method = view.getUint16(p + 10, true);
      var compressed = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
      entries[name] = { method: method, compressed: compressed,
                        localOffset: localOffset, flags: flags };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { view: view, buffer: buffer, entries: entries };
  }

  function entryBytes(zip, name) {
    var entry = zip.entries[name];
    if (!entry) return null;
    if (entry.flags & 0x1) throw new Error('encrypted entry: ' + name);

    // the central directory's name/extra lengths need not match the local
    // header's, so the data offset has to come from the local header
    var view = zip.view;
    var at = entry.localOffset;
    if (view.getUint32(at, true) !== 0x04034b50) {
      throw new Error('bad local header for ' + name);
    }
    var nameLen = view.getUint16(at + 26, true);
    var extraLen = view.getUint16(at + 28, true);
    var from = at + 30 + nameLen + extraLen;
    return { method: entry.method,
             bytes: new Uint8Array(zip.buffer, from, entry.compressed) };
  }

  function inflate(part) {
    if (!part) return Promise.resolve(null);
    if (part.method === 0) {                       // stored
      return Promise.resolve(new TextDecoder('utf-8').decode(part.bytes));
    }
    if (part.method !== 8) {
      return Promise.reject(new Error('unsupported compression method ' +
                                      part.method));
    }
    var stream = new Blob([part.bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  function readText(zip, name) {
    try {
      return inflate(entryBytes(zip, name));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* ── XML ──────────────────────────────────────────────────────────────── */
  function parseXml(text, what) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('could not parse ' + what);
    }
    return doc;
  }

  /* Local name, so the code does not care whether the file namespaces its
     elements — some producers do, some do not. */
  function tags(node, name) {
    var all = node.getElementsByTagName('*');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var tag = all[i].tagName;
      if (tag === name || tag.slice(tag.indexOf(':') + 1) === name) out.push(all[i]);
    }
    return out;
  }

  function attr(node, name) {
    if (node.hasAttribute(name)) return node.getAttribute(name);
    for (var i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i];
      var local = a.name.slice(a.name.indexOf(':') + 1);
      if (local === name) return a.value;
    }
    return null;
  }

  /* "BC12" -> 54.  Excel's column letters are bijective base-26. */
  function columnIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function rowIndex(ref) {
    var m = /(\d+)/.exec(ref);
    return m ? parseInt(m[1], 10) - 1 : -1;
  }

  /* A shared string is a run of <t> fragments; formatting splits one sentence
     across several, so they have to be joined rather than taking the first. */
  function sharedStrings(doc) {
    if (!doc) return [];
    return tags(doc.documentElement, 'si').map(function (si) {
      return tags(si, 't').map(function (t) { return t.textContent; }).join('');
    });
  }

  function sheetRows(doc, strings) {
    var rows = [];
    var cells = tags(doc.documentElement, 'c');
    var maxRow = -1, maxCol = -1;
    var found = [];

    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var ref = attr(cell, 'r') || '';
      var r = rowIndex(ref), c = columnIndex(ref);
      if (r < 0 || c < 0) continue;

      var type = attr(cell, 't') || 'n';
      var value = null;
      if (type === 'inlineStr') {
        value = tags(cell, 't').map(function (t) { return t.textContent; }).join('');
      } else {
        var v = tags(cell, 'v')[0];
        var raw = v ? v.textContent : null;
        if (raw === null || raw === '') {
          value = null;
        } else if (type === 's') {
          value = strings[parseInt(raw, 10)];
          if (value === undefined) value = null;
        } else if (type === 'str' || type === 'e') {
          value = raw;                       // formula result / error text
        } else if (type === 'b') {
          value = raw === '1';
        } else {
          var num = parseFloat(raw);
          value = isNaN(num) ? raw : num;    // 'n' and anything unrecognised
        }
      }
      if (value === '') value = null;
      found.push([r, c, value]);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }

    for (var y = 0; y <= maxRow; y++) {
      var row = new Array(maxCol + 1);
      for (var x = 0; x <= maxCol; x++) row[x] = null;
      rows.push(row);
    }
    for (i = 0; i < found.length; i++) {
      rows[found[i][0]][found[i][1]] = found[i][2];
    }
    return rows;
  }

  /* ── entry point ──────────────────────────────────────────────────────── */
  function read(buffer) {
    var zip;
    try {
      zip = readEntries(buffer);
    } catch (err) {
      return Promise.reject(err);
    }

    return Promise.all([
      readText(zip, 'xl/workbook.xml'),
      readText(zip, 'xl/_rels/workbook.xml.rels'),
      readText(zip, 'xl/sharedStrings.xml')
    ]).then(function (parts) {
      if (!parts[0]) throw new Error('no xl/workbook.xml — not an .xlsx file');
      var book = parseXml(parts[0], 'workbook.xml');
      var strings = parts[2] ? sharedStrings(parseXml(parts[2], 'sharedStrings.xml'))
                             : [];

      // rId -> worksheet path
      var targets = {};
      if (parts[1]) {
        tags(parseXml(parts[1], 'workbook.xml.rels').documentElement, 'Relationship')
          .forEach(function (rel) {
            var target = attr(rel, 'Target') || '';
            targets[attr(rel, 'Id')] =
              target.charAt(0) === '/' ? target.slice(1)
                                       : 'xl/' + target.replace(/^\.\//, '');
          });
      }

      var listed = tags(book.documentElement, 'sheet');
      var wanted = listed.map(function (sheet, i) {
        var path = targets[attr(sheet, 'id')] ||
                   ('xl/worksheets/sheet' + (i + 1) + '.xml');
        return { name: attr(sheet, 'name') || ('Sheet' + (i + 1)), path: path };
      });

      return Promise.all(wanted.map(function (s) {
        return readText(zip, s.path).then(function (text) {
          return { name: s.name,
                   rows: text ? sheetRows(parseXml(text, s.path), strings) : [] };
        });
      })).then(function (sheets) { return { sheets: sheets }; });
    });
  }

  global.LCAXlsx = { read: read };
}(this));
