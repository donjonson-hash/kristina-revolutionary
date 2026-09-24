"""Conservative, deterministic setup for CSV reconciliation.

Only a small, explicit vocabulary can suggest identifiers or numeric semantics.
Ambiguous structures stay reviewable; original headers and values are unchanged.
"""
from __future__ import annotations

from collections import defaultdict

from .reconciliation import _NUMBER, _source

PREVIEW_RECORDS = 5
DELIMITERS = (",", ";", "\t")
_ALIASES = {
    # Sharing values does not establish that a database ID is a stock code.
    # Keep each identifier namespace separate even when both look unique.
    "identifier_sku": {"sku", "артикул"},
    "identifier_id": {"id", "идентификатор"},
    "identifier_product_id": {"product_id"},
    "identifier_code": {"код"},
    "identifier_product_code": {"код товара", "код_товара"},
    "quantity": {"qty", "quantity", "количество"},
    "price": {"price", "цена"},
    "price_rub": {"price_rub", "цена_руб"},
    "unit": {"unit", "единица", "единица измерения"},
    "name": {"name", "наименование"},
}
_SEMANTICS = {alias: kind for kind, aliases in _ALIASES.items() for alias in aliases}
_IDENTIFIERS = {kind for kind in _ALIASES if kind.startswith("identifier_")}
_NUMERIC = {"quantity", "price", "price_rub"}


def _meaning(header):
    return _SEMANTICS.get(header.strip().casefold())


def _parse_sources(sources, delimiter):
    if delimiter != "auto":
        if delimiter not in DELIMITERS:
            raise ValueError("Выберите разделитель: запятая, точка с запятой или табуляция.")
        return delimiter, {side: _source(raw, name, delimiter) for side, (raw, name) in sources.items()}

    candidates = []
    for candidate in DELIMITERS:
        try:
            parsed = {side: _source(raw, name, candidate) for side, (raw, name) in sources.items()}
        except ValueError:
            continue
        candidates.append((candidate, parsed))
    # A wrong separator usually produces one giant column. Require structural
    # evidence in each source; mixed-delimiter files need explicit correction.
    structured = [item for item in candidates if all(len(meta["headers"]) > 1 for meta, _ in item[1].values())]
    if len(structured) == 1:
        return structured[0]
    if not structured and len(candidates) == len(DELIMITERS) and all(item[1] == candidates[0][1] for item in candidates):
        # True one-column files have identical interpretation for every valid
        # separator, so selecting the first changes no header or cell value.
        return candidates[0]
    if not candidates:
        raise ValueError("Не удалось прочитать CSV. Проверьте UTF-8, структуру строк и выберите разделитель в настройках.")
    raise ValueError("Не удалось однозначно определить общий разделитель CSV. Выберите разделитель в настройках; оба файла должны использовать его.")


def _map_headers(left_headers, right_headers):
    """Exact mappings first, then unambiguous aliases; never fuzzy matching."""
    right_set = set(right_headers)
    pairs = {header: header for header in left_headers if header in right_set}
    used = set(pairs.values())
    groups = {}
    for side, headers in (("left", [h for h in left_headers if h not in pairs]),
                          ("right", [h for h in right_headers if h not in used])):
        grouped = defaultdict(list)
        for header in headers:
            meaning = _meaning(header)
            if meaning:
                grouped[meaning].append(header)
        groups[side] = grouped
    for meaning, left in groups["left"].items():
        right = groups["right"].get(meaning, [])
        if len(left) == len(right) == 1:
            pairs[left[0]] = right[0]
            used.add(right[0])
    return [(header, pairs[header]) for header in left_headers if header in pairs], {
        "left": [header for header in left_headers if header not in pairs],
        "right": [header for header in right_headers if header not in used],
    }


def prepare_reconciliation(sources, delimiter="auto"):
    """Return source previews and safe suggested rules, or a specific question."""
    delimiter, parsed = _parse_sources(sources, delimiter)
    left_source, left_rows = parsed["left"]
    right_source, right_rows = parsed["right"]
    pairs, unmatched = _map_headers(left_source["headers"], right_source["headers"])
    candidates = [(a, b) for a, b in pairs if _meaning(a) in _IDENTIFIERS and _meaning(a) == _meaning(b)]
    key = None
    questions = []
    if len(candidates) != 1:
        questions.append("Выберите столбец, который обозначает одну и ту же позицию в обоих файлах — например, артикул или ID. "
                         + ("Найдено несколько возможных идентификаторов." if candidates else "Однозначный идентификатор не найден."))
    else:
        candidate = candidates[0]
        values = [[row["values"][column] for row in rows]
                  for column, rows in zip(candidate, (left_rows, right_rows))]
        if any(any(not value.strip() for value in side) for side in values):
            questions.append("В столбце идентификатора есть пустые значения. Заполните их или выберите другой ключ в настройках.")
        elif any(len(side) != len(set(side)) for side in values):
            questions.append("В столбце идентификатора есть повторяющиеся значения. Уточните ключ или устраните дубликаты перед сверкой.")
        elif all(values) and not set(values[0]).intersection(values[1]):
            questions.append("По найденному идентификатору нет общих позиций. Проверьте ключи в настройках; если списки действительно разные, подтвердите выбор вручную.")
        else:
            key = list(candidate)
    fields = []
    invalid_numeric = False
    for a, b in pairs:
        if key == [a, b]:
            continue
        meaning = _meaning(a)
        mode = "text"
        if meaning in _NUMERIC and meaning == _meaning(b):
            mode = "number"
            if not all(_NUMBER.fullmatch(row["values"][column])
                       for column, rows in ((a, left_rows), (b, right_rows)) for row in rows):
                # Do not silently reinterpret currency/grouping marks as text.
                # ready=False prevents automatic comparison. Keep the proposed
                # numeric mode so manual compare also asks for clarification.
                invalid_numeric = True
        fields.append([a, b, mode])
    if invalid_numeric:
        questions.append("В количестве или цене есть значения, которые нельзя однозначно прочитать как число. Проверьте формат в настройках: десятичные числа с точкой, без единиц и разделителей тысяч.")
    if unmatched["left"] or unmatched["right"]:
        questions.append("Некоторые столбцы не удалось сопоставить. Укажите соответствия в настройках или явно исключите их из проверки.")
    return {
        "left": {**left_source, "preview": left_rows[:PREVIEW_RECORDS]},
        "right": {**right_source, "preview": right_rows[:PREVIEW_RECORDS]},
        "delimiter": delimiter,
        "rules": {"key": key, "fields": fields, "strip": False},
        "ready": not questions,
        "question": " ".join(questions) if questions else None,
        "unmatched": unmatched,
    }
