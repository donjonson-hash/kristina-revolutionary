# Kristina organism modes — stage 3

This is the persistent slow-state layer of Kristina's organism model.

The 12 modes receive small changes from **validated, transport-stamped user
events** and are now also exposed to the autonomy layer through a **read-only
projection**. The projection is observable but deliberately excluded from all
desire and decision formulas. Experience can shape slow state; slow state still
cannot shape behaviour.

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

## Next stage

Collect production observations first. Then we can introduce a **shadow
decision**: calculate what the decision would have been with a proposed
slow-mode influence while still executing the unchanged baseline decision.

Only after shadow data is stable should slow modes influence DesireEngine,
ontological tension, crisis 957, sleep integration or aesthetic breakpoints.
