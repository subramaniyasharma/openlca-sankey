# Acknowledgments

This project builds on the openLCA ecosystem and on widely used open-source
libraries. The following projects and tools deserve credit.

## Laboratory

Developed for the **Laboratory for Eco-design, Green Chemistry And Circular
Innovation (LEGACI)** — <https://sites.google.com/mun.ca/legaci> — in the School
of Science and the Environment, Grenfell Campus, Memorial University of
Newfoundland, Corner Brook, NL.

The LEGACI logo in `gui_assets/` is the laboratory's own mark, taken from the
site above and used here with the laboratory's work; it is not covered by this
repository's license.

The dashboard's brand header, accent colour and depth palette come from the
lab's **LEGACI Sankey Mockups** in Claude Design ("Live dashboard UI mockups"),
which is built on the BEAS/Grenfell design system. That system's type pairing —
Calibri for the wordmark, Arial for functional labels — is followed through the
font stacks; the metric-compatible open-source substitutes it ships (Carlito,
Arimo) are named first in the stack but not fetched, because a generated
dashboard has to work with no network at all.

The desktop app's colours and typography follow the published Grenfell Campus
and Memorial University visual identity, but no Memorial trademark or logo file
is vendored here. Memorial's corporate typeface (Avenir) is licensed and is not
redistributed; the app falls back to faces installed with Windows. The official
Grenfell Campus logo is available from [Memorial's Marketing &
Communications](https://www.mun.ca/marcomm/memorials-brand/logos/grenfell-campus-logos/)
and can be dropped in as `gui_assets/grenfell-logo.png`.

## Ecosystem and reference work

- [openLCA](https://www.openlca.org/) and [GreenDelta's olca-app](https://github.com/GreenDelta/olca-app): the contribution-tree export and Sankey concepts this project works with.
- [Fernando3161/openLCA_Sankey](https://github.com/Fernando3161/openLCA_Sankey): reference work considered for contribution-tree visualisation and label handling.
- [ankur-paan/openlca-sankey-plugin](https://github.com/ankur-paan/openlca-sankey-plugin): reference work considered for numbered process references, publication output, and presentation ideas.

These repositories informed design decisions and comparisons. This project is
not affiliated with them, and their licenses remain separate from this
repository's license.

## Software dependencies

- [Python](https://www.python.org/) and its bundled Tk/Tkinter, which is the
  whole of the desktop app's runtime.
- [pandas](https://pandas.pydata.org/): tabular data handling.
- [openpyxl](https://openpyxl.readthedocs.io/): reading Excel workbooks.
- [Plotly](https://plotly.com/javascript/): rendering the generated Sankey
  diagram and producing image exports.

Plotly is sourced at build time and inlined by default. The optional `--cdn`
flag loads Plotly from the Plotly CDN when the generated page is opened.

## Development and validation tools

Development used standard Python tooling, a Chromium-based browser for
headless dashboard checks, and Git/GitHub for version control and distribution.
The project does not bundle or claim ownership of those tools.

## License and citation

This repository is released under the [MIT License](LICENSE). Citation
metadata is provided in [`CITATION.cff`](CITATION.cff), following the
[Citation File Format](https://citation-file-format.github.io/).
