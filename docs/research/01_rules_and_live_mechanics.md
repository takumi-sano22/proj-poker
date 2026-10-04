# Rules and Live Mechanics

## Core flow

NLHE uses:
- two private hole cards per player
- Flop: 3 community cards
- Turn: 1
- River: 1
- betting rounds: Preflop / Flop / Turn / River

At showdown, the best five-card hand from available cards wins; a player may also win by making all opponents fold.

## Position / action

Typical live structure:
- SB is left of Button
- BB is left of SB
- Preflop action starts left of BB
- Postflop action starts with the first live player left of Button
- Button moves clockwise each hand

### Heads-up
Important exception:
- Button = SB
- Button/SB acts first preflop
- Button/SB acts last postflop

Transition into heads-up needs explicit regression tests.

## Physical action vs canonical action

Live-style UI must separate what the user physically does from the poker action the rules recognize.

Example:

```text
Facing bet 100
User silently pushes one 500 chip
 -> oversized-chip ruling
 -> CALL 100
 -> change returned
```

The Poker Engine receives the canonical CALL, not the user's intended raise.

## Verbal declarations and chips

Relevant live principles from modern TDA-style rules:
- clear verbal declaration and/or chip movement can define an action
- when both exist, timing matters
- common declarations include bet, raise, call, fold, check, all-in
- a raise should be made clearly, e.g. one motion or prior declaration
- string betting should be ruled rather than modeled as a legal multi-step raise

## Oversized chip

Facing a bet, a single oversized chip without prior raise declaration is generally treated as a call under the applicable TDA-style profile.

This should be learnable through interaction, not only tutorial text.

## Multiple chips / 50% threshold

Silent multiple-chip actions have non-trivial rulings depending on:
- amount needed to call
- amount pushed
- whether a full minimum raise is reached
- threshold rules

Implement in the deterministic Ruling Engine, not in an LLM.

## Minimum raise / reopening

Do not confuse:
- total bet amount
- raise increment

Short all-ins can create reopening edge cases. Cumulative short all-ins are especially test-worthy.

## Out of turn

Out-of-turn behavior is not always simply "ignored".

Depending on rule profile and intervening action:
- action may be binding
- action may return to the proper player
- options may change

Use a versioned RulingProfile and scenario tests.

## Showdown

Distinguish:
- formal table-visible showdown
- learning-only full-card reveal

Only the former may enter an observing CPU's KnowledgeState.

## Burn/deal presentation

Dealer UI may visually model:
- shuffle/cut
- hole cards
- burn + flop
- burn + turn
- burn + river

Internal randomness must not depend on animation timing.

## Cash house-rule concerns

Configurable concerns include:
- table stakes
- buy-in/reload
- straddle
- rake
- run it twice
- rabbit hunting

These are HOUSE_RULE concerns, not universal core Hold'em logic.

## Feedback categories

Keep separate:
- RULING — affects canonical action
- ETIQUETTE — table behavior
- COACHING — educational/strategy guidance
