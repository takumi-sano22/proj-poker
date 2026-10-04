# Product Requirements

## 1. Product goal

Build a local single-user NLHE training app combining:

- 2-8 player live-style poker
- AI opponents
- physical chip/declaration practice
- evidence-based hand review
- solver/math support
- long-term learning analytics

Primary outcomes:

1. make good decisions from incomplete information
2. understand standard poker vocabulary and concepts
3. become comfortable with live chip/declaration mechanics
4. learn opponent reading and exploit adjustment
5. review mistakes without hindsight bias
6. improve through repeated play/review/drill loops

## 2. Modes

### Learning Mode
- user-triggered progressive hints
- post-hand review
- learning-only full-hole-card reveal after the hand

### Real-Play Mode
- no strategic hints during the hand
- learning reveal/review deferred
- rule/ruling feedback still applies

## 3. Game scope

- No-Limit Texas Hold'em
- 2-8 total players
- Cash + Single Table Tournament
- Cash is the default format

### Cash
- multiple real-amount presets
- **real amount is always visible**
- optional BB secondary display
- stack persists between hands
- reload/top-up
- optional auto top-up
- explicit `RakePolicy`
- versioned house-rule profiles

### Tournament
Post-MVP product scope:
- 2-8 player STT
- blind progression
- optional ante/BBA
- elimination
- heads-up
- payout
- ICM-aware review
- preset + custom blind structures
- time-based or hand-count-based levels

## 4. AI opponents

Default model role: `opponent_fast`, initially Haiku-class.

Requirements:
- most CPUs at casual-experienced level or above
- minority weaker CPUs
- multi-axis strategy/personality parameters
- weak CPUs use systematic poker leaks, not random nonsense
- selected personas may show low-probability state-conditioned irrationality such as tilt
- fixed recurring CPU pool + occasional Guests
- recurring CPUs persist only observations they legitimately acquired
- CPU-to-CPU memory is allowed only when the observing CPU actually saw the evidence

Suggested dimensions:
- skill
- preflop looseness
- aggression
- bluff tendency
- risk tolerance
- discipline
- adaptability
- trap tendency
- opponent-model quality
- tilt susceptibility/recovery

## 5. Live-style interaction

### Table
- live-oriented 2D table
- dealer button / SB / BB / positions
- cards, chips, pot and stacks

### Chips
- click + drag
- real denominations
- chip movement itself is a PhysicalAction
- numeric bet box is not the primary betting interaction
- dealer-assisted change/color-up/organization

### Declaration
Buttons for CHECK/CALL/BET/RAISE/ALL-IN/FOLD where relevant.

Voice recognition is out of scope.

### Rulings
Incorrect live-style actions should often be possible.

`PhysicalAction -> Ruling Engine -> Dealer Ruling -> Canonical Poker Action`

Do not simply disable every mistake.

## 6. Dealer

Responsibilities:
- dealing/shuffle/burn visual flow
- blind/ante handling
- action order
- chip/pot movement
- rulings
- etiquette feedback
- terminology support

Speed:
- Real Table
- Normal
- Fast

## 7. Hints

Learning Mode only, user-triggered.

Progressive levels:
1. what to consider
2. relevant math
3. range/opponent considerations
4. candidate comparison
5. recommendation

Hint usage is logged.

## 8. Hand review

Primary flow:
1. concise summary
2. important decisions
3. good decisions
4. improvement candidates
5. expandable detail

Capabilities:
- action-by-action Replay
- Decision Review using only information available at the time
- separate Reveal Review with all hole cards after hand completion
- alternative action comparison
- range analysis
- deterministic math
- solver evidence when supported
- interactive follow-up Q&A
- Review Interview when Hero's original read/intent matters
- versioned review records

Actual hidden cards must not be used as evidence for the first-pass decision evaluation.

## 9. Opponent reading

- free-form note + tags per CPU
- optional contemporaneous read capture
- no HUD during ordinary play
- review can show statistics derived only from hands the user actually observed

## 10. Session learning

Post-MVP loop:

`Play -> Review -> Weakness Hypothesis -> Targeted Practice -> Play`

Requirements:
- decision quality > short-term profit
- ability scores + confidence + sample size
- representative stats normally, deeper tracker stats on demand
- evidence-backed weakness hypotheses
- frequently regenerated current Player Profile
- automatic practice recommendations
- drills from own hands + generated analogous situations

## 11. Persistence

- Event Log is source of truth
- summaries/stats are derived
- auto-save at completed-hand boundary
- mid-hand perfect recovery is not required
- best-effort reproducibility metadata
- category reset: learning profile / opponent memories / hand history / factory reset

## 12. Constraints / non-goals

- local-first
- single user
- no auth
- no tenant model
- no SaaS hardening
- no real-money gambling integration
- no online multiplayer
- no voice recognition
- no 3D casino requirement
