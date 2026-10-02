# CTT · Compare These Texts

English document comparison and editing for the US market.

Brand: **CTT · Compare These Texts**
Descriptor: **Compare & Edit**
Promise: **See the difference. Make it right.**

Routes: /, /extension/, /privacy/, /support/. Current English Chrome/Firefox beta packages are version 0.33.6, served from /downloads/. release.json is the release metadata source. Older URLs remain available for compatibility. The historical Kristina 0.18.1 builder is not the source of this release. Store materials are in release/0.33.6/.

## Runtime

The dist directory is the deployable, tracked static source. Documents are processed by the local worker. No document upload endpoint exists: CSP disallows network connections and the server fallback has been removed. IndexedDB work is separate for each website/extension origin.

Based on Kristina 0.18.1, base engine commit 655d0bf151cbe088abcc802959b6610c011dd1c4. Internal module names, stored-work schema, Firefox extension ID, comparison algorithms, and input-language aliases are retained. User document contents are never translated. UI, assistant answers, errors, location labels, and generated reports are English. The assistant recognizes both English and Russian requests. Only the sample data uses USD; uploaded currencies are not converted.

## Maintenance

Localization catalogs are in locales/, including intentionally preserved input aliases and English assistant intent patterns. scripts/localize_js.cjs applies translations to JavaScript string literals/template chunks via AST, not to user data or regexes. scripts/localize_html.cjs handles page text and accessible attributes. scripts/finalize_english.py applies locale-specific question parsing, sample data, exact-string number formatting, and export filenames.

When upgrading the engine, regenerate/review the catalogs for new source strings; do not overwrite English assets with an untranslated build. The legacy scripts/prepare_site.py prepares the Russian base pages only. After copying fresh extension engine assets, run base preparation, both localization scripts, and finalization, then regenerate packages with python3 scripts/package_extension.py. Keep the CTT SVG/PNG mark and site.css.

Development-only dependencies: npm install, then npm test and npm run check. Publishing static assets needs no dependency installation or build step. Extension package source is in extension-package/; no browser permissions are added.

## Extension feature parity

The website includes the complete PR 50 (0.18.0) document engine: full A/B documents, editing either version, copying cell text, adding/deleting Word rows, transferring newly added rows, replacing an existing row's text, independent undo, local session restoration, and document export. Original formatting/images follow the same supported limits as the extension. CSV/Excel reconciliation remains its separate workflow.

The primary example now opens actual Word documents with a heading, embedded CTT logo and table, using the same worker and editor as uploaded files. The secondary CSV/Excel example preserves the original table reconciliation demo. Generate the embedded local documents with `node scripts/generate_document_demo.mjs`. No sample document fetch is required.

If the full editor cannot load, the website shows a retry action and retains the selected files; it no longer silently switches to the legacy excerpt editor. These improvements are included in extension release 0.20.0.

Downloads capture the selected version at the moment of the click. Later edits remain in the editor and trigger a clear invitation to download the latest version; switching comparisons cancels the pending download. DOCX text and row layout are captured together. PDF edits follow the same rule.

Autosave drains edits that arrive at the completion boundary of a previous transaction. Waiting for a save or finishing a session includes that last queued write. Controlled storage tests cover this timing boundary, reopening the committed session, failure/retry, and deletion after queued writes; browser IndexedDB itself is unchanged.

## Guided review

Start review selects the first pending difference. Use A copies that fragment into B; Keep B accepts the current difference; editing remains available in both columns, with Done advancing when review is active. Reviewed N of total includes resolved differences and explicit decisions, so completion does not require identical documents. A completed review exposes Download reviewed B. Whole-row transfers advance after resolving all affected cells. Unsupported cell transfers keep the existing row controls.

