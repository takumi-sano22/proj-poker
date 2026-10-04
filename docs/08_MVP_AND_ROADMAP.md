# MVP and Roadmap

## 1. MVP promise

> Play a complete live-style NLHE Cash session against Haiku-class CPU opponents, use real chip mechanics, then review completed hands with math + AI + at least one real solver integration.

A poker game without review is not MVP-complete.

## 2. MVP Definition of Done

### Game
- NLHE Cash
- 2-8 players
- 6-max / ~100BB standard preset
- correct button/SB/BB rotation
- Fold / Check / Call / Bet / Raise / All-in
- minimum raise
- all-in
- side pots
- split pots
- showdown
- hand ranking

### CPU
- all non-Hero seats can use AI
- player-specific KnowledgeState
- legal-action contract
- basic skill/personality variation
- invalid-output retry/fallback
- outage user choice

### UI
- live-style 2D table
- real amount always visible
- card/chip rendering
- click + drag chip betting
- declaration buttons
- dealer flow
- basic terminology

### Logging / persistence
- Hand Event Log
- Hand Summary projection
- completed-hand auto-save
- Replay
- best-effort debug/repro metadata

### Hand Review
- learning reveal after hand
- no-hindsight Decision Review
- basic equity / pot-odds math
- important-decision extraction
- alternative actions
- follow-up questions
- at least one actual solver adapter
- unsupported-solver fallback
- versioned review record

### Quality
- deterministic engine unit tests
- invariant tests
- fixed regression hands
- at least one complete 6-max session can finish and be reviewed successfully

## 3. Recommended implementation sequence

### Phase 0 — Repo / Docs / Tooling
- commit docs
- basic TypeScript project conventions
- lint/typecheck/test skeleton
- create documentation PR + parent issue
- **STOP for human Claude-skill insertion**

### Phase 1 — Vertical Poker Slice
- one 6-max cash hand
- basic UI
- event log

### Phase 2 — Full Poker Engine
- 2-8
- all betting states
- side pots
- heads-up transition
- deterministic tests

### Phase 3 — AI Opponents
- model adapter
- KnowledgeState
- basic personas
- structured action
- retry/fallback

### Phase 4 — Live Mechanics
- chip physical actions
- declarations
- ruling engine
- dealer feedback
- Replay

### Phase 5 — MVP Review
- decision reconstruction
- math/equity
- KB
- Review AI
- solver adapter
- reveal review
- follow-up

**MVP complete here.**

### Phase 6 — Session Learning
- stats
- user hypotheses/profile
- scores
- drills

### Phase 7 — Rich Opponent Simulation
- persistent CPU memory
- CPU-to-CPU memory
- tilt
- recurring pool + Guests
- table tendency presets

### Phase 8 — Tournament
- STT
- blind/ante
- payout
- ICM

## 4. Anti-scope-creep rules

MVP must not be blocked by:
- full multiway solver coverage
- Tournament
- advanced persistent CPU relationships
- perfect replay determinism
- vector DB
- voice
- 3D
- exhaustive live-ruling encyclopedia
- exhaustive stats dashboard

## 5. Required process stop

After:
1. docs are in the repository,
2. documentation PR exists,
3. implementation parent issue exists,

**stop implementation work.**

The human will add generalized Claude Code skills/harness from other projects before autonomous implementation begins.
