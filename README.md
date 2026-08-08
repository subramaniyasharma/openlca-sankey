# openLCA Sankey

Generate a self-contained, interactive Sankey diagram from an openLCA
contribution-tree Excel export.

The result is a single HTML file containing the diagram, controls, and data.
It can be opened locally, shared with collaborators, or archived alongside a
research result without running a server.

## Features

- Explore contribution-tree depth with live level controls.
- Show, pool, or hide small flows relative to their parent.
- Inspect unbalanced trees or add a direct-emissions/unresolved remainder.
- Edit labels, colours, fonts, node positions, and annotations.
- Turn node labels to any angle between −90° and +90°, exports included.
- Export PNG, SVG, CSV, and reusable style settings.
- Use a numbered publication view with a process key.

## Quick start

Install the build-time dependencies:

```bash
python -m pip install -e ".[sankey]"
```

Export a contribution tree from openLCA, then generate the dashboard:

```bash
python generate_sankey.py contribution_tree.xlsx -o dashboard.html
```

Open `dashboard.html` in a browser. No Python runtime or web server is needed
to use the generated dashboard.

## Desktop app (Windows)

`sankey_gui.py` is a small desktop front end over the same script: pick the
workbooks, set the starting values, and it writes one dashboard per file.
Double-click **`Sankey dashboard.bat`**, or run it directly:

```bash
python sankey_gui.py
```

It uses only the standard library — Tkinter ships with the python.org Windows
installer — and calls `generate_sankey.main()` rather than reimplementing
anything, so the command line remains the reference path. See
[README_sankey.md](README_sankey.md#desktop-app) for what each field does.

The command-line interface also supports `--max-depth`, `--levels`,
`--threshold`, `--max-nodes`, `--pool`, `--balance`, `--title`, `--payload-min`,
`--cdn`, and `--no-open`. See [README_sankey.md](README_sankey.md) for the
complete reference.

## Input format

The parser is designed for the Excel file produced by openLCA's **Result →
Contribution tree → Export to Excel** workflow. It locates the `Processes`
header and the `Result [...]` column automatically, then reads the indentation
of the process columns to reconstruct the tree.

## Project structure

| Path | Purpose |
| --- | --- |
| `generate_sankey.py` | Reads the Excel export and packages the dashboard. |
| `sankey_gui.py` | Windows desktop front end over `generate_sankey.py`. |
| `Sankey dashboard.bat` | Double-click launcher for the desktop app. |
| `gui_assets/` | Logo art used by the desktop app. |
| `sankey_assets/flows.js` | The single browser-side flow pipeline. |
| `sankey_assets/dashboard.js` | Controls, rendering, editing, persistence, and export. |
| `sankey_assets/template.html` | Dashboard page structure. |
| `sankey_assets/dashboard.css` | Dashboard layout and styling. |
| `docs/` | Engineering handoff and development history. |

The Python layer parses and packages data. Flow calculations stay in
`sankey_assets/flows.js` so there is one implementation to maintain.

## Acknowledgments

See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the projects, libraries,
reference implementations, and tools that informed this work.

## License

This project is released under the [Community Research and Academic
Programming License (CRAPL)](CRAPL-LICENSE.txt). The CRAPL is intentionally
research-oriented and includes important conditions around publication and
modifications; read the license before using the software.
