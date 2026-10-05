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
- `apps/server`は`packages/engine`をworkspace依存で使います。typecheck・lint・dev（tsx）・testではEngineをbuildせずに`src`から読みます（Engineの`package.json`の`exports`にある条件`@proj-poker/source`を、serverの`tsconfig.json`の`customConditions`・`vitest.config.mjs`・`tsx --conditions`で指定）。`build`（`tsconfig.build.json`）と`start`はbuild済みの`dist`を使います。
- `apps/web`も`packages/engine`をworkspace依存（devDependencies）にしますが、importするのは型（`HeroView`・`LegalActionSet`・`PlayerAction`等）だけです。Engineのロジックをブラウザで動かして合法性や他者の札を判断しません。型は同じ条件`@proj-poker/source`（webの`tsconfig.json`の`customConditions`）で`src`から読みます。

### Phase 1の実装方針（D70〜D75）

- **Betting範囲（D70）**: 全員100BBの均等Stack・単一Potで、Fold / Check / Call / Bet / Raise / All-inとMinimum Raiseを実装します。Split Potの端数はD75でPhase 1に前倒しして実装しました。Side Pot（不均等Stack）はPhase 2の#31で実装し、未対応の明示エラー（`unsupported_state`）は無くなりました（D78）。Short All-inによるActionの再開（Reopen。累積Short All-inを含む）はPhase 2の#32で実装しました（D79）。
- **暫定CPU（D71）**: seed付きの決定論ルールBotです。合法Actionから選び、そのPlayerに見える情報だけを受け取ります。将来D41 / D42のFallback / Emergency Botに流用します。
- **永続化（D72）**: `node:sqlite`（Node 24内蔵）を`apps/server`だけが使います。ORMなし・生SQL・自前の小さなマイグレーションで、EventはJSON列にappend-onlyで保存します。保存の単位はCompleted Hand（D62）で、テーブル・マイグレーション・Eventの版（`schema_version`。D76）は`docs/04` §3・§10です。
- **通信（D73）**: HeroのActionはREST（POST）、卓の状態はSSEでPushします。PushするのはHeroに見えるProjectionだけです。
- **Engine の入口（Issue #17）**: `packages/engine` は純粋関数で、`startHand`（Hand開始）→ `getLegalActions`（現在のActorの合法Action）→ `applyAction`（Actionの適用。Streetの進行・Showdown・Potの配分まで自動で進める）を持ちます。各Commandは新しいEventと畳み込み後のStateを返し、Event Logへの追記は呼び出し側が行います。Playerごとの可視Projectionは `projectHeroView`（Hero表示用）/ `projectBotView`（暫定CPU用）です。Event構成は `docs/04` §3。Chipは最小単位の整数です（D74）。Split Potの端数（Odd Chip）は、Rule Profileの設定値 `oddChipRule`（暫定値 `first_left_of_button`: Buttonの左から時計回りで最初の勝者へ1 Chipずつ。OI-008の暫定値）に従って `splitPot` が配ります（D75）。Side Potは `buildPots`（`side-pots.ts`）がFoldしていないPlayerのCommit額ごとに段を切ってMain / Side Potを組み立て、Potごとに勝者を決めて配ります（D78）。Betting Roundの終わりに誰もCallしていない超過分（Uncalled Bet）を返してからPotを組み立てます。Short All-inの後のRaiseの再開（Reopen）は、Rule Profileの設定値 `reopenRule`（暫定値 `cumulative_full_raise`: TDA準拠。行動済みのPlayerには、そのPlayerが最後に行動した時点の最高額からの上乗せの合計が直近のFull Raise幅以上になったときだけ再開する。Full Raise未満のAll-inは1回では再開しないが、複数の合計で達すれば再開する。OI-008の暫定値）に従って `getLegalActions` が判定します（D79）。Minimum RaiseはShort All-inでは変わらず、直近のFull Raise幅のままです。
- **Hand Orchestrator・暫定CPU・API（Issue #18）**: `apps/server`の構成は次のとおりです（§4の流れを実装したもの）。
  - `hand-orchestrator.ts`（Hand Orchestrator）: Stateは毎回Event Store（Event Log）から`foldHandEvents`で作り、別のStateを持ちません（D37）。`startHand` → Hero の手番か Hand の終了まで CPU を進める → Hero の Action を`applyAction`で検証して適用 → また CPU を進める、を繰り返します。CPUの手番はserver側で進め、Heroの入力待ちで止まります。CPUの思考待ち（演出）はConfig値`BOT_THINK_DELAY_MS`（既定600ms・テストは0）で、待ちの間に Log が進んでいたら予約した手番を捨てます。
  - `opponents/`（Opponent Agent Adapter）: `OpponentAgent.decide({ view, legal })`のInterfaceで、Domainの外に置いた差し替え口です。入力は`projectBotView`の結果とLegal Actionだけです。暫定CPU（D71）の`RuleBot`は、自分の札と公開Boardから手の強さを3段階で見積もり、seed付きの乱数で合法Actionから選びます（CPUのseedはHandのseedから席ごとに導きます）。CPUの出力は`applyAction`で検証し、拒否・例外ならDeterministic Safe Fallback（Check、できなければFold）にして、Fallbackの記録（seq・Player・理由）をHandの運用Metadataとして残します（§5。Retryと`AI_FALLBACK_USED` EventはLLMのOpponentを入れるときに足します）。
  - `event-store.ts`（Event Store）: §2 Persistence の Event Store の Interface（`append` / `read`）と、メモリ内の実装です。append-onlyで、seqが連続しない追記（二重追記・抜け）と`HAND_FINISHED`の後ろへの追記は何も書かずに拒否します。保存時にEventを複製して配下まで凍結し、呼び出し側の参照から書き換えられないようにします。起動時（`index.ts`）は同じInterfaceのSQLite実装（下記）を渡し、メモリ内の実装はテスト用です。
  - `sqlite-event-store.ts`・`db/database.ts`（Event StoreのSQLite実装。Issue #20・D72）: `db/database.ts`がDBファイルを開いてマイグレーションを当て、`SqliteEventStore`が`HAND_FINISHED`の時点でHandの全Eventを1トランザクションで書きます。Hand途中のEventはメモリに持ちます（D62）。DBの場所は環境変数`POKER_DB_PATH`（既定`apps/server/data/poker.sqlite`。gitignore済み）。詳細は`docs/04` §10。
  - `routes/hands.ts`（API。D73）: 下表。入力の形はJSON Schemaで検証し（型の自動変換・余分な項目の黙った削除はしない）、合法性はEngineが判定します。返す・PushするのはHeroに見えるProjection（`projectHeroView`）だけで、Hand のseedはclientから受け取らず、返しません。
  - 卓の人数・CPUの名前は`config.ts`の`PHASE1_TABLE_SETUP`（Hero 1人 + CPU 5人。OI-005の暫定値）で、ButtonはHandごとに時計回りに1席ずつ動かします。

