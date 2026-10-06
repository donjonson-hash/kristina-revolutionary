"""Build a deterministic, platform-neutral Python UNO extension."""
from pathlib import Path
import ast
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent

def build():
    source = ROOT / 'package'
    for file in source.rglob('*.xml'):
        ET.parse(file)
    for file in source.glob('*.xcu'):
        ET.parse(file)
    ast.parse((source / 'ctt_writer.py').read_text())
    target = ROOT / 'dist' / 'compare-these-texts-writer-0.1.0.oxt'
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(source.rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                info = zipfile.ZipInfo(file.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, file.read_bytes())
    print(target)
    return target

if __name__ == '__main__':
    build()
