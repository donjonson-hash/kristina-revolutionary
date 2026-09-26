"""Build reproducible, dependency-free Firefox and Chrome extension packages."""
import argparse
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.10.1"


def build(output):
    output = Path(output).resolve()
    assets = ROOT / "static" / "reconciliation"
    html = (assets / "index.html").read_text(encoding="utf-8")
    html = html.replace('/assets/', '').replace('href="/"', 'href="index.html"')
    html = html.replace('<script src="app.js"', '<script src="transport.js" defer></script><script src="app.js"')
    html = html.replace('локально, без отправки в LLM', 'внутри браузера, без отправки на сервер')
    html = html.replace('Сейчас доступны таблицы CSV.', 'Сравниваю таблицы XLSX/CSV/TSV и текстовые документы TXT/DOCX/PDF.')
    html = html.replace('Показано содержимое CSV.', 'Показаны значения выбранных листов XLSX или записей CSV/TSV. Для Excel указаны исходные листы, строки и ячейки. Числа показаны без оформления; простой формат 000… сохраняет ведущие нули, даты приведены к ISO. Формулы требуют копии со значениями. Оформление и объекты не сравниваются.')
    manifest = {
        "manifest_version": 3,
        "name": "Кристина — офисный помощник",
        "version": VERSION,
        "description": "Сравню Excel, CSV, Word, TXT и текстовые PDF, выделю отличия и помогу подготовить письмо. Обработка внутри браузера.",
        "icons": {"128": "icon.png"},
        "action": {"default_title": "Кристина — сравнить документы", "default_popup": "launcher.html", "default_icon": {"128": "icon.png"}},
        "content_security_policy": {"extension_pages": "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; connect-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'"},
    }
    for target in ("firefox", "chrome"):
        directory = output / target
        directory.mkdir(parents=True, exist_ok=True)
        # Write only the explicit package allowlist, including in reused directories.
        files = {"index.html": html.encode(), "app.js": (assets / "app.js").read_bytes(), "style.css": (assets / "style.css").read_bytes()}
        files["office.js"] = (assets / "office.js").read_bytes()
        for name in ("transport.js", "worker.mjs", "engine.mjs", "commercial-summary.mjs", "report.mjs", "xlsx-report.mjs", "pdf-report.mjs", "pdf-source.mjs", "pdf-reader-vendor.mjs", "PDF-READER-LICENSE.txt", "PDF-READER-SOURCE.md", "pdf-vendor.mjs", "pdf-font.mjs", "PDF-LICENSES.txt", "PDF-SOURCE.md", "xlsx-source.mjs", "xlsx-vendor.mjs", "SHEETJS-LICENSE.txt", "text-source.mjs", "text-engine.mjs", "text-report.mjs", "text-zip.mjs", "xml-vendor.mjs", "XMLDOM-LICENSE.txt", "XMLDOM-SOURCE.md", "launcher.html", "launcher.css", "launcher.js", "icon.png"):
            files[name] = (ROOT / "extension" / name).read_bytes()
        target_manifest = dict(manifest)
        if target == "firefox":
            target_manifest["browser_specific_settings"] = {"gecko": {
                "id": "kristina-reconciliation@donjonson-hash.github.io", "strict_min_version": "142.0",
                "data_collection_permissions": {"required": ["none"]},
            }}
        else:
            target_manifest["minimum_chrome_version"] = "120"
        files["manifest.json"] = (json.dumps(target_manifest, ensure_ascii=False, indent=2) + "\n").encode()
        for old in directory.iterdir():
            if old.name not in files:
                raise ValueError(f"Unexpected file in build directory: {old}")
        archive = output / f"kristina-{target}-{VERSION}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            for name, content in sorted(files.items()):
                (directory / name).write_bytes(content)
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zipped.writestr(info, content)
        print(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "extension")
    build(parser.parse_args().output)
