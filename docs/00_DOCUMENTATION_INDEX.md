# proj-poker Documentation Index

Status: Architecture / Requirements Baseline v1  
Date: 2026-10-04

## Purpose

This documentation is the implementation source of truth for Claude Code and human review.

The product is not merely a poker game. It is a **live-style No-Limit Texas Hold'em practice environment + AI coaching system** for a user who understands the rules but lacks practical experience and decision-making heuristics.

## Authority order

When documents conflict, use this order:

1. `decision_log.yaml` — accepted human decisions
2. `01_PRODUCT_REQUIREMENTS.md`
3. `02_DOMAIN_RULES_AND_POLICIES.md`
4. `03_SYSTEM_ARCHITECTURE.md`
5. `04_DATA_AND_EVENTS.md`
6. `05_AI_OPPONENTS_AND_REVIEW.md`
7. `06_UI_UX.md`
8. `07_LEARNING_AND_ANALYTICS.md`
9. `08_MVP_AND_ROADMAP.md`
10. `09_TEST_STRATEGY.md`
11. `research/*`
12. implementation comments

**Research is evidence, not product policy.** Strategy material must never override an accepted human decision.

## Core implementation philosophy

- Poker rules/state are deterministic code.
- LLMs choose strategy; they do not decide legality.
- Each player has an isolated information state.
- Review must avoid hindsight leakage.
- Structured evidence comes before AI prose.
- Replay and re-simulation are distinct.
- Build a vertical `Play -> Event Log -> Review` slice before broad expansion.
- Do not add auth, tenancy, cloud infrastructure, 3D, voice recognition, or other non-goals without a new human decision.

## Files

| File | Responsibility |
|---|---|
| `decision_log.yaml` | D01-D66 accepted human decisions |
| `01_PRODUCT_REQUIREMENTS.md` | Product scope and functional requirements |
| `02_DOMAIN_RULES_AND_POLICIES.md` | Poker rules, information boundaries and invariants |
| `03_SYSTEM_ARCHITECTURE.md` | Components, boundaries and data flow |
| `04_DATA_AND_EVENTS.md` | Event log, persistence and review versioning |
| `05_AI_OPPONENTS_AND_REVIEW.md` | CPU AI and review pipeline |
| `06_UI_UX.md` | Table/chip/dealer UX |
| `07_LEARNING_AND_ANALYTICS.md` | Learning loop and analytics |
| `08_MVP_AND_ROADMAP.md` | MVP DoD and delivery phases |
| `09_TEST_STRATEGY.md` | Deterministic/AI/E2E test strategy |
| `10_DECISION_TRACEABILITY.md` | Decision-to-implementation mapping |
| `11_OPEN_ITEMS.md` | Intentionally unresolved decisions |
| `research/*` | Poker-domain evidence pack |

## Repository stop point

1. finalize docs
2. create GitHub repo
3. create documentation PR
4. create parent/trigger implementation issue
5. **STOP**
6. human inserts generalized Claude skills from other projects
7. only then begin aggressive Claude Code implementation
