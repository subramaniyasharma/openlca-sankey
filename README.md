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
| `index.html` | Standalone browser tool hosted through GitHub Pages. |
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

`index.html` is the checked-in browser build assembled from the files in `sankey_assets/`.

## Python tool

The original Python command-line tool and Windows GUI (`generate_sankey.py`, `sankey_gui.py`, and related files) are preserved in the [`python-tool` branch](https://github.com/subramaniyasharma/openlca-sankey/tree/python-tool).

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
