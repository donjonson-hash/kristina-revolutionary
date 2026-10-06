# Compare These Texts

Current CTT website and offline Chrome/Firefox extension source: **0.34.2**.
The same files in `src/` produce the website and both extension packages.
Documents are processed locally; extension manifests request no permissions or
host permissions. Website: https://comparethesetexts.com/.

## Fill printed PDF forms

In **Edit & export**, open a text-based PDF. Detected printed blanks are immediately highlighted: click and type, then move to the next field, **Print** or **Download PDF**. The app saves the active entry and fits its font size to the available width and line spacing. **Add text** places an entry anywhere; **Format** offers manual controls. Printing renders only final PDF pages, preserving the form artwork. Prepared PDFs keep a direct Save PDF to computer link in the editor, plus Download PDF in the print window, for browsers that decline automatic downloads. Added Cyrillic/Latin text remains searchable in downloads. Fields are saved with the local draft. After editing underlying source text, check existing field positions before exporting. Line detection is conservative; scans and interactive PDF widgets are not automatically filled. Short date blanks and underscore runs beside printed labels are supported.

## Source and release ownership

Use this directory for future CTT changes. The root `extension/` and
`static/reconciliation/` directories preserve the older 0.18.1 implementation
and its tests; they are not the source of current CTT releases. The Telegram
bot and `scout/` are independent products.

This import preserves the application assets from saved Site version 34,
source commit `60ad3bcea23c6539242a953f4591cd2fc5f4470e`. `provenance.json`
records every imported asset and the original published ZIP checksums.
It is a historical import record, not a claim about future deployments.
Importing code here does not change the deployed website.

`HISTORY.md` is the original development record. Its old workspace paths,
regeneration instructions and upstream references describe the earlier setup;
use the build commands below instead. Old localization/base-page generators
are deliberately not part of the release pipeline: they would overwrite the
current application with an earlier UI.

## Reproduce a release

Requires Node.js 24.15+ (24.x) or 26+, and Python 3.11 or newer, plus Git for revision metadata.

```sh
cd ctt
npm ci --ignore-scripts
npm run build
npm test
npm run check
```

Outputs:

- `dist/`: static website, including extension downloads.
- `dist/downloads/ctt-chrome-0.34.2.zip`: load the extracted directory in Chrome.
- `dist/downloads/ctt-firefox-0.34.2.zip`: temporary Firefox installation.
- `dist/release/provenance.json`: Git revision, working-tree status, asset hashes
  and ZIP hashes for that build.

`dist/`, installed dependencies and historical ZIPs are not committed. The
dedicated CTT GitHub Actions job builds and tests from a clean checkout and
uploads the generated website and extensions. Store publishing and website
deployment are separate actions; a successful CI run does not publish them.

## Development and audit scope

Edit `src/`, then rebuild before testing. Source is deliberately outside a
generated `dist/` directory so repository scanners can find it. Third-party
bundles and fonts are committed with their existing license/source notices;
do not replace them with Git LFS pointers. Large bundled assets still need a
separate dependency review even if a scanner skips them.

The lockfile includes the native canvas test dependency. PDF rendering tests
must not silently disappear because that dependency is missing. Tests use
synthetic fixtures and do not require private user documents or API keys.

The import preserves the behavior of the saved release. It does not certify
that every spreadsheet layout can be compared or every PDF can retain its
layout. In particular, merged/formula worksheets supported by the single-file
editor must not be described as supported by two-file comparison without a
separate verified change to that comparison path.
