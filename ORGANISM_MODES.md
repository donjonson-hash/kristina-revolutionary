# Kristina organism modes — stage 5

This is the persistent slow-state layer of Kristina's organism model.

The 12 modes receive small changes from **validated, transport-stamped user
events** and are exposed to the autonomy layer through a **read-only
projection**. Production computes a bounded **shadow decision** from that
projection and now persists those counterfactual observations in SQLite. The
shadow result remains telemetry only: the unchanged baseline decision is still
the only executable decision.

## Why a second timescale

`EmotionalCore` is the fast state: energy, happiness, curiosity, anxiety,
loneliness, creativity and irritation can move over minutes and hours.

The organism modes are intended to hold slower tendencies that may later change
over days or weeks:

| Mode | Initial baseline | Relaxation half-life |
|---|---:|---:|
| `core_741` | 0.60 | 168 h |
| `aesthetic_drive` | 0.25 | 336 h |
| `empathy_963` | 0.35 | 96 h |
| `validation_need` | 0.30 | 72 h |
| `social_overload` | 0.15 | 18 h |
| `withdrawal_147` | 0.20 | 36 h |
| `creativity_357` | 0.22 | 48 h |
| `agency_exec` | 0.30 | 96 h |
| `invisibility_wound` | 0.18 | 240 h |
| `abandonment_wound` | 0.12 | 336 h |
| `self_critique` | 0.20 | 72 h |
| `crisis_957` | 0.08 | 24 h |

These values are **engineering calibration**, not psychological measurements or
scientific claims.

## Persistence

The modes live in the same state database as `EmotionalCore`, in the
`kristina_modes` table:

- `name`
- `baseline`
- `amplitude`
- `phase`
- `half_life_hours`
- `updated_at`
- `version`

Initialization is additive. A restart inserts missing canonical modes but never
re-seeds or overwrites an existing amplitude.

Unknown future mode rows are ignored by older code. This makes later expansion
from 12 modes safer to roll back.

## Time semantics

Relaxation uses a declared half-life in **hours**:

```
amplitude(t) =
    baseline + (amplitude(0) - baseline)
    * exp(-ln(2) * elapsed_hours / half_life_hours)
```

Therefore one 24-hour update and twenty-four one-hour updates produce the same
result apart from floating-point rounding.

Reads do not advance time. Relaxation is an explicit operation.

## Stage-2 event contract

Only a current user message with a valid transport identity can mutate the slow
field. The accepted event kinds are derived from the same validated context
used by `EmotionalCore`:

```
stamped user message
   -> user_message
   -> optional validated appraisal
   -> deterministic small mode deltas
   -> organism_mode_events receipt
```

The receipt stores pseudonymized session identity, transport event ID, a payload
hash, the applied delta vector and timestamp. It does **not** store message text.

For persistent state, the fast emotional update, slow-mode update, emotional
message receipt and organism event receipt use the **same SQLite transaction**.
If any write fails, all four roll back. A retry of the same transport event is a
no-op; reusing the event ID with a different payload is rejected.

Unstamped legacy calls and ordinary heartbeats do not change slow modes.

## Current mapping boundary

The coefficients in `MODE_EVENT_DELTAS` are deliberately small and
deterministic. They are engineering calibration, not psychological claims.

`crisis_957` is not directly increased by ordinary messages. A later tension
engine should derive crisis pressure from accumulated slow state rather than
turning one conversation into a crisis.

## Stage-3 decision observation

The autonomy layer can call `project_organism_modes()` to obtain an immutable
snapshot containing:

- current amplitudes;
- deviations from each mode's baseline;
- the strongest modes by absolute amplitude;
- the strongest changed modes by absolute baseline deviation;
- the maximum absolute deviation.

The projection is passed through decision context for proactive and creative
decision opportunities and is included only in operational telemetry.