| Method・Path | 入力 | 成功時の応答 | 主な失敗 |
|---|---|---|---|
| `POST /api/hands` | なし | 201 `{ handId, players: [{ playerId, displayName, kind }], view: HeroView }`（Heroの手番かHandの終了までCPUを進めた時点） | — |
| `POST /api/hands/:handId/actions` | `{ lastSeq, action }`。`lastSeq`はclientが見ていた`view.log`の最後の`seq`、`action`は`{ type: fold / check / call / all_in }`か`{ type: bet / raise, amount }`（`amount`はそのStreetの累計＝to額） | 200 `{ view: HeroView }` | 400 形の不正（schema）／404 Handが無い／409 `stale_view`（`lastSeq`より Log が進んでいる＝二重送信・古い画面）・`not_actor`・`hand_complete`／422 `illegal_action` |
| `GET /api/hands/:handId/stream` | なし | SSE（`text/event-stream`）。メッセージは`event: view`で、`data`は`HeroView`のJSONです。接続時に現在のViewを1回送り、以後はLogが進むたびに送ります。`status`が`complete`のViewを送ったらserverが閉じます（clientは再接続しない） | 404 Handが無い |

失敗の応答は`{ error: { kind, message } }`です。

- **Basic UI（Issue #19）**: `apps/web`の構成は次のとおりです。表示はすべてserverから届いた`HeroView`に基づき、clientは状態を進めず、合法性も判定しません（D40・D73）。
  - `hooks/useHandSession.ts`: `POST /api/hands`でHandを始め、`EventSource`で`/stream`を購読し、Heroの宣言を`POST .../actions`で送ります。RESTの応答とSSEのPushのどちらが先に届いても、同じHandで`log`の最後の`seq`が進んでいる方だけを残します（別Handの遅れた応答は捨てる）。送信中はrefとstateの2層で二重送信を止めます。`complete`のViewを受けたら`EventSource`を閉じます。SSEの`data`は最小の形検査（`parseHeroView`）を通ったものだけを描画へ流します。
  - `components/`: 卓（`Table`。席はHeroを画面下の中央に置き、席順＝時計回りに配置。SB / BBは公開Eventの`BLIND_POSTED`から読む）、Card（`PlayingCard`。SVGの構造描画。D60）、金額（`Amount`。実額が正本でBBは補助。D49）、宣言ボタン（`ActionBar`。`legalActions`にあるActionだけを出し、Bet / Raiseの額はPreset〔最小・½ Pot・¾ Pot・Pot〕とSliderで選ぶ。数値の入力欄は作らない。docs/06 §4）、進行ログ（`HandLog`）。他者の札は`seats[].holeCards`に入っているもの（Showdownで公開された札）だけを表に向け、それ以外は裏向き（Fold済みの席は札なし）で描きます。HeroがFoldした後もHandの終了まで観戦を続けます（docs/06 §8）。
  - 見た目の値は`styles.css`の`:root`のトークン（役割名の色・影3段・層ごとの角丸）に置いた暫定値です。卓UI向けのデザイン体系は#5で整えます。

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
