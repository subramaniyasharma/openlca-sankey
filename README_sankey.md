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
removing them; alignment; **side**; **orientation**; decimal places. Plus
free-text annotations.

**Label side** decides which side of its node a label sits on. Plotly makes that
call from the node's x position alone: anything past the middle of the figure
gets its label turned *inward*. For a contribution tree that is exactly wrong —
the deepest column is the one carrying the long ecoinvent names, and inward
means straight over the diagram. `Always right of the node` puts the end nodes'
labels out past the diagram and widens the right margin to hold them (capped at
45% of the width, since clipping one long name beats leaving no room to draw).

**Orientation** turns every node label about the point where it meets its node,
in 15° steps from −90° to +90°, so a narrow column can stand its labels upright
instead of truncating them. The canvas grows to fit the turned block.

Both survive into the PNG and the SVG — see [Restyled
labels](#restyled-labels) for why that needs its own code path.

**Colours** — light/dark/auto; four depth palettes; a colour picker per depth;
link colour by depth, source, target, magnitude or uniform; link opacity;
negative-flow colour; node border; background.

**Layout** — node placement (aligned to parent, value-weighted, even); snap, freeform,
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

### Restyled labels

Plotly's Sankey has no label angle at all, and no way to override which side a
label takes. What it does give us is one `<text x="0" y="0">` per label carrying
a `translate()` to the point where the label meets its node — so rewriting that
transform (and `text-anchor`) moves the label to the other side, and appending a
`rotate()` turns it about exactly the right pivot. Wrapped lines are tspans
inside the same element, so they follow either way. `applyLabelStyling()`
re-applies both after every draw, because Plotly rewrites the transform on each
one, node drags included — side first, since it replaces the transform outright
and would otherwise drop a `rotate()` already sitting on it.

Forcing a side means paying for it in margin: Plotly reserves nothing for label
text and will happily run a name off the edge of the figure. `labelRoom()`
estimates the widest label in the outermost column and `marginFor()` hands that
to the layout.

The catch is export. `Plotly.toImage` does **not** photograph the live DOM: it
rebuilds the figure from its spec into a throwaway div, which is a faithful copy
of everything Plotly knows about and nothing it does not. A rotation that only
exists in the SVG is therefore silently dropped from every PNG and SVG — the
worst kind of bug for a publication figure. So when the labels are restyled,
`exportImage()` asks Plotly for the SVG *string*, runs the same side flip and
rotation over it with `restyleLabelsInSvg()`, and then either saves that string
or rasterises it through an `<img>` and a canvas the way Plotly's own PNG path
does. Left alone, the whole detour is skipped and Plotly's `downloadImage` is
used unchanged.

For the same reason the modebar camera is removed while the labels are
restyled: it calls Plotly's own `toImage` and cannot know about any of this, so
leaving it there would hand out a quietly unstyled PNG. The panel's Export
buttons are the aware path.

### Label crowding

Two separate bugs used to make a dense diagram unreadable. Both are worth
knowing about, because both are Plotly behaviours rather than anything obvious
in this code.

**Node spacing is `node.pad`, not `node.y`.** Plotly's Sankey lays each column
out itself and treats supplied `y` values as a hint: on the reported figure
`positions()` asked for 41px between neighbours in the deepest column and Plotly
drew them 18px apart — exactly `node.pad` — with 32px of text in each. No amount
of arranging fixes that, because the number Plotly actually honours is the pad.
`effectivePad()` therefore raises the pad to the tallest label on the diagram,
and `autoHeight()` sizes the canvas with the same figure. The Node gap control
becomes a floor rather than the final word; where a column is too dense to space
even so, Plotly clamps the pad itself and the label cutoff and wrap width are
the remaining controls.

**`Plotly.react` strands old Sankey nodes.** It removes the previous data set's
node groups from an end-of-transition callback, so a second `react` arriving
before that callback runs leaves them in the DOM permanently. Dragging the
Levels slider is precisely that — one render per `input` event — and on a large
tree it left *hundreds* of stale labels piled over the real diagram while the
status bar honestly reported the small number the pipeline had produced. It
looks like a rendering bug in the flow pipeline and is not one.

`react` also never re-runs the Sankey layout: hand it new `node.x` / `node.y`
and it keeps the positions it worked out on the first draw. Switching Placement
therefore appeared to do nothing at all until something else happened to change
the node count — which is exactly the sort of thing that makes a layout look
unfixable when it is only unrefreshed.

`draw()` therefore compares a signature covering the node set *and* the
geometry against the last one drawn, and calls `Plotly.newPlot` when either has
changed, keeping `react` for style-only updates where its preserved hover and
drag state is worth having. `newPlot` purges the div's event listeners along
with its contents, so `bindPlotEvents()` re-attaches them on every full
redraw — miss that and node selection silently stops working after the first
data change.

### Placement, and why the default is Plotly's own

The diagram opens on **Aligned to parent**, which is Plotly's own Sankey layout
with no `x`/`y` supplied at all. It keeps a node inside the vertical span of the
ribbon feeding it, so the near columns read as straight bands.

The other two modes place each column against its own total and spread it over
the full height. That is genuinely useful for reading one column on its own, but
it also pulls children away from their parents: the same three depth-1 nodes sit
at 566 / 819 / 1075 px under the aligned layout and at 615 / 1927 / 2584 under
the value-weighted one. The second is the fan that made the first levels look
broken, and it used to be the default.

Worth stating plainly, since it cost a couple of wrong turns to establish: the
alignment problem was never Plotly's. Its layout does the right thing, and the
custom placement was overriding it.

Related: `applyLabelStyling()` refuses to touch a half-drawn diagram at all. It
writes to `transform`, which is the attribute those exit transitions animate, so
restyling mid-flight cancels the transition and strands the nodes by a second
route. It compares the node group count against the figure it built and waits
if they disagree.

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

## The LEGACI look

Both builds open branded, from the lab's Claude Design mockup:

* a header band — LEGACI mark, **LCA-Sankey Tool**, the lab's full name, an
  "Open source" tag, a Light/Dark pair and the source filename — over a 3px
  brand rule;
* the chrome accent (sliders, active segments, focus) in the lab's green,
  `#2f7d4f` light / `#4e9e6a` dark;
* a **LEGACI brand** depth palette, selected by default.

The header's Light/Dark buttons are a second face on the panel's Theme select
rather than a setting of their own, so the two cannot disagree. The mark is
inlined as a data URI and the webfonts are *not* fetched — the design system
ships Carlito and Arimo as metric-compatible stand-ins for Calibri and Arial,
and they are named first in the stack, but a generated dashboard is meant to
work with no network at all, and the machines this runs on have the real fonts.

### One caveat on the brand palette

The other depth palettes carry a note in `generate_sankey.py` recording what
the data-viz validator said about them. The LEGACI palette was put through the
same question and is the weakest of the usable three:

| Palette | normal | protanopia | deuteranopia |
|---|---|---|---|
| LEGACI light | 16.1 | 14.6 | **9.4** |
| LEGACI dark | 15.5 | **9.7** | 10.9 |
| categorical light | 43.2 | 14.8 | 17.2 |
| categorical dark | 41.4 | 14.7 | 18.4 |

(worst adjacent-depth CIEDE2000 separation, Brettel-style simulation)

It ships as the default anyway, because it is the branded look and the cost
lands on screen only: the publication preset switches to `print`, so a figure
for a paper is unaffected either way. For the most robust on-screen reading,
Colours → Palette → **Categorical**.

## The browser build

```bash
python build_app.py            # -> sankey_app.html
```

One HTML file that reads any contribution tree. Drop an `.xlsx` on it and the
reading, parsing and drawing all happen in the page: no server, no upload, and
nothing to install for whoever you send it to.

It is the same template, styles, flow pipeline and dashboard the per-workbook
script emits, plus three files Python otherwise stands in for:

| Path | Role |
|---|---|
| `sankey_assets/xlsx.js` | Reads the workbook |
| `sankey_assets/parse.js` | The contribution-tree parser, ported from `generate_sankey.py` |
| `sankey_assets/app.js` | Drop target, sheet picker, and the two ex-CLI flags |

**No spreadsheet library.** An `.xlsx` is a ZIP of XML, and the browser now does
both halves on its own — `DecompressionStream('deflate-raw')` for the archive,
`DOMParser` for the XML — so `xlsx.js` is ~250 lines rather than ~900 KB of
someone's general-purpose reader. It is deliberately partial: cell values only,
no styles, no dates, and no `.xls`, which is a different pre-ZIP format
entirely. It says so when handed one.

**Live where the script was fixed.** `--max-depth` and `--payload-min` are
baked in at generate time by the script; here the workbook is still in memory,
so both re-parse on the spot. A multi-sheet workbook gets a picker, and the app
opens on the first sheet that actually has a `Processes` header rather than
whatever is first.

**`dashboard.js` no longer starts itself.** It exposes
`LCADashboard.start(payload, initial, palettes)`; a per-workbook build inlines
its data as globals and calls it immediately, the drop-in build calls it per
file. A second file rebuilds the control panel from its original markup — which
drops that panel's listeners along with its nodes, rather than binding a second
set over the first — and every closure checks it is still the current
generation before drawing, so a superseded instance cannot paint over its
replacement.

### Keeping the port honest

`parse.js` is a port, and a port is only worth having if something keeps
checking it. `tools/verify_parse.py` prints digests of the payload the Python
parser builds; `window.__lcaParityDigest(url, maxDepth, payloadMin)` prints the
same digests from the browser. Every line has to match.

```bash
python tools/verify_parse.py contribution_tree.xlsx --max-depth 6
# then, in the app's console:
#   __lcaParityDigest('/contribution_tree.xlsx', 6, 0).then(console.log)
```

Floats are compared as 12-significant-digit exponential strings rather than
hashed raw: both sides hold IEEE-754 doubles, but Python and JavaScript disagree
about how to *print* them, and that is not a parsing bug.

The two currently agree exactly on node count, link count, the name list, the
resolved label list, all five link arrays and the root value, across a 3,688
link / 1,420 process export at depths 3 and 6, with and without a payload
floor.

Three places in the port are load-bearing and look arbitrary:

* a row's node cell must be a *string* — a number sitting in a name column is
  not a node, and treating it as one invents a branch;
* `path[depth]` is updated only for rows that survive the zero/NaN check, so a
  skipped row never becomes the parent of the rows beneath it;
* labels resolve in first-appearance order, because that is what decides which
  of two colliding names keeps the plain form and which becomes `#2`.

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
