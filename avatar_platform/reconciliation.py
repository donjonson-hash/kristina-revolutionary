"""Offline CSV reconciliation with explicit rules and original-row evidence.

No model, network, filesystem writes, fuzzy matching, unit conversion, or locale
inference is involved. Record numbers refer to logical CSV records (header = 1).
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
from decimal import Decimal

MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 5000
MAX_COLUMNS = 200
MAX_ISSUES = 100
_NUMBER = re.compile(r"[+-]?[0-9]+(?:\.[0-9]+)?\Z", re.ASCII)


def _validate_quotes(text: str, delimiter: str, name: str) -> None:
    # csv.reader(strict=True) still accepts quotes embedded in unquoted cells.
    state = "start"
    for char in text:
        if state == "quoted":
            if char == '"':
                state = "closed"
        elif state == "closed":
            if char == '"':
                state = "quoted"
            elif char == delimiter or char in "\r\n":
                state = "start"
            else:
                raise ValueError(f"{name}: unexpected text after a closing CSV quote")
        elif state == "start":
            if char == '"':
                state = "quoted"
            elif char != delimiter and char not in "\r\n":
                state = "unquoted"
        elif char == '"':
            raise ValueError(f"{name}: quote inside an unquoted CSV field")
        elif char == delimiter or char in "\r\n":
            state = "start"
    if state == "quoted":
        raise ValueError(f"{name}: unterminated quoted CSV field")


def _source(raw: bytes, name: str, delimiter: str) -> tuple[dict, list[dict]]:
    if not isinstance(raw, bytes):
        raise ValueError(f"{name}: source must be bytes")
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError(f"{name}: source exceeds 2 MiB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{name}: expected UTF-8 CSV") from exc
    if not text or "\x00" in text:
        raise ValueError(f"{name}: empty source or NUL character in CSV")
    _validate_quotes(text, delimiter, name)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    rows = []
    try:
        headers = next(reader)
        if not headers or any(not header.strip() for header in headers):
            raise ValueError(f"{name}: headers must be nonblank")
        if len(headers) > MAX_COLUMNS:
            raise ValueError(f"{name}: more than {MAX_COLUMNS} columns")
        if len(headers) != len(set(headers)):
            raise ValueError(f"{name}: duplicate headers")
        for record, cells in enumerate(reader, start=2):
            if len(rows) >= MAX_RECORDS:
                raise ValueError(f"{name}: more than {MAX_RECORDS} data records")
            if len(cells) != len(headers):
                raise ValueError(f"{name}: record {record} has {len(cells)} cells; expected {len(headers)}")
            rows.append({"record": record, "values": dict(zip(headers, cells))})
    except StopIteration as exc:
        raise ValueError(f"{name}: empty CSV source") from exc
    except csv.Error as exc:
        raise ValueError(f"{name}: invalid CSV: {exc}") from exc
    return {"name": name, "sha256": hashlib.sha256(raw).hexdigest(),
            "headers": headers, "row_count": len(rows)}, rows


def _validate_rules(key, fields, strip, delimiter, left_name, right_name):
    if not isinstance(strip, bool):
        raise ValueError("strip must be a boolean")
    if not isinstance(delimiter, str) or delimiter not in (",", ";", "\t"):
        raise ValueError("delimiter must be comma, semicolon, or tab")
    if not all(isinstance(name, str) and name.strip() for name in (left_name, right_name)):
        raise ValueError("source names must be nonblank strings")
    if key is not None and (not isinstance(key, (tuple, list)) or len(key) != 2
                            or not all(isinstance(c, str) and c for c in key)):
        raise ValueError("key must contain one exact column name for each source")
    if fields is not None:
        if not isinstance(fields, list):
            raise ValueError("fields must be a list of (left column, right column, mode)")
        for field in fields:
            if (not isinstance(field, (tuple, list)) or len(field) != 3
                    or not all(isinstance(c, str) and c for c in field[:2])
                    or field[2] not in ("text", "number")):
                raise ValueError("each field needs two column names and mode 'text' or 'number'")
        for side in (0, 1):
            selected = ([key[side]] if key is not None else []) + [f[side] for f in fields]
            if len(selected) != len(set(selected)):
                raise ValueError("key and compared columns must be mapped one-to-one without reuse")


def run_reconciliation(
    left: bytes, right: bytes, *, left_name: str = "A", right_name: str = "B",
    key: tuple[str, str] | None = None,
    fields: list[tuple[str, str, str]] | None = None,
    strip: bool = False, delimiter: str = ",",
) -> dict:
    """Compare two CSV sources, or request clarification without partial results.

    ``fields=None`` requests field selection; ``fields=[]`` explicitly selects
    membership-only comparison. Number mode accepts signed ASCII digits with an
    optional decimal fraction, e.g. ``-12.50``; no exponents or grouping marks.
    The stdlib CSV parser field-size limit (normally 131072 characters) applies;
    this function never changes the process-wide limit. At most 100 detailed
    issues are returned, followed by an omitted-count notice.
    Malformed CSV/configuration raises ValueError; ambiguous records and invalid
    numeric values produce needs_clarification. Headers are always exact.
    """
    _validate_rules(key, fields, strip, delimiter, left_name, right_name)
    left_source, left_rows = _source(left, left_name, delimiter)
    right_source, right_rows = _source(right, right_name, delimiter)
    result = {
        "schema_version": 1, "status": "needs_clarification",
        "sources": {"left": left_source, "right": right_source},
        "rules": {"key": list(key) if key is not None else None,
                  "fields": [list(f) for f in fields] if fields is not None else None,
                  "strip": strip, "delimiter": delimiter},
        "questions": [], "issues": [], "summary": None,
        "matched": [], "changed": [], "only_left": [], "only_right": [],
    }

    question_set = set()
    suppressed_issues = 0

    def issue(code, message, **details):
        nonlocal suppressed_issues
        if len(result["issues"]) >= MAX_ISSUES:
            suppressed_issues += 1
            return
        result["issues"].append({"code": code, "message": message, **details})
        if message not in question_set:
            question_set.add(message)
            result["questions"].append(message)

    def incomplete():
        if suppressed_issues:
            result["issues"].append({"code": "additional_issues", "count": suppressed_issues,
                                    "message": "Показаны первые 100 замечаний. Исправьте данные и повторите сверку."})
        return result

    if key is None:
        issue("missing_key", "Выберите точное имя столбца-ключа в каждом источнике перед сверкой.")
    if fields is None:
        issue("missing_fields", "Выберите поля и режимы text/number или явно задайте сверку только состава строк (fields=[]).")
    for side, source, index in (("left", left_source, 0), ("right", right_source, 1)):
        selected = ([key[index]] if key is not None else []) + [f[index] for f in (fields or [])]
        for column in selected:
            if column not in source["headers"]:
                issue("missing_column", f"Укажите существующий столбец источника {side} вместо {column!r}.",
                      side=side, column=column)
    if result["issues"]:
        return incomplete()

    normalize = (lambda value: value.strip()) if strip else (lambda value: value)
    indexes = {}
    numeric = {}
    for side, rows, index in (("left", left_rows, 0), ("right", right_rows, 1)):
        keyed = {}
        for row in rows:
            value = normalize(row["values"][key[index]])
            if not value.strip():
                issue("empty_key", f"Заполните ключ в записи {row['record']} источника {side}.",
                      side=side, record=row["record"], column=key[index])
            elif value in keyed:
                issue("duplicate_key", f"Устраните неоднозначность повторяющегося ключа {value!r} в источнике {side}.",
                      side=side, key=value, records=[keyed[value]["record"], row["record"]])
            else:
                keyed[value] = row
            for mapping in fields:
                if mapping[2] != "number":
                    continue
                column = mapping[index]
                raw = normalize(row["values"][column])
                if not _NUMBER.fullmatch(raw):
                    issue("invalid_number", f"Укажите десятичное число цифрами 0–9 с точкой в записи {row['record']} источника {side}, столбец {column!r}; единицы измерения подтвердите отдельно.",
                          side=side, record=row["record"], column=column,
                          value=row["values"][column])
                else:
                    number = Decimal(raw)
                    # The explicit grammar excludes Infinity/NaN and exponents.
                    if not number.is_finite():
                        raise ValueError("number must be finite")
                    numeric[(side, row["record"], column)] = number
        indexes[side] = keyed
    if result["issues"]:
        return incomplete()

    for value, left_row in indexes["left"].items():
        right_row = indexes["right"].get(value)
        if right_row is None:
            result["only_left"].append({"key": value, "row": left_row})
            continue
        changes = []
        for left_column, right_column, mode in fields:
            before = left_row["values"][left_column]
            after = right_row["values"][right_column]
            if mode == "number":
                equal = numeric[("left", left_row["record"], left_column)] == numeric[("right", right_row["record"], right_column)]
            else:
                equal = normalize(before) == normalize(after)
            if not equal:
                changes.append({"left_column": left_column, "right_column": right_column,
                                "mode": mode, "before": before, "after": after})
        item = {"key": value, "left": left_row, "right": right_row}
        if changes:
            result["changed"].append({**item, "changes": changes})
        else:
            result["matched"].append(item)
    result["only_right"] = [{"key": value, "row": row}
                            for value, row in indexes["right"].items()
                            if value not in indexes["left"]]
    result["status"] = "complete"
    result["summary"] = {"left_rows": len(left_rows), "right_rows": len(right_rows),
                         **{name: len(result[name]) for name in
                            ("matched", "changed", "only_left", "only_right")}}
    return result
