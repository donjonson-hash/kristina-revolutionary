# Offline PDF assets

Generated for the extension on 2026-09-25. Runtime performs no downloads.

## Packages

- `@pdf-lib/fontkit` 1.1.1; integrity `sha512-KjMd7grNapIWS/Dm0gvfHEilSyAmeLvrEGVcqLGi0VYebuqqzTbgF29efCx7tvx+IEbG3zQciRSWl3GkUSvjZg==`
- `@pdf-lib/standard-fonts` 1.0.0; integrity `sha512-hU30BK9IUN/su0Mn9VdlVKsWBS6GyhVfqjwl1FjZN4TxP6cCw0jP2w7V3Hf5uX7M0AZJ16vey9yE0ny7Sa59ZA==`
- `@pdf-lib/upng` 1.0.1; integrity `sha512-dQK2FUMQtowVP00mtIksrlZhdFXQZPC+taih1q4CvPZ5vqdxR/LKBaFg0oAfzd1GlHZXXSPdQfzQnt+ViGvEIQ==`
- `esbuild` 0.25.10; integrity `sha512-9RiGKvCwaqxO2owP61uQ4BgNborAQskMR6QusfWzQqv7AZOg5oGehdY2pRJMTKuwxd1IDBP4rSbI5lHzU7SMsQ==`
- `pako` 1.0.11; integrity `sha512-4hLB8Py4zZce5s4yd9XzopqwVv/yGNhV1Bl8NTmCq1763HeK2+EwVTv+leGeL13Dnh2wfbqowVPXCIO0z4taYw==`
- `pdf-lib` 1.17.1; integrity `sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==`
- `tslib` 1.14.1; integrity `sha512-Xni35NKzjgMrwevysHTCArtLDpPvye8zV/0E4EyYn43P7/7qvQwPh9BGkHewbMulVntbigmcT7rdX3BNo9wRJg==`

`pdf-lib` and its `@pdf-lib/fontkit` browser distribution are bundled as ESM. All runtime dependency licenses and notices retained in PDF-LICENSES.txt. Fontkit's npm release declares MIT but does not include a separate LICENSE file; its package author/contributor attribution and MIT text are included, alongside embedded upstream notices. The prebundled fontkit includes Google Brotli code under Apache-2.0 (full license included).

## Reproduction

Use an empty temporary directory outside the repository:

```sh
npm install --prefix /tmp/kristina-pdf-vendor --no-audit --no-fund --save-exact pdf-lib@1.17.1 @pdf-lib/fontkit@1.1.1 esbuild@0.25.10
```

Copy `node_modules/@pdf-lib/fontkit/dist/fontkit.es.js` to `fontkit-csp.mjs` in that directory, applying exactly one replacement:

```js
// Original:
var functionBind = Function.prototype.bind || implementation$1;
// Modified:
var functionBind = Function.prototype.bind;
```

This removes the unused legacy dynamic Function constructor fallback from the minified bundle. Firefox 142+ / Chrome 120+ support native bind. No unsafe-eval permission is needed. Other fontkit code is unchanged.

Create `entry.mjs`:

```js
export {PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, rgb} from 'pdf-lib';
export {default as fontkit} from './fontkit-csp.mjs';
```

From the repository root:

```sh
/tmp/kristina-pdf-vendor/node_modules/.bin/esbuild /tmp/kristina-pdf-vendor/entry.mjs --bundle --platform=browser --format=esm --target=es2022 --minify --legal-comments=none --outfile=extension/pdf-vendor.mjs
```

Font: unmodified DejaVuSans.ttf, from `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`, upstream https://dejavu-fonts.github.io/. Font license is Bitstream Vera, with DejaVu changes in the public domain. The original font SHA-256 is `ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280`. The original bytes are standard base64 in `pdf-font.mjs`:

```python
from pathlib import Path
import base64
font = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf').read_bytes()
Path('extension/pdf-font.mjs').write_text('// Unmodified DejaVu Sans. License and provenance: PDF-LICENSES.txt / PDF-SOURCE.md\nexport default "' + base64.b64encode(font).decode() + '";\n')
```

Subsetting occurs per generated PDF. Unsupported glyphs and control characters use explicit readable escapes; JSON retains original text. There is no replacement font fetched at runtime.

## Shipped asset SHA-256

- `pdf-vendor.mjs`: `9a5b8b110c5e5d980d07a032616f1bf4bcd1228caf5696943507be4829182828`
- `pdf-font.mjs`: `04258f500ddb395dd8ea591988991a9547661da72aeb5a7d9b1870c01a44a30b`
- `PDF-LICENSES.txt`: `fd2d7a3a7dc64d3ff84c401ddf9d85b9373f6f4af01d1eeb659fd72ef23ba57c`

The report module limits serialized evidence to 16 MiB, rendered text to 1,000,000 UTF-16 code units (also checked after escape expansion), pages to 200, and final PDF to 16 MiB. Limits reject the whole export; no partial document is returned.
