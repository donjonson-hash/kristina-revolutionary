"""Causal, failure and isolation checks for the opt-in non-LLM experiment."""

from copy import deepcopy
from datetime import timedelta
import json
import math
from pathlib import Path
import subprocess
import sys

import pytest

from emotional_core import EmotionalCore
from experiments import emotional_links as module
from experiments.emotional_links import AXES, Connection, DEFAULT_CONNECTIONS, LinkReplay, digest
from experiments.replay_emotional_links import START, run_experiment, summarize, verify_arms


def event(event_id="test", at=START, **changes):
    before = dict.fromkeys(AXES, 0.5)
    after = {axis: before[axis] + changes.get(axis, 0) for axis in AXES}
    return dict(event_id=event_id, at=at, before=before, after=after,
                source_kind="synthetic_fixture", source_ref="test-fixture")


def test_control_mutant_and_actual_inverse_restoration():
    report = run_experiment()
    assert report["status"] == "supported_on_cases"
    assert all(report["checks"].values())
    assert report == run_experiment()
    linked = report["arms"]["linked"]
    mutant = report["arms"]["mutant"]
    assert linked == report["arms"]["restored"]
    assert linked != mutant
    original = linked["rules"]["connections"]
    broken = mutant["rules"]["connections"]
    assert sum(a != b for a, b in zip(original, broken)) == 1
    # A random unrelated break is not evidence for the selected mutation.
    damaged = deepcopy(report["arms"])
    damaged["mutant"]["events"][1]["state"]["happiness"] -= 0.01
    assert not verify_arms(damaged)["mutant_loses_exactly_selected_inhibition"]


def test_duplicate_is_once_and_conflicting_reuse_cannot_change_accepted_state():
    replay = LinkReplay()
    impulse = event(curiosity=0.1)
    original = replay.observe(**impulse)
    replay.observe(**event("later", at=START + timedelta(hours=1), anxiety=0.1))
    sample = replay.sample(at=START + timedelta(hours=2), baseline=impulse["after"])
    assert replay.observe(**impulse) == original
    assert replay.sample(at=START + timedelta(hours=2), baseline=impulse["after"]) == sample
    conflicting = deepcopy(impulse)
    conflicting["after"]["curiosity"] += 0.1
    with pytest.raises(ValueError, match="reused"):
        replay.observe(**conflicting)
    assert replay.sample(at=START + timedelta(hours=2), baseline=impulse["after"]) == sample


def test_detached_inputs_receipts_and_manifest():
    replay = LinkReplay()
    impulse = event(curiosity=0.1)
    saved_input = deepcopy(impulse)
    receipt = replay.observe(**impulse)
    saved_receipt = deepcopy(receipt)
    receipt["offset"]["creativity"] = 900
    receipt["event"]["after"]["curiosity"] = 0.1
    impulse["after"]["curiosity"] = 0.1
    manifest = replay.manifest
    manifest["connections"][0]["weight"] = 900
    assert replay.observe(**saved_input) == saved_receipt
    assert replay.sample(at=START, baseline=saved_input["after"])["offset"]["creativity"] == pytest.approx(0.05)
    assert replay.manifest != manifest


def test_idle_and_zero_delta_ticks_do_not_generate_new_impulses():
    one_step, many_steps = LinkReplay(), LinkReplay()
    impulse = event(curiosity=0.1)
    for replay in (one_step, many_steps):
        replay.observe(**impulse)
    for minute in range(1, 61):
        at = START + timedelta(minutes=minute)
        # A read-only sample must not mutate the prior accepted time/offset.
        before = many_steps.sample(at=at, baseline=impulse["after"])
        assert many_steps.sample(at=at, baseline=impulse["after"]) == before
        tick = event(f"idle-{minute}", at=at)
        receipt = many_steps.observe(**tick)
        assert receipt["actions"] == 0
    at = START + timedelta(hours=1)
    expected = one_step.sample(at=at, baseline=impulse["after"])
    actual = many_steps.sample(at=at, baseline=impulse["after"])
    assert actual["offset"] == pytest.approx(expected["offset"], abs=1e-12)
    assert expected["offset"]["creativity"] == pytest.approx(0.05 * math.exp(-0.5))


