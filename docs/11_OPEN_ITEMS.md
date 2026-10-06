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

暫定値は D85（確定ではない）: `opponent_fast` は `claude-haiku-4-5`。

Latency Policy の暫定値（#47 で 15000ms、#50 で見直し。確定ではない）: CPU の 1 回の判断を待つ上限は 30000ms（`apps/server` の Config `OPPONENT_TIMEOUT_MS`）。#50 の実測（Agent SDK・OAuth・`claude-haiku-4-5`・3 人卓・2026-10-06）は 63 回で中央値 約 7.2 秒・p90 約 8.6 秒・最大 15.5 秒（子プロセスの起動〜初期化は約 0.7 秒で、残りは API の応答）。15000ms では 63 回中 1 回が超え、障害で Hand が止まるため、最大の約 2 倍に上げた。詳細は `docs/taskLog/issue-50-agent-sdk-adapter.md`。

遅延表示の暫定値（#52。確定ではない）: CPU の同じ手番がこれを超えて続いたら、卓に「AI応答が遅延しています」を補足する（docs/06 §11・D86）。10000ms（`apps/web` の `lib/config.ts` `AI_DELAY_NOTICE_MS`）。上の実測の p90（約 8.6 秒）を超えて待つときに出し、障害として止める上限（30000ms）より短くした。

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

暫定値は D92（確定ではない。永久仕様にしない）: 額面は1（白）・5（赤）・25（緑）・100（黒）・500（紫）の5種（D92）。額からChipの構成を自動で組む。

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

暫定値は D85（確定ではない）: Persona は TAG Regular・LAG・Calling Station・Nit・Maniac・Weak-tight Recreational の 6 Preset。各 Preset の 11 軸の数値・RuleBot への反映の係数・卓への既定の割り当て順（TAG Regular・LAG・Nit・Calling Station・Weak-tight Recreational・Maniac を席順に）も暫定値で、`apps/server/src/opponents/persona.ts`・`rule-bot.ts`・`config.ts` に置く（#51。環境変数 `CPU_PERSONAS` で割り当て順を変えられる）。Playtest で見直す。

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

暫定値（永久仕様ではない。確定は人間判断を経て D 番号で行う）: Split Potの端数の配り方（D75）、Short All-inのReopenは累積Full Raise（D79）、BustしたCPUの退席とButtonの移動（D80）、RulingはTDA準拠のOversized Chip・String Bet・Out-of-Turnの3種（暫定値は D91。確定ではない）。

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
