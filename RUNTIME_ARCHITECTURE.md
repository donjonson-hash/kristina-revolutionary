# Kristina runtime architecture

This document is the runtime source of truth for Kristina. It exists to stop
older prototypes from being reconnected beside the live system and creating a
second emotional or proactive controller.

## Canonical live path

```
Telegram
  -> bot.py
  -> AgentRouter
  -> KristinaPersonaAgent
  -> BrainBridge
  -> cognitive_appraisal.py
  -> EmotionalCore
  -> response / durable dialogue commit
```

Autonomous activity is driven by two one-minute heartbeats in `bot.py`:

```
EmotionalCore.evolve()
  -> DesireEngine
  -> DecisionEngine
  -> silence OR proactive message
```

and

```
EmotionalCore
  -> creative_decision()
  -> CreativeLife
  -> creative_diary
  -> optional channel publication
  -> creative_expression event
  -> EmotionalCore
```

Durable autonomous work lives in `intention_cycle.py`.

## Single sources of truth

| Concern | Canonical owner |
|---|---|
| Public identity | `kristina_identity.py` + `KRISTINA_IDENTITY_CONTRACT.md` |
| Conversation routing | `agents/router.py` |
| Event appraisal | `cognitive_appraisal.py` |
| Fast emotional state | `emotional_core.py` |
| Mood projection | `mood_engine.py` |
| Long-lived dialogue gates | `dialogue_state.py` |
| Telegram runtime / schedules | `telegram_runtime.py` |
| Desire and action choice | `autonomy_decision.py` |
| Shadow decision evidence | `shadow_telemetry.py` |
| Creative diary / expression | `creative_life.py` |
| Durable autonomous work | `intention_cycle.py` |
| Runtime event bus | `event_bus_v2.py` |

## Event bus migration

`event_bus_v2.py` is the only event bus for new runtime code.

`broadcast.py` remains a temporary synchronous compatibility adapter. Existing
legacy callers can keep using its old API. When an asyncio loop is active, the
adapter mirrors those events into EventBusV2. New code must subscribe or publish
through EventBusV2 directly.

This lets us migrate incrementally without changing the semantics of old
synchronous callbacks.

## Legacy modules that must not be reactivated

### autonomous_life.py

Detached prototype. It creates its own EmotionalCore and runs a random
30-60-minute life loop. Connecting it to production would create a second
emotional controller beside the real persistent core.

Useful pieces may be migrated individually, especially image-generation logic,
but `KristinaLife.start_life()` must not be started by the bot.

### proactive_messaging.py

Fixed clock schedule from an older proactive design. Production proactive
behaviour is now state-driven and restart-safe in `bot.py`,
`autonomy_decision.py`, `dialogue_state.py` and `telegram_runtime.py`.

Calling `setup_proactive()` would create a second sender with different
eligibility rules.

### broadcast.py

Compatibility only. Do not add new event types or new direct subscribers here
unless needed to migrate an existing legacy caller.

## Rule for the organism layer

The slow organism state begins with the passive 12-mode field documented in
[ORGANISM_MODES.md](ORGANISM_MODES.md). Hidden aesthetic vector, tension,
crisis 957 and sleep integration must continue to be added around the current
EmotionalCore, not as a second EmotionalCore and not as another independent
scheduler.

The intended layering is:

```
external/internal event
  -> appraisal
  -> EmotionalCore        # fast state
  -> organism modes       # slow state learns from validated events
       \
        \-- read-only projection --> bounded shadow desires
                                   --> shadow DecisionEngine
                                   --> telemetry only
  -> DesireEngine         # baseline formulas remain production authority
  -> DecisionEngine
  -> action or silence    # only this baseline result is executable
```

Every durable organism event should carry a stable event ID so retries cannot
apply the same experience twice.


## Shadow decision safety boundary

The shadow path in `autonomy_decision.py` is a counterfactual observer, not a
second controller. It receives the already-computed baseline desires and
baseline decision, applies bounded candidate slow-mode influence, and asks the
same `DecisionEngine` what would have happened.

`bot.py` always keeps and executes the baseline decision. Shadow calculation
is wrapped separately so a shadow exception cannot suppress or create a
production action. Do not route message generation, proactive claims, delivery,
creative diary writes or cooldown state from the shadow result until a later
explicit activation stage.


## Durable shadow evidence

`shadow_telemetry.py` is the persistence boundary for counterfactual autonomy
observations. It writes to the same state database but is not part of the
baseline decision transaction and must never become a prerequisite for action.

Production callers use stable opportunity identities so retries are idempotent.
Only hashed scope identifiers are persisted. Creative observations are bounded
to one row per 30-minute UTC bucket; proactive observations use the durable
scheduled opportunity time.

A telemetry failure is deliberately isolated from generation, proactive claims,
delivery and creative diary writes. This preserves the architectural rule that
shadow analysis can observe production decisions but cannot control them.
