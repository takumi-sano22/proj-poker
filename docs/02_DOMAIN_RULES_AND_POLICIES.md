# Domain Rules and Policies

## 1. Core invariant

**Game rules are deterministic code. LLMs do not adjudicate legality.**

Deterministic components:
- deck and dealing
- hand ranking
- button/positions
- blinds/antes
- legal actions
- minimum raise
- short all-in/reopening
- side pots
- split pots
- showdown
- winner/chip movement

## 2. Information boundary

Never pass global `GameState` directly to an opponent model.

Each player receives a separate `KnowledgeState`.

Allowed:
- own hole cards
- public board
- public actions
- stacks/pot/position
- personally observed showdowns
- personally acquired persistent observations
- own persona/transient state

Forbidden:
- another player's hidden hole cards
- folded cards
- future deck/cards
- learning-only reveal
- Hero weakness database
- another CPU's private observations
- another CPU's hidden persona parameters

Learning-only reveal is a review privilege, not an in-world event.

## 3. Rule profiles

Use versioned rule profiles because live rulings differ by context/house.

Initial conceptual profiles:
- `tournament_tda_2026_v1`
- `live_cash_training_v1`

Profile categories:
- oversized chip
- multiple chip
- minimum raise
- short all-in/reopen
- out-of-turn
- showdown order
- straddle
- run-it-twice
- rabbit hunting
- rake
- buy-in/reload

Do not claim one profile is universally authoritative.

## 4. Physical vs canonical action

PhysicalAction examples:
- chip push
- chip add
- declaration
- muck attempt
- show cards
- out-of-turn attempt

CanonicalAction:
- Fold
- Check
- Call
- Bet
- Raise
- AllIn

A ruling may convert physical intent into a different canonical action.

## 5. Critical regression scenarios

At minimum:
- minimum raise vs total bet
- short all-in
- cumulative short all-ins
- reopening action
- multiple side pots
- odd-chip split
- heads-up button/SB behavior
- transition to heads-up
- blind/ante posting
- all-in showdown
- action order after folds
- oversized-chip ruling
- string-bet/reraise ruling
- representative out-of-turn cases

## 6. Cash policy

Cash config:
- SB/BB real amounts
- starting stack/buy-in
- chip denominations
- top-up policy
- auto top-up
- rake policy
- optional straddle

Real amounts are always visible. BB is supplementary.

### RakePolicy
Must be explicit.

Support at least:
- rakeless training
- percentage + cap style policy

If analysis ignores configured rake, Review must state that limitation.

## 7. Tournament policy

Initial tournament scope:
- Single Table only
- 2-8 players
- blind/ante progression
- payouts
- elimination
- ICM review

Heads-up:
- Button = SB
- Button/SB acts first preflop
- Button/SB acts last postflop

## 8. Feedback categories

### RULING
Defines or changes canonical action.

### ETIQUETTE
Live-table behavior guidance.

### COACHING
Strategy/education.

Keep them distinct in UI and logs.

## 9. Replay vs re-simulation

Replay:
- saved events only
- actual historical hand

Re-simulation:
- alternative branch from a decision point
- may use current AI/solver
- not historical truth

Never regenerate Replay by calling current AI.

## 10. Reproducibility

Save useful metadata, but exact deterministic LLM reproduction is not a hard requirement.

Do not over-engineer the system primarily for bit-for-bit LLM replay.
