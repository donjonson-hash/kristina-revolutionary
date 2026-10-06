"""Offline Writer selection editor. No network or document-file import."""
import difflib
import uuid

import uno
import unohelper
from com.sun.star.awt import XActionListener, XTextListener
from com.sun.star.frame import XDispatch, XDispatchProvider
from com.sun.star.lang import XInitialization, XServiceInfo

IMPLEMENTATION = "org.comparethesetexts.WriterEditor"
PROTOCOL = "org.comparethesetexts.writer:"
LIMIT = 4000
STYLE = tuple(sorted(("CharStyleName", "CharFontName", "CharFontNameAsian", "CharFontNameComplex",
         "CharHeight", "CharHeightAsian", "CharHeightComplex", "CharWeight",
         "CharWeightAsian", "CharWeightComplex", "CharPosture", "CharPostureAsian",
         "CharPostureComplex", "CharColor", "CharBackColor", "CharUnderline",
         "CharStrikeout", "CharEscapement", "CharEscapementHeight", "CharHidden",
         "CharCaseMap", "CharKerning", "CharScaleWidth", "CharAutoKerning")))


def changes(original, edited):
    if len(edited) > LIMIT or any(c in edited for c in "\r\n\u2028\u2029\x00"):
        raise ValueError("Use one paragraph, up to 4,000 characters. Paragraph breaks are not supported yet.")
    return [(a, b, edited[c:d]) for tag, a, b, c, d in
            difflib.SequenceMatcher(None, original, edited, autojunk=False).get_opcodes()
            if tag != "equal"]


def position(anchor, original, offset):
    """Validate cursor boundaries instead of assuming a UTF-16/codepoint unit."""
    cursor = anchor.Text.createTextCursorByRange(anchor.Start)
    cursor.goRight(offset, True)
    prefix = original[:offset]
    if cursor.String != prefix:
        cursor.gotoRange(anchor.Start, False)
        for _ in range(LIMIT * 2 + 1):
            if cursor.String == prefix:
                break
            if len(cursor.String) >= len(prefix) or not cursor.goRight(1, True):
                raise ValueError("This edit crosses an unsupported character boundary. No changes were made.")
        else:
            raise ValueError("Unsupported text boundary.")
    cursor.collapseToEnd()
    return cursor


def span(anchor, original, start, end):
    left = position(anchor, original, start)
    right = position(anchor, original, end)
    left.gotoRange(right, True)
    if left.String != original[start:end]:
        raise ValueError("The selected passage changed. Close the editor and select it again.")
    return left


def properties(part):
    return tuple(part.getPropertyValue(name) for name in STYLE)


def paragraph_snapshot(anchor):
    paragraph = anchor.Text.createTextCursorByRange(anchor.Start)
    paragraph.gotoStartOfParagraph(False)
    paragraph.gotoEndOfParagraph(True)
    section = paragraph.getPropertyValue("TextSection")
    while section is not None:
        if section.getPropertyValue("IsProtected"):
            raise ValueError("This section is protected.")
        section = section.getParentSection()
    records = []
    paragraphs = paragraph.createEnumeration()
    while paragraphs.hasMoreElements():
        item = paragraphs.nextElement()
        if not item.supportsService("com.sun.star.text.Paragraph"):
            raise ValueError("Select ordinary paragraph text.")
        portions = item.createEnumeration()
        while portions.hasMoreElements():
            part = portions.nextElement()
            if part.TextPortionType != "Text" or part.getPropertyValue("HyperLinkURL"):
                raise ValueError("This prototype supports plain paragraphs without fields, links, comments, bookmarks or tracked changes.")
            records.append((part.String, properties(part)))
    return paragraph.String, tuple(records)


