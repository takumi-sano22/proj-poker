# Solver and Analysis

## Solver role

A solver is one evidence source in Review.

It can provide, for a specified model:
- strategy frequencies
- action EV
- equilibrium-oriented baseline

It does not automatically provide:
- the opponent's true range
- what Hero knew at the time
- live tells
- unsupported multiway truth
- missing house-rule context
- emotional state

## Capability envelope

Every solver adapter must declare capability.

Conceptually:

```ts
type SolverCapability = {
  playerCounts: number[];
  streets: ("preflop" | "flop" | "turn" | "river")[];
  modes: ("cash" | "tournament")[];
  rakeSupport: boolean;
  icmSupport: boolean;
  sidePotSupport: boolean;
};
```

Call `supports(spot)` before solving.

Unsupported is a normal result.

## Current OSS research direction

### amaster97/poker_solver
Research notes:
- MIT-licensed
- Heads-Up No-Limit Hold'em oriented
- Python reference + Rust performance core
- DCFR-related implementation
- equity / postflop subgame capabilities

Why it is an attractive PoC candidate:
- permissive license
- clear HUNL scope
- reference + optimized implementation
- suitable for local Linux/WSL experimentation

Caution:
- full-range deep solves may be expensive
- not a multiway oracle

### TexasSolver
Research notes:
- C++ / local execution
- Windows/Linux/macOS-oriented
- command-line / cross-language integration patterns
- strategy output suitable for adapter normalization
- AGPL licensing requires more care

Why it is a useful comparison candidate:
- cross-platform local use
- subprocess-style integration can be practical

Caution:
- license/integration/redistribution implications need explicit review
- capability must be measured in PoC rather than assumed

### noambrown/poker_solver
Useful mainly as a small/reference CFR/river-solver research point rather than the default production choice.

## Multiway policy

```text
if solver.supports(spot):
    use solver evidence
else:
    use math + range model + KB + Review AI
```

Never force an unsupported multiway spot into a heads-up solver and present it as exact GTO.

## Solver request/result normalization

Solver-specific formats must remain behind the adapter.

Normalized request should preserve:
- street
- player count
- board
- pot
- effective stack
- ranges
- bet tree
- rake
- assumptions

Normalized result should preserve:
- support status
- available actions
- strategy frequencies
- EV if available
- accuracy/convergence metadata
- warnings
- assumptions

Do not pass raw solver dump directly to Review AI without normalization.

## GTO and exploit

Solver output is a theoretical baseline.

If opponent evidence supports a deviation:

```text
baseline
 -> observed deviation
 -> exploit hypothesis
```

Keep these layers explicit.

## Deep analysis policy

Normal Hand Review:
- deterministic math
- equity/range
- solver when cheaply supported

Deep Analysis:
- richer tree
- alternative range assumptions
- sensitivity checks
- more expensive solving

Session Review:
- choose important/uncertain/high-impact spots
- run deeper analysis selectively

Do not run an expensive solve for every action.

## Solver PoC acceptance

Before permanent adapter selection, verify:

1. local execution on target dev environment
2. invocation from TypeScript backend
3. parseable output
4. representative river spot
5. representative turn spot
6. small flop spot
7. latency
8. memory
9. timeout/cancellation
10. invalid-input behavior
11. license/integration constraints
12. regression tolerance