def test_cyclic_graph_transmits_only_direct_impulses_once_per_edge():
    links = (Connection("forward", "curiosity", "creativity", 0.5),
             Connection("back", "creativity", "curiosity", 0.5))
    receipt = LinkReplay(links).observe(**event(curiosity=0.1))
    assert receipt["actions"] == 1
    assert receipt["offset"]["creativity"] == pytest.approx(0.05)
    assert receipt["offset"]["curiosity"] == 0


def test_catalog_order_does_not_change_results_and_zero_weights_equal_control():
    impulse = event(curiosity=0.1, anxiety=0.1, happiness=0.1)
    assert LinkReplay(DEFAULT_CONNECTIONS).observe(**impulse) == LinkReplay(
        list(reversed(DEFAULT_CONNECTIONS))).observe(**impulse)
    zero = [Connection(edge.id, edge.source, edge.target, 0) for edge in DEFAULT_CONNECTIONS]
    receipt = LinkReplay(zero).observe(**impulse)
    assert receipt["state"] == impulse["after"]
    assert receipt["actions"] == 0


def test_work_budget_blocks_entire_event_and_no_accepted_state_is_lost():
    replay = LinkReplay(max_actions=1)
    impulse = event(curiosity=0.1)
    saved = replay.observe(**impulse)
    rejected = event("over-budget", at=START + timedelta(hours=1), anxiety=0.1, curiosity=0.1)
    blocked = replay.observe(**rejected)
    assert blocked["status"] == "blocked"
    assert blocked["required_actions"] == 2
    assert replay.sample(at=START, baseline=impulse["after"])["offset"] == saved["offset"]
    # Blocked input was never committed to the idempotency ledger.
    retry = event("over-budget", at=START, anxiety=0.1)
    assert replay.observe(**retry)["status"] == "accepted"


@pytest.mark.parametrize("failure", ["exception", "wrong_weight", "wrong_target", "bad_candidate"])
def test_failed_worker_or_verifier_does_not_commit_partial_output(monkeypatch, failure):
    replay = LinkReplay()
    impulse = event(curiosity=0.1)
    saved = replay.observe(**impulse)
    real_transmit, real_candidate = module._transmit, module._candidate
    calls = []

    def bad_transmit(edge, delta):
        calls.append(edge.id)
        proposal = real_transmit(edge, delta)
        if len(calls) == 2:
            if failure == "exception":
                raise RuntimeError("worker failed after one proposal")
            if failure == "wrong_weight":
                proposal["contribution"] *= -1
            if failure == "wrong_target":
                proposal["target"] = "energy"
        return proposal

    def bad_candidate(*args):
        proposal = real_candidate(*args)
        proposal["state"]["energy"] += 0.01
        return proposal

    with monkeypatch.context() as patch:
        patch.setattr(module, "_transmit", bad_transmit)
        if failure == "bad_candidate":
            patch.setattr(module, "_candidate", bad_candidate)
        with pytest.raises((ValueError, RuntimeError)):
            replay.observe(**event("failed", at=START + timedelta(hours=1), anxiety=0.1, curiosity=0.1))
    assert replay.sample(at=START, baseline=impulse["after"])["offset"] == saved["offset"]
    accepted = replay.observe(**event("failed", anxiety=0.1))
    assert accepted["previous_receipt_sha256"] == saved["receipt_sha256"]


def test_trace_accounts_for_saturation_at_both_bounds():
    links = (Connection("up", "curiosity", "creativity", 1),
             Connection("down", "curiosity", "happiness", -1))
    impulse = event(curiosity=0.4)
    impulse["before"].update(creativity=0.98, happiness=0.11)
    impulse["after"].update(creativity=0.98, happiness=0.11)
    row = LinkReplay(links).observe(**impulse)
    assert row["offset"]["creativity"] == 0.12
    assert row["offset"]["happiness"] == -0.12
    assert row["state"]["creativity"] == 1.0
    assert row["state"]["happiness"] == 0.1
    for axis in AXES:
        assert row["raw_offset"][axis] - row["offset_clipping"][axis] == pytest.approx(row["offset"][axis])
        assert row["event"]["after"][axis] + row["offset"][axis] - row["state_clipping"][axis] == pytest.approx(row["state"][axis])


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf"), True, "0.5", 0, 1.1])
def test_malformed_snapshot_does_not_change_state(bad):
    replay = LinkReplay()
    impulse = event(curiosity=0.1)
    saved = replay.observe(**impulse)
    broken = event("broken", at=START + timedelta(hours=1))
    broken["after"]["energy"] = bad
    with pytest.raises(ValueError):
        replay.observe(**broken)
    assert replay.sample(at=START, baseline=impulse["after"])["offset"] == saved["offset"]


