"""Bounded, non-LLM links over EmotionalCore's seven numerical axes.

This is an in-memory shadow model, not a production event consumer. Inputs are
same-instant snapshots of a *synthetic* event, after circadian evolution. Linked
outputs never become new input impulses. Source hashes bind data, not truth.
"""

from collections import deque
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import re


AXES = ("energy", "happiness", "curiosity", "anxiety", "loneliness",
        "creativity", "irritation")
LOW, HIGH = 0.1, 1.0
OFFSET_CAP = 0.12
TAU_SECONDS = 2 * 3600
MAX_CONNECTIONS = 16
MAX_EVENTS = 128


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def _number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def _state(value):
    if (not isinstance(value, dict) or set(value) != set(AXES)
            or any(not _number(v, LOW, HIGH) for v in value.values())):
        raise ValueError("state must contain exactly seven finite axes in [0.1, 1.0]")
    return {axis: float(value[axis]) for axis in AXES}


def _utc(at):
    if not isinstance(at, datetime) or at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("time must be an aware datetime")
    return at.astimezone(timezone.utc)


def _identifier(value):
    if not isinstance(value, str) or re.fullmatch(r"[a-zA-Z0-9._:-]{1,80}", value) is None:
        raise ValueError("identifier must be 1..80 ASCII letters, digits or ._:-")
    return value


def _clip(value, low, high):
    return max(low, min(high, value))


@dataclass(frozen=True)
class Connection:
    id: str
    source: str
    target: str
    weight: float


DEFAULT_CONNECTIONS = (
    Connection("anxiety-curiosity", "anxiety", "curiosity", -0.4),
    Connection("curiosity-creativity", "curiosity", "creativity", 0.5),
    Connection("irritation-happiness", "irritation", "happiness", -0.3),
    Connection("happiness-anxiety", "happiness", "anxiety", -0.25),
)


def _connections(connections):
    # Bound materialization too: do not consume an unbounded iterator.
    if not isinstance(connections, (tuple, list)) or len(connections) > MAX_CONNECTIONS:
        raise ValueError("connections must be a list/tuple with at most 16 edges")
    ids = set()
    pairs = set()
    for edge in connections:
        if not isinstance(edge, Connection):
            raise ValueError("unknown connection")
        _identifier(edge.id)
        if (edge.id in ids or edge.source not in AXES or edge.target not in AXES
                or edge.source == edge.target or (edge.source, edge.target) in pairs
                or not _number(edge.weight, -1, 1)):
            raise ValueError("invalid or duplicate connection")
        ids.add(edge.id)
        pairs.add((edge.source, edge.target))
    return tuple(sorted(connections, key=lambda edge: edge.id))


def _transmit(edge, delta):
    """A trusted worker can propose only its registered edge's contribution."""
    return {"edge": edge.id, "source": edge.source, "target": edge.target,
            "weight": edge.weight, "impulse": delta[edge.source],
            "contribution": edge.weight * delta[edge.source]}


def _candidate(decayed, transmissions, baseline):
    raw = {axis: math.fsum([decayed[axis]] + [item["contribution"]
            for item in transmissions if item["target"] == axis]) for axis in AXES}
    offset = {axis: _clip(raw[axis], -OFFSET_CAP, OFFSET_CAP) for axis in AXES}
    state = {axis: _clip(baseline[axis] + offset[axis], LOW, HIGH) for axis in AXES}
    return {"raw_offset": raw, "offset": offset, "state": state,
            "offset_clipping": {axis: raw[axis] - offset[axis] for axis in AXES},
            "state_clipping": {axis: baseline[axis] + offset[axis] - state[axis]
                               for axis in AXES}}


def _verify(active, delta, decayed, baseline, transmissions, candidate):
    """Check proposed edge effects and state before accepting any shadow update.

    This enforces the numerical contract, not psychological validity. The separate
    replay verifier tests a causal hypothesis without giving it to the workers.
    """
    expected = [{"edge": edge.id, "source": edge.source, "target": edge.target,
                 "weight": edge.weight, "impulse": delta[edge.source],
                 "contribution": edge.weight * delta[edge.source]} for edge in active]
    if transmissions != expected:
        raise ValueError("unverified edge proposal")
    # Reconstruct from registered weights, never from a worker's claimed result.
    for axis in AXES:
        raw = math.fsum([decayed[axis]] + [edge.weight * delta[edge.source]
                       for edge in active if edge.target == axis])
        offset = _clip(raw, -OFFSET_CAP, OFFSET_CAP)
        state = _clip(baseline[axis] + offset, LOW, HIGH)
        expected_values = {"raw_offset": raw, "offset": offset, "state": state,
                           "offset_clipping": raw - offset,
                           "state_clipping": baseline[axis] + offset - state}
        if any(candidate[key][axis] != value for key, value in expected_values.items()):
            raise ValueError("unverified state proposal")
    _state(candidate["state"])


