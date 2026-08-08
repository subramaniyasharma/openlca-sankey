"""
generate_sankey.py — openLCA contribution tree -> interactive Sankey dashboard.

Writes ONE self-contained HTML file containing the diagram *and* a control
panel.  Everything that used to be frozen at generation time is now live in the
browser: how many levels to show, whether to pool small flows, fonts, colours,
label wrapping and placement, per-node overrides, and PNG/SVG export.

    python generate_sankey.py contribution_tree.xlsx -o dashboard.html

Run it with no arguments and it falls back to the original interactive prompts.

What Python still does
  * read the Excel contribution tree and walk its indentation-encoded depth
  * resolve short, unique display labels (see the label rule below)
  * emit the full-depth link table as JSON and inline it, with the CSS/JS
    assets and optionally Plotly itself, into one HTML file

What the browser does
  * everything else — the flow pipeline lives in sankey_assets/flows.js so
    there is exactly one implementation of it (see tools/verify_flows.py for
    the reference the port was checked against)

Label rule
  Node labels are cut at the first "|" of the ecoinvent name.  If two
  different processes reduce to the same label, the location code is
  appended so they stay distinguishable:

      market for transport, freight, train, fleet average | ... | Cutoff, U - RoW
      market for transport, freight, train, fleet average | ... | Cutoff, U - CN
        ->  market for transport, freight, train, fleet average (RoW)
            market for transport, freight, train, fleet average (CN)

  Names that do not collide keep the short form with no location suffix.
"""

import argparse
import base64
from html import escape
import json
import os
import re
import sys
import webbrowser
from datetime import date

import pandas as pd

# --- defaults ---------------------------------------------------------------
# Keep the prompt-based fallback portable. Users can still provide absolute
# paths when the workbook or output lives elsewhere.
DEFAULT_XLSX = 'contribution_tree.xlsx'
DEFAULT_OUT = 'dashboard.html'
DEFAULT_LEVELS = 2
DEFAULT_THRESHOLD = 2.0      # % of the PARENT's total, when pooling is on
DEFAULT_MAX_DEPTH = 6        # how deep to put in the payload
MAX_DEPTH_SCAN = 10

ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         'sankey_assets')

# Depth palettes handed to the dashboard.  Every one of these was checked with
# the data-viz validator (OKLab dE under simulated protan/deutan, lightness
# band, chroma floor, contrast vs surface) against both the light surface
# #fcfcfb and the dark surface #1a1a19:
#
#   categorical  PASS both modes  (worst adjacent CVD dE 9.1 light / 8.4 dark;
#                normal-vision 19.6 / 19.3).  Three light steps sit below 3:1
#                contrast, which the relief rule permits here because a Sankey
#                node always carries a visible direct label.
#   depth-ramp   PASS both modes as an ordinal ramp.  Capped at FIVE steps:
#                six is not achievable on this blue ramp, since the ordinal
#                dL >= 0.06 gate and the 2:1 light-end floor together leave
#                only nine usable grid steps.  A sixth column reuses the last.
#   print        PASS both modes as an ordinal ramp, recut per mode.
#   legacy       FAILS three checks (lightness band, chroma floor and the
#                normal-vision floor: #17A589 vs #2E86C1 is dE 14.4).  Kept
#                only so existing figures can be reproduced; the UI says so.
#   legaci       The lab's own colours, from the Claude Design mockup.  Checked
#                with the same method as the rest and it is the weakest of the
#                three usable ones: worst adjacent dE 16.1 light / 15.5 dark in
#                normal vision, falling to 9.4 (light, deuteranopia, depths 3/4)
#                and 9.7 (dark, protanopia, depths 0/1) — against 17.2 and 14.7
#                for `categorical`.  Shipped as the default anyway because it is
#                the branded look and the cost lands on screen only: the
#                publication preset switches to `print`, so figures for a paper
#                are unaffected.  Switch the Colours → Palette dropdown to
#                Categorical for the most CVD-robust on-screen reading.
PALETTES = {
    'legaci': {
        'label': 'LEGACI brand',
        'light': ['#2f7d4f', '#b8912f', '#2c7a85', '#6a9a3a', '#8a6d3b', '#5f5a4e'],
        'dark': ['#4e9e6a', '#c8a24a', '#3e8e9c', '#7fb25a', '#9a7b4f', '#6f6a5e'],
    },
    'categorical': {
        'label': 'Categorical (validated)',
        'light': ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
        'dark': ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
    },
    'depth-ramp': {
        'label': 'Depth ramp — blue (max 5)',
        'light': ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec'],
        'dark': ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf'],
    },
    'print': {
        'label': 'Print / grayscale',
        'light': ['#31291d', '#494135', '#625a4e', '#7d7569', '#989084', '#b5ada1'],
        'dark': ['#645c50', '#7a7266', '#91897d', '#a8a094', '#bfb7ab', '#d8d0c4'],
    },
    'legacy': {
        'label': 'Legacy (original script — fails a11y checks)',
        'light': ['#1B4F72', '#2E86C1', '#17A589', '#D4AC0D', '#CA6F1E', '#884EA0'],
        'dark': ['#1B4F72', '#2E86C1', '#17A589', '#D4AC0D', '#CA6F1E', '#884EA0'],
    },
}
NEGATIVE_COLOR = '#d03b3b'   # status/critical — reserved, never a depth colour

