"""Exercise actual avatar -> executor -> report, including fail-closed paths."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

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
    assert "&lt;script&gt;" in text and "&lt;img src=x" in text
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
