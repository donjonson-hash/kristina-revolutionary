# Compare These Texts for LibreOffice Writer — prototype 0.1.0

Edit one selected passage directly in Writer, preview removed/added text, then apply minimal changes as one Writer Undo operation. No browser, account, network calls, document upload, or temporary document copy.

## Install and use

1. Install `dist/compare-these-texts-writer-0.1.0.oxt` through **Tools → Extension Manager → Add**. Restart LibreOffice completely.
2. On Ubuntu, LibreOffice's Python component support must be installed. If missing: `sudo apt install python3-uno libreoffice-script-provider-python`.
3. Open a Writer document and select text within one paragraph.
4. Choose **Compare These Texts → Edit selected text…** (Russian: **Редактировать выделенный текст…**), or use the added toolbar command.
5. Edit, choose **Preview changes**, then **Apply to document**. **Cancel** leaves the document unchanged. Writer **Ctrl+Z** restores the applied edit.

Save the document normally in Writer. This extension does not save it automatically.

## Initial scope

Up to 4,000 selected characters in one main-body paragraph. Unchanged text retains its formatting. Inserted text inherits the first replaced character's formatting (or adjacent text for insertion). A replacement crossing different formatting is rejected; edit each styled fragment separately.

Tables, frames, headers/footers, fields, hyperlinks, bookmarks, comments, recorded changes, protected text and paragraph-break insertion are outside this prototype. Non-text portions anywhere in the selected paragraph are rejected. Character boundaries that cannot be verified are rejected before changes. The original paragraph and its formatting are checked again before applying.

This is a native dialog prototype, not a permanent sidebar. Existing browser style suggestions have not yet been ported. Test on a copy of a document before using the prototype for daily work. Windows/macOS installation is not verified by the Linux smoke test.

## Build and verify

`python3 ctt/libreoffice/build.py`

Native integration tests require `libreoffice-writer`, `python3-uno`, `libreoffice-script-provider-python`, `xvfb`, and `xauth`:

`xvfb-run -a /usr/bin/python3 ctt/libreoffice/tests/smoke.py`

The test installs the actual OXT in an isolated disposable profile, checks dispatch registration, edits real Writer documents, checks untouched styles, Undo/Redo, stale text and unsupported content. The desktop user profile is never used.
