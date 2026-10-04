# Data and Event Contract

## 1. Source of truth

The Hand Event Log is the canonical record of what actually happened.

Derived data:
- current state
- hand summary
- session summary
- statistics
- replay timeline
- review inputs

Do not maintain two independent canonical hand representations.

## 2. Core IDs

Recommended:
- `session_id`
- `hand_id`
- `event_id`
- `player_id`
- `cpu_profile_id`
- `action_id`
- `review_id`
- `observation_id`
- `hypothesis_id`
- `drill_id`

## 3. Conceptual events

Preserve information equivalent to:

- SESSION_STARTED / SESSION_ENDED
- HAND_STARTED / HAND_FINISHED
- BUTTON_ASSIGNED
- BLIND_POSTED / ANTE_POSTED
- HOLE_CARD_DEALT
- PLAYER_DECLARED
- PHYSICAL_CHIP_ACTION
- DEALER_RULING
- ACTION_TAKEN
- CHIPS_MOVED
- CARD_BURNED
- BOARD_DEALT
- PLAYER_FOLDED
- PLAYER_ALL_IN
- SHOWDOWN_STARTED
- CARDS_TABLED
- POT_AWARDED
- AI_ACTION_INVALID
- AI_FALLBACK_USED
- HINT_OPENED
- USER_READ_RECORDED

Implementation granularity may vary, but required information must remain reconstructable.

## 4. Visibility

Card/observation events require explicit visibility.

```ts
type Visibility =
  | { type: "public" }
  | { type: "private"; playerId: string }
  | { type: "learning_only" };
```

This enables reconstruction of what Hero and every CPU legitimately knew.

## 5. KnowledgeState projection

A player KnowledgeState contains:
- current public state
- own hole cards
- public action history
- personally observed showdowns
- persistent observations/hypotheses acquired by that player
- own transient/persona state

It must not be built from learning-only hidden-card reveals.

## 6. Opponent observation

Keep evidence separate from interpretation.

```yaml
observer_player_id: cpu_ken
subject_player_id: hero
source_hand_id: hand_123
evidence:
  - river_bet_75pct
  - showed_bluff
interpretation: bluff_frequency_may_be_high
confidence: low
```

## 7. User learning hypothesis

```yaml
id: hyp_001
type: river_bluff_catch_overcall
supporting_action_ids: [...]
counter_evidence_action_ids: [...]
sample_size: 6
confidence: medium
status: improving
```

Natural-language Player Profile is derived from this layer.

## 8. Review record

Store structured evidence + prose.

Required metadata:
- review version
- created_at
- target hand/action/session
- model role + concrete model
- KB version
- solver adapter/version
- assumptions
- math evidence IDs
- solver evidence IDs
- user-read IDs
- assessment
- confidence
- explanation

Never overwrite an older review version.

## 9. Replay metadata

Replay requires saved events only.

Optional best-effort debugging/re-analysis metadata:
- RNG seed
- deck order hash
- rule profile version
- app version
- model role/version
- AI request/response
- CPU profile version/snapshot

This does not guarantee exact re-simulation.

## 10. Auto-save boundary

Completed hand is the stable recovery boundary.

On HAND_FINISHED:
- persist hand events
- persist session projection
- persist stacks
- persist relevant memory changes

If the app exits mid-hand, resuming from the last completed hand is acceptable.

## 11. Reset semantics

### Learning reset
Clear user hypotheses, ability scores and generated player profile. Keep hand history unless separately deleted.

### Opponent memory reset
Clear persistent CPU observations/hypotheses.

### Hand history delete
Delete hand/session history and derived data.

### Factory reset
Clear all local user data/config.
