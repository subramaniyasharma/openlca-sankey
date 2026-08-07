# Sankey dashboard — engineering handoff

Engineering notes for contributors working on `generate_sankey.py` and
`sankey_assets/`. Written 2026-08-07 after the dashboard rebuild.

`README_sankey.md` is the **user**-facing doc. This is the **why**: decisions,
invariants, and the things that will look like bugs but aren't.

---

## 1. What this is

An openLCA *contribution tree* Excel export becomes **one self-contained HTML
file** — diagram plus control panel. No server, no Dash, nothing fetched at
runtime. It replaced a one-shot CLI that wrote a static `fig.write_html()` with
every colour, font, wrap width and filter frozen as a module constant.

The brief was: *"make it interactive and have tools to edit the labels placement
and colour and font change."* Followed by: *"have option to have unbalanced
sankey diagram. always no need to pool smaller flows."*

Three reference projects were supplied for inspiration and were read:
`Fernando3161/openLCA_Sankey`, `ankur-paan/openlca-sankey-plugin`, and openLCA's
own Java implementation (`GreenDelta/olca-app` → `.../results/analysis/sankey`).
What was taken from each is noted in §7.

## 2. Architecture

Python parses and packages. **The browser owns everything else** — including the
flow pipeline, so there is exactly one implementation of it and nothing to keep
in sync.

```
contribution_tree.xlsx
    │
    │  generate_sankey.py     read_sheet → parse_tree (FULL depth) → resolve_labels
    │                         → build_payload → inline into template
    ▼
dashboard.html  (one file; Plotly inlined ≈5 MB, or --cdn ≈110 KB)
    │
    │  flows.js       buildFlows(payload, opts) — the whole pipeline
    │  dashboard.js   figure building, controls, inspector, annotations, export
    ▼
Plotly.react(...)
```

| File | Role |
|---|---|
| `generate_sankey.py` | Excel → JSON payload → HTML. Parsing and label resolution only. |
| `sankey_assets/flows.js` | The flow pipeline. **Single source of truth.** |
| `sankey_assets/dashboard.js` | Figure builder, control wiring, node inspector, annotations, export, persistence. |
| `sankey_assets/template.html` | Page shell + all control markup. Placeholders: `/*{{CSS}}*/`, `/*{{FLOWS_JS}}*/`, `/*{{DASHBOARD_JS}}*/`, `<!--{{PLOTLY}}-->`, `"{{PAYLOAD}}"`, `"{{INITIAL}}"`, `"{{PALETTES}}"`, `{{TITLE}}`. |
| `sankey_assets/dashboard.css` | Shell + panel styling, light/dark. |
| `tools/verify_flows.py` | The **original** Python pipeline, preserved to regression-check the JS port. Nothing imports it at runtime. |
| `tools/*` | Verification harnesses — see §8. |

### Payload contract

Emitted by `build_payload()`, read by `flows.js`. Columnar to keep it small
(~150 KB for 3377 links).

```jsonc
{
  "meta":   { "source", "impact", "unit", "rootValue", "maxDepth", "title", "generated" },
  "names":  ["<full ecoinvent name>", ...],       // index-addressed
  "shorts": ["<resolved unique label>", ...],     // parallel to names
  "links":  { "s": [srcIdx], "t": [tgtIdx], "v": [pctOfRoot], "d": [depth], "n": [0|1] }
}
```

`v` is **already normalised to % of root** and carries **full float precision**.
Do not round it in Python — pre-rounding to 9 dp showed up as a ~5e-10 drift once
the browser summed the values. (`--payload-min` can prune tiny links, default 0.)

## 3. The flow pipeline (`flows.js`)

`buildFlows(payload, opts)` runs in this order. **The order matters.**

1. **aggregate** — cut to `0 < depth < levels`, map to `shorts`, sum duplicate
   `(source, target, depth)` triples, OR the negative flags. Then sort by
   `(source, target, depth)` to mirror pandas' `groupby` sort, because the next
   step walks the rows in that order.
2. **handleSmall** — `smallMode`:
   - `'all'` *(default)* — no-op, threshold inert
   - `'pool'` — roll sub-threshold flows into `"<parent> — other (N small flows)"`
   - `'hide'` — drop them
   Threshold is **% of the parent's own total**, never the root. Guards: never
   strip a parent of *every* child; pooling additionally needs ≥2 small flows
   (a one-member "other" node is silly) — that guard is pooling-only.
3. **limitNodes** — keep the N largest by inflow (root by outflow); roots always
   kept. `maxNodes: 0` disables.
4. **pruneUnreachable** — see §5, the one real bug fix. Skippable with
   `prune: false`, which only the regression harness does.
