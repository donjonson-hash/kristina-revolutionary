# Kristina organism modes — stage 1

This is the first persistent slow-state layer of Kristina's organism model.

It is deliberately **passive** in this stage. The live bot creates and restores
the 12 modes, but they do not yet change emotions, prompts, desires, decisions,
messages, publishing or sleep. This lets us verify persistence before coupling
the slow layer to behaviour.

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

## Stage-1 runtime contract

`EmotionalCore` owns an `organism_modes` field, but its existing
`evolve()` method does not mutate it.

Changing a mode manually must not change the result of
`get_emotional_state()`.

The heartbeat also does not advance modes yet.

This is intentional.

## Next stage

After persistence has survived production restarts, the next PR can add a
validated, idempotent event-to-mode adapter:

```
validated event
   -> emotional impulse
   -> mode deltas
   -> durable event receipt
```

Only after that layer is stable should modes begin influencing DesireEngine,
ontological tension, crisis 957, sleep integration or aesthetic breakpoints.
