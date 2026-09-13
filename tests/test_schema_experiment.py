import asyncio
import hashlib
import json

import pytest

import schema_experiment as experiment
from schema_experiment import run_schema_experiment, schema_fields, validate_schema_plan
from schema_experiment_worker import calendar_valid


def plan_for(schema=None, pointer="/properties/date", cases=None):
    schema = schema or {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
                        "properties": {"date": {"type": "string", "format": "date"}}}
    content = json.dumps(schema)
    raw = content.encode()
    return {"kind": "json_schema_format", "hypothesis": "schema_alone_checks_calendar",
            "rationale": "Проверить календарную корректность поля на синтетической выборке.",
            "schema": {"repository": "example/project", "commit": "a" * 40,
                       "path": "tests/schema.json", "content": content,
                       "blob_sha": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(),
                       "sha256": hashlib.sha256(raw).hexdigest(),
                       "url": "https://github.com/example/project/blob/" + "a" * 40 + "/tests/schema.json"},
            "pointer": pointer,
            "cases": cases or [{"value": "2024-02-29", "expected_valid": True},
                               {"value": "2023-02-29", "expected_valid": False}]}


@pytest.mark.asyncio
async def test_actual_schema_validator_compares_calendar_and_format_checker():
    plan = plan_for(cases=[{"value": value, "expected_valid": valid} for value, valid in
                           [("2024-02-29", True), ("2023-02-29", False), ("2026-04-31", False),
                            ("2026-13-12", False), ("2026-09-13", True)]])
    result = await run_schema_experiment(plan)
    assert result["outcome"] == "counterexample_found"
    assert result["counterexamples"] == 3
    assert all(row["schema_valid"] for row in result["cases"])
    assert all(row["format_checked_valid"] == row["calendar_valid"] for row in result["cases"])
    assert result["scope"] == "field_schema_synthetic_cases"
    assert result["source"]["sha256"] == plan["schema"]["sha256"]
    assert "content" not in result["source"]
    assert result["validator_version"]


@pytest.mark.asyncio
async def test_datetime_with_actual_local_ref_and_full_definition_context():
    schema = {"$schema": "http://json-schema.org/draft-07/schema#", "$id": "https://example.test/root.json",
              "definitions": {"allowed": {"type": "string", "minLength": 20},
                              "invocation": {"properties": {"startTimeUtc": {
                                  "format": "date-time", "allOf": [{"$ref": "#/definitions/allowed"}]}}}}}
    cases = [{"value": value, "expected_valid": valid} for value, valid in
             [("2024-02-29T12:00:00Z", True), ("2026-02-30T12:00:00Z", False),
              ("2026-09-13T12:00:00+01:60", False)]]
    result = await run_schema_experiment(plan_for(schema, "/definitions/invocation/properties/startTimeUtc", cases))
    assert result["counterexamples"] == 2
    assert result["cases"][0]["format_checked_valid"]
    assert not result["cases"][1]["format_checked_valid"]
    assert not result["cases"][2]["calendar_valid"]


@pytest.mark.asyncio
async def test_schema_constraints_are_used_not_just_format():
    schema = {"properties": {"date": {"type": "string", "format": "date", "enum": ["2024-02-29"]}}}
    result = await run_schema_experiment(plan_for(schema))
    assert result["outcome"] == "supported_on_cases"
    assert not result["cases"][1]["schema_valid"]


@pytest.mark.asyncio
@pytest.mark.parametrize("cases", [
    [{"value": "2023-02-29", "expected_valid": False}],
    [{"value": "2024-02-29", "expected_valid": True}],
])
async def test_missing_control_coverage_is_inconclusive(cases):
    result = await run_schema_experiment(plan_for(cases=cases))
    assert result["outcome"] == "inconclusive"
    assert result["control_coverage"] is False


@pytest.mark.asyncio
async def test_no_structurally_accepted_cases_is_inconclusive():
    result = await run_schema_experiment(plan_for({"properties": {"date": {"type": "number", "format": "date"}}}))
    assert result["outcome"] == "inconclusive"
    assert not any(row["schema_valid"] for row in result["cases"])


def test_schema_fields_escapes_pointers_and_ignores_example_payloads():
    schema = {"properties": {"id": {"type": "string"}, "a/b~c": {"format": "date", "description": "x" * 400}},
              "examples": [{"format": "date-time", "$ref": "https://example.test/data"}]}
    assert schema_fields(json.dumps(schema)) == [{"pointer": "/properties/a~1b~0c", "format": "date", "description": "x" * 300}]
    plan = plan_for(schema, "/examples/0")
    with pytest.raises(ValueError, match="explicit date"):
        validate_schema_plan(plan)


@pytest.mark.parametrize("key,value", [("sha256", "0" * 64), ("blob_sha", "0" * 40),
                                     ("url", "https://example.test/schema"), ("commit", "main")])
def test_provenance_tampering_is_rejected(key, value):
    plan = plan_for()
    plan["schema"][key] = value
    with pytest.raises(ValueError):
        validate_schema_plan(plan)


@pytest.mark.parametrize("ref", ["https://example.test/schema", "file:///etc/passwd", "#anchor", "//example.test/schema"])
def test_external_and_anchor_refs_rejected_before_process_creation(ref):
    plan = plan_for({"properties": {"date": {"format": "date", "allOf": [{"$ref": ref}]}}})
    with pytest.raises(ValueError, match="references"):
        validate_schema_plan(plan)


