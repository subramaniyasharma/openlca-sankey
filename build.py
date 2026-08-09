"""
build.py — assemble index.html from sankey_assets/.

index.html is a build artifact, not a source file. It used to be edited by
hand alongside the assets it duplicates, which meant every change had to be
made twice and stay in step; the credit footer's CSS was added to
dashboard.css and missed in index.html, so the footer shipped unstyled.

    python build.py            # regenerate index.html
    python build.py --check    # fail if index.html is stale (CI / pre-commit)

Standard library only, so it runs anywhere Python does. Nothing to install.

Editing rule: change the files in sankey_assets/ and rerun this. Never edit
index.html directly — the next build overwrites it.
"""

import argparse
import base64
import difflib
import json
import os
import sys
from html import escape

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, 'sankey_assets')
OUT = os.path.join(ROOT, 'index.html')

TITLE = 'openLCA Sankey'
LOGO = os.path.join(ROOT, 'assets', 'legaci-logo.png')

# Kept as a CDN tag rather than inlined: it is ~3.5 MB, and the page is served
# from GitHub Pages where a cached CDN copy is the better trade. README says so.
PLOTLY_TAG = ('<script src="https://cdn.plot.ly/plotly-3.0.1.min.js" '
              'charset="utf-8"></script>')


def read(name):
    with open(os.path.join(ASSETS, name), encoding='utf-8') as fh:
        return fh.read()


def json_for_script(value):
    """Serialise JSON safely for insertion inside a <script> tag."""
    return json.dumps(value, ensure_ascii=False,
                      separators=(',', ':')).replace('</', '<\\/')


def logo_data_uri():
    """The LEGACI mark, inlined so the page pulls no image over the network."""
    try:
        with open(LOGO, 'rb') as fh:
            return ('data:image/png;base64,' +
                    base64.b64encode(fh.read()).decode('ascii'))
    except OSError:
        return ''          # app.js hides the <img> when the src is empty


def render():
    with open(os.path.join(ASSETS, 'palettes.json'), encoding='utf-8') as fh:
        palettes = json.load(fh)

    html = (read('template.html')
            .replace('/*{{CSS}}*/', read('dashboard.css'))
            .replace('/*{{FLOWS_JS}}*/', read('flows.js'))
            .replace('/*{{DASHBOARD_JS}}*/', read('dashboard.js'))
            .replace('/*{{XLSX_JS}}*/', read('xlsx.js'))
            .replace('/*{{PARSE_JS}}*/', read('parse.js'))
            .replace('/*{{APP_JS}}*/', read('app.js'))
            .replace('<!--{{PLOTLY}}-->', PLOTLY_TAG)
            .replace('{{LOGO}}', logo_data_uri())
            # no workbook yet — app.js hands the dashboard its data on drop
            .replace('"{{PAYLOAD}}"', 'null')
            .replace('"{{INITIAL}}"', 'null')
            .replace('"{{PALETTES}}"', json_for_script(palettes))
            .replace('{{TITLE}}', escape(TITLE)))

    left = [tag for tag in ('{{CSS}}', '{{FLOWS_JS}}', '{{DASHBOARD_JS}}',
                            '{{XLSX_JS}}', '{{PARSE_JS}}', '{{APP_JS}}',
                            '{{PLOTLY}}', '{{LOGO}}', '{{PAYLOAD}}',
                            '{{INITIAL}}', '{{PALETTES}}', '{{TITLE}}')
            if tag in html]
    if left:
        raise SystemExit('template placeholders left unfilled: ' +
                         ', '.join(left))
    return html


def current():
    try:
        with open(OUT, encoding='utf-8') as fh:
            return fh.read()
    except OSError:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--check', action='store_true',
                    help='exit non-zero if index.html differs from a fresh '
                         'build, without writing anything')
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)

    html = render()
    existing = current()

    if args.check:
        if existing == html:
            print('index.html is up to date.')
            return 0
        print('index.html is STALE — it does not match sankey_assets/.\n'
              'Run `python build.py` and commit the result.\n')
        diff = difflib.unified_diff(
            (existing or '').splitlines(), html.splitlines(),
            fromfile='index.html (committed)', tofile='index.html (rebuilt)',
            lineterm='', n=1)
        for i, line in enumerate(diff):
            if i > 60:
                print('  … diff truncated')
                break
            print('  ' + line[:140])
        return 1

    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(html)
    size = os.path.getsize(OUT) / 1024
    print(f'Wrote {os.path.relpath(OUT, ROOT)}  ({size:.0f} KB)')
    if existing is not None and existing != html:
        print('  (contents changed — review the diff before committing)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