# trailing ecoinvent location: "... | Cutoff, U - RoW"  /  "... - US-NPCC"
_LOCATION_RE = re.compile(r'\s[-–]\s*([A-Za-z]{2,4}(?:-[A-Za-z0-9]{1,10})?)\s*$')
_UNIT_RE = re.compile(r'\[([^\]]+)\]')


# --- helpers ----------------------------------------------------------------
def ask(prompt, default):
    raw = input(f"{prompt} [{default}]: ").strip().strip('"').strip("'")
    return raw or default


def split_name(full_name):
    """
    Break an openLCA/ecoinvent process name into (short_name, location).

    short_name = everything before the first "|", with any trailing location
    stripped, so "NI_HPAL - GLO" becomes "NI_HPAL".
    """
    text = ' '.join(str(full_name).split())
    location = ''
    match = _LOCATION_RE.search(text)
    if match:
        location = match.group(1)

    short = text.split('|')[0].strip()
    short_match = _LOCATION_RE.search(short)
    if short_match:
        if not location:
            location = short_match.group(1)
        short = short[:short_match.start()].strip()

    return (short or text), location


def resolve_labels(full_names):
    """
    Map every full process name to a unique display label.

    Only names that actually collide get a location suffix; a numeric suffix is
    added if two different processes share both the short name and the location.
    """
    parsed = {name: split_name(name) for name in full_names}

    shorts = {}
    for name, (short, _) in parsed.items():
        shorts.setdefault(short, set()).add(name)

    labels, used = {}, {}
    for name, (short, location) in parsed.items():
        if len(shorts[short]) > 1:                       # collision
            label = f'{short} ({location})' if location else short
        else:
            label = short

        if label in used and used[label] != name:        # still ambiguous
            suffix = 2
            while f'{label} #{suffix}' in used:
                suffix += 1
            label = f'{label} #{suffix}'
        used[label] = name
        labels[name] = label

    n_suffixed = sum(1 for s, names in shorts.items() if len(names) > 1)
    if n_suffixed:
        print(f"  {n_suffixed} label(s) collided after trimming at '|' — "
              f"location code appended.")
    return labels


def rgba(hex_color, alpha):
    """'#3d5a80' -> 'rgba(61,90,128,0.4)'. Plotly rejects 8-digit hex."""
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return f'rgba({r},{g},{b},{alpha})'


def find_result_column(df, header_row=None):
    """Find the column index containing 'result'.

    *header_row* is the raw Processes header row (a Series) from the
    original spreadsheet, if available.  We check it first because
    when we read without column headers the DataFrame columns are just
    integers.
    """
    if header_row is not None:
        for i, val in enumerate(header_row):
            if pd.notna(val) and 'result' in str(val).lower():
                return i
    # fallback: check DataFrame column names
    for i, col in enumerate(df.columns):
        if 'result' in str(col).lower():
            return i
    return min(8, len(df.columns) - 1)


