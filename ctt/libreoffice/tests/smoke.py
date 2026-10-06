"""Native smoke test; run with system Python/pyuno under xvfb-run."""
import importlib.util
import faulthandler
import traceback
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

import uno

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ctt_writer", ROOT / "package/ctt_writer.py")
extension = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extension)


def prop(name, value):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name, item.Value = name, value
    return item


def rejected(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError("Expected edit to be rejected")


def run():
    faulthandler.dump_traceback_later(40, repeat=True)
    with tempfile.TemporaryDirectory(prefix="ctt-writer-") as tmp:
        profile = Path(tmp, "profile").as_uri()
        package = ROOT / "dist/compare-these-texts-writer-0.1.0.oxt"
        install = subprocess.run(["unopkg", "add", "--suppress-license", "-env:UserInstallation=" + profile, str(package)], capture_output=True, text=True, timeout=60)
        assert install.returncode == 0, install.stdout + install.stderr
        pipe = "ctt_" + uuid.uuid4().hex
        log = open(Path(tmp, "office.log"), "w+")
        process = subprocess.Popen(["libreoffice", "-env:UserInstallation=" + profile, "--norestore", "--nodefault", "--nofirststartwizard", "--accept=pipe,name=" + pipe + ";urp;StarOffice.ComponentContext"], stdout=log, stderr=log)
        desktop = None
        try:
            local = uno.getComponentContext()
            resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
            remote = None
            for _ in range(100):
                try:
                    remote = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
                    break
                except Exception:
                    time.sleep(.1)
            assert remote is not None, "LibreOffice did not start"
            desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)

            def doc(text):
                document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
                document.Text.String = text
                return document

            def select(document, text=None):
                cursor = document.Text.createTextCursor()
                if text is None:
                    cursor.gotoEnd(True)
                else:
                    cursor.goRight(len(text), True)
                document.CurrentController.select(cursor)
                return cursor

            document = doc("We utilize a cold stone.")
            whole = select(document)
            whole.CharFontName, whole.CharHeight = "Liberation Serif", 14
            bold = document.Text.createTextCursor()
            bold.goRight(13, False)
            bold.goRight(10, True)
            bold.CharWeight = 150.0
            select(document)
            edit = extension.SelectionEdit(document)
            assert edit.apply("We use a cold stone.")
            assert document.Text.String == "We use a cold stone."
            check = document.Text.createTextCursor()
            check.goRight(9, False)
            check.goRight(10, True)
            assert check.CharWeight == 150.0, "Untouched bold text changed"
            assert check.CharFontName == "Liberation Serif"
            assert check.CharHeight == 14
            undo = document.getUndoManager()
            undo.undo()
            assert document.Text.String == "We utilize a cold stone."
            undo.redo()
            assert document.Text.String == "We use a cold stone."
            undo.undo()
            print("PASS: minimal edits, formatting and Undo/Redo", flush=True)
            # Test installed protocol and native dialog construction/Cancel.
            select(document)
            url = uno.createUnoStruct("com.sun.star.util.URL")
            url.Complete, url.Protocol, url.Path = extension.PROTOCOL + "edit", extension.PROTOCOL, "edit"
            dispatch = document.CurrentController.Frame.queryDispatch(url, "", 0)
            assert dispatch is not None, "Installed command is unavailable"
            ui = remote.ServiceManager.createInstanceWithContext("com.sun.star.ui.test.UITest", remote)
            assert ui.executeDialog(url.Complete), "Could not open installed editor"
            window = ui.getTopFocusWindow()
            print("Dialog children:", window.getChildren(), flush=True)
            window.executeAction("TYPE", (prop("KEYCODE", "ESC"),))
            assert document.Text.String == "We utilize a cold stone."
            document.close(True)
            print("PASS: installed command, dialog, minimal edit, formatting, one-step Undo/Redo", flush=True)

            for original, edited in [("Привет, мир!", "Привет, друг!"), ("A 😀 cold stone", "A 😀 warm stone"), ("Cafe\u0301 is cold", "Cafe\u0301 is warm"), ("A 👩‍💻 cold stone", "A 👩‍💻 warm stone"), ("Hello", "Oh, Hello!"), ("Hello", "")]:
                document = doc(original)
                select(document)
                edit = extension.SelectionEdit(document)
                edit.apply(edited)
                assert document.Text.String == edited, (original, document.Text.String)
                document.getUndoManager().undo()
                assert document.Text.String == original
                document.close(True)
            print("PASS: Cyrillic, emoji, combining marks, ZWJ, boundary insertions, deletion", flush=True)
            for original, edited in [("A 😀 stone", "A 😃 stone"), ("A 👩‍💻 stone", "A stone"), ("Cafe\u0301", "Cafe")]:
                document = doc(original)
                select(document)
                edit = extension.SelectionEdit(document)
                try:
                    edit.apply(edited)
                except ValueError:
                    assert document.Text.String == original
                else:
                    assert document.Text.String == edited
                    document.getUndoManager().undo()
                    assert document.Text.String == original
                document.close(True)
            print("PASS: edits at Unicode boundaries apply correctly or reject without mutation", flush=True)


            document = doc("Original sentence.")
            select(document)
            edit = extension.SelectionEdit(document)
            document.Text.String = "Changed elsewhere."
            rejected(lambda: edit.apply("Another sentence."))
            assert document.Text.String == "Changed elsewhere."
            document.close(True)
            document = doc("One paragraph.\nSecond paragraph.")
            select(document)
            rejected(lambda: extension.SelectionEdit(document))
            document.close(True)
            document = doc("Field follows: ")
            field = document.createInstance("com.sun.star.text.TextField.DateTime")
            cursor = document.Text.createTextCursor()
            cursor.gotoEnd(False)
            document.Text.insertTextContent(cursor, field, False)
            select(document)
            rejected(lambda: extension.SelectionEdit(document))
            document.close(True)
            document = doc("Recorded changes.")
            document.setPropertyValue("RecordChanges", True)
            select(document)
            rejected(lambda: extension.SelectionEdit(document))
            document.close(True)
            document = doc("Different fonts")
            cursor = select(document)
            cursor.CharFontName = "Liberation Serif"
            cursor.collapseToStart()
            cursor.goRight(5, True)
            cursor.CharFontName = "Liberation Sans"
            select(document)
            edit = extension.SelectionEdit(document)
            rejected(lambda: edit.apply("XXXXXXXXXXXXXXX"))
            assert document.Text.String == "Different fonts"
            document.close(True)
            print("PASS: stale selection, multiple paragraphs, fields, tracked changes, mixed-style rejection", flush=True)
        except Exception:
            traceback.print_exc()
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
            log.close()


if __name__ == "__main__":
    run()
