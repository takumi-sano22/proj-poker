# MVPとロードマップ

## 1. MVPのプロダクト約束

> Haiku級CPU相手に、ライブ実戦を意識したNLHE Cash Sessionを最後まで遊び、実チップ操作を行い、そのHandをMath + AI + 対応可能な実SolverでReviewできる。

「ポーカーが遊べる」だけではMVP完成ではありません。

## 2. MVP Definition of Done

### Game

- NLHE Cash
- 2〜8人
- 6-max / 約100BBの標準Preset
- 正しいButton / SB / BB Rotation
- Fold / Check / Call / Bet / Raise / All-in
- Minimum Raise
- All-in
- Side Pot
- Split Pot
- Showdown
- Hand Ranking
- Heads-Up Transition

### CPU

- Hero以外をAI CPUにできる
- Player-specific KnowledgeState
- Legal Action Contract
- 基本的なSkill / Persona差
- Invalid Output Retry / Fallback
- AI障害時にUser Choice

### UI

- 実卓寄り2D Table
- 実額常時表示
- Card / Chip構造描画
- Click + Drag Chip Betting
- Declaration Buttons
- Dealer Flow
- 基本Poker用語

### Logging / Persistence

- Hand Event Log
- Hand Summary Projection
- Completed Hand Auto Save
- Replay
- Best-effort Debug / Repro Metadata

### Hand Review

- Learning Reveal
- Hindsight LeakなしのDecision Review
- Basic Equity / Pot Odds
- Important Spot抽出
- Alternative Action比較
- Range Reasoning
- Follow-up
- Local KB Retrieval
- 実Solver Adapter最低1つ
- Unsupported Spot Fallback
- Versioned Review

### Quality

- Deterministic Poker Engine Unit Test
- Invariant Test
- Fixed Regression Hands
- Information Leakage Test
- Solver Adapter Test
- 6-max SessionをPlay→Finish→Review→Replay→Next HandまでE2Eで完走

## 3. 推奨実装順

### Phase 0 — Repository / Docs / Tooling

- Docs Merge
- HumanがClaude Skills / Harness投入
- TypeScript Project Skeleton
- Lint / Typecheck / Test

### Phase 1 — Vertical Poker Slice

- 6-max Cash 1 Hand
- Basic UI
- Event Log

### Phase 2 — Full Poker Engine

- 2〜8人
- Betting State
- Side Pot
- Heads-Up
- Deterministic Tests

子Issue #31〜#36 に分解します（D77）。Optional BB表示・Fast ForwardはPhase 4、再起動後のSession ResumeはPhase 5で扱います。

### Phase 3 — AI Opponents

- Model Adapter
- KnowledgeState
- Basic Persona
- Structured Action
- Retry / Fallback

### Phase 4 — Live Mechanics

- Chip Physical Action
- Declaration
- Ruling Engine
- Dealer Feedback
- Replay

### Phase 5 — MVP Review

- Decision Reconstruction
- Math / Equity
- KB
- Review AI
- Solver Adapter
- Reveal Review
- Follow-up

**ここでMVP完成。**

## 3.1 Post-MVPの実装順（D102）

MVP Parent #2はPhase 5の完了でCloseしました（再オープンしない）。MVP後は、Post-MVP Parent #104の下にPhaseごとのParent（#105・#106・#107）を置き、その下に子Issueを作ります。

| Phase | Parent | 内容 |
|---|---|---|
| Phase 6 | #105 | Session Learning |
| Phase 7 | #106 | Rich Opponent Simulation |
| Phase 8 | #107 | Tournament（6-max STT / ICM） |

実装は **Phase 6 → Phase 7 → Phase 8** の順です。後のPhaseの調査・設計メモは構いませんが、前のPhaseのGate（§3.2）を満たすまで次のPhaseの機能実装に入りません。MVPの不変条件（`docs/02` §1・§2、`CLAUDE.md`の不変条件）はPost-MVPでもそのまま継承します。

### Phase 6 — Session Learning（#105。D103〜D105）

- Detailed Stats（全Player対応のProjection。UIはHero主体）
- Ability / Overall Score（`ScoringPolicy phase6_provisional_v1`。OI-006の暫定値）
- Confidence / Sample Size / Evidence IDs / Trend
- Evidence-backed Weakness Hypothesis / Recent・Long-term Player Profile
- User Read / Note / Tag
- Targeted Drill

子Issueの分解（#105の推奨。着手時に`phase-planning`で確定する）:

