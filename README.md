# openLCA Sankey

Interactive, publication-quality Sankey diagrams from openLCA contribution-tree Excel exports.

[Open the browser tool](https://subramaniyasharma.github.io/openlca-sankey/)

## Why this project exists

openLCA provides the data needed for contribution analysis, but the default Sankey presentation can be difficult to customize for a paper, report, or presentation. This project turns an openLCA contribution-tree export into a clear, editable diagram that is easier to explore and prepare for publication.

The goal is simple: make openLCA Sankey diagrams publication-quality, customizable, and easy to use without requiring a specialist dashboard setup.

## What it does

- Reads `.xlsx` contribution-tree exports from openLCA.
- Explores contribution depth, small-flow handling, root balance, and node limits.
- Customizes labels, fonts, colours, placement, annotations, and layout.
- Supports light and dark themes, including a publication preset with a process key.
- Exports PNG, SVG, CSV flow data, and reusable style settings.
- Lets users inspect and edit individual node labels and colours.

## Quick start

1. In openLCA, open a result and choose **Contribution tree → Export to Excel**.
2. [Open the tool](https://subramaniyasharma.github.io/openlca-sankey/).
3. Drop the exported `.xlsx` file onto the loading page, or choose it from the file picker.
4. Adjust the diagram with the controls panel and export the result.

## Local, private, and offline

The browser tool runs locally in the page. There is no application server, upload endpoint, database, or account required. The workbook is parsed in the browser and is not uploaded anywhere.

The generated dashboard can be made fully self-contained for offline use by
inlining Plotly (the default for `generate_sankey.py`). The lightweight public
`index.html` uses the Plotly CDN to keep the repository and first page load
small; its workbook parsing and Sankey processing still happen locally in the
browser. Use an inlined build when working in a network-restricted environment.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | **Generated** — the standalone browser tool served through GitHub Pages. Do not edit by hand. |
| `build.py` | Assembles `index.html` from `sankey_assets/`. Standard library only. |
| `sankey_assets/palettes.json` | Depth colour palettes inlined into the page. |
| `assets/legaci-logo.png` | Logo, inlined as a data URI at build time. |
| `sankey_assets/xlsx.js` | Minimal read-only `.xlsx` reader. |
| `sankey_assets/parse.js` | Contribution-tree parser. |
| `sankey_assets/app.js` | File loading, sheet selection, and loader error handling. |
| `sankey_assets/flows.js` | Single browser-side flow pipeline. |
| `sankey_assets/dashboard.js` | Controls, rendering, editing, persistence, and export. |
| `sankey_assets/template.html` | Source page structure. |
| `sankey_assets/dashboard.css` | Source layout and styling. |
| `CITATION.cff` | Machine-readable citation metadata. |
| `ACKNOWLEDGMENTS.md` | Projects, libraries, references, and tools credited by the project. |
| `LICENSE` | MIT open-source license. |

## Building

`index.html` is a build artifact, not a source file. Edit the files in
`sankey_assets/`, then regenerate it:

```bash
python build.py
```

To check that the committed page matches its sources, without writing
anything:

```bash
python build.py --check
```

Editing `index.html` directly will be overwritten by the next build, and edits
made only there are invisible to `sankey_assets/`. That is not hypothetical:
the credit footer's stylesheet and the loading-screen logo were both added to
the sources but missed in the page, and shipped broken until the build was
reintroduced.

### Enforcement

`--check` runs on every push and pull request via
[`.github/workflows/build-check.yml`](.github/workflows/build-check.yml), so a
stale page cannot reach `main` unnoticed.

To catch it before it leaves your machine, install the same check as a
pre-commit hook:

```bash
printf '#!/bin/sh\nexec python build.py --check\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Remove it with `rm .git/hooks/pre-commit`. Hooks are local and are not shared
by cloning.

## Python tool

The original Python command-line generator (`generate_sankey.py`) is preserved
in the [`python-tool` branch](https://github.com/subramaniyasharma/openlca-sankey/tree/python-tool).
The Windows GUI (`sankey_gui.py`), the packager and the parser parity harness
(`tools/verify_parse.py`) are not on that branch — they are on
[`test1`](https://github.com/subramaniyasharma/openlca-sankey/tree/test1).

## Citation

If you use openLCA Sankey in research, teaching, or a publication, please cite the project using [`CITATION.cff`](CITATION.cff). The file follows the [Citation File Format](https://citation-file-format.github.io/), which GitHub can use to display citation information for the repository.

## Acknowledgments

This project builds on openLCA, Plotly, Python tooling, and ideas from related open-source Sankey projects. See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the full list and the relevant links.

## License

This project is released under the [MIT License](LICENSE).

## Links

- [Repository](https://github.com/subramaniyasharma/openlca-sankey)
- [MIT License](https://github.com/subramaniyasharma/openlca-sankey/blob/main/LICENSE)
- [Citation File Format](https://citation-file-format.github.io/)
- [Subramaniyasharma on LinkedIn](https://www.linkedin.com/in/subramaniyasharma-sivaraman-1246827a/)
