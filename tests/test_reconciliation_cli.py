"""Exercise actual avatar -> executor -> report, including fail-closed paths."""
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def run_cli(*args):
    env = {**os.environ, "DEEPSEEK_API_KEY": "not-a-real-key-must-never-be-used"}
    return subprocess.run([sys.executable, str(ROOT / "reconcile_lists.py"), *map(str, args)],
                          cwd=ROOT, env=env, capture_output=True, text=True, timeout=10)


def test_full_professional_scenario(tmp_path):
    left = ROOT / "examples/reconciliation/order.csv"
    right = ROOT / "examples/reconciliation/confirmation.csv"
    output, page = tmp_path / "result.json", tmp_path / "result.html"
    proc = run_cli("--left", left, "--right", right, "--key", "sku", "--field", "unit",
                   "--number", "quantity", "--output", output, "--html", page)
    assert proc.returncode == 0, proc.stderr
    report = json.loads(output.read_text())
    assert report["summary"] == {"left_rows": 4, "right_rows": 4, "matched": 1,
                                  "changed": 2, "only_left": 1, "only_right": 1}
    assert report["sources"]["left"]["sha256"] == hashlib.sha256(left.read_bytes()).hexdigest()
    assert {item["key"] for item in report["changed"]} == {"DS-200", "LP-300"}
    assert report["matched"][0]["right"]["values"]["quantity"] == "10.00"
    assert "DS-200" in page.read_text() and "LP-300" in page.read_text()
    # Both evidence paths can be checked against original data, not model claims.
    assert report["only_left"][0]["row"]["values"]["sku"] == "OLD-400"
    assert report["only_right"][0]["row"]["values"]["sku"] == "NEW-500"


def test_missing_rules_produces_questions_not_success(tmp_path):
    source = ROOT / "examples/reconciliation/order.csv"
    output = tmp_path / "questions.json"
    proc = run_cli("--left", source, "--right", source, "--output", output)
    assert proc.returncode == 2, proc.stderr
    report = json.loads(output.read_text())
    assert report["status"] == "needs_clarification" and report["questions"]
    assert report["summary"] is None and report["matched"] == []


def test_source_and_existing_report_cannot_be_overwritten(tmp_path):
    source = tmp_path / "source.csv"
    source.write_text("sku\nx\n")
    for output in (source, tmp_path / "existing.json"):
        if output != source:
            output.write_text("previous result")
        previous = output.read_bytes()
        proc = run_cli("--left", source, "--right", source, "--key", "sku",
                       "--membership-only", "--output", output)
        assert proc.returncode == 1
        assert output.read_bytes() == previous


def test_html_escapes_untrusted_cells(tmp_path):
    left, right = tmp_path / "a.csv", tmp_path / "b.csv"
    left.write_text('sku,value\nx,<script>alert(1)</script>\n')
    right.write_text('sku,value\nx,<img src=x onerror=alert(1)>\n')
    page = tmp_path / "result.html"
    proc = run_cli("--left", left, "--right", right, "--key", "sku", "--field", "value",
                   "--output", tmp_path / "result.json", "--html", page)
    assert proc.returncode == 0, proc.stderr
    text = page.read_text()
    assert "<script>" not in text and "<img src=x" not in text
    visible = _ReportText(text)
    assert "<script>alert(1)</script>" in visible.values
    assert "<img src=x onerror=alert(1)>" in visible.values
    assert "default-src 'none'" in text


def test_invalid_csv_does_not_leave_report(tmp_path):
    source = tmp_path / "bad.csv"
    source.write_text("sku,qty\nx,1,extra\n")
    output = tmp_path / "result.json"
    proc = run_cli("--left", source, "--right", source, "--key", "sku", "--number", "qty",
                   "--output", output)
    assert proc.returncode == 1 and not output.exists()


def test_wide_diff_does_not_repeat_full_evidence_per_field():
    from avatar_platform.reconciliation import run_reconciliation
    from reconcile_lists import render_html
    columns = [f"field{i}" for i in range(199)]
    header = ",".join(["sku", *columns]) + "\n"
    left = (header + ",".join(["x", *(["a" * 500] * 199)]) + "\n").encode()
    right = (header + ",".join(["x", *(["b" * 500] * 199)]) + "\n").encode()
    result = run_reconciliation(left, right, key=("sku", "sku"),
                                fields=[(c, c, "text") for c in columns])
    page = render_html(result)
    assert len(result["changed"][0]["changes"]) == 199
    assert page.count("<summary>Исходная запись") == 2
    assert len(page.encode()) < 4 * (len(left) + len(right))