class SelectionEdit:
    def __init__(self, document):
        self.document = document
        self.check_document()
        selection = document.CurrentController.getSelection()
        if not hasattr(selection, "getCount") or selection.getCount() != 1:
            raise ValueError("Select one continuous passage in a Writer paragraph.")
        selected = selection.getByIndex(0)
        self.anchor = selected.Text.createTextCursorByRange(selected.Start)
        self.anchor.gotoRange(selected.End, True)
        self.original = self.anchor.String
        if not self.original or len(self.original) > LIMIT:
            raise ValueError("Select between 1 and 4,000 characters in one paragraph.")
        if any(c in self.original for c in "\r\n\u2028\u2029"):
            raise ValueError("Select text within a single paragraph for this prototype.")
        if self.anchor.Text != document.Text:
            raise ValueError("Select main document text. Tables, frames, headers and footnotes are not supported yet.")
        self.before = paragraph_snapshot(self.anchor)
        prefix = self.anchor.Text.createTextCursorByRange(self.anchor.Start)
        prefix.gotoStartOfParagraph(False)
        prefix.gotoRange(self.anchor.Start, True)
        self.paragraph_offset = len(prefix.String)
        self.applied = False

    def check_document(self):
        if not self.document.supportsService("com.sun.star.text.TextDocument"):
            raise ValueError("Open a Writer document first.")
        if self.document.isReadonly():
            raise ValueError("The document is read-only.")
        if self.document.getPropertyValue("RecordChanges"):
            raise ValueError("Turn off recording changes before using this prototype.")

    def apply(self, edited):
        self.check_document()
        if self.applied or self.anchor.String != self.original or paragraph_snapshot(self.anchor) != self.before:
            raise ValueError("The original passage or its formatting changed. Close the editor and select it again.")
        patches = changes(self.original, edited)
        if not patches:
            return False
        prepared = []
        for start, end, replacement in patches:
            region = span(self.anchor, self.original, start, end)
            sample = min(start, len(self.original) - 1)
            style = properties(span(self.anchor, self.original, sample, sample + 1))
            # A replacement spanning multiple styles needs an explicit mapping;
            # do not silently flatten such a range in the initial prototype.
            if replacement and end > start:
                for offset in range(start, end):
                    if properties(span(self.anchor, self.original, offset, offset + 1)) != style:
                        raise ValueError("One replacement crosses different text formatting. Make smaller edits within each formatted part.")
            prepared.append((region, replacement, style))
        undo = self.document.getUndoManager()
        title = "Compare These Texts " + uuid.uuid4().hex[:8]
        if undo.isLocked():
            raise ValueError("Undo is unavailable. No changes were made.")
        changed = False
        self.document.lockControllers()
        try:
            undo.enterUndoContext(title)
        except Exception:
            self.document.unlockControllers()
            raise
        try:
            try:
                for region, replacement, style in reversed(prepared):
                    changed = True
                    region.setString(replacement)
                    if replacement:
                        if region.String != replacement:
                            raise RuntimeError("Could not verify the inserted text.")
                        region.setPropertyValue("CharStyleName", style[STYLE.index("CharStyleName")])
                        direct = tuple((name, value) for name, value in zip(STYLE, style) if name != "CharStyleName")
                        region.setPropertyValues(tuple(n for n, _ in direct), tuple(v for _, v in direct))
                expected = self.before[0][:self.paragraph_offset] + edited + self.before[0][self.paragraph_offset + len(self.original):]
                if paragraph_snapshot(self.anchor)[0] != expected:
                    raise RuntimeError("Could not verify the final paragraph.")
            finally:
                undo.leaveUndoContext()
        except Exception:
            if changed and undo.isUndoPossible() and undo.getCurrentUndoActionTitle() == title:
                undo.undo()
            raise
        finally:
            self.document.unlockControllers()
        self.applied = True
        return True


class Listener(unohelper.Base, XActionListener, XTextListener):
    def __init__(self, action=None, text=None):
        self.action, self.text = action, text

    def actionPerformed(self, event):
        if self.action:
            self.action()

    def textChanged(self, event):
        if self.text:
            self.text()

    def disposing(self, event):
        pass


def message(context, frame, text):
    toolkit = context.ServiceManager.createInstanceWithContext("com.sun.star.awt.Toolkit", context)
    box = toolkit.createMessageBox(frame.getContainerWindow(), uno.Enum("com.sun.star.awt.MessageBoxType", "INFOBOX"), 1, "Compare These Texts", str(text))
    box.execute()
    box.dispose()


