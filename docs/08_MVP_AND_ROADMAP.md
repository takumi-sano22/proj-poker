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

### Phase 6 — Session Learning

- Detailed Stats
- User Hypothesis
- Player Profile
- Score
- Drill

### Phase 7 — Rich Opponent Simulation

- Persistent CPU Memory
- CPU-to-CPU Memory
- Tilt
- Fixed Pool + Guest
- Table Tendency

### Phase 8 — Tournament

- STT
- Blind / Ante
- Payout
- ICM

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