Review decisions are saved with the local session and tied to exact current content/order. Editing either side reopens affected decisions. New differences enter the queue; deleted temporary rows do not leave stale entries. Document-level order/layout differences require a separate Keep B layout decision. Undo decision works within the current view; manual document edits invalidate that decision undo chain to preserve newer edits. After reload, accepted differences can be reopened with Review again, and document undo remains available. Old saved sessions load without review metadata.

## Assistant panel

The website opens the assistant from Explain changes above the documents. At widths of 1500px and above, the 400px panel sits beside both documents; below that it follows them. Selection explanations read the current drafts and update after editing or undo. General questions and email drafts still use the original report, explicitly labeled after edits. The 0.20.0 extension packages include the same assistant panel and current document context.

## Verification

Targeted tests cover the real worker/UI demo, English assistant actions and negation, preservation of Russian source content and aliases, DOCX table edit/export/reopen, HTML/XLSX/PDF report language, exact numbers, and fail-closed transport errors. Assistant tests also cover panel focus/closing/reset and live selection updates through edit, copy, undo and deselection. DOM integration now loads the actual module graph in the page realm, with native crypto/compression and the real comparison worker. It covers the Word demo, cell and row operations, exported DOCX reopening with an image, and an injected module-load failure followed by retry. This is not browser layout/CSP verification. Static checks validate links, packaged extension assets, manifests, and JS syntax. Release checks compare every runtime asset in the current Chrome/Firefox ZIPs against the website and run the Word review/export flow using the extracted archives. Browser installation and browser CSP enforcement still require manual verification.

Browser visual QA and validation in a supported WebMCP browser context were unavailable in this managed static-site environment. The optional read-only WebMCP status tool is feature-detected and does not affect comparison.

Upstream extension source: https://github.com/donjonson-hash/kristina-revolutionary

## Spreadsheet editing and PDF status (0.21.0)

CSV and the selected XLSX sheet now open as complete cell grids, paged in 50-row windows, with both versions editable. Matched and unchecked cells remain visible. Cell edits are explicitly applied; type choices preserve text/number/boolean semantics. Use A/Keep B works per checked cell; a missing row is copied explicitly, appended without shifting existing workbook references. Whole-row copy requires corresponding columns. Undo, source downloads, local session restoration and content/type-sensitive review decisions are supported. Rows remain paired by the original comparison identifiers during editing. Copied dates and zero-padded identifiers use their normalized text value to avoid date-epoch and leading-zero changes.

XLSX export patches changed worksheet XML in the original archive, retaining styles, images and other sheets. Other sheets containing formulas are marked for recalculation on opening in Excel. The selected-sheet input limits remain: values-only, unique headers, no merged cells. Other sheets are retained, not compared; images/charts are not rendered in the grid. CSV preserves exact string data, delimiter, BOM and line-ending style.

PDF supports page view and editable text view. Geometry and backgrounds on all changed pages are checked before offering edited PDF download. Since 0.23.0, edits outside these bounds can be downloaded as a reformatted text PDF (see below). Rendering failure falls back to full editable text. Edited PDF output is flattened and gets a regenerated text layer; existing line-area fit/rotation/background limits remain. Native-canvas regression tests render a real two-page PDF, reopen the edited export, and check invalid→valid edits and page navigation. This is not an installed-browser test.

## 0.21.1 — Insert copied spreadsheet rows in place

Missing CSV/XLSX rows now follow their source neighbors instead of being appended. Existing target rows and edits shift together; row pairing, undo and saved review drafts track the new positions. XLSX export moves row formatting and updates cell references, filters, named ranges, table ranges and drawing anchors. Legacy VML anchors remain unsupported for structural insertion. Existing formula-free selected-sheet comparison limits still apply.

Regression coverage includes the demo's OLD-400 row at row 5, out-of-order insertion of several missing rows, undo/restoration, edited shifted cells, exported CSV ordering and XLSX styles/references.

## 0.22.0 — Final check of current edits