| ID | 内容 |
|---|---|
| P6-0 | Post-MVP Decision / Docs Sync（#108。この文書の同期） |
| P6-1 | Analytics Projection / Detailed Stats |
| P6-2 | Ability Evidence / ScoringPolicy |
| P6-3 | Hypothesis Lifecycle / Player Profile |
| P6-4 | User Read / Note / Tag |
| P6-5 | Session Review / Learning UI |
| P6-6 | Targeted Drill |
| P6-7 | Reset / Persistence / Rebuild |
| P6-8 | Eval / Critical E2E / README |

### Phase 7 — Rich Opponent Simulation（#106。D106・D107）

- Persistent CPU Memory（Fixed CPUの永続`cpuProfileId`）
- CPU-to-CPU Memory（Observer CPUのPrivate Memory）
- Tilt（Version付きの決定論State Machine・transient）
- Fixed Pool + Guest
- Table Tendency（観察可能なEvidenceだけ）

子Issueの分解（#106の推奨）: P7-1 Fixed CPU Identity / Pool / Guest・P7-2 Observation Evidence Store・P7-3 Private Opponent Hypothesis / Recency・P7-4 Memory → KnowledgeState Integration・P7-5 Tilt State Machine・P7-6 Table Tendency・P7-7 Opponent Policy / Eval・P7-8 Reset / Persistence / Migration・P7-9 Critical E2E / README。

### Phase 8 — Tournament（#107。D108・D109）

- 6-max STT（最初の標準Preset）
- Blind / Ante（標準はHand数base・Big Blind Ante）
- Elimination / Payout（暫定Preset 50 / 30 / 20。OI-007）
- ICM（2〜8人の決定論Calculator）
- Tournament-aware CPU / Review

子Issueの分解（#107の推奨）: P8-1 Tournament Mode / Session Model / Preset・P8-2 Blind / Ante Engine Integration・P8-3 Elimination / Position / Tournament Progression・P8-4 Payout / Result・P8-5 Deterministic ICM Calculator・P8-6 Tournament KnowledgeState / CPU Adaptation・P8-7 Tournament Review / ICM Evidence・P8-8 Tournament UI・P8-9 Tournament Critical E2E / README。

## 3.2 Post-MVPのPhase Gate（#104）

Phase 6の開始（Documentation Gate）:

- #104で確定した判断をD番号で記録し（D102〜D109）、`docs/07`・`05`・`02`・`08`・`11`へ同期するDocumentation PR（#108）がレビュー・マージされていること。人間が#104のGateを確認するまで、Phase 6の機能実装に入りません。

Phase 6 → Phase 7:

- StatsをEventから再計算できる
- ScoreがPolicy Version付きで再計算できる
- Confidence / Sample Size / Evidence IDsが保持される
- HypothesisがSupporting / Counter Evidenceから決定論的に更新される
- Recent / Long-term Profileが自然言語Summaryに依存せず再生成できる
- User Read / Note / TagがHidden Personaと混ざらない
- Drillが元Handとprovenanceを持ち、Engine Validationを通る
- Phase 6のCritical E2Eが通る

Phase 7 → Phase 8:

- Fixed CPU IdentityとGuestの寿命がテストされる
- Observationがprovenanceを持つ
- CPU Private MemoryのIsolation Testが通る
- Learning-only RevealがMemoryに入らない
- recency decayを含むHypothesis Projectionが再構築可能
- Tiltがdeterministic / versioned / transient
- Cash / Tournament contextのStrategy Hypothesisが分離される
- Phase 7のCritical E2E / Evalが通る

各PhaseのDefinition of DoneはParent Issue（#105・#106・#107）が一次情報です。

## 4. Scope Creep防止

MVPを以下でBlockしません。

- Full Multiway Solver
- Tournament
- 高度Persistent CPU Memory
- 完全LLM再現
- Vector DB
- Voice
- 3D
- すべてのLive Ruling
- 完全なTracker Dashboard

Post-MVP（#104〜#107）を以下でBlockしません（D102）。

- Full Multiway Solver
- Push/Fold Nash Solver等のTournament Solver
- Online Multiplayer
- Auth / Tenant / Multi-user
- Voice / 3D
- MTT
- Re-entry / Rebuy / Add-on
- Satellite / Bounty / PKO
- 完全なCasino Rule Coverage
- LLM Memoryを正本とする構成

## 5. 実装開始前の必須停止

以下が終わったら**実装を開始せず停止**します。

1. DocsをRepositoryへ入れる
2. Documentation PRを作る
3. Parent Issueを作る

その後:

4. 人間が他PJ由来のClaude Skills / Harnessを投入
5. その内容を開発規約として確認
6. Phase 0 / 1実装開始

Claude Codeは4を飛ばしてはいけません。

Post-MVP（Phase 6以降）の開始の停止条件は§3.2のDocumentation Gateです。Claude CodeはこのGateも自己判断で解除しません。
