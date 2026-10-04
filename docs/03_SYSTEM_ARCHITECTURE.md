# System Architecture

## 1. Stack

Application Core: TypeScript.

Recommended:
- local browser UI
- React/Next.js or equivalent TS web stack
- local application server/runtime
- SQLite
- specialist analyzers through adapters/subprocesses

Solver/equity components may be Rust/Python/C++.

## 2. Logical components

```text
UI
├─ Table / Chips / Dealer
├─ Review
├─ Learning Dashboard
└─ Settings

Application Services
├─ Session Service
├─ Hand Orchestrator
├─ Replay Service
├─ Review Orchestrator
├─ Learning Service
└─ Reset Service

Domain
├─ Poker Engine
├─ Ruling Engine
├─ Hand Evaluator
├─ Pot/SidePot Engine
├─ Position Engine
└─ Rule Profiles

AI / Analysis
├─ Opponent Agent Adapter
├─ Model Router
├─ Math/Equity Engine
├─ Solver Adapter
├─ Knowledge Retrieval
├─ Evidence Sufficiency Gate
├─ Web Research Adapter
└─ Review Agent

Persistence
├─ Event Store
├─ Hand/Session Projections
├─ CPU Memory Store
├─ User Learning Store
└─ Review Version Store
```

## 3. Model roles

Never hardcode concrete model names into domain logic.

```yaml
models:
  opponent_fast: claude-haiku-...
  review_standard: claude-sonnet-...
  review_deep: claude-sonnet-...
```

Initial policy:
- opponent: Haiku-class
- review: stronger model
- routing may change based on measured cost/quality

## 4. Hand orchestration

```text
Start Hand
 -> deterministic state
 -> emit event
 -> determine next actor
 -> build actor KnowledgeState
 -> build legal actions
 -> Hero: UI input
 -> CPU: Opponent Agent
 -> validate output
 -> apply canonical action
 -> emit events
 -> continue
 -> finish hand
 -> persist projection/snapshot
 -> enable review
```

## 5. CPU validation

Validate:
1. schema
2. action legality
3. amount legality

If invalid:
- retry once with explicit correction
- then deterministic safe fallback

Log invalid outputs.

## 6. AI outage

User chooses:
- Retry
- Continue with Emergency Bot
- End/Pause Session

Emergency Bot is not automatic.
Affected actions/hands are flagged.

## 7. Review orchestration

```text
Hand Events
 -> reconstruct Hero information set
 -> deterministic math
 -> range analysis
 -> solver capability check
      -> supported: solver evidence
      -> unsupported: skip
 -> local KB retrieval
 -> evidence sufficiency
      -> insufficient: web research
 -> Review AI
 -> optional Review Interview
 -> versioned Review
```

## 8. Solver adapter

```ts
interface SolverAdapter {
  capabilities(): SolverCapability;
  supports(spot: AnalysisSpot): SupportResult;
  analyze(spot: AnalysisSpot, options: SolveOptions): Promise<SolverEvidence>;
}
```

Unsupported is normal, not exceptional.

MVP requires at least one real local solver integration for supported spots.

Never present a HU approximation as exact multiway GTO.

## 9. Knowledge Base

Runtime KB is curated from the Research Pack.

`Research -> Curated KB -> Retrieval -> Review Evidence`

MVP does not require a vector DB.

## 10. Web fallback

Use web only when local evidence is insufficient.

Triggers can include:
- unknown concept
- house-specific rule
- current solver/tool behavior
- material source conflict

Record provenance/date/scope.

## 11. Architecture non-goals

Do not introduce without a new requirement:
- auth provider
- cloud DB
- multi-tenancy
- distributed microservices
- Kubernetes
- remote event bus
- elaborate event-sourcing framework