Both full-document and spreadsheet reviews have Check again. The result distinguishes no remaining differences within the checked scope, outstanding differences, and differences deliberately kept. Navigation opens the next outstanding item; Download updated B preserves existing PDF layout validation and offers reformatted PDF when needed. New edits, decisions and undo invalidate the result; restored sessions retain decisions but require a fresh check. Spreadsheet Check again atomically applies visible cell inputs before checking; invalid typed input cannot produce a successful result.

The scope is visible under What was checked: documents check current text/order and supported Word table structure; spreadsheets check current paired rows and selected columns using the existing comparison rules. Spreadsheet headers, unchecked columns, row order and formatting are outside that check; row keys are not rematched. Images and page appearance are not compared. Original reports remain original evidence.

## 0.23.0 — PDF editing beyond the original line box

PDF drafts can be saved after long replacements, explicit newlines, additions, deletions and reordered sections. Edits that fit retain the existing original-page renderer. Others use a clearly labeled reformatted PDF containing the current text in draft order, with readable wrapping and automatic page breaks. Original images and formatting are not included in this alternative. Overflow automatically opens editable text; original pages remain available for reference. TXT download remains optional.

Exports capture the clicked revision, keep original text out of the replacement PDF, and cancel during long single-section reflow. Regression checks reopen generated PDFs, inspect page bounds, retain Cyrillic and long words, validate current entry order and final-page text, and cover immediate continued edits during download plus return to the original-layout mode.

## 0.24.0 — PDF expansion with original images and page artwork

The main PDF download now preserves untouched page pixels, including photos, logos, headings and graphics, while changed text wraps inside its original horizontal area. It inserts vertical space, shifts following content and adds pages at cuts that avoid text and image bounds. Unchanged and replaced text receive a searchable text layer; source PDF objects are not embedded. Dense adjacent edits flow sequentially; full-width color bands are retained. Changed text uses the bundled font at the measured source size and sampled color.

Supported expansion requires reliable text coordinates, an identifiable uniform text background and an unchanged source section order. Images crossing a changed horizontal band, text/image overlap, unsafe cuts, rotated edits and section rearrangement can require the explicit Download text-only PDF alternative in the per-document menu. Preserving export failures do not silently discard images. The text-only alternative remains available separately even while original-layout validation is pending. Original page view remains the reference preview for an expanded export.

Native-canvas integration covers exported image pixel preservation on a single page, unchanged blue heading and full-width footer, multi-page text expansion and rereading, adjacent edited lines without overlap, enclosed-image rejection, clicked-revision capture, original-layout recovery and the explicit text-only button.

## 0.24.1 — Edited PDF pages visible in the comparison

Large edits now regenerate the displayed PDF in both document columns instead of automatically switching to unformatted text. The preview and preserving download use identical generated bytes for the selected revision. Hotspots follow edited and unchanged text onto new pages; inserted sections retain their own keys. Navigation, selection, restoration and returning to original layout use the current page geometry. Text view remains an explicit choice; unsupported layouts visibly fall back to editable text without discarding edits.

Preview work is cached by draft revision, canceled on newer edits and disposed with the review. Tests exercise the actual A/B editor with native Canvas: overflow remains a selectable rendered page, generated-page navigation/restoration, quick subsequent edits, returning to original layout, disposal during generation and source-key mapping. Existing export tests retain image and colour checks. This does not replace installed-browser visual verification.

## 0.25.0 — Document / Text / Preview PDF

PDF columns now use a two-button Document / Text view switch with accessible pressed state. Text view explains that original images remain attached and offers Preview PDF. The primary download stays labeled Download PDF; text-only exports are explicitly marked as excluding images and page formatting. Switching views and downloading text-only output do not mutate the working draft or its undo history.

Confirmed layout failures show a plain-language reason and Undo last edit, Continue editing and Download text-only PDF actions. Original-layout overflow alone is not treated as failure. Preview PDF retries failed generation without discarding the draft; changes following automatic fallback retry document rendering. Known failures disable the preserving download until recovery, including the guided-review download. Export failures use the same recovery controls.

