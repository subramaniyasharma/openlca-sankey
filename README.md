# openLCA Sankey

Interactive Sankey diagrams from openLCA contribution-tree exports —
directly in your browser.

**[→ Open the tool](https://subramaniyasharma.github.io/openlca-sankey/)**

Upload an Excel file exported from openLCA's *Result → Contribution tree →
Export to Excel* workflow and explore it as a live, editable Sankey diagram.
No Python, no server, no installation required. The workbook is read, parsed
and drawn entirely in the page — nothing is uploaded, and whoever you send the
file to needs no network.

## Features

- Branded for LEGACI: header band, lab accent colour and brand depth palette.
- Explore contribution-tree depth with live level controls.
- Show, pool, or hide small flows relative to their parent.
- Inspect unbalanced trees or add a direct-emissions/unresolved remainder.
- Edit labels, colours, fonts, node positions, and annotations.
- Push the end nodes' labels out to the right of the diagram instead of over it.
- Turn node labels to any angle between −90° and +90°, exports included.
- Export PNG, SVG, CSV, and reusable style settings.
- Use a numbered publication view with a process key.
- Light/dark theme that follows your system preference.

## How it works

1. Open the tool in your browser.
2. Drop (or browse for) your `.xlsx` contribution-tree export.
3. The file is parsed **entirely in the browser** using native DOM decompression
   and browser APIs.
4. The interactive dashboard renders with [Plotly](https://plotly.com/javascript/).

Two things that were build-time flags in the old CLI are live controls here,
because the workbook is in memory: the payload depth cap, and the
percentage below which links are dropped. A workbook with several sheets gets a
sheet picker.

## Python tool

The original Python command-line tool and Windows GUI (`generate_sankey.py`, `sankey_gui.py`, etc.) that reads an
Excel export and packages a self-contained HTML dashboard are preserved in the
[`python-tool`](https://github.com/subramaniyasharma/openlca-sankey/tree/python-tool) branch.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | The standalone browser tool (hosted via GitHub Pages). |
| `sankey_assets/xlsx.js` | Minimal read-only `.xlsx` reader, no dependencies. |
| `sankey_assets/parse.js` | The contribution-tree parser. |
| `sankey_assets/app.js` | Drop-in build: file handling and sheet picking. |
| `sankey_assets/flows.js` | The single browser-side flow pipeline. |
| `sankey_assets/dashboard.js` | Controls, rendering, editing, persistence, and export. |
| `sankey_assets/template.html` | Dashboard page structure. |
| `sankey_assets/dashboard.css` | Dashboard layout and styling. |

*Note: The `index.html` file in this branch is pre-built from the `sankey_assets/`.*

## Acknowledgments

See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the projects, libraries,
reference implementations, and tools that informed this work.

## License

This project is released under the [Community Research and Academic
Programming License (CRAPL)](CRAPL-LICENSE.txt). The CRAPL is intentionally
research-oriented and includes important conditions around publication and
modifications; read the license before using the software.
