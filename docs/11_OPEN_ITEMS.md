# 未確定事項 / Open Items

このファイルの項目は、**意図的に未確定**です。

Claude Codeは必要なら可逆なDefaultを置いて構いませんが、それを永久仕様として勝手に確定してはいけません。

## OI-001 — 具体的なAnthropic Model

確定:
- OpponentはHaiku級を初期値
- Reviewはより上位Modelを初期値

未確定:
- 正確なModel名
- Routing Threshold
- Cost / Latency Policy

Role-based Configで実装します。

## OI-002 — Primary Solver

MVPで実Solver統合は必須です。

候補:
- MIT LicenseのHUNL Solver
- TexasSolver比較PoC

永久選定前に:

- Local PoC
- Supported Spot
- Latency / Memory
- Invocation / Output
- License

を確認します。

Multiway Supportを推測で決めないでください。

## OI-003 — Rake Preset

`RakePolicy` は必須。

未確定:
- 初期Live Preset
- Percentage
- Cap

## OI-004 — Chip Preset

複数の実額Presetは必須。

未確定:
- 初期Denomination
- Color

## OI-005 — CPU Pool

確定:
- Recurring CPU
- Guest

未確定:
- 人数
- Name
- Avatar
- Persona Distribution

DB Schemaを固定人数へCoupleしないでください。

## OI-006 — Session Score Formula

確定:
- Ability Score
- Overall Score
- Confidence
- Sample Size
- Decision Quality重視

未確定:
- Weight
- Hint-assisted補正
- Confidence Aggregation

Playtest後に決定します。

## OI-007 — Tournament Preset

確定:
- STT
- ICM

未確定:
- Starting Stack
- Blind Level
- Payout Default

## OI-008 — Live Ruling完全範囲

MVPでは代表的なCore Rulingを扱います。

すべてのCasino Edge CaseをMVP要件にしません。

Versioned Rule Profileで拡張可能にします。

## OI-009 — Multiway Deep Solver

MVP Blockerではありません。

Unsupported時:

- Math
- Range Analysis
- KB
- Review AI

へFallbackします。

HU ApproximationをExact Multiway GTOとして表示してはいけません。

## OI-010 — Runtime Web Search Provider

Evidence Gateの振る舞いは確定。

具体的Provider / Integrationは未確定です。

## OI-011 — Chipの数値表現

前提（docs/09 §3）:
- Chip総量の保存（INV-TEST-002 / 005）を完全一致で検証できる表現にする

暫定（Phase 1・Issue #17。人間判断ではないためDは付けない）:
- Chipは「最小単位の整数」（`number`。`Number.isSafeInteger` で検証）で表し、浮動小数は使わない
- Blind・Stack・Bet・Potはすべて同じ単位で持つ
- Phase 1 Presetは SB 1 / BB 2 / Starting Stack 200（100BB）。`packages/engine/src/table-config.ts` の `PHASE1_CASH_PRESET`

未確定:
- 最小単位と実額（通貨・Denomination）の対応（OI-004と合わせて決める）
- `bigint` 等への変更要否（Stack上限・Tournamentの桁）

## すでに確定しており、Routine Implementationで再検討しない項目

- Local Single User
- Authなし
- Tenantなし
- TypeScript中心
- Event Log正本
- Deterministic Poker Engine
- CPU KnowledgeState分離
- Learning Reveal Isolation
- 実額常時表示
- Chip-based Live Interaction
- Voice Recognition Scope外
- Hand ReviewはMVP
- Supported Spotで実Solver統合
- Replay != Re-simulation
- ReproducibilityはBest Effort
