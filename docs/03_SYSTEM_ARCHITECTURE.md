# システムアーキテクチャ

## 1. 技術方針

Application CoreはTypeScript中心とします。

想定構成:
- Local Browser UI
- React / Next.js等のTypeScript Web Stack
- Local Application Runtime
- SQLite
- Specialist AnalyzerはAdapter / Subprocess経由

Solver / Equity Engineは必要に応じて:
- Rust
- Python
- C++

を許可します。

「一言語に揃えるためだけ」に専門計算をTypeScriptへ再実装しないでください。

### ディレクトリ構成（D67・D68）

上記の想定構成のうち、Web StackはVite + ReactのSPA、Local Application RuntimeはFastifyの常駐Nodeで具体化します（D67）。リポジトリはpnpm workspaceです（D68）。

```text
packages/
└─ engine/   Poker Engine（純粋TypeScript。I/O・DB・LLMをimportしない）
apps/
├─ server/   Local Application Runtime（Fastify。Claude API・SQLiteはここだけが扱う）
└─ web/      Local Browser UI（Vite + React。ブラウザへAPI Keyを渡さない）
```

- `apps/web`はdev時に`/api`を`apps/server`へproxyし、ブラウザは同一originの`/api`だけを呼びます。
- `apps/server`はlocal専用で`127.0.0.1`にbindします。
- `packages/engine`はruntime依存を持たず、`apps/*`へも依存しません（D68）。

### Phase 1の実装方針（D70〜D73）

- **Betting範囲（D70）**: 全員100BBの均等Stack・単一Potで、Fold / Check / Call / Bet / Raise / All-inとMinimum Raiseを実装します。Side Pot・Short All-in Reopen・Split Potの端数はPhase 2で、未対応の状態はEngineが明示エラーにします。
- **暫定CPU（D71）**: seed付きの決定論ルールBotです。合法Actionから選び、そのPlayerに見える情報だけを受け取ります。将来D41 / D42のFallback / Emergency Botに流用します。
- **永続化（D72）**: `node:sqlite`（Node 24内蔵）を`apps/server`だけが使います。ORMなし・生SQL・自前の小さなマイグレーションで、EventはJSON列にappend-onlyで保存します。
- **通信（D73）**: HeroのActionはREST（POST）、卓の状態はSSEでPushします。PushするのはHeroに見えるProjectionだけです。
- **Engine の入口（Issue #17）**: `packages/engine` は純粋関数で、`startHand`（Hand開始）→ `getLegalActions`（現在のActorの合法Action）→ `applyAction`（Actionの適用。Streetの進行・Showdown・Potの配分まで自動で進める）を持ちます。各Commandは新しいEventと畳み込み後のStateを返し、Event Logへの追記は呼び出し側が行います。Playerごとの可視Projectionは `projectHeroView`（Hero表示用）/ `projectBotView`（暫定CPU用）です。Event構成は `docs/04` §3。Chipは最小単位の整数です（暫定。OI-011）。

## 2. Logical Component

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
├─ Pot / SidePot Engine
├─ Position Engine
└─ Rule Profiles

AI / Analysis
├─ Opponent Agent Adapter
├─ Model Router
├─ Math / Equity Engine
├─ Solver Adapter
├─ Knowledge Retrieval
├─ Evidence Sufficiency Gate
├─ Web Research Adapter
└─ Review Agent

Persistence
├─ Event Store
├─ Hand / Session Projection
├─ CPU Memory Store
├─ User Learning Store
└─ Review Version Store
```

## 3. Model Role

Domain Logicへ具体モデル名をHard Codeしません。

例:

```yaml
models:
  opponent_fast: claude-haiku-...
  review_standard: claude-sonnet-...
  review_deep: claude-sonnet-...
```

初期方針:
- Opponent: Haiku級
- Review: より上位モデル
- コスト / Latency / Quality実測後にRouting変更可能

## 4. Hand Orchestration

```text
Start Hand
 ↓
Poker EngineがState初期化
 ↓
Event発行
 ↓
Next Actor決定
 ↓
Actor用KnowledgeState構築
 ↓
Legal Actions構築
 ↓
HeroならUI
CPUならOpponent Agent
 ↓
Output Validation
 ↓
Canonical Action適用
 ↓
Event発行
 ↓
次Action
 ↓
Hand Finished
 ↓
Projection / Snapshot保存
 ↓
Review可能
```

## 5. CPU Output Validation

Opponent Agentへ渡すもの:
- KnowledgeState
- Legal Actions
- Legal Amount Range
- Relevant Math
- Persona / State

Validation:
1. Schema
2. Legal Action
3. Amount Range

Invalid時:
- 1回だけ明示的にCorrectionしてRetry
- 再度InvalidならDeterministic Safe Fallback

Invalid OutputはLogへ残します。

## 6. AI障害

ユーザーに選択させます。

- Retry
- Emergency Botで続行
- Session終了 / Pause

Emergency Botへ自動切替しません。

Fallback利用Hand / ActionにはFlagを付けます。

## 7. Review Orchestration

```text
Hand Events
 ↓
Heroの判断時点Information Setを再構築
 ↓
Deterministic Math
 ↓
Range Analysis
 ↓
Solver Capability Check
 ├─ Supported → Solver Evidence
 └─ Unsupported → Skip
 ↓
Local KB Retrieval
 ↓
Evidence Sufficiency
 ├─ Enough → Review AI
 └─ Insufficient → Web Research → Review AI
 ↓
必要ならReview Interview
 ↓
Versioned Review
```

## 8. Solver Adapter

概念Interface:

```ts
interface SolverAdapter {
  capabilities(): SolverCapability;
  supports(spot: AnalysisSpot): SupportResult;
  analyze(
    spot: AnalysisSpot,
    options: SolveOptions
  ): Promise<SolverEvidence>;
}
```

Unsupported Spotは正常系です。

MVP要件:
- 少なくとも1つのLocal Solverが実働
- Supported Spotでは実際にSolver Evidenceを使う
- Unsupported SpotではGraceful Fallback

HU SolverをMultiwayのExact GTOとして表示してはいけません。

## 9. Knowledge Base

Research Packをそのまま毎回LLMへ入れません。

```text
Research Pack
 ↓
Curated Knowledge Base
 ↓
Retrieval
 ↓
Review Evidence
```

MVPではVector DBを必須にしません。

Metadata + Topic / Full-text Retrievalから開始可能です。

## 10. Web Fallback

Local Evidenceが不足するときだけ使います。

Trigger例:
- 未知の用語
- House-specific Rule
- Current Solver / Tool Behavior
- Source Conflict
- KB Coverage不足

Web Evidenceには:
- Source
- Date
- Scope
- Confidence

を保持します。

## 11. Architecture上の非目標

新たな人間判断なしに導入しないもの:

- Auth Provider
- Cloud DB
- Multi Tenant
- Distributed Microservices
- Kubernetes
- Remote Event Bus
- 大規模Event Sourcing Framework
