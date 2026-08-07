# Sankey dashboard

Turns an openLCA **contribution tree** Excel export into a single self-contained
HTML file: the diagram plus a control panel. No server, no `pip install dash`,
nothing loaded from the internet. Email the file and every tweak travels with it.

```bash
python generate_sankey.py "contribution_tree.xlsx" -o dashboard.html
```

Run it with no arguments and you get the original four prompts instead.

## Getting the input

In the openLCA desktop app, open a result → **Contribution tree** → export to
Excel. The script looks for the `Processes` header row and reads the tree from
the indentation in columns 0–5 and the `Result [...]` column.

## What the panel controls

**Data** — Levels (how many node columns); small flows (*Show all* / *Pool into
"other"* / *Hide*) with a threshold measured against each flow's **own parent**;
a max-node cap that keeps only the largest contributors; and whether to draw the
`direct emissions + unresolved` link that closes the root to 100%.

**Typography** — font family, base/label/title/hover sizes, label and title
colour, title text, alignment and weight.

**Labels** — name / name+% / % / **numbered** / none; short or full process name;
wrap width; truncation; a label cutoff that silences hairline nodes without
removing them; alignment; decimal places. Plus free-text annotations.

**Colours** — light/dark/auto; four depth palettes; a colour picker per depth;
link colour by depth, source, target, magnitude or uniform; link opacity;
negative-flow colour; node border; background.

**Layout** — value-weighted / even / automatic node placement; snap, freeform,
perpendicular or fixed dragging; node gap and width; height and width; margins.

**Selected node** — click any node to rename it, recolour it, hide its label, or
**detach the label** into an annotation you can drag anywhere and retype in
place. Dragged node positions stick until you reset them.

**Export** — PNG at 1–5×, SVG (real vector text), the flow table as CSV, the
style as JSON to reuse on another diagram, and a one-click publication preset
(print palette, white ground, numbered nodes with a key below the diagram).

Everything you change is remembered in the browser, per source file.

## Defaults that differ from the old script

The previous version always pooled sub-threshold flows into `"— other"` nodes
and always injected the `direct emissions + unresolved` link. Both are now
**off** by default, so the dashboard opens showing the tree as openLCA reported
it; simplification is something you switch on. (openLCA's own Sankey also
defaults to a cutoff of 0.)

## Where the logic lives

| Path | Role |
|---|---|
| `generate_sankey.py` | Reads the Excel tree at full depth, resolves display labels, writes the HTML |
| `sankey_assets/flows.js` | The flow pipeline — level cut, aggregation, small-flow handling, node cap, prune, balance, cycle breaking |
| `sankey_assets/dashboard.js` | Figure building, controls, node inspector, annotations, export, persistence |
| `sankey_assets/template.html`, `dashboard.css` | Page shell and styling |
| `tools/verify_flows.py` | The original Python pipeline, kept only to regression-check the JS port |

The flow pipeline lives in **one** place (`flows.js`) so there is nothing to
keep in sync. Python only parses and packages.

### Label rule

Labels are cut at the first `|` of the ecoinvent name. Names that collide get
their location appended, then a `#2`-style suffix if they still collide:

```
market for transport, freight, train, fleet average | ... | Cutoff, U - RoW
market for transport, freight, train, fleet average | ... | Cutoff, U - CN
  ->  market for transport, freight, train, fleet average (RoW)
      market for transport, freight, train, fleet average (CN)
```

Labels are resolved once over the **whole** tree, not per level, so a node keeps
its name as you move the Levels slider. The old script re-resolved per level, so
the same process could be labelled differently at 2 levels than at 4.

## Command line

```
python generate_sankey.py [xlsx] [-o out.html]
       [--max-depth 6]        deepest level put in the payload
       [--levels 2]           initial Levels slider position
       [--threshold 2.0]      initial threshold
       [--max-nodes 0]        initial node cap (0 = no cap)
       [--pool] [--balance]   start with those modes on
       [--title "..."]        initial title
       [--payload-min 0]      drop links below this % of the root from the payload
       [--cdn]                load Plotly from the CDN (~150 KB instead of ~5 MB)
       [--no-open]            don't open a browser
```

An output name with no extension gets `.html` appended.

## Requirements

`pandas`, `openpyxl`, `plotly` (only to source the Plotly bundle at build time —
the generated page has no Python dependency at all):

```bash
pip install -e ".[sankey]"
```

## Verifying a change to the pipeline

`flows.js` is checked against the original Python implementation, which is
preserved verbatim in `tools/verify_flows.py`.

```bash
# reference side
python tools/verify_flows.py contribution_tree.xlsx --levels 4 --threshold 0.5 \
       --full-labels 5 --out ref.json

# dashboard side: open the generated HTML with ?dumpFlows=1 and read #flow-dump
#   dashboard.html?dumpFlows=1&levels=4&threshold=0.5
# or in the console:  dumpFlows(4, 0.5)
```

The two must agree on flow count, node count, per-link values, pooled-node names
and the cycle-drop count. They currently match exactly (`max value delta 0.0`) at
levels 2/4/3 and thresholds 2.0/0.5/5.0.

Two deliberate differences, both switched off for the comparison:

* `--full-labels` makes the reference resolve labels over the whole tree, the way
  the payload does (see the label rule above).
* `dumpFlows` passes `prune: false`. The reference never pruned, and pruning is a
  fix rather than a port — see below.

### The detached-subtree fix

Pooling or hiding a flow strands whatever hung below it: the children stay in the
table but nothing reaches their parent, so Plotly draws a floating subtree that
looks like a real contribution. The original pipeline had this. On
`contribution_tree.xlsx` at six levels it left **1161 of 1664 flows (70%)
detached across 424 nodes**. `flows.js` now walks out from the root and drops
anything unreachable, and reports the count in the status bar. `Show all` never
strands anything, so it is a no-op there.
