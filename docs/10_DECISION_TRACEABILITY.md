# 人間判断のトレーサビリティ

D01〜D93の採用済み人間判断は、`decision_log.yaml` を正本として保存しています。

Claude Codeはこれらを自己判断で上書きしてはいけません。

## 判断グループ

| ID | 主な対象 |
|---|---|
| D01〜D09 | Review、Hint、評価方針 |
| D10〜D15 | 卓編成、Memory、Cash/Tournament、Chip、Dealer |
| D16〜D24 | Session Learning、GTO、Solver、KB、Web |
| D25〜D30 | CPU Persona、Leak、Tilt、Information Boundary |
| D31〜D36 | User Read、HUD、Score、Drill |
| D37〜D42 | Event Log、Replay、Review Version、Engine、AI障害 |
| D43〜D54 | UI、Live Mechanics、Cash/Tournament Config |
| D55〜D60 | MVP、Stack、Solver、Research、Test、Asset |
| D61〜D66 | Single User、Persistence、CPU Pool、Reset、Latency、MVP DoD |
| D67〜D69 | Web Stack、Repository構成、品質ツール |
| D70〜D76 | Phase 1 のBetting範囲、暫定CPU、永続化、通信、Chipの数値表現、Odd Chip Split、Eventの版（schema_version） |
| D77〜D81 | Phase 2 の分解、Side PotのEvent（POT_AWARDEDのPot単位化・schema_version 2）、Short All-inのReopen、Bust・Buttonの移動、Reopen規則のEvent化（HAND_STARTEDのreopenRule・schema_version 3） |
| D82〜D86 | Phase 3 の分解、AIのEvent（AI_ACTION_INVALID / AI_FALLBACK_USED・schema_version 4）、APIキーの置き場所と実API呼び出しの扱い（D84。D87で変更）、opponent_fastのModelとPersonaの暫定値、AI障害時のUser Choice |
| D87 | Claudeの認証をClaude CodeのOAuth（サブスク枠）にする（ユーザー指示。D84を変更）。Agent SDK経由・資格情報はリポジトリとブラウザに置かない・ANTHROPIC_API_KEYは子プロセスから外す |
| D88 | AI障害時のSession終了とEmergency BotのSession単位の登録はPhase 3ではメモリに持ち、Event Logへの記録はPhase 5のSession Resumeで設計する（Emergency Botの各ActionはAI_FALLBACK_USED） |
| D89〜D93 | Phase 4 の分解（D89）、宣言・物理的なChip操作・裁定のEvent（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING・schema_version 5。D90）、Rulingは TDA準拠の3種（D91）、Chipの額面Preset（1/5/25/100/500。D92）、ReplayとFast Forwardの範囲（D93） |

## 特に重要なClosed Decision

### D28

CPUごとに `KnowledgeState` を分離する。

### D37

Event Logを正本とする。

### D38

ReplayとRe-simulationは別物。完全再現はHard Requirementではない。

### D40

Poker Rulesは決定論的Code、LLMは戦略選択のみ。

### D49

実額は常に表示する。BBは補助。

### D55 / D66

Hand ReviewまでがMVP。

### D56 / D67 / D68

TypeScript中心のlocal Web。Vite + ReactのSPA（Local Browser UI）と常駐Node（Fastify）のLocal Runtime。Claude APIとSQLiteはRuntime側だけが扱う。pnpm workspaceで`packages/engine`（I/O・LLM非依存の純粋TypeScript）・`apps/server`・`apps/web`に分ける。

### D57

Supported Spotについて、実Solver統合をMVPから行う。

### D61

Single User。Auth / Multi-user設計を作らない。

正確な採用文言・選択肢は `decision_log.yaml` を参照してください。