5. **handleBalance** — depth-1 children of an LCA tree don't sum to the root.
   The gap is **always computed and reported**; drawing it as a
   `direct emissions + unresolved` link is opt-in. Floor is
   `max(smallMode === 'all' ? 0 : threshold, 1e-6)` — the `1e-6` stops a
   numerically-zero gap creating a degenerate zero-width node.
6. **breakCycles** — not optional; Plotly's Sankey cannot render a cycle. Sorts
   by value descending (so the *smallest* offending edge is dropped) with a
   `(source, target)` tie-break for determinism.

Returns `{flows, depthOf, nodeTotals, incoming, outgoing, stats}`.

`depthOf` semantics are inherited from the original and must not "improve":
a **source** takes the first depth it is seen at (`setdefault`), a **target**
the last (plain assign). `nodeTotals` is a node's *inflow*, or outflow for the
root.

## 4. Decisions that must not be silently undone

**Defaults are OFF for both simplifications.** Small flows default to `Show all`,
balance defaults to `Unbalanced`. This was an explicit user instruction, and it
matches openLCA's own `SankeyConfig.cutoff = 0.0`. The old script always pooled
and always balanced.

**Labels are resolved once over the whole tree, not per level.** So a node keeps
its name as you move the Levels slider. The old code re-resolved per level, so
the same process could be `market for sulfuric acid` at 2 levels and
`market for sulfuric acid (RoW)` at 4. Cost: slightly more suffixing at shallow
levels. This is the *only* intended behavioural difference from the reference,
and `tools/verify_flows.py --full-labels N` exists to neutralise it when diffing.

**`edits: {...}` not `editable: true`.** The blanket flag also enables title
editing, which makes Plotly render a **"Click to enter Plot subtitle"**
placeholder under every title. Only annotation position/tail/text are enabled;
the title has a panel field.

**No `prompt()` / `alert()`.** Modal dialogs block in sandboxed contexts (and
hang headless runs). "Add free text" drops in an editable annotation instead;
errors go to the `#save-note` line. `confirm()` survives on *Reset all* only,
because that one is destructive.

**Palettes were validated, not chosen by eye.** See §6. Do not swap in
nicer-looking hexes without re-running the validator.

**Never cycle a palette.** A depth column past the last slot reuses the last
colour and the UI says so.

## 5. The detached-subtree fix

**This is the one genuine bug fix, and it changes output versus the original.**

Pooling or hiding a flow strands whatever hung below it: the children stay in the
table but nothing reaches their parent, so Plotly draws a floating subtree that
reads as a real contribution. The original pipeline had this. Measured on
`contribution_tree.xlsx`:

| mode | levels | threshold | flows | orphaned | detached nodes |
|---|---|---|---|---|---|
| all | 6 | 2.0 | 2614 | **0** | 0 |
| pool | 4 | 2.0 | 75 | 51 | 18 |
| pool | 6 | 2.0 | 1664 | **1161 (70%)** | 424 |
| hide | 6 | 2.0 | 1489 | 1080 | 435 |

`pruneUnreachable` walks out from the depth-1 sources and drops anything
unreachable, reporting `stats.detached`. `Show all` never strands anything, so
it is a no-op there — which is why the new default is clean.

Because the reference never pruned, `window.dumpFlows(...)` passes
`prune: false`, so the regression diff tests the *port* rather than two things
at once.

## 6. Palette validation (concrete numbers)

Node isn't installed on this machine, so the data-viz skill's
`validate_palette.js` was ported to `tools/validate_palette.py`. **The port was
verified first** by reproducing the skill's documented reference figures exactly
(adjacent CVD ΔE 9.1 light / 8.4 dark, normal-vision 19.6 / 19.3).

| Preset | Result |
|---|---|
| `categorical` *(default)* | PASS both modes. Worst adjacent CVD ΔE 9.1 light / 8.4 dark. Three light steps under 3:1 contrast — permitted by the relief rule, since a Sankey node always carries a visible direct label. |
| `depth-ramp` (blue) | PASS both modes as an ordinal ramp. **Capped at 5 steps** — six is mathematically impossible here: the ΔL ≥ 0.06 gate plus the 2:1 light-end floor leave only 9 usable grid steps, and 6 steps need a span of 10. |
| `print` (grayscale) | PASS both modes, recut per mode (the light cut fails on dark and vice versa). |
| `legacy` (the original `DEPTH_COLORS`) | **FAILS 3 checks** — lightness band and chroma floor (`#1B4F72`), and the normal-vision floor (`#17A589` vs `#2E86C1` = ΔE 14.4, under the 15 hard floor). Retained only to reproduce existing figures; the UI labels it as failing. |