Native Canvas integration tests cover Text editing followed by an image-preserving preview, view state and unchanged undo history, section-reorder failure, explicit retry, focus for continued editing, text-only download and undo back to the original PDF.

## 0.25.1 — Complete text bounds on flattened PDFs

Some PDFs store a page image plus an invisible text layer whose substitute font is narrower than the visible lettering. Selection and erasure now refine such line bounds against the original page pixels, with uniform-background checks, neighboring-line boundaries, clear gutters and conservative rejection of ambiguous continuation or decoration. Corrected bounds are shared by highlights, edit fit checks and exports, and are rebuilt for restored comparisons without changing text drafts or undo history. Vector text outside raster artwork retains its existing geometry.

Regression coverage uses a synthetic flattened PDF with tracked visible lettering and a narrower invisible layer. Tests confirm complete pixel erasure including the suffix, preserved neighboring text, corrected selection after restore, and refusal to consume a nearby rule or ignore an unresolved spaced suffix. The two reported headings were also checked locally against the supplied source PDF and the rendered edited page. Private source files are not included in the repository.

## 0.26.0 — Replace block in PDFs

Selected single-source PDF blocks now offer Replace block: a staged text editor, page preview, draggable/keyboard-resizable lower-right corner, numeric dimensions, Apply and Cancel. Changes to text and dimensions commit together and survive local session restore; one undo restores both. Preview uses the same bounded PDF renderer as download, including other current edits. A stale proposal cannot be applied. Replacement hotspots follow the new area.

Replacement text retains the source font size and sampled color, uses the bundled replacement font, and wraps within a fixed top-left-anchored box. The original block must be completely covered; the replacement must stay on the page and may not overlap neighboring text, images, or nonuniform extra space. Flattened page images remain supported where the visible bounds and plain background can be resolved. Multi-source selections, rotated/ambiguous text, and combined page-reflow plus fixed replacement blocks remain unsupported, with explicit feedback.

Native Canvas integration covers staged cancellation, two-line Apply, session restore, preserving export with no old text, one-step undo, neighbor/image collision refusal, and explicit rejection of mixed reflow.

## 0.26.1 — Apply for names beside a PDF list

Fixes replacement blocks rejected because raster-only bullets in an adjacent column were mistaken for a possible continuation of the name. Only repeated compact markers aligned with distinct known text rows qualify; isolated marks, bars and ambiguous suffixes still fail closed. Bounds version2 rechecks older uncertain reports.

Block dialogs start at one-line height, leave room for neighboring list markers, and offer automatic text fitting (at most20% below the source size) plus an explicit text-size control. Text size is part of the same undoable/restorable block transaction and is shared by preview and export. Numeric dimensions no longer show long floating-point tails.

Regression coverage includes marker/isolated-dot/bar distinction, rebuilding older uncertain bounds, bounded automatic sizing, and existing draft/restore/export/undo coverage. The reported full-name replacement was also applied and reopened on both supplied PDFs; private documents remain outside the repository.

## 0.27.0 — Edited Word documents as PDF

Word columns now offer Word/PDF format selection beside Download. PDF opens a page-by-page preview and downloads precisely the generated bytes shown there. Editing, closing, failure, or cancellation never alters the Word draft; changed revisions invalidate the old preview download. Conversion is local and works in both packaged extensions.

The renderer uses projectDocxVisual, including current cell edits, inserted/deleted rows and images retained after text deletion. It embeds searchable Unicode text with regular/bold DejaVu fonts, honors text colors, emphasis, basic alignment, margins, lists, inline PNG/JPEG images, table shading/borders and horizontal/vertical merges. Long paragraphs, unbroken identifiers and table cells paginate without cropping lines or images. Explicit page breaks and pageBreakBefore are carried from the source. Multiple section layouts and text columns are rejected with a DOCX download alternative. Fonts and pagination can differ from Word; the preview states this. This is semantic conversion of supported documents, not a full Word layout engine (advanced typography and table header repetition are not reproduced).

