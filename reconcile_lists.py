"""Offline vertical slice: professional avatar -> CSV reconciliation -> evidence report."""

from __future__ import annotations

import argparse
import html
import io
import json
from pathlib import Path
import sys

from avatar_platform.avatar_factory import AvatarFactory
from avatar_platform.llm_adapter import BaseLLMAdapter


MAX_REPORT_BYTES = 16 * 1024 * 1024


class _ReportBuffer:
    """Bound UTF-8 output while building it, before any report file is opened."""

    def __init__(self, format_name):
        self.format_name = format_name
        self.size = 0
        self.stream = io.StringIO()

    def append(self, text):
        size = len(text.encode("utf-8"))
        if self.size + size > MAX_REPORT_BYTES:
            raise ValueError(f"{self.format_name} report exceeds 16 MiB; split the input lists")
        self.size += size
        self.stream.write(text)

    def extend(self, chunks):
        for chunk in chunks:
            self.append(chunk)

    def getvalue(self):
        return self.stream.getvalue()


def render_json(report: dict) -> str:
    output = _ReportBuffer("JSON")
    output.extend(json.JSONEncoder(ensure_ascii=False, indent=2).iterencode(report))
    output.append("\n")
    return output.getvalue()


class NoModelAdapter(BaseLLMAdapter):
    """This operation must execute code, never substitute a model or mock answer."""

    async def generate(self, *args, **kwargs):
        raise RuntimeError("Сверка списков не использует LLM")


def column_pair(value: str) -> tuple[str, str]:
    parts = value.split("=")
    if len(parts) == 1 and parts[0]:
        return parts[0], parts[0]
    if len(parts) == 2 and all(parts):
        return parts[0], parts[1]
    raise argparse.ArgumentTypeError("Укажите столбец или пару левый=правый")


def _highlight_value(value: str, other: str) -> str:
    """Mark one differing span in linear time, retaining the exact original text."""
    start = 0
    limit = min(len(value), len(other))
    while start < limit and value[start] == other[start]:
        start += 1
    end = 0
    while end < limit - start and value[len(value) - end - 1] == other[len(other) - end - 1]:
        end += 1
    stop = len(value) - end
    escaped = html.escape
    middle = escaped(value[start:stop], quote=True)
    # An insertion/deletion may leave no characters to mark on this side.
    marked = f"<mark>{middle}</mark>" if middle else ""
    return escaped(value[:start], quote=True) + marked + escaped(value[stop:], quote=True)