Re-run: `python tools/validate_palette.py "#hex,#hex,..." [dark] [--ordinal]`.

## 7. What came from the reference projects

- **openLCA's own Java Sankey** — `SankeyConfig` defaults to `cutoff = 0.0` and
  `maxCount = min(techFlowCount, 25)`. That validated the `Show all` default and
  prompted the **Max nodes** control, which is the knob openLCA users reach for.
- **`ankur-paan/openlca-sankey-plugin`** — numbered process references with a
  key (long ecoinvent names never fit a figure column), independent font-size
  controls, high-scale PNG, and a grayscale publication theme. Became the
  `number` label mode + `#node-key` and the **Publication preset** button.
- **`Fernando3161/openLCA_Sankey`** — colour-by-magnitude and label shortening;
  both already had equivalents (`linkMode: 'magnitude'`, `truncate`).

## 8. Verification — all of it lives in `tools/`

Paths resolve via `tools/_paths.py`; override with `SANKEY_XLSX`, `SANKEY_DASH`,
`SANKEY_CHROME` env vars. The browser harnesses drive **headless Chrome** and
scrape the DOM, because no Node/Deno/Bun is installed on this machine.

| Harness | What it proves |
|---|---|
| `flows_test.html` | 58 assertions on `flows.js` against synthetic trees — balance, all three small-flow modes, pooling guards, parent-relative threshold, the prune, the node cap, level cuts, aggregation, negatives, cycles, node bookkeeping, determinism. Open in a browser, or `--dump-dom` it. |
| `compare_flows.py` | Diffs `flows.js` against the preserved original (`verify_flows.py`) at 3 level/threshold combinations. **Currently identical, `max value delta 0.000e+00`.** |
| `check_defaults.py` | The new `Show all` + `Unbalanced` paths against an independently-computed aggregate straight from the payload. |
| `ui_suite.py` | Drives **all 45 controls** in a real browser and fails on any console error. `python ui_suite.py col-` runs a subset. |
| `drive.py` | The driver `ui_suite` builds on — injects a script, screenshots, reports errors. Useful standalone for eyeballing one setting. |
| `shot.py` | Plain screenshot of the dashboard. |
| `validate_palette.py` | The colour checks (§6). |

Status at handoff: **all green** — 58/58 unit, 3/3 regression identical, defaults
pass, 45/45 controls clean.

### Known verification gap

SVG **download** was not exercised end-to-end: headless Chrome won't exit with a
pending SVG blob download. The render path underneath it *was* verified —
`Plotly.toImage(gd, {format:'svg'})` returns a 216 KB vector data URI, and PNG at
3× returns 3.5 MB. PNG download runs clean. Click **SVG** once manually.

## 9. Gotchas

- **`contribution_tree.xlsx` balances exactly** (gap ≈ 1.5e-8 %). The balance
  feature cannot be exercised on it at all — `flows_test.html` uses a synthetic
  unbalanced tree, which is the normal LCA case. Don't conclude balancing is
  broken because this file shows no difference.
- **`levels` means node columns**, and the filter is `depth < levels` — inherited
  from the original's `0 < depth < max_levels`. `levels = 2` draws depths 0 and 1.
- **`parse_tree` ordering is load-bearing**: `path[depth]` is updated *after* the
  zero/NaN result check. That is why filtering a full-depth parse by
  `depth < levels` reproduces the old per-level gate exactly.
- **Auto-height sizes to the tallest column's label *stack***, not its node count
  — a two-line wrapped label needs twice the room. Guessing on node count is what
  produced the old 6840px files that still had labels touching.
- **Node drags are captured** from `plotly_restyle` into `state.nodePos` so they
  survive re-renders. "Reset dragged positions" clears them.
- **Annotation placement** reads the rendered node's `getBoundingClientRect()`
  against `gd._fullLayout` (a private field) and converts to paper coords. If a
  Plotly upgrade breaks it, the fallback is the plot centre — and annotations are
  draggable, so it degrades rather than fails.
- `dashboard.js` and `flows.js` are deliberately **ES5** (`var`, no arrows) so the
  generated file works in older browsers and plain script hosts.
- `--no-open` with no positional xlsx still triggers the interactive prompts;
  that's the intended fallback.

## 10. Suggested next steps

- Wire the openLCA IPC path (`openlca_ipc/contributions.py`) straight into
  `build_payload`, so the dashboard can be generated without the manual Excel
  export.
- A legend / colour key for the depth palette — there is none today.
- Per-node font size needs the annotation path, because Plotly's Sankey
  `textfont` is trace-wide. Already possible via "Detach label"; not exposed as
  a per-node control.
- `docs/SANKEY_SESSION_LOG.md` is the filtered transcript of the build session if
  more detail is ever needed.