def test_nested_identifier_is_rejected_but_property_named_id_is_allowed():
    schema = {"properties": {"id": {"type": "string"}, "date": {"format": "date", "$id": "nested"}}}
    with pytest.raises(ValueError, match="identifiers"):
        validate_schema_plan(plan_for(schema))


@pytest.mark.asyncio
@pytest.mark.parametrize("schema", [
    {"properties": {"date": {"format": "date", "type": "not-a-type"}}},
    {"$schema": "https://example.test/unknown-dialect", "properties": {"date": {"format": "date"}}},
])
async def test_invalid_schema_or_dialect_never_reports_success(schema):
    with pytest.raises(ValueError, match="worker failed"):
        await run_schema_experiment(plan_for(schema))


@pytest.mark.asyncio
async def test_recursive_schema_is_bounded_and_does_not_claim_result():
    schema = {"properties": {"date": {"format": "date", "allOf": [{"$ref": "#/properties/date"}]}}}
    with pytest.raises(ValueError, match="worker failed"):
        await run_schema_experiment(plan_for(schema))


@pytest.mark.asyncio
async def test_timeout_kills_and_reaps_child(monkeypatch, tmp_path):
    worker = tmp_path / "sleep_worker.py"
    worker.write_text("import time\ntime.sleep(60)\n")
    monkeypatch.setattr(experiment, "WORKER_PATH", worker)
    monkeypatch.setattr(experiment, "WORKER_TIMEOUT", 0.05)
    processes = []
    create = asyncio.create_subprocess_exec
    async def capture(*args, **kwargs):
        process = await create(*args, **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(experiment.asyncio, "create_subprocess_exec", capture)
    with pytest.raises(asyncio.TimeoutError):
        await run_schema_experiment(plan_for())
    assert len(processes) == 1 and processes[0].returncode is not None


@pytest.mark.asyncio
async def test_child_cannot_inherit_api_keys(monkeypatch):
    monkeypatch.setenv("SECRET_TEST_API_KEY", "must-not-cross-worker-boundary")
    create = asyncio.create_subprocess_exec
    async def inspect(*args, **kwargs):
        assert "SECRET_TEST_API_KEY" not in kwargs["env"]
        assert "shell" not in kwargs
        return await create(*args, **kwargs)
    monkeypatch.setattr(experiment.asyncio, "create_subprocess_exec", inspect)
    await run_schema_experiment(plan_for())


@pytest.mark.asyncio
async def test_cancellation_kills_and_reaps_child(monkeypatch, tmp_path):
    worker = tmp_path / "cancel_worker.py"
    worker.write_text("import time\ntime.sleep(60)\n")
    monkeypatch.setattr(experiment, "WORKER_PATH", worker)
    created = asyncio.Event()
    processes = []
    create = asyncio.create_subprocess_exec
    async def capture(*args, **kwargs):
        process = await create(*args, **kwargs)
        processes.append(process)
        created.set()
        return process
    monkeypatch.setattr(experiment.asyncio, "create_subprocess_exec", capture)
    task = asyncio.create_task(run_schema_experiment(plan_for()))
    await created.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert processes[0].returncode is not None


@pytest.mark.asyncio
async def test_excess_output_is_rejected_and_child_reaped(monkeypatch, tmp_path):
    worker = tmp_path / "output_worker.py"
    worker.write_text("import sys\nsys.stdin.buffer.read()\nsys.stdout.write('x' * 100000)\n")
    monkeypatch.setattr(experiment, "WORKER_PATH", worker)
    with pytest.raises(ValueError, match="output exceeds limit"):
        await run_schema_experiment(plan_for())


@pytest.mark.asyncio
async def test_worker_results_are_checked_before_return():
    import copy
    plan = plan_for()
    result = await run_schema_experiment(plan)
    for key, value in (("outcome", "success"), ("counterexamples", 999), ("scope", "production_bug"),
                       ("source", {}), ("cases", [])):
        malformed = copy.deepcopy(result)
        malformed[key] = value
        with pytest.raises(ValueError):
            experiment._validate_result(malformed, plan)


@pytest.mark.parametrize("value", ["2016-12-31T23:59:60Z", "0000-01-01T00:00:00Z"])
def test_unsupported_calendar_samples_do_not_become_false_counterexamples(value):
    schema = {"properties": {"date": {"format": "date-time"}}}
    with pytest.raises(ValueError, match="Leap-second|Year zero"):
        validate_schema_plan(plan_for(schema, cases=[{"value": value, "expected_valid": True}]))


@pytest.mark.parametrize("value,format_name,expected", [
    ("2024-02-29", "date", True), ("2024-2-29", "date", False),
    ("2023-02-29", "date", False), ("0000-01-01", "date", False),
    ("2026-09-13T12:00:00", "date-time", False),
    ("2026-09-13t12:00:00z", "date-time", True),
    ("2026-09-13T12:00:00+24:00", "date-time", False),
    ("2026-09-13T12:00:00+01:60", "date-time", False),
    ("2026-09-13T25:00:00Z", "date-time", False),
    ("2026-02-30T12:00:00Z", "date-time", False),
    ("2026-09-13T12:00:00.123+02:00", "date-time", True),
])
def test_independent_parser_requires_real_calendar_and_timezone(value, format_name, expected):
    assert calendar_valid(value, format_name) is expected


def test_duplicate_json_keys_and_oversize_content_are_rejected():
    with pytest.raises(ValueError, match="Duplicate"):
        schema_fields('{"properties": {}, "properties": {}}')
    with pytest.raises(ValueError, match="limit"):
        schema_fields(" " * (experiment.MAX_SCHEMA_BYTES + 1))
