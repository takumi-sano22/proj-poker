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

Review の暫定値は D97（確定ではない）: `review_standard` は `claude-sonnet-5-5`、`review_deep`（Hero が「詳しく」を選んだ Spot だけ）は `claude-opus-5-5`。実装は #82。

Review の Latency Policy の暫定値（#82。確定ではない）: Review AI の 1 回の呼び出しを待つ上限は 120000ms（`apps/server` の Config `REVIEW_TIMEOUT_MS`）。#82 の実測（Agent SDK・OAuth・`claude-sonnet-5-5`・2026-10-06）は Review Eval の 4 判断 × 4 回と API の通し 3 Hand で 1 回あたり 12.5〜24.3 秒（Evidence の組み立てを含む API の通しは最大 27.6 秒）。構造化出力の JSON の直しで 2 ターンになる回と `review_deep` の遅さを見込んで最大の約 5 倍に置いた。Review は Hand の進行と切り離して裏で作る。Solver の Solve の上限（`SOLVER_TIMEOUT_MS`）は #82 で 20000ms から 60000ms に見直した（Range Model の Range の HU Turn が約 33 秒。`docs/03` §8）。詳細は `docs/taskLog/issue-82-review-ai-pass-a.md`。

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

→ D96 で選定（#76 の PoC に基づく）: Primary Solver は amaster97/poker_solver（MIT）で、Capability は HU の River と Turn だけを宣言する。Flop と Multiway は Unsupported として正常に Fallback し前提を表示する（OI-009）。noambrown/poker_solver はテストでの照合にだけ使い、TexasSolver は採用しない。実装は #81。

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

D106で確定（Identityと寿命。人数等は未確定のまま）: Fixed CPUは席・player idと別の永続`cpuProfileId`を持ちMemoryはSessionを跨いで持続する。GuestのMemoryはSession終了時に破棄する。上の「未確定」（人数・Name・Avatar・Persona Distribution）はこの判断では決めていない。

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

暫定値は D103・D104（確定ではない。永久仕様にしない）: Scoreは Version付きの暫定式 `ScoringPolicy phase6_provisional_v1` で計算する。Pass A Assessmentの点は strong 100・reasonable 80・mixed_marginal 60・improvement_suggested 35・major_leak 0、insufficient_evidence は集計から除外。Confidenceは点数を変えず集計のWeightに使う（Weightの値と集計式は暫定値）。Player ProfileのRecentは直近100の有効Decision（Config）。Decision → Abilityの割り当てとWeightは決定論・Version付き。Drillの結果は通常Scoreに混ぜない（D105）。上の「未確定」（Weight・Hint-assisted補正・Confidence Aggregation）は、Playtest後にPolicyのVersionを上げて見直す（`docs/07` §2）。

#113で `phase6_provisional_v1` に置いた暫定値（確定ではない。詳細は `docs/07` §2「実装（#113）」）: ConfidenceのWeightは high 1・medium 0.7・low 0.4。Decision → Abilityの割り当ては、Streetの Ability（Preflop / Postflop）を Weight 1、Bet Sizing・Pot / Equity Math・Range Reading・Positionを条件つきで Weight 0.5（Opponent Adaptationは割り当てなし）。Live Mechanicsは、理由のある裁定が入った判断を0点・入らなかった判断を100点とする別のScore（D48）。ScoreのConfidenceは件数で決め（0件 insufficient・1〜9 low・10〜29 medium・30以上 high）、Trendは直近10件とその前の10件の差（5点以上）で見る。同じ判断に複数のReviewのVersionがあれば最新を使い、standard / deepの優先は付けない。Hint-assisted補正はまだ入れていない。

#114で置いた暫定値（確定ではない。詳細は `docs/07` §4・§5「実装（#114）」）: Player ProfileのRecentは直近100の有効Decision（Pass AのReviewがある判断。`ProfilePolicy phase6_profile_v1`）。Weakness Hypothesisの`HypothesisPolicy phase6_hypothesis_v1`は、typeを5つ（`preflop_unraised` / `preflop_facing_raise` / `postflop_facing_bet` / `postflop_unbet` / `bet_raise`）、Supportingを`improvement_suggested` / `major_leak`、Counterを`strong` / `reasonable`とし、状態のしきい値は 3件未満 insufficient_data・Supporting 4件以上かつ6割以上 strong・2件以上かつ4割以上 supported・直近5件の窓でSupporting 1件以下 improving / 0件 resolved。Playtest後にVersionを上げて見直す。

## OI-007 — Tournament Preset

確定:
- STT
- ICM

未確定:
- Starting Stack
- Blind Level
- Payout Default

暫定値は D108（確定ではない。永久仕様にしない）: 最初の標準Presetは6-max STT。Blind StructureはCoreで時間base / Hand数baseの両方を扱い、標準PresetはHand数base。標準STTのAnteはBig Blind Ante。初期6-max STTのPayoutは50% / 30% / 20%（Custom Payoutを後から足せる構造）。Starting Stack・Blind Levelの値は、P8-1でVersion付きConfigに暫定値を置く（`docs/02` §7）。

## OI-008 — Live Ruling完全範囲

MVPでは代表的なCore Rulingを扱います。

すべてのCasino Edge CaseをMVP要件にしません。

Versioned Rule Profileで拡張可能にします。

暫定値（永久仕様ではない。確定は人間判断を経て D 番号で行う）: Split Potの端数の配り方（D75）、Short All-inのReopenは累積Full Raise（D79）、BustしたCPUの退席とButtonの移動（D80）、RulingはTDA準拠のOversized Chip・String Bet・Out-of-Turnの3種（暫定値は D91。確定ではない）。宣言の優先と合法範囲への寄せ方・Multiple Chip（50%規則）・Out-of-Turnの「状況が変わる」の判定条件は、#63でTDAに沿ってRule Profile `phase4_provisional_v1` に置いた暫定値（docs/02 §3。TDAとの差もそこに書く）。

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

## OI-011 — Opponent MemoryとTiltのParameter

確定（D106・D107）:
- Hypothesis / Tendencyの集計にrecency decayをかける（Raw Evidenceは消さない）
- Tiltは Version付きの決定論State Machineで、Hand間で増減・減衰し、Session終了でReset

未確定:
- recency decayの係数・形
- 十分なSampleの基準
- PersonaごとのHypothesisの更新の速さ・早合点の傾向
- TiltのTrigger・しきい値・増減・減衰の値と、Personaへの反映の大きさ

Phase 7でVersion付きのConfig / Policyに暫定値を置き、Eval / Playtestで見直します。

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
