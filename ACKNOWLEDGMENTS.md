# Acknowledgments

This project builds on the openLCA ecosystem and on widely used open-source
libraries. The following projects and tools deserve credit.

## Ecosystem and reference work

- [openLCA](https://www.openlca.org/) and [GreenDelta's olca-app](https://github.com/GreenDelta/olca-app): the contribution-tree export and Sankey concepts this project works with.
- [Fernando3161/openLCA_Sankey](https://github.com/Fernando3161/openLCA_Sankey): reference work considered for contribution-tree visualisation and label handling.
- [ankur-paan/openlca-sankey-plugin](https://github.com/ankur-paan/openlca-sankey-plugin): reference work considered for numbered process references, publication output, and presentation ideas.

These repositories informed design decisions and comparisons. This project is
not affiliated with them, and their licenses remain separate from this
repository's license.

## Software dependencies

- [Python](https://www.python.org/)
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

## License attribution

The [CRAPL](https://matt.might.net/articles/crapl/) was created by Matthew
Might. The complete license text is included in
[`CRAPL-LICENSE.txt`](CRAPL-LICENSE.txt).