Tests cover edited text, logo, merged tables, inserted rows, a 130-line multipage cell, manual breaks, landscape page size, reordered paragraphs, canceled generation, stale preview prevention and unchanged draft history. Generated sample pages were also rendered with Poppler and visually inspected.

## 0.28.0 — Edited spreadsheets as PDF

Each spreadsheet column now offers its original format or PDF beside Download. PDF opens the shared page preview and downloads exactly the displayed bytes. Export includes the selected sheet, inserted rows and current cell edits; visible pending inputs are applied before export. Undo or subsequent edits invalidate an older preview. Canceling generation leaves the document intact.

Tables use readable portrait or landscape pages, repeated headers and wrapped cell text. Wide tables continue in column groups with the first column repeated; long rows continue across pages without losing text. Numeric display formats, leading zeros and workbook date systems are preserved. Images and charts remain in XLSX and are explicitly excluded from this table PDF. The PDF is a readable table rendering, not an exact reproduction of Excel print layout.

Tests cover offset headers, sparse worksheet dimensions, edited dates in the 1904 date system, formatted identifiers, every column of a wide CSV, long multi-page cells and unbroken text, inserted rows, unconfirmed input, stale previews and cancellation. Generated PDF pages were rendered and visually inspected.

## 0.29.0 — Edit and export one document

The home workspace now switches between Compare documents and Edit & export. Open one DOCX, XLSX, CSV or TSV without a comparison partner or identifier mapping. Word reuses the visual document editor, including table row tools; spreadsheets reuse the cell editor. Download the original format or preview and download PDF. The internal editor adapter keeps an original reference but performs no comparison request and hides reference panels and review decisions.

Spreadsheet import accepts headerless and duplicate-header CSV files, supports delimiter selection and lets users select an Excel worksheet before opening it. Editing is scoped to that worksheet; other workbook parts remain in XLSX. Existing formula-free, unmerged selected-sheet limits apply, with bounded rows, columns and total cells. The first displayed table row repeats in single-sheet PDFs.

Switching modes retains both workspaces in memory. Single-document edits are kept in the current tab, with an unload warning and replacement confirmation; they are not part of comparison-session autosave. A failed replacement preserves the current document. Pending cell input commits on cell selection and download. Tests cover single-file import, selected-sheet preservation, Word/image export, edited PDF preview, pending CSV/XLSX input, undo, mode switching and failed replacement.

## 0.29.1 — Fit spreadsheet columns across the PDF page

PDF export now measures displayed values and distributes page width between readable column minima and preferred widths. Numeric columns retain room for full values while headings and prose wrap. Wide tables use landscape A4; the renderer first attempts all columns at 9.5 pt, then 9 or 8.5 pt. Only tables that cannot fit at these readable sizes use horizontal parts with a repeated first column. Vertical pages retain all columns and repeat headers.

Tests cover seven mixed-width columns, a twelve-column table with tall cells, bounded font reduction, legitimate forty-column fallback, formatted numbers, very long identifiers, complete text preservation and every line staying within its cell. The user's submitted seven-column PDF was reconstructed privately for layout verification: all columns remain together at 9.5 pt, continuing vertically over two pages. Uploaded contents are not stored in the repository.

## 0.30.0 — Continue editing a saved single document

Edit & export now saves one local draft in a dedicated IndexedDB database, independent of comparison sessions. The home page offers Continue editing with the filename; active work reports Saved in this browser only after the serialized write queue commits. Delete saved work waits for outstanding saves, clears the draft, and closes that editor. Storage failures offer retry, and optimistic transaction tokens prevent an older tab from overwriting or deleting newer work. Documents stay on the device.

