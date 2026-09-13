"""Provenance-checked, bounded experiments on repository JSON Schema fields."""

import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote


MAX_SCHEMA_BYTES = 300_000
MAX_INPUT_BYTES = 2_000_000  # JSON escaping can expand repository text.
MAX_OUTPUT_BYTES = 32_000
WORKER_TIMEOUT = 5.0
WORKER_PATH = Path(__file__).with_name("schema_experiment_worker.py")


def _text(value, limit, label):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"Invalid {label}")
    return value


def _load_schema(content):
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_SCHEMA_BYTES:
        raise ValueError("Schema content exceeds limit")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate schema key")
            result[key] = value
        return result
    try:
        root = json.loads(content, object_pairs_hook=unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    except (RecursionError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid schema JSON") from exc
    if not isinstance(root, dict):
        raise ValueError("Schema root must be an object")
    count = 0
    pending = [(root, "", 0)]
    while pending:
        node, pointer, depth = pending.pop()
        count += 1
        if count > 20_000 or depth > 64:
            raise ValueError("Schema complexity exceeds limit")
        if isinstance(node, dict):
            pending.extend((value, pointer + "/" + _escape(key), depth + 1)
                           for key, value in node.items())
        elif isinstance(node, list):
            pending.extend((value, pointer + "/" + str(i), depth + 1)
                           for i, value in enumerate(node))
    for node, pointer in _schema_nodes(root):
        if pointer and ("$id" in node or "id" in node):
            raise ValueError("Nested schema identifiers are unsupported")
        if any(key in node for key in ("$dynamicRef", "$recursiveRef", "$anchor", "$dynamicAnchor")):
            raise ValueError("Only local JSON Pointer references are supported")
        if "$ref" in node:
            ref = node["$ref"]
            if not isinstance(ref, str) or (ref != "#" and not ref.startswith("#/")):
                raise ValueError("External or anchor schema references are forbidden")
            resolve_pointer(root, ref[1:])
    return root


def _schema_nodes(root):
    """Walk schema-bearing keywords; examples/const/properties names remain data."""
    pending = [(root, "")]
    maps = {"properties", "patternProperties", "definitions", "$defs", "dependentSchemas", "dependencies"}
    singles = {"additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else",
               "unevaluatedProperties", "unevaluatedItems", "contentSchema"}
    arrays = {"allOf", "anyOf", "oneOf", "prefixItems"}
    while pending:
        node, pointer = pending.pop()
        if not isinstance(node, dict):
            continue
        yield node, pointer
        for key, child in node.items():
            location = pointer + "/" + _escape(key)
            if key in maps and isinstance(child, dict):
                pending.extend((value, location + "/" + _escape(name)) for name, value in child.items()
                               if isinstance(value, dict))
            elif key in singles or (key == "items" and isinstance(child, dict)):
                pending.append((child, location))
            elif (key in arrays or key == "items") and isinstance(child, list):
                pending.extend((value, location + "/" + str(i)) for i, value in enumerate(child))


def _escape(value):
    return value.replace("~", "~0").replace("/", "~1")


def resolve_pointer(root, pointer):
    if not isinstance(pointer, str) or (pointer and not pointer.startswith("/")):
        raise ValueError("Invalid JSON Pointer")
    node = root
    if not pointer:
        return node
    for part in pointer[1:].split("/"):
        if re.search(r"~(?![01])", part):
            raise ValueError("Invalid JSON Pointer escape")
        key = part.replace("~1", "/").replace("~0", "~")
        try:
            if isinstance(node, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", key):
                    raise ValueError("Invalid array pointer")
                node = node[int(key)]
            else:
                node = node[key]
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError("Schema pointer does not resolve") from exc
    return node


def schema_fields(content):
    """List explicitly declared date fields; schemas are data, never instructions."""
    root = _load_schema(content)
    fields = []
    for node, pointer in _schema_nodes(root):
        if node.get("format") in ("date", "date-time"):
            description = node.get("description", "")
            fields.append({"pointer": pointer, "format": node["format"],
                           "description": description[:300] if isinstance(description, str) else ""})
    return sorted(fields, key=lambda field: field["pointer"])


def validate_schema_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"kind", "hypothesis", "rationale", "schema", "pointer", "cases"}:
        raise ValueError("Unexpected schema experiment fields")
    if plan["kind"] != "json_schema_format" or plan["hypothesis"] != "schema_alone_checks_calendar":
        raise ValueError("Unsupported schema experiment")
    _text(plan["rationale"], 300, "rationale")
    source = plan["schema"]
    keys = {"repository", "commit", "path", "blob_sha", "sha256", "content", "url"}
    if not isinstance(source, dict) or set(source) != keys:
        raise ValueError("Unexpected schema source fields")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", _text(source["repository"], 200, "repository")):
        raise ValueError("Invalid repository")
    for key, length in (("commit", 40), ("blob_sha", 40), ("sha256", 64)):
        if not isinstance(source[key], str) or not re.fullmatch("[0-9a-f]{%d}" % length, source[key]):
            raise ValueError("Invalid source digest")
    path = _text(source["path"], 1000, "schema path")
    if path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")):
        raise ValueError("Invalid schema path")
    expected_url = f"https://github.com/{source['repository']}/blob/{source['commit']}/{quote(path, safe='/')}"
    if source["url"] != expected_url:
        raise ValueError("Schema URL must identify its pinned source")
    root = _load_schema(source["content"])
    raw = source["content"].encode("utf-8")
    blob = b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw
    if hashlib.sha256(raw).hexdigest() != source["sha256"] or hashlib.sha1(blob).hexdigest() != source["blob_sha"]:
        raise ValueError("Schema provenance digest mismatch")
    pointer = plan["pointer"]
    if not isinstance(pointer, str) or len(pointer) > 1000:
        raise ValueError("Invalid field pointer")
    field = resolve_pointer(root, pointer)
    if not isinstance(field, dict) or field.get("format") not in ("date", "date-time") or not any(
            location == pointer for _, location in _schema_nodes(root)):
        raise ValueError("Pointer must identify an explicit date or date-time field")
    cases = plan["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= 8:
        raise ValueError("Schema experiment requires one to eight cases")
    for case in cases:
        if not isinstance(case, dict) or set(case) != {"value", "expected_valid"}:
            raise ValueError("Unexpected schema case fields")
        if not isinstance(case["value"], str) or len(case["value"]) > 64 or type(case["expected_valid"]) is not bool:
            raise ValueError("Invalid schema experiment case")
        if field["format"] == "date-time" and re.match(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:60", case["value"]):
            raise ValueError("Leap-second samples require an unsupported astronomical calendar check")
        if case["value"].startswith("0000-"):
            raise ValueError("Year zero is outside the independent parser range")
    return {**plan, "schema": source.copy(), "cases": [case.copy() for case in cases]}


def _validate_result(result, plan):
    keys = {"kind", "hypothesis", "outcome", "cases", "counterexamples", "summary", "runner_version",
            "source", "validator_version", "schema_dialect", "format", "scope", "control_coverage", "limitations"}
    if not isinstance(result, dict) or set(result) != keys:
        raise ValueError("Unexpected worker result fields")
    if result["kind"] != plan["kind"] or result["hypothesis"] != plan["hypothesis"]:
        raise ValueError("Worker returned a different experiment")
    if result["outcome"] not in ("inconclusive", "counterexample_found", "supported_on_cases"):
        raise ValueError("Unknown worker outcome")
    source = {key: value for key, value in plan["schema"].items() if key != "content"}
    source["pointer"] = plan["pointer"]
    if result["source"] != source:
        raise ValueError("Worker result provenance mismatch")
    rows = result["cases"]
    if not isinstance(rows, list) or len(rows) != len(plan["cases"]):
        raise ValueError("Worker case count mismatch")
    flags = {"schema_valid", "format_checked_valid", "calendar_valid", "prediction_matches"}
    for row, case in zip(rows, plan["cases"]):
        if not isinstance(row, dict) or set(row) != flags | {"value", "expected_valid"}:
            raise ValueError("Invalid worker observations")
        if row["value"] != case["value"] or type(row["expected_valid"]) is not bool or row["expected_valid"] != case["expected_valid"]:
            raise ValueError("Worker input mismatch")
        if any(type(row[key]) is not bool for key in flags):
            raise ValueError("Invalid worker flags")
        if row["prediction_matches"] != (row["calendar_valid"] == row["expected_valid"]):
            raise ValueError("Inconsistent worker prediction")
    count = sum(row["schema_valid"] and not row["calendar_valid"] for row in rows)
    coverage = any(row["schema_valid"] and row["calendar_valid"] for row in rows) and any(not row["calendar_valid"] for row in rows)
    expected_outcome = "inconclusive" if not coverage else "counterexample_found" if count else "supported_on_cases"
    if type(result["counterexamples"]) is not int or result["counterexamples"] != count or result["control_coverage"] is not coverage or result["outcome"] != expected_outcome:
        raise ValueError("Inconsistent worker conclusion")
    if type(result["runner_version"]) is not int or result["runner_version"] != 1 or result["scope"] != "field_schema_synthetic_cases":
        raise ValueError("Invalid worker scope or version")
    field = resolve_pointer(_load_schema(plan["schema"]["content"]), plan["pointer"])
    if result["format"] != field["format"]:
        raise ValueError("Worker format mismatch")
    for key, limit in (("summary", 1000), ("validator_version", 50), ("schema_dialect", 200)):
        _text(result[key], limit, key)
    if not isinstance(result["limitations"], list) or not 1 <= len(result["limitations"]) <= 10:
        raise ValueError("Invalid worker limitations")
    for limitation in result["limitations"]:
        _text(limitation, 100, "limitation")
    return result


async def run_schema_experiment(plan):
    """Execute only the fixed validator worker, with bounded data and lifetime."""
    plan = validate_schema_plan(plan)
    payload = json.dumps(plan, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError("Experiment input exceeds limit")
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(WORKER_PATH), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": os.defpath, "LANG": "C.UTF-8"}, limit=MAX_OUTPUT_BYTES + 1)
    async def communicate():
        process.stdin.write(payload)
        await process.stdin.drain()
        process.stdin.close()
        output = await process.stdout.read(MAX_OUTPUT_BYTES + 1)
        if len(output) > MAX_OUTPUT_BYTES:
            raise ValueError("Experiment output exceeds limit")
        # read() may return before EOF; collect remaining bounded output.
        while True:
            chunk = await process.stdout.read(MAX_OUTPUT_BYTES + 1 - len(output))
            if not chunk:
                break
            output += chunk
            if len(output) > MAX_OUTPUT_BYTES:
                raise ValueError("Experiment output exceeds limit")
        await process.wait()
        return output
    try:
        output = await asyncio.wait_for(communicate(), timeout=WORKER_TIMEOUT)
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        # A full StreamReader pauses its pipe transport. Drain after killing so
        # Process.wait() cannot hang waiting for that transport to close.
        if not process.stdin.is_closing():
            process.stdin.close()
        while await process.stdout.read(4096):
            pass
        await process.wait()
    if process.returncode != 0:
        raise ValueError("Schema experiment worker failed or exceeded resource limits")
    try:
        envelope = json.loads(output)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("Invalid experiment worker response") from exc
    if not isinstance(envelope, dict) or set(envelope) != {"result"} or not isinstance(envelope["result"], dict):
        raise ValueError("Schema validation failed in isolated worker")
    return _validate_result(envelope["result"], plan)
