"""
build_app.py — package the drop-in web build.

Produces one self-contained HTML file that reads any contribution-tree
workbook in the browser: no server, no upload, nothing to install for whoever
you send it to.  It is the same template, styles, flow pipeline and dashboard
the per-workbook script emits, plus the reader and the parser that Python
otherwise runs.

    python build_app.py                 # -> sankey_app.html, Plotly inlined
    python build_app.py --cdn -o app.html

The only build-time dependency is plotly, and only to source its bundle; drop
that with --cdn and the standard library is enough.
"""

import argparse
import json
import os
import sys
from html import escape

import generate_sankey as gs

DEFAULT_OUT = 'sankey_app.html'


def build(out_html, use_cdn=False):
    template = gs._read_asset('template.html')

    html = (template
            .replace('/*{{CSS}}*/', gs._read_asset('dashboard.css'))
            .replace('/*{{FLOWS_JS}}*/', gs._read_asset('flows.js'))
            .replace('/*{{DASHBOARD_JS}}*/', gs._read_asset('dashboard.js'))
            .replace('/*{{XLSX_JS}}*/', gs._read_asset('xlsx.js'))
            .replace('/*{{PARSE_JS}}*/', gs._read_asset('parse.js'))
            .replace('/*{{APP_JS}}*/', gs._read_asset('app.js'))
            .replace('<!--{{PLOTLY}}-->', gs._plotly_tag(use_cdn))
            .replace('{{LOGO}}', gs._logo_data_uri())
            # no data yet — the dashboard waits for app.js to hand it some
            .replace('"{{PAYLOAD}}"', 'null')
            .replace('"{{INITIAL}}"', 'null')
            .replace('"{{PALETTES}}"', gs._json_for_script(gs.PALETTES))
            .replace('{{TITLE}}', escape('openLCA Sankey')))

    left = [tag for tag in ('{{CSS}}', '{{FLOWS_JS}}', '{{DASHBOARD_JS}}',
                            '{{XLSX_JS}}', '{{PARSE_JS}}', '{{APP_JS}}',
                            '{{PAYLOAD}}', '{{INITIAL}}', '{{PALETTES}}',
                            '{{TITLE}}', '{{PLOTLY}}', '{{LOGO}}')
            if tag in html]
    if left:
        raise SystemExit('template placeholders left unfilled: ' + ', '.join(left))

    directory = os.path.dirname(os.path.abspath(out_html))
    os.makedirs(directory, exist_ok=True)
    with open(out_html, 'w', encoding='utf-8') as fh:
        fh.write(html)

    size_mb = os.path.getsize(out_html) / 1_048_576
    print(f'Wrote {out_html}  ({size_mb:.1f} MB'
          f'{", Plotly from CDN" if use_cdn else ", Plotly inlined"})')
    print('Open it in a browser and drop a contribution-tree .xlsx on it.')
    return out_html


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('-o', '--out', default=DEFAULT_OUT,
                    help=f'output HTML file (default: {DEFAULT_OUT})')
    ap.add_argument('--cdn', action='store_true',
                    help='load Plotly from the CDN instead of inlining it')
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)

    out = args.out
    if not os.path.splitext(out)[1]:
        out += '.html'
    build(out, use_cdn=args.cdn)
    return 0


if __name__ == '__main__':
    sys.exit(main())
