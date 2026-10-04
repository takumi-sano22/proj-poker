# Learning and Analytics

## 1. Principle

Do not equate short-term profit with poker skill.

Primary signal:
- decision quality given information available

Secondary:
- actual profit/loss
- BB result
- outcome variance

## 2. Ability dimensions

Initial:
- Preflop
- Postflop
- Bet Sizing
- Pot/Equity Math
- Range Reading
- Opponent Adaptation
- Position
- Live Mechanics

Each stores:
- score
- confidence
- sample size
- evidence IDs
- trend

## 3. Statistics

Persist enough event data to derive many stats.

Normal UI:
- VPIP
- PFR
- 3-bet
- selected aggression/fold metrics
- position/street breakdown

Detailed UI:
- larger tracker-style metric set

Always preserve numerator/denominator opportunity counts.

## 4. User profile

Structured evidence is primary.

Natural-language profile is regenerated frequently from:
- recent evidence
- long-term evidence
- improvements
- unresolved hypotheses

Do not recursively treat old prose as truth.

## 5. Hypothesis lifecycle

Possible states:
- suspected
- supported
- strong
- improving
- resolved
- insufficient_data

Counter-evidence must be able to weaken a hypothesis.

## 6. Session Review

Include:
- hands / duration
- actual result in real amount + BB
- decision-quality summary
- strengths
- leaks
- important hands
- confidence/sample caveats
- recommended drills

## 7. Targeted drills

Pipeline:
`real mistake -> underlying concept -> analogous generated spot -> vary one meaningful factor -> re-test`

Do not merely replay identical cards.

## 8. Opponent-reading training

During play:
- no HUD
- user notes/tags
- optional read capture

During review:
- compare user's read with evidence they actually could observe
- show relevant observed stats
- never use hidden CPU persona as evidence

## 9. Hints and scoring

Store how much assistance was used.

Future scoring may distinguish:
- independent decision
- hint-assisted decision
- review-only understanding

Exact weighting remains unresolved until playtesting.