The saved payload retains original source bytes, the selected Excel worksheet or CSV separator, and editor snapshots. Word restores text, inserted rows, selection, zoom, scroll and undo history. Spreadsheets restore cell patches, inserted rows, visible row page, selected cell, scroll, and unconfirmed value/type separately; even an incomplete number is recoverable without prematurely applying it. Single-sheet undo of pending input is also saved. Replacement files only become active after successful opening, and payload closures stay tied to their original source.

Coverage includes close/reopen/continue in the actual entry UI, page-two CSV input, invalid numeric input in XLSX followed by export, Word row/history recovery, honest quota-failure status, stale-tab protection, and delete during an outstanding write. Existing comparison session queue tests remain in place. Browser and extension storage remain separate.


## 0.31.0 — Edit one PDF

Edit & export accepts a text-based PDF directly, alongside Word and spreadsheets. It reuses the existing visual PDF editor: click text, type edits, use Replace block for a resized replacement, switch Document/Text, and download an edited PDF with original images in supported layouts. Longer text uses the existing image-preserving expanded layout. Scans and unsupported PDF features keep the parser's existing limits and cannot replace an already open document.

The single-document local draft includes original PDF bytes, text edits, confirmed replacement geometry, undo history, selected text, page, zoom, scroll and Document/Text preference. An untouched or fully undone PDF downloads its original bytes. Comparison controls and the reference panel stay hidden, and no comparison request is needed.

Validation: full entry upload, local save/reopen, Replace block, page/view restoration, original-byte download, edited-text extraction, raster verification of retained artwork, image-preserving expansion and generated-page restoration, undo, rejected scan replacement and draft deletion. Existing Word/spreadsheet and A/B PDF tests remain in the suite.


## 0.31.1 — Fit inline PDF replacements before page reflow

Ordinary one-line PDF edits that exceed the original text width now try the same bounded local area and 80% minimum font size as Replace block before requesting page reflow. Preview, download pixels, searchable text and selection geometry share this derived plan; it adds no extra undo step or explicit replacement box. Nearby text, image, raster-boundary and added-area background checks still apply. A failed layout offers Adjust text area directly from the recovery bar.

Verified the supplied resume's name replacement through ordinary single-document editing and download. Synthetic regressions cover a flattened page with a Cyrillic text layer, nearby artwork and subtitle, edited export, restored drafts, oversized replacement recovery, overlap refusal, and grouped A/B line hotspots. Existing PDF reflow/block/export and single-editor scenarios also pass.


## 0.32.0 — Find and replace in documents

The visual document editor now offers Find & replace, with literal case-insensitive search, an optional Match case checkbox, occurrence navigation, highlighted sections and a context snippet. Replace changes one occurrence; Replace all changes the selected document in one undoable operation. In A/B comparison the scope explicitly selects A or B (B by default); single-document mode always edits its visible document. Search operates within individual paragraphs/source text blocks, not across paragraph boundaries or text inside images. Empty replacement removes matched text.

Text-only batch updates preserve paragraph records, PDF replacement boxes, Word table row plans and inserted rows. They reject stale patches and excessive output before committing, reuse existing PDF fitting/export and review invalidation, and trigger the existing local autosave. Search input itself is temporary.

Validated literal punctuation/Unicode/emoji offsets/dollar replacement, atomic size rejection, PDF geometry and grouped records, inserted Word rows and exported DOCX, per-column scope, PDF occurrence selection/page navigation/export, autosave snapshots and one-step undo after restoration.


## 0.33.0 — Find and replace in spreadsheets

Excel and CSV now use the same Find & replace panel as documents. Search covers text cells throughout the selected sheet, including headings, unchecked columns and rows outside the visible page. Navigation shows the cell address, highlights matches and opens the matching cell. Compare mode explicitly selects A or B; Edit & export searches its visible sheet. Numeric, date, boolean and formula cells in Excel are excluded. CSV values retain their text representation, including leading zeros.

