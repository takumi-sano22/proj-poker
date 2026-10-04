# Poker Research Pack

Date: 2026-10-04  
Scope: No-Limit Texas Hold'em, live Cash + Single Table Tournament

## Purpose

This Research Pack is evidence for product/KB design. It is **not** the implementation source of truth.

Relationship:

```text
Research Pack
  -> accepted Product Requirements
  -> Architecture / Domain Rules
  -> curated runtime Knowledge Base
```

Research content must never silently override accepted human decisions.

## Knowledge labels

| Label | Meaning | Example |
|---|---|---|
| RULE | formal rule/ruling | oversized chip, minimum raise |
| FACT | definition/math | pot odds, equity |
| THEORY_BASELINE | equilibrium/theory reference | solver strategy, river bluff ratio |
| HEURISTIC | context-dependent rule of thumb | Rule of 4 and 2 |
| EXPLOIT | adjustment to observed deviation | bluff less vs overcaller |
| HOUSE_RULE | venue/profile-specific | straddle, rake, run it twice |
| UNCERTAIN | evidence/context insufficient | small-sample player read |

This distinction is required so that Review AI does not present a heuristic as a universal poker rule.

## Major research conclusions

1. Live rulings are profile/house dependent; do not hardcode one universal ruleset.
2. Decision Review must be separated from full-hand Reveal Review.
3. Win probability, equity, required equity and EV are different quantities.
4. Cash rake can materially affect strategy and must be explicit in analysis context.
5. Solver capability boundaries matter; local OSS coverage is commonly heads-up oriented.
6. Multiway spots must gracefully fall back to math/range/KB/AI instead of being mislabeled as exact solver truth.
7. Research source scope—format, players, stack, rake, date—must be retained when curating the runtime KB.

## Files

- `01_rules_and_live_mechanics.md`
- `02_strategy_and_math.md`
- `03_review_and_learning.md`
- `04_tournament_and_icm.md`
- `05_solver_and_analysis.md`
- `06_knowledge_base_design.md`
- `SOURCES.md`