# --- reading ----------------------------------------------------------------
def read_sheet(excel_path):
    """Return (tree_df, header_row, impact_name, unit) from a contribution export."""
    raw = pd.read_excel(excel_path, header=None)

    impact = ''
    first_cell = raw.iloc[0, 0] if len(raw) else None
    if pd.notna(first_cell):
        impact = re.sub(r'^\s*upstream contributions to:\s*', '',
                        str(first_cell).strip(), flags=re.I)

    first_col = raw.iloc[:, 0].astype(str).str.strip().str.lower()
    hits = raw.index[first_col == 'processes']
    header_row = None
    if len(hits):
        header_idx = int(hits[0])
        header_row = raw.iloc[header_idx]
        df = raw.iloc[header_idx + 1:].reset_index(drop=True)
        print(f"  Found the 'Processes' header on row {header_idx + 1}.")
    else:
        print("  No 'Processes' header found — reading the whole sheet.")
        df = raw

    unit = ''
    if header_row is not None:
        result_col = find_result_column(df, header_row=header_row)
        match = _UNIT_RE.search(str(header_row.iloc[result_col]))
        if match:
            unit = match.group(1)

    return df, header_row, impact, unit


# --- parsing ----------------------------------------------------------------
def parse_tree(df, max_depth, header_row=None):
    """
    Walk the indented tree; a row's depth is its first non-empty text cell.

    Unlike the original this emits links at *every* depth up to *max_depth*,
    because the level cut now happens in the browser.  The order of operations
    is otherwise identical — in particular `path` is updated only for rows that
    survive the zero/NaN result check, so filtering the output of this function
    by `depth < levels` gives exactly what the old `max_levels` gate gave.
    """
    result_col = find_result_column(df, header_row=header_row)
    scan_cols = min(MAX_DEPTH_SCAN, len(df.columns))

    raw_links, path = [], {}
    root_value, n_negative, deepest = None, 0, 0

    for _, row in df.iterrows():
        depth, node_name = -1, None
        for d in range(scan_cols):
            val = row.iloc[d]
            if pd.notna(val) and isinstance(val, str) and str(val).strip():
                depth, node_name = d, val
                break
        if node_name is None:
            continue

        result_val = pd.to_numeric(row.iloc[result_col], errors='coerce')
        if pd.isna(result_val) or result_val == 0:
            continue

        path[depth] = node_name
        if depth == 0 and root_value is None:
            root_value = abs(result_val)
        deepest = max(deepest, depth)

        if 0 < depth <= max_depth:
            parent = path.get(depth - 1)
            if parent and parent != node_name:
                if result_val < 0:
                    n_negative += 1
                raw_links.append({'SourceFull': parent, 'TargetFull': node_name,
                                  'Value': abs(result_val), 'Depth': depth,
                                  'Negative': result_val < 0})

    return raw_links, root_value, n_negative, deepest


def build_payload(raw_links, root_value, meta, payload_min=0.0):
    """
    Index-compressed JSON for the dashboard.

    Values are normalised to % of the root exactly as the original pipeline did
    (before aggregation — summing normalised values is the same as normalising
    the sum), so the browser only has to filter and aggregate.
    """
    names = []
    index = {}

    def idx(name):
        if name not in index:
            index[name] = len(names)
            names.append(name)
        return index[name]

    scale = 100.0 / root_value if root_value else 1.0
    if not root_value:
        print('  ! No depth-0 root value found — using raw amounts.')

    src, tgt, val, dep, neg = [], [], [], [], []
    pruned = 0
    for link in raw_links:
        value = link['Value'] * scale
        if payload_min and value < payload_min:
            pruned += 1
            continue
        src.append(idx(link['SourceFull']))
        tgt.append(idx(link['TargetFull']))
        # Full precision on purpose: the browser sums these, and pre-rounding
        # here showed up as a ~1e-9 drift against the reference pipeline.
        val.append(value)
        dep.append(link['Depth'])
        neg.append(1 if link['Negative'] else 0)

    if pruned:
        print(f'  Pruned {pruned} link(s) below {payload_min}% of the root '
              f'from the payload.')

    labels = resolve_labels(names)
    shorts = [labels[name] for name in names]

    return {
        'meta': meta,
        'names': names,
        'shorts': shorts,
        'links': {'s': src, 't': tgt, 'v': val, 'd': dep, 'n': neg},
    }


