# Bundled XML parser

- Package: `@xmldom/xmldom`, pinned version **0.9.12**, MIT license in `XMLDOM-LICENSE.txt`.
- Official source: https://github.com/xmldom/xmldom
- Release: https://github.com/xmldom/xmldom/releases/tag/0.9.12
- Distribution: https://registry.npmjs.org/@xmldom/xmldom/-/xmldom-0.9.12.tgz
- Tarball SHA-256: `08245e18c248b957b4c6e07f8549ad5f55ae11b7a8abd4c1113a0fd61ddc67ee`.
- Bundle SHA-256: `11b7d8958a1f9e3758c861c7a40efd2dc55dedea62d427ec9ed1dd8bac27555c`.

`xml-vendor.mjs` exports `DOMParser`. It was bundled with esbuild 0.25.12:

```sh
# entry.js beside unpacked package/
printf '%s\n' "export { DOMParser } from './package/lib/index.js';" > entry.js
esbuild entry.js --bundle --format=esm --platform=browser --minify \
  --legal-comments=inline --outfile=xml-vendor.mjs
```

The bundle is checked in and loaded locally; installation and document comparison
need no runtime dependency downloads. Input explicitly rejects DTDs and custom
entities. Any XML parser warning/error stops import. ZIP expansion, XML size,
element count and depth, text characters and block counts are bounded separately.

DOCX extraction follows the main-document paragraph/run/text structure documented
by Microsoft: https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document
