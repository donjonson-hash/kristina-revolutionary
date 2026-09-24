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


def render_html(report: dict) -> str:
    """Static HTML; all source content is escaped and displayed as evidence."""
    esc = lambda value: html.escape(str(value), quote=True)
    complete = report["status"] == "complete"
    title = "Сверка завершена" if complete else "Нужно уточнение — сравнение не выполнено"
    parts = _ReportBuffer("HTML")
    parts.extend([f"<h1>{title}</h1>",
                  "<p>Кристина · помощник по сверке данных. Расчёт выполнен локальным кодом, без LLM.</p>"])
    parts.append("<h2>Источники</h2><table><thead><tr><th>Список</th><th>Файл</th>"
                 "<th>Строк данных</th><th>SHA-256 исходных байтов</th></tr></thead><tbody>")
    for side, label in (("left", "A"), ("right", "B")):
        source = report["sources"][side]
        parts.append(f"<tr><td>{label}</td><td>{esc(source['name'])}</td>"
                     f"<td>{source['row_count']}</td><td class='hash'>{esc(source['sha256'])}</td></tr>")
    parts.append("</tbody></table><h2>Правила сравнения</h2><pre>"
                 + esc(json.dumps(report["rules"], ensure_ascii=False, indent=2)) + "</pre>")
    parts.append("<p>Сравниваются только выбранные столбцы. Текст сравнивается с учётом регистра. "
                 "Числа — только в явно выбранных числовых столбцах; единицы и валюты не пересчитываются. "
                 "Номер записи включает заголовок: первая строка данных — запись 2. "
                 "При переносах внутри CSV-ячейки это не номер физической строки файла.</p>")
    if not complete:
        parts.append("<h2>Уточнения</h2><ul>")
        parts.extend(f"<li>{esc(q)}</li>" for q in report["questions"])
        parts.append("</ul><h2>Диагностика</h2><pre>"
                     + esc(json.dumps(report["issues"], ensure_ascii=False, indent=2)) + "</pre>")
    else:
        summary = report["summary"]
        labels = {"matched": "Совпали выбранные поля", "changed": "Есть различия",
                  "only_left": "Только в A", "only_right": "Только в B"}
        parts.append("<h2>Результат</h2><div class='totals'>")
        for key, label in labels.items():
            parts.append(f"<div><strong>{summary[key]}</strong><span>{label}</span></div>")
        parts.append("</div>")

        def evidence(row: dict) -> str:
            return (f"<details><summary>Исходная запись {row['record']}</summary><pre>"
                    + esc(json.dumps(row["values"], ensure_ascii=False, indent=2)) + "</pre></details>")

        parts.append("<h2>Различия</h2><table><thead><tr><th>Ключ</th><th>Поле A → B</th>"
                     "<th>Значение A</th><th>Значение B</th><th>Основание</th></tr></thead><tbody>")
        for item in report["changed"]:
            for index, change in enumerate(item["changes"]):
                basis = (f"A: {evidence(item['left'])}B: {evidence(item['right'])}" if index == 0
                         else f"Та же пара записей: A — {item['left']['record']}, B — {item['right']['record']}")
                parts.append(f"<tr><td>{esc(item['key'])}</td>"
                             f"<td>{esc(change['left_column'])} → {esc(change['right_column'])}"
                             f"<br><small>{esc(change['mode'])}</small></td>"
                             f"<td class='raw'>{esc(change['before'])}</td>"
                             f"<td class='raw'>{esc(change['after'])}</td>"
                             f"<td>{basis}</td></tr>")
        parts.append("</tbody></table>")
        if not report["changed"]:
            parts.append("<p>Различий в выбранных полях сопоставленных записей нет.</p>")
        for key in ("only_left", "only_right"):
            parts.append(f"<h2>{labels[key]}</h2><ul>")
            parts.extend(f"<li><strong>{esc(item['key'])}</strong>{evidence(item['row'])}</li>"
                         for item in report[key])
            parts.append("</ul>")
            if not report[key]:
                parts.append("<p>Нет записей.</p>")
        parts.append("<h2>Совпавшие записи</h2><details><summary>Показать исходные данные</summary><ul>")
        parts.extend(f"<li><strong>{esc(item['key'])}</strong>A: {evidence(item['left'])}"
                     f"B: {evidence(item['right'])}</li>" for item in report["matched"])
        parts.append("</ul></details>")
    prefix = ("<!doctype html><html lang='ru'><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width, initial-scale=1'>"
            "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
            f"<title>{title} — Кристина</title><style>"
            "body{font:16px/1.5 system-ui,sans-serif;color:#17313c;background:#f4f7f8;margin:0;padding:24px}"
            "main{max-width:1200px;margin:auto;background:white;padding:28px;border-radius:16px}"
            "h1{font-size:28px}h2{margin-top:32px;font-size:21px}table{border-collapse:collapse;width:100%;table-layout:fixed}"
            "th,td{text-align:left;vertical-align:top;border:1px solid #cbd7dc;padding:10px;overflow-wrap:anywhere}"
            "th{background:#eaf1f4}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f8;padding:10px}"
            ".hash{font-size:12px}.raw{white-space:pre-wrap}.totals{display:flex;flex-wrap:wrap;gap:14px}"
            ".totals div{background:#eaf1f4;border-radius:8px;padding:14px;flex:1;min-width:150px}"
            ".totals strong{display:block;font-size:26px}.totals span{display:block}summary{cursor:pointer}"
            "li{margin-bottom:12px}@media(max-width:650px){body{padding:8px}main{padding:12px}th,td{padding:5px;font-size:13px}}"
            "</style><main>")
    suffix = "</main></html>"
    if parts.size + len(prefix.encode("utf-8")) + len(suffix) > MAX_REPORT_BYTES:
        raise ValueError("HTML report exceeds 16 MiB; split the input lists")
    return prefix + parts.getvalue() + suffix


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
