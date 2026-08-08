"""
verify_parse.py — check the browser parser against the Python one.

sankey_assets/parse.js is a port of generate_sankey.py, and a port is only
worth anything if someone keeps checking it.  This prints digests of the
payload the Python parser builds; the drop-in build prints the same digests for
the same workbook via `window.__lcaParityDigest(url, maxDepth, payloadMin)`.
Every line has to match.

    python tools/verify_parse.py contribution_tree.xlsx --max-depth 6

Floats are compared as 12-significant-digit exponential strings rather than
hashed raw: both sides hold IEEE-754 doubles, but Python and JavaScript disagree
about how to *print* them, and that difference is not a parsing bug.
"""

import argparse
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_sankey as gs  # noqa: E402


def canon(x):
    """A float rendering both languages can produce identically."""
    return f'{float(x):.11e}'


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def digest(payload):
    links = payload['links']
    return {
        'nodes': str(len(payload['names'])),
        'links': str(len(links['s'])),
        'names': sha('\n'.join(payload['names'])),
        'shorts': sha('\n'.join(payload['shorts'])),
        's': sha(','.join(str(i) for i in links['s'])),
        't': sha(','.join(str(i) for i in links['t'])),
        'd': sha(','.join(str(i) for i in links['d'])),
        'n': sha(','.join(str(i) for i in links['n'])),
        'v': sha(','.join(canon(x) for x in links['v'])),
        'rootValue': canon(payload['meta']['rootValue'] or 0.0),
        'unit': payload['meta']['unit'],
        'impact': payload['meta']['impact'],
        'maxDepth': str(payload['meta']['maxDepth']),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('xlsx')
    ap.add_argument('--max-depth', type=int, default=6)
    ap.add_argument('--payload-min', type=float, default=0.0)
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)

    df, header_row, impact, unit = gs.read_sheet(args.xlsx)
    raw_links, root_value, _negatives, deepest = gs.parse_tree(
        df, args.max_depth, header_row=header_row)
    if not raw_links:
        print('no links parsed')
        return 1

    meta = {
        'source': os.path.basename(args.xlsx),
        'impact': impact,
        'unit': unit,
        'rootValue': float(root_value) if root_value else None,
        'maxDepth': min(args.max_depth, deepest),
        'title': '',
        'generated': '',
    }
    payload = gs.build_payload(raw_links, root_value, meta,
                               payload_min=args.payload_min)

    print(f'\npython  {os.path.basename(args.xlsx)}  '
          f'max-depth={args.max_depth} payload-min={args.payload_min}')
    for key, value in digest(payload).items():
        print(f'  {key:<10} {value}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
