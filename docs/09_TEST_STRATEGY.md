# Test Strategy

## 1. Priority

Deterministic poker correctness is the highest testing priority.

AI may be strategically imperfect; chip accounting and action legality may not be.

## 2. Poker Engine unit tests

Cover:
- hand rankings
- ties
- deck uniqueness
- dealing
- blinds/antes
- action order
- Fold/Check/Call/Bet/Raise
- minimum raise
- all-in
- short all-in
- reopening
- side pots
- split pots
- button movement
- heads-up

## 3. Invariants

### INV-001
No card exists simultaneously in two locations.

### INV-002
Total chips are conserved except explicit rake/rebuy/top-up operations.

### INV-003
A folded player is never asked to act again in that hand.

### INV-004
A player cannot commit more than their stack.

### INV-005
Distributed pot equals distributable pot after rake.

### INV-006
Only the legal actor can produce a canonical action.

### INV-007
Opponent KnowledgeState contains no hidden opponent cards.

### INV-008
Learning-only reveal never becomes CPU memory.

## 4. Scenario regression suite

Fixed hands:
- ordinary heads-up
- ordinary 6-max
- multiway all-in
- 3-way side pot
- short all-in not reopening
- cumulative short raises
- odd-chip split
- transition to heads-up
- oversized-chip ruling
- string-raise ruling
- representative out-of-turn case

## 5. AI opponent eval

Separate from engine correctness.

Measure:
- valid structured-output rate
- illegal-action rate
- retry rate
- latency
- persona differentiation
- action diversity
- obvious strategic incoherence
- hidden-information leakage

Use fixed representative decision spots.

## 6. Review eval

Verify:
- no hindsight leakage in Pass A
- deterministic math correctness
- solver capability gating
- KB/source grounding
- uncertainty language
- hidden CPU settings are not used as evidence
- assumption changes can appropriately change a recommendation

Use human-reviewed regression hands.

## 7. Solver adapter tests

- capability detection
- supported spot
- unsupported spot
- timeout
- cancellation
- invalid input
- parse failure
- version metadata
- range-assumption preservation

## 8. Critical E2E

1. start 6-max cash
2. play a complete hand
3. use chip/declaration interaction
4. finish hand
5. open review
6. reveal all hands
7. Replay
8. ask one follow-up
9. start next hand
10. close/reopen between hands and resume

## 9. Property/fuzz testing

Useful for:
- random legal action sequences
- side-pot/chip conservation
- random stack sizes
- random player counts
- deck uniqueness

Do not substitute fuzzing for explicit rule scenarios.