class LinkReplay:
    """One bounded offline replay. No persistence, threads, network or LLM.

    Duplicate events return their original receipt within this instance. A
    conflicting ID, reversed clock, failed worker or exhausted budget never
    changes the accepted offset, clock or receipt ledger. There is no eviction
    and no durable exactly-once claim across restarts.
    """

    def __init__(self, connections=DEFAULT_CONNECTIONS, *, max_actions=MAX_CONNECTIONS):
        if type(max_actions) is not int or not 0 <= max_actions <= MAX_CONNECTIONS:
            raise ValueError("max_actions must be an integer in [0, 16]")
        self._connections = _connections(connections)
        self._max_actions = max_actions
        self._offset = dict.fromkeys(AXES, 0.0)
        self._at = None
        self._receipts = {}
        self._last_receipt = None
        self._manifest = {
            "version": 1, "mode": "synthetic_shadow_one_hop",
            "connections": [asdict(edge) for edge in self._connections],
            "offset_cap": OFFSET_CAP, "tau_seconds": TAU_SECONDS,
            "max_actions": max_actions, "max_events": MAX_EVENTS,
            "state_range": [LOW, HIGH],
        }

    @property
    def manifest(self):
        return deepcopy(self._manifest)

    def _decay(self, at):
        if self._at is not None and at < self._at:
            raise ValueError("out-of-order event/time")
        elapsed = (at - self._at).total_seconds() if self._at is not None else 0.0
        factor = math.exp(-elapsed / TAU_SECONDS)
        return elapsed, factor, {axis: value * factor for axis, value in self._offset.items()}

    def sample(self, *, at, baseline):
        """Read-only idle projection; sampling cannot create another impulse."""
        baseline = _state(baseline)
        elapsed, factor, decayed = self._decay(_utc(at))
        return {"elapsed_seconds": elapsed, "decay_factor": factor,
                **_candidate(decayed, [], baseline)}

    def observe(self, *, event_id, at, before, after, source_kind, source_ref):
        """Accept snapshots immediately before/after one synthetic event.

        Both snapshots must have the same timestamp: elapsed-time/circadian
        changes are not event impulses. This caller obligation cannot be proved
        from two dictionaries; production sources are deliberately unsupported.
        """
        at = _utc(at)
        if source_kind != "synthetic_fixture":
            raise ValueError("only synthetic_fixture sources are supported in this pilot")
        event = {"id": _identifier(event_id), "at": at.isoformat(),
                 "before": _state(before), "after": _state(after),
                 "source_kind": source_kind, "source_ref": _identifier(source_ref)}
        event_hash = digest(event)
        if event_id in self._receipts:
            saved = self._receipts[event_id]
            if saved["event_sha256"] != event_hash:
                raise ValueError("event ID reused with different content")
            return deepcopy(saved)
        if len(self._receipts) >= MAX_EVENTS:
            raise ValueError("replay event budget exhausted")
        elapsed, factor, decayed = self._decay(at)
        delta = {axis: event["after"][axis] - event["before"][axis] for axis in AXES}
        active = [edge for edge in self._connections if edge.weight and delta[edge.source]]
        if len(active) > self._max_actions:
            return {"status": "blocked", "reason": "action_budget",
                    "event_sha256": event_hash, "rules_sha256": digest(self._manifest),
                    "required_actions": len(active), "max_actions": self._max_actions}

        # Each queued worker receives the *direct* delta, never another worker's
        # output. Even a cyclic catalog cannot create a recursive feedback loop.
        queue = deque(active)
        transmissions = []
        while queue:
            transmissions.append(deepcopy(_transmit(queue.popleft(), delta.copy())))
        candidate = _candidate(decayed, transmissions, event["after"])
        _verify(active, delta, decayed, event["after"], transmissions, candidate)
        receipt = {"version": 1, "status": "accepted", "event": event,
                   "event_sha256": event_hash, "rules_sha256": digest(self._manifest),
                   "previous_receipt_sha256": self._last_receipt,
                   "elapsed_seconds": elapsed, "decay_factor": factor,
                   "offset_before": self._offset.copy(), "decayed_offset": decayed,
                   "direct_delta": delta, "actions": len(transmissions),
                   "transmissions": transmissions, **candidate}
        receipt["receipt_sha256"] = digest(receipt)
        # Construct detached hand-offs before committing; returned data cannot
        # mutate accepted state or poison subsequent duplicate-ID checks.
        saved = deepcopy(receipt)
        result = deepcopy(receipt)
        self._offset = candidate["offset"].copy()
        self._at = at
        self._receipts[event_id] = saved
        self._last_receipt = receipt["receipt_sha256"]
        return result