@pytest.mark.parametrize("case", ["missing_axis", "unknown_axis", "source", "missing_evidence", "naive", "reverse"])
def test_incomplete_unknown_or_out_of_order_event_is_rejected(case):
    replay = LinkReplay()
    replay.observe(**event())
    broken = event("broken")
    if case == "missing_axis":
        del broken["before"]["energy"]
    elif case == "unknown_axis":
        broken["after"]["fear"] = 0.5
    elif case == "source":
        broken["source_kind"] = "assistant_self_report"
    elif case == "missing_evidence":
        broken["source_ref"] = ""
    elif case == "naive":
        broken["at"] = START.replace(tzinfo=None)
    else:
        broken["at"] -= timedelta(seconds=1)
    with pytest.raises(ValueError):
        replay.observe(**broken)
    assert replay.sample(at=START, baseline=event()["after"])["offset"] == dict.fromkeys(AXES, 0)


def test_event_budget_has_no_eviction_that_could_reapply_old_events():
    replay = LinkReplay()
    original = replay.observe(**event("0", curiosity=0.1))
    for i in range(1, module.MAX_EVENTS):
        replay.observe(**event(str(i)))
    with pytest.raises(ValueError, match="event budget"):
        replay.observe(**event("overflow"))
    assert replay.observe(**event("0", curiosity=0.1)) == original


@pytest.mark.parametrize("connections", [
    [Connection("x", "unknown", "happiness", 0.5)],
    [Connection("x", "curiosity", "curiosity", 0.5)],
    [Connection("x", "curiosity", "happiness", float("nan"))],
    [Connection("x", "curiosity", "happiness", True)],
    [Connection("x", "curiosity", "happiness", 1.1)],
    [Connection("x", "curiosity", "happiness", 0.5)] * 2,
    list(DEFAULT_CONNECTIONS) * 5,
])
def test_invalid_catalog_is_rejected(connections):
    with pytest.raises(ValueError):
        LinkReplay(connections)


def test_receipts_bind_inputs_rules_and_preceding_accepted_event():
    replay = LinkReplay()
    first = replay.observe(**event("first", curiosity=0.1))
    second = replay.observe(**event("second", anxiety=0.1))
    assert first["previous_receipt_sha256"] is None
    assert second["previous_receipt_sha256"] == first["receipt_sha256"]
    for row in (first, second):
        assert row["event_sha256"] == digest(row["event"])
        assert row["rules_sha256"] == digest(replay.manifest)
        claimed = row.pop("receipt_sha256")
        assert claimed == digest(row)


def test_no_network_database_model_or_live_pipeline_in_fresh_process(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    # The audit hook rejects side effects, including transient writes subsequently
    # deleted. -S removes installed dependencies; -B prevents bytecode writes.
    script = '''
import json, os, sys
sys.path.insert(0, sys.argv[1])
def guard(event, args):
    if event.startswith(("socket.", "sqlite3.connect", "subprocess.")) or event == "os.system":
        raise AssertionError("unexpected side effect: " + event)
    if event == "open":
        mode, flags = args[1], args[2]
        if (isinstance(mode, str) and any(c in mode for c in "wax+")) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
            raise AssertionError("unexpected file write")
sys.addaudithook(guard)
from experiments.replay_emotional_links import run_experiment, summarize
report = run_experiment()
assert report["status"] == "supported_on_cases"
assert not set(("ai_client", "cognitive_appraisal", "brain_integration", "event_bus", "mood_engine")) & set(sys.modules)
import emotional_core
assert emotional_core._emotional_core is None
print(json.dumps(summarize(report), sort_keys=True))
'''
    result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", script, str(repo)],
                            cwd=tmp_path, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == summarize(run_experiment())
    assert not list(tmp_path.iterdir())


def test_replay_uses_existing_seven_axis_core_without_mutating_global_instance():
    import emotional_core
    core = EmotionalCore(clock=lambda: START)
    assert set(core.state) == set(AXES)
    assert emotional_core._emotional_core is None
    run_experiment()
    assert emotional_core._emotional_core is None
