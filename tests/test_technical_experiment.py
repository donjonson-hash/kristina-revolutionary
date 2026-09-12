"""Actual calendar observations and bounded, data-only model selection."""

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from technical_experiment import choose_experiment, run_experiment, validate_plan


def plan(cases=None, hypothesis="predictions_hold"):
    return {"kind": "calendar_validation", "hypothesis": hypothesis,
            "rationale": "Хочу проверить календарные границы.",
            "cases": cases if cases is not None else [{"value": "2024-02-29", "expected_valid": True}]}


@pytest.mark.parametrize("value,format_valid,calendar_valid", [
    ("2024-02-29", True, True), ("2023-02-29", True, False),
    ("1900-02-29", True, False), ("2000-02-29", True, True),
    ("2026-13-12", True, False), ("2026-04-31", True, False),
    ("0000-01-01", True, False), ("9999-12-31", True, True),
    ("20260228", False, False), ("2026-W01-1", False, False),
    ("2026-01-01\n", False, False), ("２０２６-01-01", False, False),
    ("", False, False), ("2026-1-1", False, False),
])
def test_real_calendar_and_strict_format(value, format_valid, calendar_valid):
    result = run_experiment(plan([{"value": value, "expected_valid": calendar_valid}]))
    case = result["cases"][0]
    assert (case["format_valid"], case["calendar_valid"]) == (format_valid, calendar_valid)
    assert case["prediction_matches"] is True
    assert result["outcome"] == "supported_on_cases"


def test_counterexample_depends_on_hypothesis_not_expected_boolean():
    cases = [{"value": "2023-02-29", "expected_valid": False}]
    format_result = run_experiment(plan(cases, "format_implies_calendar_validity"))
    assert format_result["outcome"] == "counterexample_found"
    assert format_result["counterexamples"] == 1
    assert format_result["cases"][0]["prediction_matches"] is True
    assert run_experiment(plan(cases))["outcome"] == "supported_on_cases"
    wrong_prediction = run_experiment(plan([{"value": "2024-02-29", "expected_valid": False}]))
    assert wrong_prediction["counterexamples"] == 1
    assert wrong_prediction["outcome"] == "counterexample_found"


@pytest.mark.parametrize("change", [
    {"kind": "python"}, {"hypothesis": []}, {"hypothesis": "true"},
    {"rationale": ""}, {"rationale": " "}, {"rationale": "x" * 301},
    {"rationale": 123}, {"cases": []}, {"cases": {}},
    {"cases": [{"value": "x", "expected_valid": False}] * 9},
    {"cases": [{"value": "x" * 33, "expected_valid": False}]},
    {"cases": [{"value": 20260101, "expected_valid": False}]},
    {"cases": [{"value": "x", "expected_valid": 0}]},
    {"cases": [{"value": "x", "expected_valid": False, "code": "pass"}]},
    {"cases": [{"value": "x"}]}, {"command": "whoami"},
])
def test_unbounded_or_extra_instructions_are_rejected(change):
    with pytest.raises(ValueError):
        run_experiment(plan() | change)


def test_code_paths_and_urls_are_only_invalid_date_data(tmp_path):
    marker = tmp_path / "marker"
    values = ["__import__('os').abort()", "open('marker','w')", "https://example.com", "/etc/passwd"]
    selected = plan([{"value": value, "expected_valid": False} for value in values])
    result = run_experiment(selected)
    assert all(not case["format_valid"] and not case["calendar_valid"] for case in result["cases"])
    assert not marker.exists()
    assert "синтетической выборкой" in result["summary"]
    assert "внешние системы и реальные планы не проверялись" in result["summary"]
    assert run_experiment(selected) == result
    assert selected == validate_plan(selected)
    assert result["runner_version"] == 1


@pytest.mark.parametrize("response,expected", [
    ({"decision": "skip"}, None),
    ({"decision": "experiment", "plan": plan()}, plan()),
])
async def test_selection_one_call_closed_and_context_labelled(monkeypatch, response, expected):
    import technical_experiment as module
    client = SimpleNamespace(chat=AsyncMock(return_value=json.dumps(response)), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    result = await choose_experiment({"topic": "Валидация дат"}, datetime(2026, 9, 12, 12, tzinfo=timezone.utc))
    assert result == expected
    client.chat.assert_awaited_once()
    client.close.assert_awaited_once()
    assert client.chat.call_args.kwargs == {"temperature": 0.2, "max_tokens": 600}
    messages = client.chat.call_args.args[0]
    assert "2026-09-12T14:00:00+02:00" in messages[1]["content"]
    assert "interpretation" in messages[1]["content"] and "user_report" in messages[1]["content"]
    assert "Отпуск, ром, флирт" in messages[0]["content"]


@pytest.mark.parametrize("raw", [
    "provider unavailable", "null", "[]", "{}", '"skip"',
    '{"decision":"skip","plan":{}}', '{"decision":"experiment","plan":{}}',
    '{"decision":"later"}', "x" * 4001, None,
])
async def test_invalid_response_raises_for_worker_without_retry(monkeypatch, raw):
    import technical_experiment as module
    client = SimpleNamespace(chat=AsyncMock(return_value=raw), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    with pytest.raises(ValueError):
        await choose_experiment({"topic": "Валидация дат"})
    client.chat.assert_awaited_once()
    client.close.assert_awaited_once()


async def test_timeout_propagates_and_client_closes(monkeypatch):
    import technical_experiment as module
    client = SimpleNamespace(chat=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    deadlines = []
    async def timeout(coro, *, timeout):
        deadlines.append(timeout)
        coro.close()
        raise TimeoutError
    monkeypatch.setattr(module, "asyncio", SimpleNamespace(wait_for=timeout))
    with pytest.raises(TimeoutError):
        await choose_experiment({"topic": "Валидация дат"})
    assert deadlines == [20]
    assert client.chat.call_count == 1
    client.close.assert_awaited_once()


async def test_external_cancellation_propagates_and_closes(monkeypatch):
    import technical_experiment as module
    client = SimpleNamespace(chat=AsyncMock(side_effect=asyncio.CancelledError), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    with pytest.raises(asyncio.CancelledError):
        await choose_experiment({"topic": "Валидация дат"})
    client.close.assert_awaited_once()