@pytest.mark.parametrize("format_name", ["JSON", "HTML"])
def test_amplified_reports_are_rejected_before_either_file_is_created(tmp_path, format_name):
    left, right = tmp_path / "a.csv", tmp_path / "b.csv"
    if format_name == "JSON":
        # A small CSV can repeat a long header in thousands of evidence objects.
        header = "h" * 10000
        raw = (f"id,{header}\n" + "".join(f"{i},x\n" for i in range(1000))).encode()
        left.write_bytes(raw)
        right.write_bytes(raw)
        rules = ["--membership-only"]
    else:
        # JSON stays below its limit; HTML escaping amplifies both source values.
        columns = [f"f{i}" for i in range(100)]
        header = ",".join(["id", *columns]) + "\n"
        left.write_text(header + ",".join(["x", *(["&" * 18000 + "a"] * 100)]) + "\n")
        right.write_text(header + ",".join(["x", *(["&" * 18000 + "b"] * 100)]) + "\n")
        rules = [arg for column in columns for arg in ("--field", column)]
    originals = [p.read_bytes() for p in (left, right)]
    output, page = tmp_path / "result.json", tmp_path / "result.html"
    proc = run_cli("--left", left, "--right", right, "--key", "id", *rules,
                   "--output", output, "--html", page)
    assert proc.returncode == 1, proc.stderr
    error = json.loads(proc.stderr)
    assert error["status"] == "invalid_input"
    assert f"{format_name} report exceeds 16 MiB" in error["error"]
    assert not output.exists() and not page.exists()
    assert [p.read_bytes() for p in (left, right)] == originals


def test_json_budget_counts_utf8_bytes_and_trailing_newline(monkeypatch):
    import reconcile_lists as cli

    report = {"value": "Я🙂"}
    expected = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    monkeypatch.setattr(cli, "MAX_REPORT_BYTES", len(expected.encode("utf-8")))
    assert cli.render_json(report) == expected
    monkeypatch.setattr(cli, "MAX_REPORT_BYTES", len(expected.encode("utf-8")) - 1)
    with pytest.raises(ValueError, match="JSON report exceeds"):
        cli.render_json(report)


def test_html_budget_includes_document_wrapper(monkeypatch):
    import reconcile_lists as cli
    from avatar_platform.reconciliation import run_reconciliation

    report = run_reconciliation(b"id\nx\n", b"id\nx\n", key=("id", "id"), fields=[])
    expected = cli.render_html(report)
    monkeypatch.setattr(cli, "MAX_REPORT_BYTES", len(expected.encode("utf-8")))
    assert cli.render_html(report) == expected
    monkeypatch.setattr(cli, "MAX_REPORT_BYTES", len(expected.encode("utf-8")) - 1)
    with pytest.raises(ValueError, match="HTML report exceeds"):
        cli.render_html(report)


class _ReportText(HTMLParser):
    """Read the visible source values even when a mark splits their text nodes."""

    def __init__(self, page):
        super().__init__(convert_charrefs=True)
        self.values = []
        self.marks = []
        self._value = None
        self._mark = None
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        if tag == "dd":
            self._value = ""
        if tag == "mark":
            self._mark = ""

    def handle_data(self, data):
        if self._value is not None:
            self._value += data
        if self._mark is not None:
            self._mark += data

    def handle_endtag(self, tag):
        if tag == "dd":
            self.values.append(self._value)
            self._value = None
        if tag == "mark":
            self.marks.append(self._mark)
            self._mark = None


def test_document_view_preserves_values_and_marks_only_differing_span():
    from avatar_platform.reconciliation import run_reconciliation
    from reconcile_lists import render_html

    report = run_reconciliation(
        b"sku,text,amount,note\nx,Delivery 15 days,10,unreviewed A\nleft,only left,1,a\nsame,ok,2,a\n",
        b"code,description,qty,note\nx,Delivery 20 days,10.00,unreviewed B\nright,only right,1,b\nsame,ok,2.0,b\n",
        key=("sku", "code"), fields=[("text", "description", "text"), ("amount", "qty", "number")])
    page = render_html(report)
    parsed = _ReportText(page)
    assert parsed.marks == ["15", "20"]
    assert "Delivery 15 days" in parsed.values and "Delivery 20 days" in parsed.values
    assert "10" in parsed.values and "10.00" in parsed.values
    assert "unreviewed A" in parsed.values and "unreviewed B" in parsed.values
    assert "only left" in parsed.values and "only right" in parsed.values
    assert "Не сравнивалось" in page and "Совпадает как число" in page
    assert page.count("Запись с этим ключом отсутствует.") == 2
    assert "<table" not in page and "<script" not in page
    assert "A — sku; B — code" in page
    assert len(parsed.values) == 24  # Every original field from all six records, once.


def test_highlight_keeps_empty_multiline_and_escaped_values():
    from reconcile_lists import _highlight_value

    for left, right in [("", "added"), ("a\nb<>&", "a\nc<>&"), ("abc", "abcd"), ("same", "same")]:
        for value, other in ((left, right), (right, left)):
            parsed = _ReportText("<dd>" + _highlight_value(value, other) + "</dd>")
            assert parsed.values == [value]


def test_long_key_is_not_repeated_for_each_difference():
    from avatar_platform.reconciliation import run_reconciliation
    from reconcile_lists import render_html

    columns = [f"f{i}" for i in range(199)]
    header = ",".join(["id", *columns]) + "\n"
    key = "k" * 100000
    left = (header + ",".join([key, *(["a"] * 199)]) + "\n").encode()
    right = (header + ",".join([key, *(["b"] * 199)]) + "\n").encode()
    report = run_reconciliation(left, right, key=("id", "id"), fields=[(c, c, "text") for c in columns])
    page = render_html(report)
    assert page.count(key) == 3  # Pair heading and one original key on each side.
    assert len(page.encode()) < 500000