# --- HTML assembly ----------------------------------------------------------
def _read_asset(name):
    with open(os.path.join(ASSET_DIR, name), encoding='utf-8') as fh:
        return fh.read()


def _logo_data_uri():
    """The LEGACI mark, inlined so a generated page needs nothing from the net."""
    path = os.path.join(os.path.dirname(ASSET_DIR), 'gui_assets',
                        'legaci-mark-76.png')
    try:
        with open(path, 'rb') as fh:
            return ('data:image/png;base64,' +
                    base64.b64encode(fh.read()).decode('ascii'))
    except OSError:
        return ''          # dashboard.js hides the <img> when this is empty


def _plotly_tag(use_cdn):
    cdn_tag = ('<script src="https://cdn.plot.ly/plotly-3.0.1.min.js" '
               'charset="utf-8"></script>')
    if use_cdn:
        return cdn_tag
    try:
        from plotly.offline import get_plotlyjs
    except ImportError:
        print('  ! plotly is not installed — falling back to the CDN build.\n'
              '    Install it with:  pip install plotly')
        return cdn_tag
    return '<script type="text/javascript">' + get_plotlyjs() + '</script>'


def _json_for_script(value):
    """Serialize JSON safely for insertion inside an HTML script tag."""
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')) \
        .replace('</', '<\\/')


def render_dashboard(payload, out_html, initial, use_cdn=False):
    """Inline the template, styles, scripts, Plotly and the data into one file."""
    template = _read_asset('template.html')
    payload_json = _json_for_script(payload)

    output_dir = os.path.dirname(os.path.abspath(out_html))
    os.makedirs(output_dir, exist_ok=True)

    html = (template
            .replace('/*{{CSS}}*/', _read_asset('dashboard.css'))
            .replace('/*{{FLOWS_JS}}*/', _read_asset('flows.js'))
            .replace('/*{{DASHBOARD_JS}}*/', _read_asset('dashboard.js'))
            # the reader, the parser and the drop-in controller belong to
            # build_app.py; this build already has its data
            .replace('/*{{XLSX_JS}}*/', '')
            .replace('/*{{PARSE_JS}}*/', '')
            .replace('/*{{APP_JS}}*/', '')
            .replace('<!--{{PLOTLY}}-->', _plotly_tag(use_cdn))
            .replace('{{LOGO}}', _logo_data_uri())
            .replace('"{{PAYLOAD}}"', payload_json)
            .replace('"{{INITIAL}}"', _json_for_script(initial))
            .replace('"{{PALETTES}}"', _json_for_script(PALETTES))
            .replace('{{TITLE}}', escape(payload['meta'].get('title', 'Sankey'))))

    with open(out_html, 'w', encoding='utf-8') as fh:
        fh.write(html)

    size_mb = os.path.getsize(out_html) / 1_048_576
    print(f'  Wrote dashboard: {out_html}  ({size_mb:.1f} MB'
          f'{", Plotly from CDN" if use_cdn else ", Plotly inlined"})')
    return out_html