`DesireEngine.calculate()` validates the projection type but does not use any
mode value in its scoring formulas. Tests assert that extreme values such as
`crisis_957 = 1.0`, `social_overload = 1.0` or
`withdrawal_147 = 0.95` produce exactly the same desire scores and decisions
as when no projection is supplied.

Reading the projection does not advance mode time or mutate persistence.

## Stage-4 shadow decision

For every eligible proactive or daytime creative decision, production keeps the
existing baseline path unchanged and separately calculates a counterfactual:

```
fast emotional state
  -> baseline desires
  -> baseline decision ---------------------> executable action/silence
          |
          + organism baseline deviations
          -> bounded shadow desire deltas
          -> shadow decision ----------------> telemetry only
```

Shadow coupling uses **deviation from each mode's own baseline**, not raw mode
amplitude. A mode sitting at its resting baseline therefore contributes exactly
zero.

Each desire's total shadow adjustment is capped at ±0.12 before the score is
clamped to [0, 1]. The current coefficients in `SHADOW_MODE_WEIGHTS` are
engineering hypotheses to observe, not psychological measurements.

The shadow path uses the same `DecisionEngine` hard gates as production. It
cannot bypass cooldown. It may predict that slow state would have changed an
intention, crossed the action threshold, or increased the desire for space, but
that result is never executed.

Shadow failures are isolated: an exception in counterfactual calculation is
logged and the baseline production action continues unchanged.

Telemetry contains decision labels, scores, maximum score delta and the compact
organism projection. It contains no message text.

## Stage-5 durable shadow telemetry

`shadow_telemetry.py` stores shadow observations in the same persistent state
database as `EmotionalCore`. The table is append-only by observation identity:
the first observation for a decision opportunity wins and later retries cannot
overwrite it.

Each row stores:

- decision kind (`proactive` or `creative`);
- a SHA-256 scope digest instead of a raw chat/session identifier;
- opportunity and observation timestamps;
- baseline action, intention, score and reason;
- shadow action, intention, score and reason;
- whether action, intention or overall decision changed;
- maximum absolute score delta and the complete per-desire delta vector;
- all 12 mode deviations from baseline plus the strongest shifted mode names.

No conversation text, prompt, generated message or raw Telegram/session ID is
stored.

Proactive opportunities use their persisted scheduled due time as the stable
observation identity. Creative shadow telemetry is sampled into 30-minute UTC
buckets, so the one-minute heartbeat cannot create one database row per minute.
This sampling affects telemetry volume only and does not change creative
decisions.

Telemetry writes are outside the production control path. A telemetry database
failure is logged but cannot suppress or create a proactive message, diary
entry or other baseline action.

`ShadowTelemetryStore.summary()` provides the initial calibration dataset:
total observations, decision/action/intention change counts and rates, plus
average and maximum shadow score displacement. Raw recent rows remain available
for deeper offline analysis.

## Next stage

Accumulate a meaningful production sample before changing any live decision
formula. The first calibration pass should compare proactive and creative
observations separately, inspect which mode deviations dominate changed
decisions, and test whether the ±0.12 cap or individual candidate weights are
too strong, too weak or directionally wrong.

Only after that evidence should slow modes receive any authority over the live
DesireEngine. Ontological tension, crisis 957, sleep integration and aesthetic
breakpoints remain later layers.


## Read-only calibration report

Production administrators can inspect accumulated evidence without opening the
SQLite database manually:

```
/shadow 24h
/shadow 7d
/shadow all
```

The Telegram command is restricted to user IDs listed in
`KRISTINA_ADMIN_IDS`. If that setting is empty, nobody can use the command.

The report is read-only. It does not advance modes, create new shadow
observations or change any decision. It shows total observations, how often the
counterfactual would have changed decision/action/intention, proactive vs
creative rates, average and maximum score displacement, frequently shifted
modes and average per-desire shadow deltas.

The command intentionally remains absent from the public welcome text because
it is an operational calibration tool, not a user feature.
