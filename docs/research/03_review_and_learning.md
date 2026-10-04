# Review and Learning Model

## Goal

The app should teach a reusable decision process under incomplete information, not merely reveal whether a hand happened to win.

## Two-pass Hand Review

### Pass A — Decision Review

Allowed:
- Hero hole cards
- public board at that point
- pot/stacks/positions
- public actions
- Hero notes/read at that time
- observed history available to Hero

Forbidden:
- folded CPU hole cards
- future board cards
- CPU secret persona
- review-only learning profile data
- information only another CPU had

Output should include:
- assessment
- confidence
- alternatives
- key factors
- range assumptions
- math evidence
- supported solver evidence

### Pass B — Reveal Review

After the hand:
- all hole cards may be shown for learning
- actual-hand equity may be shown
- Hero read can be compared with reality

Pass B must not rewrite Pass A simply because the hidden cards became known.

## Review Interview

When action quality depends on Hero's contemporaneous read or intention, Review AI may ask a focused question.

Examples:
- Did you believe Villain was value-heavy?
- What worse hands were you targeting with this bet?
- Were you calling because of pot odds or because of a player read?

The answer is stored as UserDecisionContext.

## Review UI

Initial:
1. overall summary
2. important spots
3. good decisions
4. improvement candidates

Expandable:
- timeline
- replay
- per-action review
- ranges
- math
- solver
- reveal
- chat

## Evaluation

Prefer categorical per-action assessment:
- strong
- reasonable
- mixed/marginal
- improvement suggested
- major leak
- insufficient evidence

Session-level categories:
- Preflop
- Postflop
- Bet Sizing
- Pot/Equity Math
- Range Reading
- Opponent Adaptation
- Position
- Live Mechanics

Attach confidence + sample size.

## Evidence-backed weaknesses

Do not store permanent labels such as "bad river player".

Store hypotheses with:
- supporting actions
- counter-evidence
- sample size
- confidence
- status/trend

The natural-language user profile is derived and regenerated.

## Opponent-reading review

During play:
- no HUD
- notes/tags
- optional read capture

During review:
- compare read to evidence Hero could actually observe
- show observed statistics
- keep hidden CPU parameters hidden

## Targeted drills

```text
problem hand
 -> identify concept
 -> generate analogous spot
 -> vary one factor
 -> new decision
 -> review
```

The goal is transfer, not memorization.

## Hints

Learning Mode hints:
1. consideration
2. math
3. range/opponent evidence
4. alternatives
5. recommendation

Hint use should be recorded.
