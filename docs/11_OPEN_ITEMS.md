# Open Items / Intentionally Unresolved

These items are intentionally **not fixed**.

Claude Code may implement a reversible configuration default where necessary, but must not silently turn it into permanent product policy.

## OI-001 — Exact Anthropic models

Fixed:
- opponent default = Haiku-class
- review default = stronger model

Open:
- concrete model names
- routing thresholds
- exact cost/latency policy

Implement by role-based configuration.

## OI-002 — Primary solver

MVP requires one real solver integration.

Research candidates include:
- MIT-licensed HUNL solver implementations
- TexasSolver as a comparison candidate

Before permanent selection:
- local PoC
- supported-spot verification
- latency/memory benchmark
- invocation/output validation
- license review

Do not assume multiway support.

## OI-003 — Exact rake presets

`RakePolicy` is required.

Open:
- exact initial live presets
- percentage/cap values

## OI-004 — Exact chip presets

Multiple common real-amount presets are required.

Open:
- exact denominations/colors shipped first

## OI-005 — Exact CPU pool

Direction is fixed:
- recurring pool
- Guests

Open:
- count
- names
- avatars
- initial persona distribution

Do not couple the schema to a fixed number of CPU profiles.

## OI-006 — Session score formula

Fixed:
- ability scores
- overall score
- confidence/sample size
- decision quality prioritized

Open:
- exact weights
- hint-assisted weighting
- confidence aggregation

Requires playtesting.

## OI-007 — Tournament presets

STT/ICM is fixed scope.

Open:
- exact starting stacks
- blind levels
- payout defaults

## OI-008 — Full live-ruling coverage

MVP needs representative core rulings, not every casino edge case.

Use extensible versioned Rule Profiles.

## OI-009 — Multiway deep solving

Not an MVP blocker.

Fallback:
- deterministic math
- range analysis
- KB
- Review AI

Never label HU approximation as exact multiway GTO.

## OI-010 — Runtime web-search provider

The evidence gate is fixed; the concrete provider/integration is open.

# Explicitly closed

Do not reopen during routine implementation:

- local single-user
- no auth/tenant
- TypeScript-centered core
- Event Log source of truth
- deterministic poker engine
- isolated KnowledgeState
- learning-reveal isolation
- real amount always visible
- chip-based live interaction
- voice recognition out of scope
- Hand Review required for MVP
- real solver integration required for supported spots
- Replay != Re-simulation
- reproducibility is best-effort
