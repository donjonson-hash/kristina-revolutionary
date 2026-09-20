"""Opt-in, in-memory shadow receipts for committed, validated appraisal events.

No LLM, training, persistence, network, or writes to EmotionalCore. Digests bind
observations to input data; they do not authenticate user reports or prove feelings.
"""

from copy import deepcopy
from dataclasses import asdict, dataclass
import re
import threading

from experiments.emotional_links import (
    DEFAULT_CONNECTIONS, MAX_CONNECTIONS, MAX_EVENTS, LinkReplay,
    _identifier, _number, _state, _utc, digest,
)

MAX_STREAMS = 16
SOURCE_ID = "brain_bridge.user_message"


@dataclass(frozen=True)
class AppraisalSource:
    session_sha256: str
    source_id: str
    event_id: str
    source_sha256: str
    appraisal_sha256: str
    reaction: str
    intensity: float

    @classmethod
    def from_validated(cls, appraisal, *, user_input, session_id, event_id):
        """Called by BrainBridge after validation against the current message."""
        from cognitive_appraisal import Appraisal

        if not isinstance(appraisal, Appraisal):
            raise ValueError("validated Appraisal required")
        if not isinstance(session_id, str) or not 1 <= len(session_id) <= 4096:
            raise ValueError("bounded, non-anonymous session identity required")
        if not isinstance(user_input, str) or not 1 <= len(user_input) <= 12000:
            raise ValueError("bounded source message required")
        return cls(digest(session_id), SOURCE_ID, _identifier(event_id),
                   digest(user_input), digest(asdict(appraisal)),
                   appraisal.reaction, appraisal.intensity)

    def matches(self, appraisal):
        """The captured appraisal must be the one whose effects were applied."""
        return (self.appraisal_sha256 == digest(asdict(appraisal))
                and self.reaction == appraisal.reaction
                and self.intensity == appraisal.intensity)

    def validate(self):
        for value in (self.session_sha256, self.source_sha256, self.appraisal_sha256):
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
                raise ValueError("invalid observation digest")
        _identifier(self.source_id)
        _identifier(self.event_id)
        if (self.reaction not in {"curiosity", "warmth", "concern", "frustration", "neutral"}
                or not _number(self.intensity, 0, 1)
                or (self.reaction == "neutral" and self.intensity != 0)):
            raise ValueError("invalid observation appraisal")


class _AppraisalReplay(LinkReplay):
    def __init__(self, connections, max_actions):
        super().__init__(connections, max_actions=max_actions)
        self._manifest["mode"] = "validated_appraisal_shadow_one_hop"


class AppraisalLinkObserver:
    """At most 16 independent streams and 128 receipts total, without eviction.

    Exact retries return the saved receipt; conflicting IDs are rejected within
    their session/source stream. This does not deduplicate production events and
    is not an exactly-once guarantee across observer instances or restarts.
    """

    def __init__(self, connections=DEFAULT_CONNECTIONS, *, max_actions=MAX_CONNECTIONS):
        # Validate the fixed catalog/budget even before the first event arrives.
        self._prototype = _AppraisalReplay(connections, max_actions)
        self._streams = {}
        self._count = 0
        self._lock = threading.RLock()

    @property
    def receipts(self):
        with self._lock:
            return deepcopy([receipt for replay in self._streams.values()
                             for receipt in replay._receipts.values()])

    def observe(self, source, *, at, before, after):
        """Accept a detached, same-instant snapshot after production commit."""
        if not isinstance(source, AppraisalSource):
            raise ValueError("appraisal source required")
        source.validate()
        event = {"id": source.event_id, "at": _utc(at).isoformat(),
                 "before": _state(before), "after": _state(after),
                 "source_kind": "validated_appraisal", "source_ref": source.source_sha256,
                 "provenance": asdict(source)}
        key = (source.session_sha256, source.source_id)
        with self._lock:
            replay = self._streams.get(key)
            duplicate = replay is not None and source.event_id in replay._receipts
            if not duplicate and self._count >= MAX_EVENTS:
                raise ValueError("observer event budget exhausted")
            if replay is None:
                if len(self._streams) >= MAX_STREAMS:
                    raise ValueError("observer stream budget exhausted")
                replay = deepcopy(self._prototype)
            receipt = replay._observe_event(event)
            if receipt["status"] == "accepted":
                self._streams[key] = replay
                if not duplicate:
                    self._count += 1
            return receipt
