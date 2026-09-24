"""Automatic rules must never trade evidence for a convenient guess."""
import csv
import io

import pytest

from avatar_platform.reconciliation import run_reconciliation
from avatar_platform.reconciliation_setup import prepare_reconciliation


def csv_bytes(headers, rows, delimiter=","):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=delimiter)
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def prepare(left, right=None, delimiter="auto"):
    return prepare_reconciliation({"left": (left, "order.csv"), "right": (right if right is not None else left, "supplier.csv")}, delimiter)


def test_aliases_infer_rules_and_preserve_exact_source_values():
    left = csv_bytes(["Артикул", "Количество", "Цена_руб", "Единица", "Наименование", "Телефон"], [
        ["001", "10", "189", "шт", "Блокнот", "001234"],
        ["002", "5", "12.50", "шт", "Ручка", "123456"],
    ], ";")
    right = csv_bytes(["sku", "qty", "price_rub", "unit", "name", "Телефон"], [
        ["002", "4", "12.50", "шт", "Ручка", "123456"],
        ["001", "10.00", "189.00", "шт", "Блокнот", "001234"],
    ], ";")
    result = prepare(left, right)
    assert result["ready"] and result["question"] is None
    assert result["delimiter"] == ";"
    assert result["rules"] == {"key": ["Артикул", "sku"], "strip": False, "fields": [
        ["Количество", "qty", "number"], ["Цена_руб", "price_rub", "number"],
        ["Единица", "unit", "text"], ["Наименование", "name", "text"], ["Телефон", "Телефон", "text"],
    ]}
    assert result["left"]["preview"][0]["values"]["Артикул"] == "001"
    report = run_reconciliation(left, right, **result["rules"], delimiter=result["delimiter"])
    assert report["status"] == "complete"
    assert report["summary"]["matched"] == report["summary"]["changed"] == 1
    assert report["changed"][0]["key"] == "002"


@pytest.mark.parametrize("header", ["Количество", "quantity", "price", "Цена_руб", "Телефон", "Наименование"])
def test_unique_numeric_or_name_values_are_not_identifiers(header):
    result = prepare(csv_bytes([header], [["001"], ["002"]]))
    assert result["rules"]["key"] is None
    assert not result["ready"] and "идентификатор" in result["question"]


@pytest.mark.parametrize("rows,reason", [
    ([["A", "1"], ["A", "2"]], "повторяющиеся"),
    ([["A", "1"], [" ", "2"]], "пустые"),
])
def test_all_records_are_checked_for_key_ambiguity(rows, reason):
    # The bad key occurs beyond the five-row preview.
    raw = csv_bytes(["sku", "quantity"], [[f"X-{i}", "1"] for i in range(6)] + rows)
    result = prepare(raw)
    assert not result["ready"] and result["rules"]["key"] is None
    assert reason in result["question"]


def test_multiple_identifiers_are_not_ranked_or_guessed():
    result = prepare(b"sku,id,quantity\nA,001,1\nB,002,2\n")
    assert result["rules"]["key"] is None
    assert not result["ready"] and "несколько" in result["question"]


def test_no_overlap_requires_manual_confirmation_but_empty_side_is_valid():
    left = b"sku,quantity\nA,1\n"
    result = prepare(left, b"sku,quantity\nB,1\n")
    assert not result["ready"] and "нет общих" in result["question"]
    empty = prepare(left, b"sku,quantity\n")
    assert empty["ready"] and empty["rules"]["key"] == ["sku", "sku"]


@pytest.mark.parametrize("invalid", ["1,5", "1e3", "NaN", " 12", "12 ", "1 000", "", "１２", "5 руб"])
def test_invalid_numeric_value_beyond_preview_blocks_auto_compare(invalid):
    raw = csv_bytes(["sku", "quantity"], [[str(i), "1"] for i in range(6)] + [["last", invalid]])
    result = prepare(raw)
    assert not result["ready"] and "формат" in result["question"]
    assert result["rules"]["fields"] == [["quantity", "quantity", "number"]]
    report = run_reconciliation(raw, raw, **result["rules"], delimiter=result["delimiter"])
    assert report["status"] == "needs_clarification"
    assert report["summary"] is None


def test_unmatched_and_ambiguous_alias_columns_are_never_silently_excluded():
    left = b"sku,qty,quantity,notes\nA,1,1,check\n"
    right = "Артикул,Количество,Комментарий\nA,1,check\n".encode()
    result = prepare(left, right)
    assert not result["ready"]
    assert result["rules"]["key"] == ["sku", "Артикул"]
    assert result["unmatched"] == {"left": ["qty", "quantity", "notes"], "right": ["Количество", "Комментарий"]}
    assert "сопоставить" in result["question"]