def render_html(report: dict) -> str:
    """Static paired document views; source values stay intact and escaped."""
    esc = lambda value: html.escape(str(value), quote=True)
    complete = report["status"] == "complete"
    title = "Сверка завершена" if complete else "Нужно уточнение — сравнение не выполнено"
    parts = _ReportBuffer("HTML")
    parts.append("<!doctype html><html lang='ru'><head><meta charset='utf-8'>"
                 "<meta name='viewport' content='width=device-width, initial-scale=1'>"
                 "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
                 f"<title>{title} — Кристина</title><style>"
                 "*{box-sizing:border-box}body{font:16px/1.6 system-ui,sans-serif;color:#263b34;background:#f3f4ee;margin:0;padding:32px}"
                 "main{max-width:1280px;margin:auto}h1{font-size:32px;line-height:1.2}h2{font-size:23px;margin-top:32px}h3{font-size:18px;margin:0 0 14px}"
                 "p{margin:10px 0}.muted,.field-note{color:#59685f}.totals{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}"
                 ".totals div{background:#fff;padding:16px 20px;border:1px solid #d9dfd5;border-radius:10px;flex:1;min-width:150px}"
                 ".totals strong{font-size:28px;display:block}.totals span{display:block}.pair{margin:22px 0;break-inside:avoid}"
                 ".documents{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:stretch}"
                 ".paper{background:#fff;border:1px solid #d5dbd1;border-radius:4px;padding:24px;min-width:0;box-shadow:0 3px 10px #24362708}"
                 ".paper.removed{border-left:5px solid #b95c40}.paper.added{border-left:5px solid #388058}"
                 ".paper header{font-weight:650;border-bottom:1px solid #dde1da;padding-bottom:12px;margin-bottom:14px}"
                 ".paper dl{margin:16px 0 0}.field{padding:10px 12px;border-bottom:1px solid #eceee9}.field.changed{border-radius:4px}"
                 ".left .field.changed{background:#fff3ee}.right .field.changed{background:#eef8f0}"
                 "dt{font-size:13px;color:#52645a}dd{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}"
                 ".left mark{background:#ffd5c5;color:#672a17}.right mark{background:#c5ebce;color:#164c2b}"
                 "mark{border-radius:2px;padding:1px 0}.field-note{font-size:12px;display:block}.empty{color:#67756d;font-style:italic}"
                 ".badge{font-size:13px;font-weight:500;border:1px solid #ced8cd;border-radius:20px;padding:2px 9px;display:inline-block;margin-left:8px}"
                 "summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e9ede5;padding:16px;border-radius:6px}"
                 ".metadata{margin-top:28px;padding:20px;border:1px solid #d5dbd1;border-radius:8px}.source{margin:14px 0}"
                 ".hash{font:12px/1.5 monospace;overflow-wrap:anywhere}h3,header,dt,.source{overflow-wrap:anywhere}"
                 "@media(max-width:700px){body{padding:14px}.documents{grid-template-columns:1fr;gap:10px}.paper{padding:16px}h1{font-size:27px}}"
                 "@media print{body{padding:0;background:#fff}.paper{box-shadow:none}.documents{gap:12px}.totals div{padding:10px}}"
                 "</style></head><body><main>")
    parts.append(f"<h1>{title}</h1><p>Кристина · помощник по сверке данных. "
                 "Расчёт выполнен локальным кодом, без LLM.</p>")
    if not complete:
        parts.append("<h2>Уточнения</h2><ul>")
        parts.extend(f"<li>{esc(q)}</li>" for q in report["questions"])
        parts.append("</ul><h2>Диагностика</h2><pre>"
                     + esc(json.dumps(report["issues"], ensure_ascii=False, indent=2)) + "</pre>")
    else:
        labels = {"changed": "Есть различия", "only_left": "Только в A",
                  "only_right": "Только в B", "matched": "Совпали выбранные поля"}
        parts.append("<div class='totals'>")
        for key, label in labels.items():
            parts.append(f"<div><strong>{esc(report['summary'][key])}</strong><span>{label}</span></div>")
        parts.append("</div><p>Записи двух CSV показаны рядом и сопоставлены по ключу. "
                     "Это представление исходных данных, а не исходная вёрстка документа. "
                     "Подсветка отмечает изменившуюся часть значения; подписи указывают вид отличия.</p>")
        key_columns = report["rules"]["key"]
        parts.append(f"<p><strong>Ключ сопоставления:</strong> A — {esc(key_columns[0])}; "
                     f"B — {esc(key_columns[1])}.</p>")
        fields = report["rules"]["fields"] or []
        checked = {"left": {f[0]: f[2] for f in fields}, "right": {f[1]: f[2] for f in fields}}

        def paper(row, side, changes, absent=False):
            label = "A" if side == "left" else "B"
            only = "removed" if side == "left" else "added"
            parts.append(f"<article class='paper {side}{' ' + only if absent and row else ''}'>")
            parts.append(f"<header>{label} · {esc(report['sources'][side]['name'])}</header>")
            if row is None:
                parts.append("<p class='empty'>Запись с этим ключом отсутствует.</p></article>")
                return
            parts.append(f"<details open><summary>Исходная запись {esc(row['record'])}</summary><dl>")
            column_key = "left_column" if side == "left" else "right_column"
            changed = {change[column_key]: change for change in changes}
            key_column = key_columns[0 if side == "left" else 1]
            for column, value in row["values"].items():
                change = changed.get(column)
                parts.append(f"<div class='field{' changed' if change else ''}'><dt>{esc(column)}</dt><dd>")
                if change:
                    other = change["after" if side == "left" else "before"]
                    parts.append(_highlight_value(value, other))
                else:
                    parts.append(esc(value))
                parts.append("</dd>")
                if absent:
                    note = f"Только в {label} — парной записи нет"
                elif change:
                    note = "Отличается · значение A" if side == "left" else "Отличается · значение B"
                elif column == key_column:
                    note = "Ключ сопоставления"
                elif column not in checked[side]:
                    note = "Не сравнивалось"
                else:
                    note = "Совпадает как число" if checked[side][column] == "number" else "Совпадает по правилу сравнения"
                if value == "":
                    note = "Пустое значение · " + note
                parts.append(f"<span class='field-note'>{note}</span></div>")
            parts.append("</dl></details></article>")

        def pair(item, category):
            parts.append(f"<section class='pair'><h3>Ключ: {esc(item['key'])}"
                         f"<span class='badge'>{labels[category]}</span></h3><div class='documents'>")
            only = category in ("only_left", "only_right")
            for side in ("left", "right"):
                row = (item["row"] if category == "only_" + side else None) if only else item[side]
                paper(row, side, item.get("changes", []), absent=only)
            parts.append("</div></section>")

        parts.append("<h2>Различия в документах</h2>")
        for category in ("changed", "only_left", "only_right"):
            for item in report[category]:
                pair(item, category)
        if not any(report[category] for category in ("changed", "only_left", "only_right")):
            parts.append("<p>Различий в выбранных полях сопоставленных записей нет. Состав ключей совпадает.</p>")
        parts.append("<h2>Совпавшие записи</h2><details><summary>Показать исходные данные — "
                     f"{esc(report['summary']['matched'])} записей</summary>")
        for item in report["matched"]:
            pair(item, "matched")
        parts.append("</details>")
    parts.append("<details class='metadata'><summary>Источники и правила сравнения</summary><h2>Источники</h2>")
    for side, label in (("left", "A"), ("right", "B")):
        source = report["sources"][side]
        parts.append(f"<div class='source'><strong>{label} · {esc(source['name'])}</strong>"
                     f"<p>Строк данных: {esc(source['row_count'])}</p>"
                     f"<p class='hash'>SHA-256 исходных байтов: {esc(source['sha256'])}</p></div>")
    parts.append("<h2>Правила сравнения</h2><pre>"
                 + esc(json.dumps(report["rules"], ensure_ascii=False, indent=2)) + "</pre>"
                 "<p>Сравниваются только выбранные столбцы. Текст сравнивается с учётом регистра. "
                 "Числа — только в явно выбранных числовых столбцах; единицы и валюты не пересчитываются. "
                 "Номер записи включает заголовок: первая строка данных — запись 2. "
                 "При переносах внутри CSV-ячейки это не номер физической строки файла.</p></details>"
                 "</main></body></html>")
    return parts.getvalue()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Кристина: проверяемая сверка двух CSV без LLM")
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--right", type=Path, required=True)
    parser.add_argument("--key", type=column_pair, help="Ключ: sku или sku=артикул")
    parser.add_argument("--field", type=column_pair, action="append", default=[], help="Текстовое поле; можно повторять")
    parser.add_argument("--number", type=column_pair, action="append", default=[], help="Числовое поле; можно повторять")
    parser.add_argument("--membership-only", action="store_true", help="Сверить только наличие ключей")
    parser.add_argument("--strip", action="store_true", help="Игнорировать пробелы по краям ключей и значений")
    parser.add_argument("--delimiter", choices=[",", ";", "tab"], default=",")
    parser.add_argument("--output", type=Path, required=True, help="Новый файл JSON")
    parser.add_argument("--html", type=Path, help="Новый HTML-отчёт")
    args = parser.parse_args(argv)
    if args.membership_only and (args.field or args.number):
        parser.error("--membership-only нельзя сочетать с --field или --number")
    try:
        inputs = {args.left.resolve(), args.right.resolve()}
        outputs = [p for p in (args.output, args.html) if p is not None]
        resolved = [p.resolve() for p in outputs]
        if len(set(resolved)) != len(resolved) or any(p in inputs for p in resolved):
            raise ValueError("Отчёты должны иметь разные пути и не совпадать с исходниками")
        if any(p.exists() for p in outputs):
            raise ValueError("Файл отчёта уже существует; укажите новый путь")
        # Bound reads before decoding; never load arbitrary-size files into memory.
        def read_source(path):
            with path.open("rb") as stream:
                return stream.read(2 * 1024 * 1024 + 1)

        left, right = read_source(args.left), read_source(args.right)
        fields = [(a, b, "text") for a, b in args.field] + [(a, b, "number") for a, b in args.number]
        avatar = AvatarFactory(llm_adapter=NoModelAdapter()).create_avatar(
            user_id="local-cli", name="Кристина", role_id="reconciliation_specialist")
        report = avatar.reconcile_lists(
            left, right, left_name=args.left.name, right_name=args.right.name,
            key=args.key, fields=fields if fields or args.membership_only else None,
            strip=args.strip, delimiter="\t" if args.delimiter == "tab" else args.delimiter)
        payloads = [(args.output, render_json(report))]
        if args.html:
            payloads.append((args.html, render_html(report)))
        written = []
        try:
            for path, payload in payloads:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("x", encoding="utf-8") as stream:
                    written.append(path)
                    stream.write(payload)
        except OSError:
            for path in written:
                path.unlink(missing_ok=True)
            raise
    except (ValueError, OSError) as exc:
        print(json.dumps({"status": "invalid_input", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": report["status"], "summary": report["summary"],
                      "questions": report["questions"], "json": str(args.output),
                      "html": str(args.html) if args.html else None}, ensure_ascii=False))
    return 0 if report["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
