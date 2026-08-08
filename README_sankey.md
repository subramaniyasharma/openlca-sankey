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
removing them; alignment; **orientation**; decimal places. Plus free-text
annotations.

Orientation turns every node label about the point where it meets its node, in
15° steps from −90° to +90°, so a narrow column can stand its labels upright
instead of truncating them. The canvas grows to fit the turned block, and both
the PNG and the SVG export come out rotated — see [Rotated
labels](#rotated-labels) for why that needs its own code path.

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
| `sankey_gui.py` | Desktop front end; shells out to `generate_sankey.main()` and owns no pipeline logic |
| `sankey_assets/flows.js` | The flow pipeline — level cut, aggregation, small-flow handling, node cap, prune, balance, cycle breaking |
| `sankey_assets/dashboard.js` | Figure building, controls, node inspector, annotations, export, persistence |
| `sankey_assets/template.html`, `dashboard.css` | Page shell and styling |

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

### Rotated labels

Plotly's Sankey has no label angle of its own, and there is no figure attribute
to set. What it does give us is one `<text x="0" y="0">` per label carrying a
`translate()` to the point where the label meets its node — so appending a
`rotate()` to that transform turns the label about exactly the right pivot, and
wrapped lines (tspans inside the same element) turn with it. `applyLabelAngle()`
re-applies it after every draw, because Plotly rewrites the transform on each
one, node drags included.

The catch is export. `Plotly.toImage` does **not** photograph the live DOM: it
rebuilds the figure from its spec into a throwaway div, which is a faithful copy
of everything Plotly knows about and nothing it does not. A rotation that only
exists in the SVG is therefore silently dropped from every PNG and SVG — the
worst kind of bug for a publication figure. So when the labels are turned,
`exportImage()` asks Plotly for the SVG *string*, runs the same rotation over it
with `rotateLabelsInSvg()`, and then either saves that string or rasterises it
through an `<img>` and a canvas the way Plotly's own PNG path does. At 0° the
whole detour is skipped and Plotly's `downloadImage` is used unchanged.

For the same reason the modebar camera is removed while the labels are turned:
it calls Plotly's own `toImage` and cannot know about the rotation, so leaving
it there would hand out a quietly un-rotated PNG. The panel's Export buttons are
the rotation-aware path.

`labelExtent()` sizes the canvas from the rotated bounding box
(`h·cos θ + w·sin θ`) rather than the line count, so upright labels get the room
they need. At 0° that expression collapses to the old line-stack height, and a
horizontal diagram is laid out exactly as it was before the control existed.

## Desktop app

`sankey_gui.py` is a Tkinter front end for people who would rather not open a
terminal. It queues up any number of workbooks — **Add files…**, or **Scan
folder…** to sweep a tree for `.xlsx` — and writes `<name>-dashboard.html` per
workbook into a folder you choose.

```bash
python sankey_gui.py
```

On Windows, `Sankey dashboard.bat` launches it with `pythonw` so no console
window trails behind it.

The fields map one-to-one onto the command line above, and every one of them
only sets where the dashboard *opens*: levels, threshold, colours and labels all
stay adjustable inside the page. Runs happen on a worker thread with
`generate_sankey`'s own output piped into the log pane, so a batch of large
workbooks does not freeze the window, and a workbook that fails to parse is
reported without taking the rest of the queue down with it.

Nothing about the pipeline lives here — the GUI builds an argument list and
calls `generate_sankey.main()`, so the script stays the reference
implementation and keeps working on its own.

Its look is set entirely by the `THEME` dict at the top of the file: a design
pass only has to touch that block and drop replacement art into `gui_assets/`.
The colours follow Grenfell Campus's own pages — white ground, `#393939` body
text, campus blue `#1e22aa` on the accents — and the type falls back through
faces actually installed on Windows, since Memorial's Avenir is licensed and
cannot be redistributed here. If you have the official Grenfell Campus logo,
drop it in as `gui_assets/grenfell-logo.png` and the header will pick it up; it
is deliberately not vendored.

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

The detailed harness commands below document the original development
verification run. Those harness files are not included in this compact public
distribution; use the generated dashboard's own controls and the Python syntax
check above for a quick local check.

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
