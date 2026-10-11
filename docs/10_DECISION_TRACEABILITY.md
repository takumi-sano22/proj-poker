# 人間判断のトレーサビリティ

D01〜D145の採用済み人間判断は、`decision_log.yaml` を正本として保存しています。

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
| D127〜D130 | Phase 8 の実装前判断: 標準6-max STTの暫定値（Starting Stack 1,500・10 HandごとのBlind表・参加費100pt。D127）、AnteのDead MoneyとBBAのBlind優先・time-baseのプレイ時間とUIでの選択（D128）、HeroのBustでTournamentを終えEvent Logだけに残しProjectionは都度計算（D129）、ICM EquityとBubble FactorとAll-inの必要Equity（ShoveはCallされた場合の条件付き）をCPUとReviewへ構造化して渡す（D130） |
| D131 | Review の文の数値は Evidence から決定論で作った数値表の参照（{N3}）で書かせ、%・pt・BB の付いた生の数値を表と照合する（Pass A と Pass A への Follow-up。Retry の上限は増やさない・保存は置き換えた平文で DB スキーマは不変・Pass B は範囲外・Cash の Review Eval を最大 24 呼び出しで再録画。#168） |
| D132 | Tournament の Claude CPU / Review の実モデル Eval の上限（CPU 7 Spot × 2 Persona × repeat 2 = 最大 28 Decision・56 呼び出し／Review 4 判断 × repeat 2 = 8 Review + Follow-up 2 = 最大 20 呼び出し）。OAuth / Agent SDK / buildClaudeEnv の経路だけ・結果を見て Prompt / Policy を調整しない・CI は録画の再生だけ。#202 |
| D133 | Tournament の Claude CPU の Prompt で、Public Tournament Context を戦略上の基準・Persona をそこからの偏り・Skill を Context を反映する精度として読ませる（Short Stack で Preflop Looseness を固定 Range と読まない・Bubble Factor を慎重になる圧力として理解させる。Push/Fold Nash / Solver は足さない）。PERSONA_PRESETS・Cash・RuleBot・KnowledgeState は変えない。#202 と同じ 28 Decision / 56 呼び出しで 1 回だけ比較測定・1 変更 1 測定。#207 |
| D134 | Tournament の Claude CPU の Persona Differentiation は aggregate の品質指標（暫定の合格ライン 0.2 は不変）で、強い Tournament pressure の個別 Spot で Persona が同じ Action に収束しても失敗としない。Spot 別の Persona Differentiation・contextEffect・layerEffect は診断値で Gate にしない。D133 の Prompt と #207 の録画 v2（0.571）を current として維持し、少数標本だけで Prompt を再調整・追加測定しない。実機 Playtest で体感の問題が出たら別 Issue で人間判断。#212 |
| D135〜D142 | Post-Phase8 の横断 UI/UX（#215・#216。Q1〜Q29 の人間判断）: モダン・カジノの世界観と可読性・正確性を守った強めの演出・装飾素材と Card / Chip の構造描画（D135）、Home / Play / Learn と起動時の Home・読み取り専用の Session 状態照会・Learn / Replay の戻り先（D136）、PC / スマホのレイアウトとスマホの Hero 操作パネル（D137）、Chip の Click / Drag の視認性・移動の視覚化・Betting Area の判定領域（D138）、Hero の下書きの保持と無効化（D139）、表示順序を保つ演出・速度4段階・Showdown を省かない・Live / Replay の共有・再接続（D140）、効果音（BGM なし）と音量・ミュートの保存（D141）、RULING → ETIQUETTE の確認 → 再開（D142）。可逆な値と技術検証は OI-012 |
| D143 | UX-06 #221 での採用判断: 可視 seq の飛び番を残余リスクとして受容（表示・意味づけしない）、演出中の下書きを維持して送信前に同期・再検証、現行 REST/SSE の HeroView.log から client で演出時系列を復元する案 A。UX06-1〜3=A（#222 / #219 の前提） |
| D144 | UX-02 #217 での採用判断: Home の照会は GET /api/session/current（state と Session の種類だけ・Session ID / Hand ID / Stack / 札は返さない）、開始と同じ読み取り専用の判定から作る、ended はこのプロセスの終了だけ（再起動後は null）、未知の state は安全側、#230 の承認後に追加で拡張。UX02-1〜3=A（UX-03 #218・#230 の前提） |
| D145 | UX-11 #226 での採用判断: ETIQUETTE の Ack の要否は DEALER_RULING の notes から決定論で導き、確認の位置は HandRuntime のメモリ（Event / DB は不変）、POST /api/hands/:handId/etiquette-ack と REST / SSE の {revision, pendingRulingSeq}（確認済みの seq の再送は今の待ちを変えずに 200・Ack の要らない / 未来の seq は stale_etiquette）、Ack 待ちの操作と次の Hand の開始は etiquette_ack_required、Outage が先で Retry 後も Ack まで止める、再起動での消失は D62 の範囲、Tournament のプレイ時間は Hand の進行中の待ちだけ。UX11-1〜5・T1=A（UX-11 #226 の本実装の前提） |

### Q1〜Q29 と D 番号の対応（#216）

| Q | D | 実装する Issue（#215 の子） |
|---|---|---|
| Q1・Q5・Q10 | D135 | UX-08 #223・UX-09 #224 |
| Q2・Q6・Q23・Q25 | D136 | UX-02 #217・UX-03 #218・UX-04 #219 |
| Q3・Q4・Q7・Q27 | D137 | UX-03 #218・UX-05 #220 |
| Q11・Q13・Q17・Q18 | D138 | UX-05 #220・UX-09 #224 |
| Q12・Q24 | D139 | UX-04 #219 |
| Q8・Q14・Q15・Q19・Q20・Q21・Q26 | D140 | UX-06 #221・UX-07 #222・UX-09 #224 |
| Q9・Q16・Q22 | D141 | UX-08 #223・UX-10 #225 |
| Q28・Q29 | D142（Ack の契約は D145） | UX-11 #226 |

UX-06 の人間承認（#221 / D143）: UX06-1=A（`seq` の飛び番は表示・意味づけせず受容）、UX06-2=A（`authoritative` / `displayed` を分離し、未送信下書きを保持して送信時に同期・再検証）、UX06-3=A（現行 API 維持、client が可視 Event の時系列を再構築）。Gate 0 は PR #228 の成果への人間承認により解除済みだが、Gate 1 は他の依存条件が残り未解除。

既存の判断との関係（どれも変更ではなく具体化。旧 D の status は変えない）: D15（Dealer の進行の速度変更 / Skip）は D140 の表示演出の速度4段階で具体化し、Fast Forward（D93）とは別の契約のまま。D43（実卓寄り2D）・D60（Card / Chip の構造描画・装飾のみ画像生成）は D135 でも維持。D44（Click / Drag）は D138 で維持。D62（Hand の間の Auto Save・Hand 途中の完全復帰は求めない）は D136・D139 でも変えない。D91（Ruling の3種）・D90（裁定の Event）は D142 でも変えず、変わるのは表示と確認の流れだけ。D80（Bust と Session の終了）・D93（Replay の操作）は変えず、D140 の Replay の速度は D93 の Play / Pause に足すもの。旧 `docs/06` §1 の「Casino ゲーム的な演出より読みやすさを優先」と `docs/01` FR-LIVE-005 の速度の3段（Real Table / Normal / Fast）は D ではない docs の記述で、D135・D140 に合わせて書き換えた。

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
