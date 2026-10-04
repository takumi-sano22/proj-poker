# proj-poker

AI-driven **No-Limit Texas Hold'em practice and coaching environment** focused on live-table decision making.

> Status: design baseline / pre-implementation  
> This repository currently contains the product requirements, poker-domain research, architecture, and implementation roadmap.

## Why this project exists

Knowing the rules of poker is not the same as being able to play well at a real table.

This project is designed for a player who understands the basic rules but still needs practical experience with:

- incomplete-information decision making
- ranges, equity, pot odds, EV, value betting, and bluffing
- opponent adaptation
- live chip and declaration mechanics
- post-hand reflection without hindsight bias

The goal is to build a local training environment that can help bridge that gap.

## Product concept

The application combines:

- **2-8 player NLHE tables**
- **AI opponents** with different skill levels, styles, persistent observations, and human-like leaks
- **live-style chip interaction** instead of a simple numeric bet box
- **dealer rulings** for common live-table mistakes
- **hand review** that separates information available at decision time from learning-only full-card reveal
- **math + range analysis + solver evidence + AI coaching**
- **long-term learning analytics and targeted drills**

## Architecture principles

### Deterministic poker, probabilistic strategy

Poker rules, legal actions, pots, side pots, hand ranking, and chip movement are deterministic code.

LLMs choose strategic actions. They do **not** decide whether an action is legal.

### Isolated information state

Each CPU receives only the information that player is legitimately allowed to know.

A CPU must never receive:

- another player's hidden cards
- future cards
- review-only reveals
- another CPU's private observations
- the user's hidden learning profile

### Review without hindsight leakage

Hand review has two distinct passes:

1. **Decision Review** — evaluates the action using only information available at the time.
2. **Reveal Review** — shows all hole cards afterward for learning and comparison.

The second pass must not retroactively contaminate the first.

### Evidence before explanation

Review output is built from structured evidence first:

```text
Hand Events
  -> decision-time information reconstruction
  -> deterministic math
  -> range analysis
  -> solver evidence when supported
  -> local poker knowledge
  -> web fallback only when evidence is insufficient
  -> Review AI
```

## Planned stack

- TypeScript-centered application core
- local web UI
- SQLite
- Claude Haiku-class model for frequent opponent actions
- stronger review model by default, configurable by role
- local solver behind an adapter
- specialist Rust/Python/C++ components allowed behind stable interfaces

Concrete model and solver choices are intentionally configurable and will be validated with cost/latency/quality PoCs.

## MVP definition

The MVP is complete only when a user can:

1. play a complete NLHE Cash session against AI opponents,
2. interact through a live-style 2D table and chip interface,
3. persist the hand as an event log,
4. replay the hand,
5. review decisions without hidden-information leakage,
6. inspect learning-only full-card reveal,
7. receive math / AI / supported-solver analysis,
8. ask follow-up questions.

A poker game without the review loop is **not** considered MVP complete.

## Documentation

The implementation specification lives under [`docs/`](./docs).

Start with:

- [Documentation index](./docs/00_DOCUMENTATION_INDEX.md)
- [Product requirements](./docs/01_PRODUCT_REQUIREMENTS.md)
- [Domain rules and policies](./docs/02_DOMAIN_RULES_AND_POLICIES.md)
- [System architecture](./docs/03_SYSTEM_ARCHITECTURE.md)
- [MVP and roadmap](./docs/08_MVP_AND_ROADMAP.md)
- [Decision traceability](./docs/10_DECISION_TRACEABILITY.md)
- [Research pack](./docs/research/README.md)

The accepted product decisions are also recorded in machine-readable form in [`docs/decision_log.yaml`](./docs/decision_log.yaml).

## Development approach

The project is intentionally designed for an AI-driven development workflow with strong human decision gates.

Before implementation begins:

1. product decisions and poker research are documented,
2. architecture and invariants are fixed,
3. deterministic poker tests are treated as executable specification,
4. unresolved decisions are isolated instead of being invented by coding agents.

## Scope notes

This is a learning / simulation project.

Out of scope for the current design:

- real-money gambling
- online multiplayer
- SaaS / multi-tenant architecture
- voice recognition
- 3D casino simulation
- perfect deterministic reproduction of LLM outputs
- pretending a heads-up solver is an exact oracle for unsupported multiway spots

## Current phase

The repository is currently at the **design and documentation baseline**.

Implementation will begin after the project-specific Claude Code skills and development harness are added.
