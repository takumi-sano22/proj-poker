# Solverと高度解析

## 1. Solverの役割

SolverはReview Evidenceの一つです。

Solverが扱えるもの:

- 指定Range / Stack / Pot / Bet TreeにおけるStrategy Frequency
- Action EV
- Equilibrium-oriented Baseline

Solverだけでは自動的に分からないもの:

- 実在相手の真のRange
- Heroが当時何を知っていたか
- Live Tell
- Unsupported Multiway Spot
- House Rule Mismatch
- Emotional State

## 2. Solver Capability Envelope

各Solver AdapterはCapabilityを明示します。

概念:

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

Solve前に必ず `supports(spot)` を確認します。

UnsupportedはErrorではなく正常系です。

## 3. 現在のOSS調査候補

### amaster97/poker_solver

公開情報上:

- MIT License
- Heads-Up No-Limit Hold'em向け
- Python Reference + Rust Performance Core
- DCFR
- Equity / Postflop Subgame

利点:

- Licenseが比較的扱いやすい
- HUNL Scopeが明確
- Reference実装とOptimized Coreの両方
- WSL / LinuxでPoCしやすい

注意:

- Deep / Full-range SolveはCompute Intensive
- Multiway Oracleではない

**初期PoC第一候補。**

### TexasSolver

公開情報上:

- C++
- Windows / Linux / macOS
- Console / Cross-language Integration
- Strategy Output
- AGPL

利点:

- Cross-platform
- Subprocess Adapterと相性が良い可能性
- 実用候補として比較価値がある

注意:

- AGPL / Integration / Redistribution条件の確認が必要
- Supported SpotはPoCで検証し、推測しない

**比較PoC候補。**

### noambrown/poker_solver

MIT LicenseのRiver Solver / CFR Referenceとして有用です。

Primary Solverというより、Validation / Reference用途の候補です。

## 4. Multiwayの扱い

原則:

```text
if solver.supports(spot):
    Solver Evidenceを使う
else:
    Math + Range Model + KB + Review AI
```

6-max Tableでも、Postflopで2人まで絞られたSpotはHU Solver対象候補になり得ます。

ただし、途中までMultiwayだった場合は:

- Prior Action
- Current Range推定
- Card Removal
- Bunching

等のAssumptionが必要です。

ReviewにはAssumptionを表示します。

## 5. Solver Request / Resultの正規化

Solver-specificなInput / OutputをReview AIへ直接渡しません。

Normalized Requestで保持するもの:

- Street
- Player Count
- Board
- Pot
- Effective Stack
- Range
- Bet Tree
- Rake
- Assumptions

Normalized Result:

- Supported
- Actions
- Frequencies
- EV
- Accuracy / Convergence
- Warnings
- Assumptions

## 6. SolverとExploit

Solver ResultはBaselineです。

Opponent Evidenceが十分なら:

```text
Baseline
 ↓
Observed Deviation
 ↓
Exploit Hypothesis
```

を分けて表示します。

Node-locking等は高度解析で有用ですが、MVP通常Reviewの必須要件にはしません。

## 7. Deep Analysis Policy

通常Hand Review:

- Lightweight Math
- Equity / Range
- SupportedならSolver

「詳しく解析」:

- Richer Bet Tree
- Range Variant
- Sensitivity Analysis
- Exploit Assumption

Session Review:

- Important / Uncertain / High-impact Spotを選択
- Selective Deep Analysis

全Actionに高コストSolveを実行しません。

## 8. Solver PoC Acceptance Criteria

永久選定前に実測:

1. WSL / Windows Local Execution
2. TypeScript BackendからInvocation
3. Parseable Output
4. Representative River Spot
5. Representative Turn Spot
6. Small Flop Spot
7. Latency
8. Memory
9. Cancellation / Timeout
10. Invalid Input
11. License / Integration Constraints
12. Regression Tolerance

この結果でPrimary Adapterを決定します。