@pytest.mark.parametrize("delimiter", [",", ";", "\t"])
def test_separator_is_determined_by_full_csv_parse_including_quotes(delimiter):
    raw = csv_bytes(["sku", "name"], [["A", "one, two; three\tfour\nfive"]], delimiter)
    result = prepare(raw)
    assert result["delimiter"] == delimiter and result["ready"]
    assert result["left"]["preview"][0]["values"]["name"] == "one, two; three\tfour\nfive"


def test_single_column_membership_has_no_semantic_separator_ambiguity():
    result = prepare(b"id\n001\n002\n")
    assert result["ready"]
    assert result["rules"] == {"key": ["id", "id"], "fields": [], "strip": False}


@pytest.mark.parametrize("left,right", [
    (b"sku,name;unit\nA,book;piece\n", None),
    (b"sku,quantity\nA,1\n", b"sku;quantity\nA;1\n"),
    (b"sku,quantity\nA,1,2\n", None),
])
def test_ambiguous_or_mixed_or_malformed_csv_never_guesses(left, right):
    with pytest.raises(ValueError, match="разделитель"):
        prepare(left, right)


def test_explicit_separator_preserves_unusual_headers():
    raw = b"sku,name;unit\nA,book;piece\n"
    result = prepare(raw, delimiter=",")
    assert result["ready"] and result["rules"]["fields"] == [["name;unit", "name;unit", "text"]]


def test_long_header_output_is_linear_and_preserves_original_header():
    long_header = "custom" + "x" * 100_000
    raw = csv_bytes(["sku", long_header], [["A", "one"], ["B", "two"]])
    result = prepare(raw)
    assert result["ready"]
    assert result["rules"]["fields"] == [[long_header, long_header, "text"]]
    assert result["question"] is None


@pytest.mark.parametrize("left_key,right_key", [
    ("sku", "id"), ("Артикул", "идентификатор"),
    ("sku", "product_id"), ("id", "product_id"),
    ("код", "sku"), ("код", "id"), ("код", "код товара"),
])
def test_coinciding_values_do_not_join_different_identifier_namespaces(left_key, right_key):
    left = csv_bytes([left_key, "quantity"], [["001", "10"]])
    right = csv_bytes([right_key, "quantity"], [["001", "20"]])
    result = prepare(left, right)
    assert not result["ready"] and result["rules"]["key"] is None
    assert result["unmatched"] == {"left": [left_key], "right": [right_key]}
    assert result["rules"]["fields"] == [["quantity", "quantity", "number"]]


@pytest.mark.parametrize("left_key,right_key", [
    ("SKU", "Артикул"), ("id", "Идентификатор"),
    ("product_id", "PRODUCT_ID"), ("код", "Код"),
    ("код товара", "Код_товара"),
])
def test_identifier_aliases_stay_within_their_namespace(left_key, right_key):
    result = prepare(csv_bytes([left_key], [["001"]]), csv_bytes([right_key], [["001"]]))
    assert result["ready"] and result["rules"]["key"] == [left_key, right_key]


@pytest.mark.parametrize("left_field,right_field", [
    ("Цена_руб", "price"), ("Цена_руб", "цена"),
    ("Цена_руб", "price_usd"), ("price_rub", "price"),
    ("Количество_кг", "quantity"), ("Количество_кг", "quantity_lb"),
    ("quantity_kg", "quantity"), ("qty_kg", "qty_g"),
])
def test_currency_and_quantity_units_are_never_dropped_by_alias_matching(left_field, right_field):
    result = prepare(csv_bytes(["sku", left_field], [["001", "10"]]),
                     csv_bytes(["sku", right_field], [["001", "10"]]))
    assert not result["ready"]
    assert result["rules"]["key"] == ["sku", "sku"]
    assert result["rules"]["fields"] == []
    assert result["unmatched"] == {"left": [left_field], "right": [right_field]}


def test_explicit_same_currency_alias_retains_numeric_comparison():
    left = csv_bytes(["sku", "Цена_руб"], [["001", "189"]])
    right = csv_bytes(["Артикул", "price_rub"], [["001", "189.00"]])
    result = prepare(left, right)
    assert result["ready"] and result["rules"]["fields"] == [["Цена_руб", "price_rub", "number"]]
    report = run_reconciliation(left, right, **result["rules"], delimiter=result["delimiter"])
    assert report["summary"]["matched"] == 1
