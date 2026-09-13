"""Fixed subprocess worker. Repository input is JSON data, never Python code."""

import json
import re
import sys
from datetime import date, datetime
from importlib.metadata import version


def _limits():
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))


def calendar_valid(value, format_name):
    if format_name == "date":
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            return False
        try:
            date.fromisoformat(value)
            return True
        except ValueError:
            return False
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})", value):
        return False
    # Python normalizes malformed offsets such as +01:60; reject them first.
    if value[-1] not in "Zz" and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("t", "T").replace("z", "+00:00").replace("Z", "+00:00"))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def _probe_schema(root, pointer):
    from schema_experiment import _schema_nodes
    embedded = json.loads(json.dumps(root))
    for node, _ in _schema_nodes(embedded):
        if "$ref" in node:
            node["$ref"] = "#/definitions/__experiment_root" + node["$ref"][1:]
    for key in ("$id", "id", "$schema"):
        embedded.pop(key, None)
    return {"$schema": root.get("$schema", "https://json-schema.org/draft/2020-12/schema"),
            "definitions": {"__experiment_root": embedded},
            "$ref": "#/definitions/__experiment_root" + pointer}


def execute(plan):
    from jsonschema import FormatChecker
    from jsonschema.validators import validator_for
    from referencing import Registry
    from referencing.exceptions import NoSuchResource
    from schema_experiment import _load_schema, resolve_pointer, validate_schema_plan

    plan = validate_schema_plan(plan)
    root = _load_schema(plan["schema"]["content"])
    dialect = root.get("$schema", "https://json-schema.org/draft/2020-12/schema")
    if not isinstance(dialect, str):
        raise ValueError("Invalid schema dialect")
    validator_class = validator_for({"$schema": dialect}, default=None)
    if validator_class is None:
        raise ValueError("Unsupported schema dialect")
    # Draft 3 uses different reference/type semantics; do not silently reinterpret it.
    if "draft-03" in dialect:
        raise ValueError("Unsupported schema dialect")
    validator_class.check_schema(root)
    field = resolve_pointer(root, plan["pointer"])
    format_name = field["format"]
    checker = FormatChecker()
    if format_name not in checker.checkers:
        raise ValueError("Requested format checker is unavailable")
    def refuse_retrieval(uri):
        raise NoSuchResource(ref=uri)
    registry = Registry(retrieve=refuse_retrieval)
    probe = _probe_schema(root, plan["pointer"])
    validator_class.check_schema(probe)
    baseline = validator_class(probe, registry=registry)
    checked = validator_class(probe, registry=registry, format_checker=checker)
    rows = []
    for case in plan["cases"]:
        value = case["value"]
        valid = calendar_valid(value, format_name)
        rows.append({**case, "schema_valid": baseline.is_valid(value),
                     "format_checked_valid": checked.is_valid(value),
                     "calendar_valid": valid, "prediction_matches": valid == case["expected_valid"]})
    counterexamples = sum(row["schema_valid"] and not row["calendar_valid"] for row in rows)
    coverage = any(row["schema_valid"] and row["calendar_valid"] for row in rows) and any(not row["calendar_valid"] for row in rows)
    outcome = ("inconclusive" if not coverage else
               "counterexample_found" if counterexamples else "supported_on_cases")
    summaries = {
        "inconclusive": "Контрольная выборка недостаточна для вывода о гипотезе.",
        "counterexample_found": "На синтетических значениях поля схема без FormatChecker пропустила календарно неверное значение.",
        "supported_on_cases": "В проверенной контрольной выборке схема без FormatChecker не пропустила календарно неверных значений.",
    }
    source = {key: value for key, value in plan["schema"].items() if key != "content"}
    source["pointer"] = plan["pointer"]
    return {"kind": plan["kind"], "hypothesis": plan["hypothesis"], "outcome": outcome,
            "cases": rows, "counterexamples": counterexamples,
            "summary": summaries[outcome] + " Проверено отдельное поле, а не полный отчёт или реальные данные проекта.",
            "runner_version": 1, "source": source, "validator_version": version("jsonschema"),
            "schema_dialect": dialect, "format": format_name,
            "scope": "field_schema_synthetic_cases", "control_coverage": coverage,
            "limitations": ["synthetic_cases_only", "not_full_document_validation", "not_production_bug_evidence",
                            "python_calendar_range_0001_9999", "leap_seconds_not_supported"]}


def main():
    _limits()
    from schema_experiment import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("Worker input exceeds limit")
    result = execute(json.loads(data))
    output = json.dumps({"result": result}, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(output) > MAX_OUTPUT_BYTES:
        raise ValueError("Worker output exceeds limit")
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never return repository content, prompts, or misleading partial success.
        sys.exit(1)
