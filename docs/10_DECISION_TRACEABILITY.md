# Decision Traceability

All accepted human decisions are recorded in `decision_log.yaml`.

Claude Code must not silently override them.

## Decision groups

| IDs | Area |
|---|---|
| D01-D09 | Review, hints, evaluation philosophy |
| D10-D15 | Table composition, memory, cash/tournament, chips/dealer |
| D16-D24 | Session learning, GTO/solver/KB/web |
| D25-D30 | CPU personality, leaks, tilt and information boundaries |
| D31-D36 | User reads, HUD policy, scoring and drills |
| D37-D42 | Event log, replay, review versioning, deterministic engine, AI failures |
| D43-D54 | UI, live mechanics, cash/tournament configuration |
| D55-D60 | MVP, stack, solver, research, testing, assets |
| D61-D66 | Single-user persistence, CPU pool, reset, latency, final MVP DoD |

## High-impact closed decisions

These are especially important implementation constraints:

- D28: CPU-specific KnowledgeState isolation
- D37: Event Log is source of truth
- D38: Replay != Re-simulation; exact reproducibility is not a hard requirement
- D40: Poker rules are deterministic code; LLM decides strategy only
- D49: real monetary amount is always visible
- D55/D66: Hand Review is part of MVP
- D57: at least one real solver integration is required for supported spots
- D61: no auth / no multi-user design

For the exact accepted wording and choice, refer to `decision_log.yaml`.
