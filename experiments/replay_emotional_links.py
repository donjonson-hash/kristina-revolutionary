"""Run with: python -B -S -m experiments.replay_emotional_links

Uses only the standard library and four in-memory EmotionalCore instances.
No model, chat transport, global event bus or persistent memory is initialized.
"""

from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
import math

from emotional_core import EmotionalCore
from experiments.emotional_links import AXES, DEFAULT_CONNECTIONS, LinkReplay, digest


START = datetime(2026, 9, 20, 10, tzinfo=timezone.utc)
# Numerical stimuli, not interpreted messages or claims about real experiences.
# Magnitudes match existing appraisal/experiment effects; semantic appraisal is
# intentionally outside this experiment. Every fixture is labelled synthetic.
FIXTURES = (
    {"id": "curiosity", "minute": 0, "delta": {"curiosity": 0.08}},
    {"id": "concern", "minute": 15, "delta": {"anxiety": 0.06, "energy": -0.02}},
    {"id": "frustration", "minute": 30, "delta": {"irritation": 0.06, "curiosity": -0.02}},
    {"id": "success", "minute": 45, "delta": {"happiness": 0.03}},
)
MUTATED_EDGE = "anxiety-curiosity"


def _run_arm(connections):
    now = START
    core = EmotionalCore(db_path=None, clock=lambda: now)
    links = LinkReplay(connections)
    rows = []
    for fixture in FIXTURES:
        now = START + timedelta(minutes=fixture["minute"])
        before = core.evolve()["state"]  # Circadian evolution occurs BEFORE the impulse.
        for axis, change in fixture["delta"].items():
            core.state[axis] += change  # Only this isolated core receives synthetic stimuli.
        after = core.evolve()["state"]  # Same instant; applies the core's own clamp.
        receipt = links.observe(event_id=fixture["id"], at=now, before=before, after=after,
                                source_kind="synthetic_fixture", source_ref=digest(fixture))
        if receipt["status"] != "accepted":
            raise RuntimeError("fixture unexpectedly blocked")
        rows.append(receipt)
        if core.state != after:
            raise AssertionError("shadow mutated the baseline core")
    now += timedelta(hours=4)
    idle_baseline = core.evolve()["state"]
    idle = links.sample(at=now, baseline=idle_baseline)
    return {"rules": links.manifest, "events": rows,
            "idle": {"at": now.isoformat(), "baseline": idle_baseline, **idle}}


def verify_arms(arms):
    """Observable causal checks, separate from transmission and acceptance.

    A crash or an arbitrary discrepancy is NOT a successful mutation test.
    """
    control, linked, mutant, restored = (arms[key] for key in
                                         ("control", "linked", "mutant", "restored"))
    concern = linked["events"][1]
    broken = mutant["events"][1]
    active_delta = concern["state"]["curiosity"] - control["events"][1]["state"]["curiosity"]
    lost_delta = broken["state"]["curiosity"] - control["events"][1]["state"]["curiosity"]
    non_target = lambda row: [item for item in row["transmissions"] if item["edge"] != MUTATED_EDGE]
    return {
        "control_equals_existing_core": all(row["state"] == row["event"]["after"]
                                             for row in control["events"]),
        "all_arms_received_identical_events": all(
            [row["event_sha256"] for row in arm["events"]]
            == [row["event_sha256"] for row in control["events"]] for arm in arms.values()),
        "curiosity_excites_creativity": math.isclose(
            linked["events"][0]["offset"]["creativity"], 0.04, abs_tol=1e-12),
        "anxiety_inhibits_curiosity": math.isclose(active_delta, -0.024, abs_tol=1e-12),
        "mutant_loses_exactly_selected_inhibition": (
            math.isclose(lost_delta, 0.0, abs_tol=1e-12)
            and all(non_target(a) == non_target(b)
                    and all(a["state"][axis] == b["state"][axis]
                            for axis in AXES if axis != "curiosity")
                    for a, b in zip(linked["events"], mutant["events"]))),
        "irritation_inhibits_happiness": math.isclose(
            linked["events"][2]["offset"]["happiness"], -0.018, abs_tol=1e-12),
        "happiness_inhibits_anxiety": math.isclose(
            linked["events"][3]["offset"]["anxiety"], -0.0075, abs_tol=1e-12),
        "restored_graph_and_entire_trajectory_match": linked == restored,
        "four_hour_idle_only_decays_offset": all(math.isclose(
            linked["idle"]["offset"][axis], linked["events"][-1]["offset"][axis] * math.exp(-2),
            abs_tol=1e-12) for axis in AXES),
        "bounded_states_and_work": all(
            row["actions"] <= arm["rules"]["max_actions"]
            and all(math.isfinite(v) and 0.1 <= v <= 1 for v in row["state"].values())
            and all(abs(v) <= 0.12 for v in row["offset"].values())
            for arm in arms.values() for row in arm["events"]),
    }


def run_experiment():
    # Change exactly one edge in a copy, then undo that change in the mutant.
    mutant = tuple(replace(edge, weight=0.0) if edge.id == MUTATED_EDGE else edge
                   for edge in DEFAULT_CONNECTIONS)
    original_weight = next(edge.weight for edge in DEFAULT_CONNECTIONS if edge.id == MUTATED_EDGE)
    restored = tuple(replace(edge, weight=original_weight) if edge.id == MUTATED_EDGE else edge
                     for edge in mutant)
    arms = {name: _run_arm(graph) for name, graph in (
        ("control", ()), ("linked", DEFAULT_CONNECTIONS), ("mutant", mutant), ("restored", restored))}
    checks = verify_arms(arms)
    return {
        "version": 1, "scope": "synthetic_offline_shadow",
        "status": "supported_on_cases" if all(checks.values()) else "counterexample_found",
        "sources": {
            "kristina_base": "89f455ce0182d25f010faf4e7e7dd9530dba356d",
            "drydock_design_reference": "405cc1f6dc47cecc2c2671ced9aad10ede644500",
        },
        "fixtures": FIXTURES, "fixtures_sha256": digest(FIXTURES),
        "mutation": {"edge": MUTATED_EDGE, "baseline_weight": original_weight,
                     "mutant_weight": 0.0, "restored_weight": original_weight},
        "checks": checks, "arms": arms,
    }


def summarize(report):
    """Compact, reproducible artifact; full receipts remain available from CLI."""
    return {
        key: report[key] for key in ("version", "scope", "status", "sources", "fixtures_sha256",
                                    "mutation", "checks")
    } | {"rules": [asdict(edge) for edge in DEFAULT_CONNECTIONS], "arms": {
        name: {"trajectory_sha256": digest(arm), "events": [
            {"id": row["event"]["id"], "state": row["state"], "offset": row["offset"],
             "actions": row["actions"]} for row in arm["events"]], "idle": arm["idle"]}
        for name, arm in report["arms"].items()}}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", action="store_true", help="emit a compact result instead of full receipts")
    args = parser.parse_args()
    result = run_experiment()
    print(json.dumps(summarize(result) if args.summary else result, indent=2, sort_keys=True, allow_nan=False))
    raise SystemExit(0 if result["status"] == "supported_on_cases" else 1)
