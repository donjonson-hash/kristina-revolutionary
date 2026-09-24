"""Behavioral controls for evidence-backed, offline reconciliation."""

import hashlib
from unittest.mock import AsyncMock

import pytest

from avatar_platform.avatar_instance import AvatarInstance
from avatar_platform.profession_profile import get_profession
from avatar_platform.reconciliation import MAX_SOURCE_BYTES, run_reconciliation
from avatar_platform.user_profile import UserProfile


def compare(left, right, **rules):
    return run_reconciliation(left.encode(), right.encode(), key=("id", "sku"),
                              fields=[("qty", "quantity", "number")], **rules)


def assert_incomplete(result, code):
    assert result["status"] == "needs_clarification"
    assert result["summary"] is None
    assert result["questions"]
    assert code in {issue["code"] for issue in result["issues"]}
    assert all(result[name] == [] for name in ("matched", "changed", "only_left", "only_right"))


def test_order_independent_comparison_and_source_evidence():
    left = "id,qty,description\na,2,first\nb,4,second\nc,1,missing\n"
    right = "sku,quantity,description\nb,5,changed\na,2,same\nd,3,extra\n"
    result = compare(left, right)
    assert result["status"] == "complete"
    assert result["summary"] == {"left_rows": 3, "right_rows": 3, "matched": 1,
                                 "changed": 1, "only_left": 1, "only_right": 1}
    assert result["matched"][0]["key"] == "a"
    change = result["changed"][0]
    assert change["left"]["record"] == 3
    assert change["right"]["record"] == 2
    assert change["changes"] == [{"left_column": "qty", "right_column": "quantity",
                                  "mode": "number", "before": "4", "after": "5"}]
    assert result["only_left"][0]["key"] == "c"
    assert result["only_right"][0]["key"] == "d"
    assert result["sources"]["left"]["sha256"] == hashlib.sha256(left.encode()).hexdigest()
    assert result["sources"]["right"]["headers"] == ["sku", "quantity", "description"]
    assert result["matched"][0]["left"]["values"]["description"] == "first"


def test_decimal_equivalence_preserves_raw_strings_and_large_precision():
    result = compare("id,qty\na,123456789012345678901234567890.00\n",
                     "sku,quantity\na,+123456789012345678901234567890\n")
    assert result["summary"]["matched"] == 1
    assert result["matched"][0]["left"]["values"]["qty"].endswith(".00")
    result = compare("id,qty\na,123456789012345678901234567890.01\n",
                     "sku,quantity\na,123456789012345678901234567890.02\n")
    assert result["summary"]["changed"] == 1


@pytest.mark.parametrize("value", ["", "NaN", "Infinity", "1e2", "1 000", "1,2", "１２", " 2", "2 "])
def test_invalid_number_blocks_all_results_even_in_unmatched_rows(value):
    escaped = '"' + value.replace('"', '""') + '"'
    result = compare(f"id,qty\na,2\nmissing,{escaped}\n", "sku,quantity\na,2\n")
    assert_incomplete(result, "invalid_number")


@pytest.mark.parametrize("left,right,strip", [
    ("id,qty\na,2\na,2\n", "sku,quantity\na,2\n", False),
    ("id,qty\n a,2\na ,3\n", "sku,quantity\na,2\n", True),
    ("id,qty\na,2\n", "sku,quantity\na,2\na,3\n", False),
])
def test_duplicate_keys_are_ambiguous_including_identical_rows(left, right, strip):
    assert_incomplete(compare(left, right, strip=strip), "duplicate_key")


@pytest.mark.parametrize("value", ["", "  "])
def test_empty_key_does_not_become_a_match(value):
    assert_incomplete(compare(f"id,qty\n{value},2\n", "sku,quantity\na,2\n"), "empty_key")


def test_explicit_strip_applies_to_values_but_preserves_raw_evidence():
    left = b'id,description\n a ," hello "\n'
    right = b'sku,label\na,hello\n'
    rules = {"key": ("id", "sku"), "fields": [("description", "label", "text")]}
    untouched = run_reconciliation(left, right, **rules)
    assert untouched["summary"]["only_left"] == 1
    result = run_reconciliation(left, right, strip=True, **rules)
    assert result["summary"]["matched"] == 1
    assert result["matched"][0]["left"]["values"] == {"id": " a ", "description": " hello "}


def test_missing_rules_and_membership_only_are_distinct():
    left, right = b"id,qty\na,1\n", b"sku,quantity\na,9\n"
    assert_incomplete(run_reconciliation(left, right), "missing_key")
    assert_incomplete(run_reconciliation(left, right, key=("id", "sku")), "missing_fields")
    result = run_reconciliation(left, right, key=("id", "sku"), fields=[])
    assert result["summary"]["matched"] == 1
    assert result["rules"]["fields"] == []
    assert_incomplete(run_reconciliation(left, right, key=("ID", "sku"), fields=[]), "missing_column")