def editor_dialog(context, frame, selection):
    manager = context.ServiceManager
    model = manager.createInstanceWithContext("com.sun.star.awt.UnoControlDialogModel", context)
    model.Width, model.Height, model.Title = 440, 335, "Compare These Texts — Writer prototype"
    def control(kind, name, x, y, w, h, **props):
        item = model.createInstance("com.sun.star.awt.UnoControl" + kind + "Model")
        values = dict(Name=name, PositionX=x, PositionY=y, Width=w, Height=h, **props)
        for key, value in values.items():
            item.setPropertyValue(key, value)
        model.insertByName(name, item)
        return item
    control("FixedText", "original_label", 10, 8, 420, 12, Label="Original selection (read-only)")
    control("Edit", "original", 10, 22, 420, 58, Text=selection.original, MultiLine=True, ReadOnly=True, VScroll=True)
    control("FixedText", "edited_label", 10, 85, 420, 12, Label="Edit the selected text")
    control("Edit", "edited", 10, 99, 420, 70, Text=selection.original, MultiLine=True, VScroll=True, MaxTextLen=LIMIT)
    control("FixedText", "diff_label", 10, 175, 420, 12, Label="Changes: − removed / + added. Unchanged text keeps its formatting.")
    control("Edit", "diff", 10, 189, 420, 80, Text="Choose Preview changes before applying.", MultiLine=True, ReadOnly=True, VScroll=True)
    control("FixedText", "status", 10, 275, 420, 25, Label="Works locally. One paragraph only. Use Writer Undo after applying.")
    control("Button", "preview", 10, 308, 120, 18, Label="Preview changes")
    apply = control("Button", "apply", 200, 308, 110, 18, Label="Apply to document", Enabled=False)
    control("Button", "cancel", 320, 308, 110, 18, Label="Cancel", PushButtonType=2)
    dialog = manager.createInstanceWithContext("com.sun.star.awt.UnoControlDialog", context)
    dialog.setModel(model)
    toolkit = manager.createInstanceWithContext("com.sun.star.awt.Toolkit", context)
    dialog.createPeer(toolkit, frame.getContainerWindow())
    previewed = [None]
    def invalidate():
        previewed[0] = None
        apply.Enabled = False
        model.getByName("status").Label = "Text changed. Preview again before applying."
    def preview():
        try:
            edited = dialog.getControl("edited").getText()
            patches = changes(selection.original, edited)
            lines = []
            for a, b, replacement in patches:
                lines.extend(["− " + (selection.original[a:b] or "[nothing]"), "+ " + (replacement or "[nothing]"), ""])
            dialog.getControl("diff").setText("\n".join(lines) if patches else "No changes.")
            previewed[0] = edited
            apply.Enabled = bool(patches)
            model.getByName("status").Label = "New text inherits the first changed character's formatting. Apply is one Undo step."
        except Exception as error:
            invalidate()
            model.getByName("status").Label = str(error)
    def accept():
        try:
            if previewed[0] is None or dialog.getControl("edited").getText() != previewed[0]:
                invalidate()
                return
            selection.apply(previewed[0])
            dialog.endExecute()
        except Exception as error:
            model.getByName("status").Label = str(error)
            apply.Enabled = False
    listeners = [Listener(action=preview), Listener(action=accept), Listener(text=invalidate)]
    dialog.getControl("preview").addActionListener(listeners[0])
    dialog.getControl("apply").addActionListener(listeners[1])
    dialog.getControl("edited").addTextListener(listeners[2])
    try:
        dialog.execute()
    finally:
        dialog.dispose()


class WriterEditor(unohelper.Base, XInitialization, XServiceInfo, XDispatchProvider, XDispatch):
    def __init__(self, context):
        self.context, self.frame = context, None

    def initialize(self, arguments):
        if arguments:
            self.frame = arguments[0]

    def getImplementationName(self):
        return IMPLEMENTATION

    def supportsService(self, name):
        return name == "com.sun.star.frame.ProtocolHandler"

    def getSupportedServiceNames(self):
        return ("com.sun.star.frame.ProtocolHandler",)

    def queryDispatch(self, url, target, flags):
        return self if url.Protocol == PROTOCOL and url.Path == "edit" else None

    def queryDispatches(self, requests):
        return tuple(self.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags) for r in requests)

    def dispatch(self, url, arguments):
        if not self.frame:
            return
        try:
            selection = SelectionEdit(self.frame.getController().getModel())
            editor_dialog(self.context, self.frame, selection)
        except Exception as error:
            message(self.context, self.frame, error)

    def addStatusListener(self, listener, url):
        event = uno.createUnoStruct("com.sun.star.frame.FeatureStateEvent")
        event.Source, event.FeatureURL, event.IsEnabled = self, url, True
        listener.statusChanged(event)

    def removeStatusListener(self, listener, url):
        pass


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(WriterEditor, IMPLEMENTATION, ("com.sun.star.frame.ProtocolHandler",))