# --- main -------------------------------------------------------------------
def parse_args(argv):
    ap = argparse.ArgumentParser(
        description='openLCA contribution tree -> interactive Sankey dashboard.',
        epilog='Run with no arguments for the original interactive prompts.')
    ap.add_argument('xlsx', nargs='?', help='Excel contribution tree export')
    ap.add_argument('-o', '--out', help='output HTML file')
    ap.add_argument('--max-depth', type=int, default=DEFAULT_MAX_DEPTH,
                    help=f'deepest level to put in the payload '
                         f'(default {DEFAULT_MAX_DEPTH})')
    ap.add_argument('--levels', type=int, default=DEFAULT_LEVELS,
                    help='initial position of the Levels slider')
    ap.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                    help='initial position of the Threshold slider')
    ap.add_argument('--max-nodes', type=int, default=0, metavar='N',
                    help='initial node cap, keeping only the N largest '
                         "contributors (openLCA's own default is 25); "
                         '0 keeps everything')
    ap.add_argument('--pool', action='store_true',
                    help='start with small flows pooled into "other" nodes')
    ap.add_argument('--balance', action='store_true',
                    help='start with the "direct + unresolved" link switched on')
    ap.add_argument('--title', help='initial diagram title')
    ap.add_argument('--payload-min', type=float, default=0.0, metavar='PCT',
                    help='drop links below this %% of the root from the payload '
                         '(default 0 — keep everything)')
    ap.add_argument('--cdn', action='store_true',
                    help='load Plotly from the CDN instead of inlining it')
    ap.add_argument('--no-open', action='store_true',
                    help="don't open the result in a browser")
    return ap.parse_args(argv)


def prompt_for(args):
    """Original interactive prompts, used when no CLI arguments were given."""
    args.xlsx = ask('Excel contribution tree', DEFAULT_XLSX)
    args.out = ask('Output HTML dashboard', DEFAULT_OUT)
    try:
        args.levels = int(ask('Number of levels', str(DEFAULT_LEVELS)))
    except ValueError:
        print(f'  Invalid level count — using {DEFAULT_LEVELS}.')
    try:
        args.threshold = float(
            ask('Group flows smaller than this % of their parent',
                str(DEFAULT_THRESHOLD)))
    except ValueError:
        print(f'  Invalid threshold — using {DEFAULT_THRESHOLD}.')
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.xlsx is None:
        args = prompt_for(args)

    out_html = args.out or DEFAULT_OUT
    if not os.path.splitext(out_html)[1]:
        out_html += '.html'          # so it opens by double-click

    print(f'\nReading {args.xlsx} ...')
    try:
        df, header_row, impact, unit = read_sheet(args.xlsx)
    except Exception as exc:
        print(f'Error reading Excel file: {exc}')
        return 1

    raw_links, root_value, n_negative, deepest = parse_tree(
        df, args.max_depth, header_row=header_row)
    if not raw_links:
        print("No links parsed. Check the indentation and the 'Result' column.")
        return 1
    if n_negative:
        print(f'  {n_negative} negative flow(s) — shown in the negative colour.')

    max_depth = min(args.max_depth, deepest)
    source_name = os.path.basename(args.xlsx)
    title = args.title or (
        f'{impact} — contribution tree' if impact
        else f'{source_name} — contribution tree')

    meta = {
        'source': source_name,
        'impact': impact,
        'unit': unit,
        'rootValue': float(root_value) if root_value else None,
        'maxDepth': max_depth,
        'title': title,
        'generated': date.today().isoformat(),
    }
    payload = build_payload(raw_links, root_value, meta,
                            payload_min=args.payload_min)

    initial = {
        'levels': max(2, min(args.levels, max_depth + 1)),
        'threshold': args.threshold,
        'maxNodes': max(0, args.max_nodes),
        'smallMode': 'pool' if args.pool else 'all',
        'balance': bool(args.balance),
        'negativeColor': NEGATIVE_COLOR,
    }

    render_dashboard(payload, out_html, initial, use_cdn=args.cdn)

    n_links = len(payload['links']['s'])
    print(f'\n{n_links} links across {len(payload["names"])} processes, '
          f'depth 0–{max_depth}.')
    print('Open the panel on the right to change levels, pooling, colours, '
          'fonts and labels.')

    if not args.no_open:
        webbrowser.open(f'file://{os.path.abspath(out_html)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
