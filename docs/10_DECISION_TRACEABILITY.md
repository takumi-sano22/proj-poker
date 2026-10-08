# 人間判断のトレーサビリティ

D01〜D126の採用済み人間判断は、`decision_log.yaml` を正本として保存しています。

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
| D94〜D98 | Phase 5 の分解（#77〜#85・Web FallbackはMVPに入れない。D94）、Sessionの開始・終了・Handの打ち切り・Emergency Botへの切り替えのEvent（SESSION_STARTED / SESSION_ENDED / HAND_ABORTED / EMERGENCY_BOT_ENGAGED・schema_version 6）とSession Projection・reviewsのテーブル（D95。D88のEvent化）、Primary Solverはamaster97/poker_solverのHU River / Turn（OI-002の選定。D96）、Reviewのモデルの暫定値（review_standard / review_deep。OI-001の暫定値。D97）、Curated KBとPlaywrightのE2E（D98） |
| D99 | Reveal Review（Pass B）とFollow-upの履歴は、マイグレーションv4で足す追記だけのreveal_reviews（Assessmentを持たない）とreview_followupsに保存し、Pass Aのreviewsは変えない（#83の途中の人間判断） |
| D100 | HandごとのBest-effort Metadata（App Version・CPUのprovider / Model・Persona Profile Version）をHAND_METADATA_RECORDED（system）としてEventに残しschema_versionを7に上げる。AIの生データは保存しない（#97） |
| D101 | Review の文の内部識別子（playerId・Evidence の項目名）は Retry せず、保存前に既知の対応表で表示名・自然な言葉へ置換する。Prompt でも禁止し、Eval に残存率を足す（#96） |
| D102〜D109 | Post-MVP（#104〜#107）の人間確定方針。Parent構造と Phase 6→7→8 の順序・Gate・不変条件の継承（D102）、Phase 6 の全Player対応 Stats Projection と `ScoringPolicy phase6_provisional_v1`（OI-006の暫定値。D103）、Recent / Long-term Profile と決定論の Hypothesis 遷移（D104）、User Read / Note / Tag と Engine Validation 必須・通常Scoreと別系列の Drill（D105）、Fixed CPU の `cpuProfileId`・Guest の寿命・append-only の Observation と recency decay・observer private の CPU-to-CPU Memory・Table Tendency（D106）、Tilt の版付き決定論 State Machine（D107）、`TournamentSession` 層と 6-max STT・Hand数base・BBA・Payout 50/30/20（OI-007の暫定値。D108）、Public Tournament Context と決定論 ICM（Chip EV と別 Evidence。D109） |
| D110〜D112 | Phase 6 の分解（#112〜#119。Drill は決定論の変形だけで LLM 生成は Phase 6 の範囲外。D110）、Phase 6 の Stats / Score / Profile は都度計算・保存しない（Hypothesis は D104 どおり構造化保存。D111）、User Read は USER_READ_RECORDED（schema_version 8）・Note / Tag はマイグレーション v5 の追記型テーブル（D112） |
| D113〜D116 | Weakness Hypothesis は reviews から作り直せる Snapshot 表（マイグレーション v6。#115 を #114 より先に実装。D113）、Learning Reset は区切りの行の追記で正本を消さず User Read / Note / Tag も消さない（D114）、Score と Decision Quality Summary は Review 済みの判断だけを数え M 件中 N 件を表示（D115）、Drill は専用 Session の通常 Hand と追記型の drills 表で区別し通常の集計から除く（D116） |
| D117 | 意味上の順序（Learning Resetの前後・Replay・Session内のHand・Recent・最新のSession Projection・Resume）は永続的な単調増加の論理順序で決め、壁時計の列は表示・監査のMetadataとして残す。#129・#130は#132でまとめて直し、それまでPhase 6 → 7 Gateを保留する |
| D118〜D121 | Phase 7 の人間確定事項。席と永続 Identity を結ぶ追記型の session_participants（マイグレーション v10）・Fixed Pool はコードの Version 付き Config（OI-005 の暫定値）・Observation は表に持たず Event Log から決定論で抽出・Guest は Session 限りの Identity（D118）、OI-011 の暫定値（phase7_memory_v1 の指数減衰と Sample の基準・phase7_tilt_v1 の 0〜3 の整数 Tilt。順序は論理順序。D119）、Opponent Memory Reset は追記型の区切りの表（マイグレーション v11）で正本と User Read / Note / Tag を消さない（D120）、P7-0〜P7-9（#135〜#144）を直列・Memory は Evidence ID 付きの上限付き要約で KnowledgeState へ注入し LLM の呼び出しを増やさない（D121） |
| D122〜D123 | Phase 7 の派生の人間判断。Hero の Review の Evidence に、判断時点より前の public の Table Tendency を構造化 Evidence として入れる（Learning-only Reveal・CPU の Private Memory / Persona・Tilt は使わず、数値は決定論のコードが正本。D122）、Memory 付き Prompt の Claude CPU の実モデル Eval は API キーを使わず OAuth 経路で最大 36 Decision・CI は録画の再生だけ（D123） |
| D124 | CPU Memory の永続 Cache は、Hand ごとに抽出した Observation（Observer 別・抽出の Version 付き）をマイグレーション v12 の派生の表に持ち、Hand の開始で読むときに足りない Hand だけ補う。Hypothesis の集計は都度計算・表は DELETE 可で正本にしない（#150・#165） |
| D125〜D126 | Review の自然言語中の数値 Grounding は Phase 7 では実装せず Blocker にしない・横断の品質課題として #104 に残す（D125）、River の代表 Spot だけで Claude CPU の実モデル Eval を追加測定（最大 36 Decision・72 呼び出し・OAuth・既存の録画は残し CI は再生だけ・逆向きでも Prompt / Policy は変えない。D126） |

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
