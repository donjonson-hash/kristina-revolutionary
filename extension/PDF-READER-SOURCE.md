# Offline PDF text reader

`pdf-reader-vendor.mjs` contains Mozilla PDF.js **6.3.289** (Apache-2.0),
bundled with esbuild **0.25.12**. The upstream license is retained verbatim in
`PDF-READER-LICENSE.txt`. This reader is separate from the pdf-lib report exporter.

Upstream: <https://github.com/mozilla/pdf.js>

API documentation: <https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html>

Package: <https://www.npmjs.com/package/pdfjs-dist/v/6.3.289>

Published package integrity:

```text
sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==
```

The build verifies both upstream source SHA-256 checksums and the dependency versions:

```text
build/pdf.mjs         495588717f62303a839e91a5343deebf1b41f52e2f9f6361e73dee6ea6a4355e
build/pdf.worker.mjs  f2870db902eaff8397442c912b69459980ac91f6f4b5ed827167b12cf7057930
pdf-reader-vendor.mjs dcd3cd61840406b08cef5c57dcd6552de5ee3be67e80e2c6314ecb427ac512aa
```

## Rebuild

From the repository root, with Node.js 24:

```sh
npm install --prefix /tmp/kristina-pdf-reader --ignore-scripts --no-audit --no-fund pdfjs-dist@6.3.289 esbuild@0.25.12
node scripts/build_pdf_reader_vendor.mjs /tmp/kristina-pdf-reader
```

The script bundles only `getDocument` and its local worker handler; no maps, fonts,
WASM, canvas packages, source maps or runtime downloads are included.
Every upstream patch must match exactly once or the build fails.

## Documented modifications

1. Disable the PDF.js worker's automatic global message listener. The existing
   application Worker retains its own listener. PDF.js uses its loopback protocol
   inside that Worker, so it does not create a nested Worker or import a remote script.
2. Retain upstream text extraction for raster XObjects and inline images: skip
   image content and recurse into Form XObjects for text. The earlier image rejection
   patches were removed in 0.10.0; image rendering and comparison are not requested.
3. Reject `ErrorFont`, graphic Type3 fonts and characters without a usable Unicode
   mapping, instead of silently dropping glyphs or substituting a raw PDF character code.
4. Limit a decoded stream buffer to 32 MiB before allocation and a single text
   fragment to 500000 PDF code units before conversion to glyphs.
5. Install non-enumerable compatibility methods only when missing:
   `Promise.try`, `Promise.withResolvers`, `Map.getOrInsert`,
   `Map.getOrInsertComputed` and `Uint8Array.toHex`. These cover newer built-ins
   exercised by the text-import path on the extension's supported browser versions.

No executable JavaScript from a PDF is evaluated. The bundle contains no `eval`
or dynamic `Function` constructor. `isEvalSupported: false` is supplied for clarity;
PDF.js 6.3.289 has already removed that dynamic-evaluation implementation.

## Extraction scope and limits

`pdf-source.mjs` supplies bytes directly and disables worker fetching, font faces,
system fonts, XFA, WASM, image decoding and canvas support. Its external-data factory
always rejects. A standard PDF font may use PDF.js's built-in encoding/metrics;
files requiring external CMaps or unusable font mappings fail.

Import is limited to 2 MiB, 100 pages, 2000 extracted lines, 500000 Unicode code
points, 100000 text items and 15 seconds per document. The existing application
Worker timeout is the outer bound for synchronous parser work. Decompression has
the independent per-stream limit above. The importer rejects encrypted documents,
forms, annotations (including links), attachments, optional-content layers and every
page with no usable text, even if other pages contain text. Text-bearing pages may
contain images; those images and any text within them are not compared. This scope
is stated in the result, office draft and exported reports. It does not perform OCR or render original pages.

Lines concatenate items in PDF.js source order and split at `hasEOL`. Since Form
XObjects can end without this marker, the importer also separates items by their
page-space geometry: a different baseline (over half the larger em, with a 0.5 pt
tolerance floor), a changed orientation (axis dot product below 0.999), or a gap
between advance intervals exceeding two em. Font changes alone are not boundaries.
Whitespace items retain their strings but do not replace the previous text geometry;
geometry resets on flush and on each page and persists across streamed chunks.
Vertical writing retains PDF.js boundaries. Missing/degenerate geometry causes
separation rather than guessing adjacency. This bounded, linear heuristic neither
sorts columns nor guarantees paragraph reconstruction; large superscripts and
widely spaced text may split. The application does not insert spaces or apply
semantic matching. `disableNormalization: true`
preserves PDF.js text output without its optional character normalization, but PDF
whitespace and reading order are reconstructed by PDF.js and are not guaranteed to
match the visual document. Source notes state this limitation. Replacement characters,
private-use mappings, unpaired surrogates and unsupported controls fail explicitly.

Validation uses independently authored Cyrillic PDF inputs, standard Helvetica,
fragmented text runs, text with raster/inline images, image-only and mixed scan
rejection, form rejection, invalid/password files,
Unicode rejection and page limits. A real Node Worker with browser-like globals,
no DOMMatrix, prohibited fetch/XHR/nested Worker stubs and removed compatibility
methods also exercised successful extraction and preserved the application listener.
This is a Worker protocol check, not a claim of native-browser visual verification.