def test_multiline_csv_has_logical_record_numbers_and_bom_hash():
    left = b'\xef\xbb\xbfid,note\nx,"line one\nline two"\ny,"say ""hi"""\n'
    right = b'key,note\ny,changed\nx,"line one\nline two"\n'
    result = run_reconciliation(left, right, key=("id", "key"), fields=[("note", "note", "text")])
    assert result["changed"][0]["left"]["record"] == 3
    assert result["matched"][0]["left"]["values"]["note"] == "line one\nline two"
    assert result["sources"]["left"]["sha256"] == hashlib.sha256(left).hexdigest()


@pytest.mark.parametrize("raw", [b"", b"\xff", b"id,id\na,b", b"id, \na,b", b"id,qty\na",
                                 b'id,qty\na,"2', b'id,qty\na,2"bad', b'id\n\n', b'id\nx\x00'])
def test_malformed_csv_rejected(raw):
    with pytest.raises(ValueError):
        run_reconciliation(raw, b"id\na", key=("id", "id"), fields=[])


@pytest.mark.parametrize("rules", [
    {"delimiter": "|"}, {"strip": "yes"}, {"key": "id"},
    {"fields": [("qty", "quantity", "auto")]},
    {"fields": [("qty", "quantity", "text"), ("qty", "other", "text")]},
    {"fields": [("id", "quantity", "text")]},
])
def test_invalid_configuration_rejected(rules):
    base = {"key": ("id", "sku"), "fields": []}
    base.update(rules)
    with pytest.raises(ValueError):
        run_reconciliation(b"id,qty\na,2", b"sku,quantity\na,2", **base)


@pytest.mark.parametrize("delimiter", [";", "\t"])
def test_explicit_delimiters_and_header_only_empty_lists(delimiter):
    raw = f"id{delimiter}qty\n".encode()
    result = run_reconciliation(raw, raw, key=("id", "id"), fields=[], delimiter=delimiter)
    assert result["summary"] == {"left_rows": 0, "right_rows": 0, "matched": 0,
                                 "changed": 0, "only_left": 0, "only_right": 0}


@pytest.mark.parametrize("raw, message", [
    (b"x" * (MAX_SOURCE_BYTES + 1), "2 MiB"),
    (b"id\n" + b"x\n" * 5001, "5000"),
    ((",".join(f"h{i}" for i in range(201))).encode(), "200"),
], ids=["source-bytes", "record-count", "column-count"])
def test_source_limits_rejected(raw, message):
    with pytest.raises(ValueError, match=message):
        run_reconciliation(raw, b"id\nx", key=("id", "id"), fields=[])


def test_professional_entry_point_bypasses_llm_and_emotions():
    llm = AsyncMock()
    user = UserProfile("test", "Test", "reconciliation_specialist")
    user.emotional_state.update(energy=0, focus=0, stress=1)
    avatar = AvatarInstance("test", user, get_profession(user.role_id), llm_adapter=llm)
    result = avatar.reconcile_lists(b"id\na", b"id\na", key=("id", "id"), fields=[])
    assert result["status"] == "complete"
    llm.generate.assert_not_called()
    avatar.profession = get_profession("backend_dev")
    with pytest.raises(PermissionError):
        avatar.reconcile_lists(b"id\na", b"id\na", key=("id", "id"), fields=[])
    llm.generate.assert_not_called()


def test_many_invalid_values_return_bounded_diagnostics_without_partial_comparison():
    left = b"id,qty\n" + b"\n".join(f"{i},bad".encode() for i in range(150))
    result = run_reconciliation(left, b"sku,quantity\n0,1", key=("id", "sku"),
                                fields=[("qty", "quantity", "number")])
    assert_incomplete(result, "invalid_number")
    assert len(result["issues"]) == 101
    assert result["issues"][-1]["code"] == "additional_issues"
    assert result["issues"][-1]["count"] == 50


def test_csv_field_limit_remains_process_local_configuration():
    import csv

    limit = csv.field_size_limit()
    if limit >= MAX_SOURCE_BYTES:
        pytest.skip("process CSV field limit exceeds the independent source-byte limit")
    with pytest.raises(ValueError, match="field larger than field limit"):
        run_reconciliation(b"id\n" + b"x" * (limit + 1), b"id\nx", key=("id", "id"), fields=[])
    assert csv.field_size_limit() == limit
