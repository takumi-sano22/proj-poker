# 人間判断のトレーサビリティ

D01〜D74の採用済み人間判断は、`decision_log.yaml` を正本として保存しています。

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
| D70〜D74 | Phase 1 のBetting範囲、暫定CPU、永続化、通信、Chipの数値表現 |

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