Replace and Replace all use one validated batch and one review-level undo step. Pending cell input is committed before searching; invalid input remains visible and blocks replacement. Formatting and other workbook parts are retained on export. Local autosave now includes bounded spreadsheet undo history, so a replacement can be undone after reopening saved work.

Validated XLSX types, formatting, inserted rows and unrelated workbook parts; semicolon CSV with BOM, CRLF and leading-zero identifiers; offscreen matches, repeated occurrences in a cell, pending input, A/B scope, export and restored one-step undo.

## 0.33.1 — Free beta release preparation

Release metadata is centralized in release.json. Chrome/Firefox manifests use the English CTT BETA name and size-specific icons. Privacy and support pages are included in both offline archives. The site now links to Help & feedback and current beta downloads. The release/0.33.1 folder contains English listing text, reviewer instructions, privacy disclosure guidance, real workspace screenshots, promotional artwork and a verification report. The store kit is served separately under /release/; upload only its Chrome ZIP to the store. No store submission has been made. See the verification report for the installed-Chrome acceptance gate.

## 0.33.2 — Visible spreadsheet undo

The CSV/XLSX cell editor now includes Undo last change beside the selected cell, in comparison and single-document modes. Pending input enables Discard cell edit immediately. Both undo controls share the existing history and update after discarding, applying or undoing an edit. Field refresh now precedes undo-state calculation, avoiding an enabled button when the history is empty. A regression test covers pending input over existing history, applied edits and inserted rows.

## 0.33.3 — Readable styled spreadsheets

XLSX columns now use workbook width metadata (bounded 40–800px, with a 160px fallback) and scroll within the grid. Solid source fills cover the entire cell instead of the text button. Foreground black/white is chosen for contrast, and text aligns to the top of each row. Difference highlighting supplies its own readable foreground; selection outlines update immediately. Blank colored cell areas remain clickable. These display choices do not rewrite source styles on export. A synthetic dark/light workbook regression and browser check cover the issue reported in screenshots; the user's original workbook was not available.

## 0.33.4 — Spreadsheet PDF export with emoji

- Embed local monochrome Noto Emoji on demand; use a static, complete font to retain visible outlines. No runtime downloads.
- Use matching font runs for width measurement, wrapping and drawing; keep grapheme clusters together.
- Carry readable foreground colors from the spreadsheet grid into the PDF.
- Restore embedded-font preview compatibility in browsers without Math.sumPrecise.
- Add Cyrillic/emoji extraction, contrast and visible-glyph regression coverage.

## 0.33.5 — Merged Excel cells and continuous PDF columns

- Edit & export opens valid merged XLSX cells. Edit their anchor, undo, search and restore; retain original merge ranges on XLSX export.
- Clip vertical merge continuations at grid page boundaries while keeping the real edit address.
- Keep all PDF columns on the same page width, using a wider digital page when A4 cannot fit readable columns. Only rows continue onto subsequent pages.
- Render merged PDF areas as single rectangles and preserve every line across vertical page boundaries.
- Row comparison still requires unmerged cells and now directs layout editing to Edit & export.

- PDF preview includes Zoom in / Fit page width for wide sheets.

## 0.33.6 — Open and preserve spreadsheet formulas

- Edit & export accepts sheets containing formulas. Calculated cells are read-only; edit input cells to update supported totals.
- Bounded local parser evaluates cell/range references, quoted sheet names, arithmetic, IF, IFERROR, SUMIFS and COUNTIFS, plus a limited subset of common aggregates. No eval, network requests, macros or external workbook evaluation.
- Preserve formula expressions in XLSX and refresh supported result caches across sheets. Excel recalculation is enabled on open.
- Unsupported formulas retain clearly labelled saved values before edits; after edits, unresolved totals are marked and PDF export asks for Excel recalculation instead of exporting stale results.
- Regression coverage includes cross-sheet changes, undo, restore, cached result types, formula protection, unsupported dependencies and bounded wildcard criteria.
