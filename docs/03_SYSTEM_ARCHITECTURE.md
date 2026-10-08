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
├─ server/   Local Application Runtime（Fastify。Claude・SQLiteはここだけが扱う）
└─ web/      Local Browser UI（Vite + React。ブラウザへClaudeの資格情報を渡さない）
e2e/         Critical E2E（Playwright。#85・#119・#144・D98。プロダクトのコードは持たない）
```

- `apps/web`はdev時に`/api`を`apps/server`へproxyし、ブラウザは同一originの`/api`だけを呼びます。proxy先のポートは`apps/server`と同じ環境変数`PORT`（既定3001）です（#85）。
- `apps/server`はlocal専用で`127.0.0.1`にbindします。
- `packages/engine`はruntime依存を持たず、`apps/*`へも依存しません（D68）。
- `apps/server`は`packages/engine`をworkspace依存で使います。typecheck・lint・dev（tsx）・testではEngineをbuildせずに`src`から読みます（Engineの`package.json`の`exports`にある条件`@proj-poker/source`を、serverの`tsconfig.json`の`customConditions`・`vitest.config.mjs`・`tsx --conditions`で指定）。`build`（`tsconfig.build.json`）と`start`はbuild済みの`dist`を使います。
- `e2e`はプロダクトのコードを持ちませんが、Phase 7のE2E（#144）は`apps/server`のProjectionの関数（Memory・Tiltの組み立て）と`SqliteEventStore`を相対パスでimportし、テストプロセスからserverの一時DBを読み取り専用で開いて確かめます（確認用のAPIを本番に足さないため。`docs/09` §8）。Engineと同じ条件`@proj-poker/source`で`src`から読みます（`e2e/tsconfig.json`の`customConditions`と、`pnpm e2e`の`NODE_OPTIONS=--conditions=@proj-poker/source`）。
- `apps/web`も`packages/engine`をworkspace依存（devDependencies）にしますが、importするのは型（`HeroView`・`LegalActionSet`・`PlayerAction`等）と、表示用の決定論の関数（Chipの構成`composeChips`〔#62〕・Pot Odds の`potOdds`〔#79〕）だけです。Engineのロジックをブラウザで動かして合法性や他者の札を判断しません。型は同じ条件`@proj-poker/source`（webの`tsconfig.json`の`customConditions`）で`src`から読みます。

### Phase 1の実装方針（D70〜D75）

- **Betting範囲（D70）**: 全員100BBの均等Stack・単一Potで、Fold / Check / Call / Bet / Raise / All-inとMinimum Raiseを実装します。Split Potの端数はD75でPhase 1に前倒しして実装しました。Side Pot（不均等Stack）はPhase 2の#31で実装し、未対応の明示エラー（`unsupported_state`）は無くなりました（D78）。Short All-inによるActionの再開（Reopen。累積Short All-inを含む）はPhase 2の#32で実装しました（D79）。人数は#33で2〜8人に広げました（Engineの`MAX_PLAYERS`＝8。標準Presetは6-max）。
- **暫定CPU（D71）**: seed付きの決定論ルールBotです。合法Actionから選び、そのPlayerに見える情報だけを受け取ります。将来D41 / D42のFallback / Emergency Botに流用します。
- **永続化（D72）**: `node:sqlite`（Node 24内蔵）を`apps/server`だけが使います。ORMなし・生SQL・自前の小さなマイグレーションで、EventはJSON列にappend-onlyで保存します。保存の単位はCompleted Hand（D62）で、テーブル・マイグレーション・Eventの版（`schema_version`。D76）は`docs/04` §3・§10です。
- **通信（D73）**: HeroのActionはREST（POST）、卓の状態はSSEでPushします。PushするのはHeroに見えるProjectionだけです。
- **Engine の入口（Issue #17）**: `packages/engine` は純粋関数で、`startHand`（Hand開始）→ `getLegalActions`（現在のActorの合法Action）→ `applyAction`（Actionの適用。Streetの進行・Showdown・Potの配分まで自動で進める）を持ちます。各Commandは新しいEventと畳み込み後のStateを返し、Event Logへの追記は呼び出し側が行います。Playerごとの可視Projectionは `projectHeroView`（Hero表示用）/ `projectKnowledgeState`（CPU用のKnowledgeState。#46）です。Event構成は `docs/04` §3。Chipは最小単位の整数です（D74）。Chipの額面（暫定値1・5・25・100・500。D92・OI-004）はTable Configの`chipDenominations`（色の名前つき。表示用でEventには持たせない）に置き、額からChipの構成（額面ごとの枚数）を大きい額面から貪欲に組む`composeChips`（`chips.ts`。合計＝額を保つ決定論の関数）を持ちます（Stackの構成表示用。Potの計算には使いません。#62）。Split Potの端数（Odd Chip）は、Rule Profileの設定値 `oddChipRule`（暫定値 `first_left_of_button`: Buttonの左から時計回りで最初の勝者へ1 Chipずつ。OI-008の暫定値）に従って `splitPot` が配ります（D75）。Side Potは `buildPots`（`side-pots.ts`）がFoldしていないPlayerのCommit額ごとに段を切ってMain / Side Potを組み立て、Potごとに勝者を決めて配ります（D78）。Betting Roundの終わりに誰もCallしていない超過分（Uncalled Bet）を返してからPotを組み立てます。Short All-inの後のRaiseの再開（Reopen）は、Rule Profileの設定値 `reopenRule`（暫定値 `cumulative_full_raise`: TDA準拠。行動済みのPlayerには、そのPlayerが最後に行動した時点の最高額からの上乗せの合計が直近のFull Raise幅以上になったときだけ再開する。Full Raise未満のAll-inは1回では再開しないが、複数の合計で達すれば再開する。OI-008の暫定値）に従って `getLegalActions` が判定します（D79）。Minimum RaiseはShort All-inでは変わらず、直近のFull Raise幅のままです。Hand と Hand の間の席とButtonは `nextHandSeating`（`position.ts`。Position Engine）が決めます（#34）。入力は前Handの席順（`HAND_STARTED` の `seats` の順）・`HAND_FINISHED` の `stacks`・前Handの `buttonPlayerId` で、Stack 0のPlayer（Bust）を外して席順を保った次Handの `seats` と `buttonPlayerId` を返し、残りが1人以下なら次Handが無いこと（`no_next_hand`）を返します。Buttonの進め方はRule Profileの設定値 `buttonRule`（`TableConfig`。暫定値 `simple_moving`: 前Buttonから時計回りで次Handに座っている最初のPlayerへ進める。前Button本人がBustしても同じ規則で、Dead Buttonは使わない。D80・OI-008の暫定値）です。`buttonRule` はHandの中では使わず、その結果が次Handの `HAND_STARTED` の席順・`buttonPlayerId` に残るので、Eventには項目を足しません。SB・BBは `startHand` がButtonから決めます（Heads-UpはButton = SB。docs/02 §7）。Heroの物理的な操作（Chipを出す・足す・宣言・手番でない操作）は、Ruling Engine（`ruling.ts`）の `rulePhysicalActions` / `resolveOutOfTurn` が、Rule Profileの設定値 `ruling`（`TableConfig`。Oversized Chip・String Bet・Multiple Chip・宣言・Out-of-Turnの規則。D91・OI-008の暫定値）でCanonical Actionに裁定します（結果は必ずLegal Actionのどれか。規則の一覧はdocs/02 §3、型と結果は§4。#63）。裁定そのものはStateもEventも作らず、`ruling` はEventに持たせません（版は `ruleProfile` のID〔`phase4_provisional_v1`〕で分かる）。操作と裁定のEvent化は `applyPhysicalActions`（裁定して `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING` と決まったActionの `ACTION_TAKEN` を返す）と `resolvePendingOutOfTurn`（保留したOut-of-Turnを、そのPlayerの手番で拘束か撤回か裁定する）です（#64・D90。Eventの形は`docs/04` §3）。保留中のOut-of-TurnはEventの畳み込み（`HandState.pendingOutOfTurn`）で持ち、保留中は2回目の操作も、そのPlayerのCanonical Action（`applyAction`）も `not_actor` で受け付けません。Server（Session）での使い方は下記のHand Orchestrator（#35）です。
- **Hand Orchestrator・暫定CPU・API（Issue #18）**: `apps/server`の構成は次のとおりです（§4の流れを実装したもの）。
  - `hand-orchestrator.ts`（Hand Orchestrator）: Stateは毎回Event Store（Event Log）から`foldHandEvents`で作り、別のStateを持ちません（D37）。`startHand` → Hero の手番か Hand の終了まで CPU を進める → Hero の Action を`applyAction`で検証して適用 → また CPU を進める、を繰り返します。CPUの手番はserver側で非同期に進め（#47）、Heroの入力待ちで止まります。CPUの思考待ち（演出）はConfig値`BOT_THINK_DELAY_MS`（既定600ms・テストは0）です。0のときは`startHand` / `heroAction`がCPUの手番が尽きるまで待ってから返し、0より大きいときは待たずに返してCPUの行動を1手ずつSSEで届けます。同じHandでCPUを進める処理は同時に1本だけで、待ちの間（思考待ち・判断待ち）に Log が進んでいたら、その手番の判断を捨てます。CPUの1回の判断を待つ上限はConfig値`OPPONENT_TIMEOUT_MS`（既定30000ms。OI-001のLatency Policyが決まるまでの暫定値。#47で15000ms、#50の実測で見直し）です。アプリの終了時は待ちを打ち切り、遅れて届いた判断を適用しません。Fast Forward（#67・D12・D93）: HeroがFoldした後（またはHandから外れている間）のHandの途中に限り、`setFastForward(handId, true)`でそのHandの残りのCPUの思考待ち（`BOT_THINK_DELAY_MS`）を0にします（待っている最中の分も終える）。CPUの判断の待ち（`OPPONENT_TIMEOUT_MS`の範囲。Claudeの応答）は縮めません。Handが終わる（`HAND_FINISHED`の追記）と切れ、次のHandは通常の速さです。メモリにだけ持つ演出の状態で、Eventは増やしません。
    - **Heroの物理的な操作（Issue #64・D90・D91）**: `heroPhysicalAction` が、Heroの1回の手番の操作（宣言・Chipを出す・足す）をEngineの `applyPhysicalActions` で裁定し、操作・裁定・決まったActionを1回で追記します（Rule Profileの規則は `TableSetup.table.ruling`）。手番でない操作（Out-of-Turn）は保留だけを追記し、CPUの手番を続けます。CPUの判断を待っている間にHeroが操作するとLogが進むので、その判断は捨て、保留を公開の事実として含む `KnowledgeState` でもう一度求めます。Heroの手番が来たら、CPUの手番を進める処理（`runCpuTurns`）が `resolvePendingOutOfTurn` で拘束か撤回かを裁定して追記し、拘束ならそのまま次の手番へ、撤回ならHeroの選び直しを待ちます。Canonical Actionの `heroAction` は、Rulingを通さない互換の入口として残します（Event は `ACTION_TAKEN` だけ。webの操作をPhysicalActionへ移すのは#65で、移した後にこの入口を残すかは#65で決めます）。
    - **Session（Issue #35・D80）**: OrchestratorはSessionを持ち、Hand間でStackを持ち越します。持つのは「今のSessionのIDと最後のHandのID」だけで、次Handの席・Button・Stackは最後のHandの`HAND_STARTED`（席順・`buttonPlayerId`）と`HAND_FINISHED`（`stacks`）から`nextHandSeating`で毎回決めます（D37）。Sessionの最初のHandは均等Stack（`startingStack`）で、Buttonは席順の先頭（Hero）です。Stack 0のCPUは次Handに座りません（退席）。HeroがBustするか、残りがHeroだけになったら（`no_next_hand`）Sessionを終えます。Session終了後に新しいHandを求められたら、新しいSessionとして均等Stackで始めます。Handの開始は冪等です。開始の要求は、clientが結果まで見た最後のHand（`afterHandId`。まだ無ければnull）を持ちます（Actionの`lastSeq`と同じ考え方）。今のSessionの最後のHandが進行中か、終わっていてもclientがまだ見ていない（`afterHandId`が違う）ときは、新しく作らずそのHandを返します（`POST /api/hands`は200）。開始の応答だけが失われて再送されても、結果を見ないままButton・Stackを進めたり、Sessionを捨てたりしません。最後のHandが内部エラーで進行を止めていた場合は、持ち越すStackが決まらないので新しいSessionとして均等Stackで始めます。SessionのIDはEvent Storeへの追記で渡し、SQLiteの`hands.session_id`に残ります（`docs/04` §10）。**Sessionの開始・終了とResume（#77・D95）**: 新しいSessionの最初のHandには開始のEventに続けて`SESSION_STARTED`を、Sessionが終わるHandにはHandの終わりと同じ追記で`SESSION_ENDED`（`reason`）を置きます（`recordSessionEvent`。`docs/04` §3）。`SessionStatus`はHandのEvent（`SESSION_ENDED`、無ければ`HAND_STARTED`・`HAND_FINISHED`）から作ります。Event Storeは、Handが終わるたびにそのSessionのSession Projection（`session-projection.ts`。状態・各席のStack・Personaの割り当て・Emergency BotのCPU）を同じトランザクションで書きます。Orchestratorは起動時に、最後にHandが終わったSessionのProjectionが`ready_for_next_hand`で、最後のHandの席のPlayerが今の卓の設定にそろっていればそのSessionを戻し（Resume。Emergency BotのCPUとPersonaの割り当てもProjectionから）、次の開始で同じSessionとしてStack・Buttonを持ち越します（CPUの席の参加者〔Fixed CPU / Guest。下の`opponents/cpu-pool.ts`〕もEvent Storeから戻す）。Hand途中で止まったHandは戻しません（D62）。Sessionが終わっていた・卓の設定を変えて起動した場合は新しいSessionで始めます。
    - Handごとに、そのHandから見たSessionの状態（`SessionStatus`）を返します: `in_hand`（Handの途中）/ `ready_for_next_hand`（Handが終わり次Handを始められる）/ `ended`（`reason`: `hero_busted`＝HeroがBust・`hero_last_standing`＝CPUが全員BustしHeroが勝ち残った・`ai_outage`＝CPUの障害でHeroがSession終了を選んだ〔§6。#52〕）。Heroに返すのはHero自身の結果と次Handの有無だけです。
  - `opponents/`（Opponent Agent Adapter）: `OpponentAgent.decide({ knowledge, legal, correction? }, signal?)`（Promiseを返す。#47。`signal`は判断を待たなくなったときにabortされる。#50）のInterfaceで、Domainの外に置いた差し替え口です。入力はそのCPUの`KnowledgeState`（`projectKnowledgeState`の結果に、Phase 7〔#139・D121〕からはそのCPU自身のMemoryの要約`memory`を足した`CpuKnowledgeState`。§5）とLegal Actionだけで、再要求のときだけ前回の出力が不正だった理由（`correction`）が付きます。既定のCPUは暫定CPU（D71）の`RuleBot`で、`OPPONENT_PROVIDER=claude`のときだけClaudeの`ClaudeOpponent`（§3。#50）を使います。`RuleBot`は、自分の札と公開Boardから手の強さを3段階で見積もり、seed付きの乱数で合法Actionから選びます（CPUのseedはHandのseedから席ごとに導きます）。CPUの出力の検証・Retry・Fallback・障害の扱いは§5です。
  - `opponents/persona.ts`（#51）: Persona（`docs/05` §2の11軸。値は0〜1で0.5が平均。一つの`difficulty`に縮約しません）と6つのPreset（TAG Regular・LAG・Calling Station・Nit・Maniac・Weak-tight Recreational。種類も数値もD85・OI-005の暫定値）を置きます。PersonaはOrchestratorが`OpponentFactory(seed, playerId, persona)`で各CPUのAgentへ渡し、そのCPUの判断の中だけで使います: `ClaudeOpponent`はPromptの「あなたの性格」の節（`describePersona`。Tiltの2軸は入れない）、`RuleBot`は参加Range（Preflop Looseness）とAggression / Bluffのしきい値（`tuningFromPersona`。全軸0.5でPersonaなしと同じ値）。PersonaなしのRuleBotの挙動はD71のときのままで、Fallback（§5）の`RuleBot`にも同じPersonaを渡します。`KnowledgeState`にMemoryの要約があれば、`RuleBot`はPersonaのSkill・Adaptability・Opponent Reading Qualityの平均に比例する幅で、mediumの手のCall（直前に額を上げた相手の`aggression_frequency`）とPostflopのweakの手のBluff（降りていない相手全員の`fold_to_cbet_flop`の最小）のしきい値だけをずらします（`memoryAdjustedTuning`・`phase7_rulebot_memory_v1`。十分なSampleの項目だけを読み、乱数の引き方は変えない。係数はOI-011の暫定値。#139）。PersonaなしのRuleBotはMemoryを読みません。`KnowledgeState`にそのCPU自身のTilt（`tilt`。#140・D107）があれば、`RuleBot`は1段あたりPreflop LoosenessとAggressionを+0.05（3段で+0.15が上限）ずらしたPersonaでしきい値を作ります（`tiltedPersona`。乱数の引き方は変えない。PersonaなしのRuleBotはTiltを読まない）。Tiltの段階は`opponents/tilt.ts`（Policyは`opponents/tilt-policy.ts`の`phase7_tilt_v1`。OI-011の暫定値）が、今のSessionの保存済みのHandを論理順序で畳み込んで都度作ります（保存しない。Session が変われば0から。上がり幅・下がり方はPersonaのTilt Susceptibility・Recovery Speed。Triggerの定義は`docs/05` §4）。`KnowledgeState`にそのCPUから見たTable Tendency（`tableTendency`。#141・D106）があれば、`RuleBot`はPersonaのAdaptabilityに比例する幅（最大0.1）で、同じ2つのしきい値だけをずらします（卓の`aggression_frequency`が基準0.35より高いほどmediumの手のCallを広げ、卓の`vpip`が基準0.3より高いほどweakの手のBluffを減らす。`tableTendencyAdjustedTuning`・`phase7_rulebot_table_tendency_v1`。十分なSampleの項目だけを読み、Memoryより先に当てる。乱数の引き方は変えない。係数はOI-011の暫定値。PersonaなしのRuleBotは読まない）。この4つの層（Persona・Tilt・Table Tendency・Memory）は`composeTuning`の1か所で、Persona → Tilt → Table Tendency → Memoryの順に決定論で合成し、確率のしきい値ごとに、Personaだけのしきい値からのずれを±0.2までに丸めます（`phase7_rulebot_composition_v1`。OI-011の暫定値で、今のPresetと各層の上限では届かない。#142）。Personaは`OpponentInput`（`KnowledgeState`）・Event・Heroへの応答（`players`・View・SSE）には入れません（他CPUのSecret Persona。D28）。DBにはSession ProjectionのPersonaの割り当て（CPU → Preset ID）だけを置きます（再起動後のResumeで同じ割り当てに戻すため。#77・D95。server内だけで読み、Hero・CPUへは出さない）。
  - `opponents/cpu-pool.ts`（#136・D106・D118）: CPUの永続Identity。Fixed Pool（`cpuProfileId`・名前・Persona Preset）はDBに置かず、Version付きのConfig（`PHASE7_CPU_POOL`・`phase7_pool_v1`。OI-005の暫定値: Fixed 8人＋Guestは1卓に最大1席）に置きます。Orchestratorは新しいSessionの最初のHandで、そのHandのseedから導いたseedで`composeSessionParticipants`を呼び、CPUの席ごとにFixed CPU（Sessionを跨いで同じ`cpuProfileId`）かGuest（そのSession限りのid）を決めます。Fixed CPUは常にPoolのPersonaで打ちます（同じ`cpuProfileId`は同じPersona）。席のPersona（既定の割り当て順・`CPU_PERSONAS`）と同じPersonaのFixed CPUから選ぶので既定の割り当てでは席のPersonaは変わらず、`CPU_PERSONAS`の上書きはFixed Poolで満たせる範囲で効きます（満たせない席はPoolのPersonaで座り、warnに残す）。参加者はEvent Storeへの最初の追記で渡し、Sessionの最初のHandの保存と同じトランザクションで`session_participants`（v10）に残ります（`docs/04` §12）。Resumeでは同じSessionの参加者を戻し（`HandOrchestrator.sessionParticipants`）、Heroへの応答・Event Logには入れません。
  - `event-store.ts`（Event Store）: §2 Persistence の Event Store の Interface（`append` / `read` / `listHands` / `latestSessionProjection` / `sessionHandIds` / `finishedHandIds` / `savedOrder` / `sessionParticipants`）と、メモリ内の実装です。Handの順は壁時計ではなく保存の論理順序（`logical-order.ts`・マイグレーションv9の`ordinals`。#132・D117・`docs/04` §10）で決めます。`savedOrder(handId)`は終わったHandの保存の番号（Learning Resetの前後の判定に使う）です。`listHands(limit, exclude?)`と`latestSessionProjection(exclude?)`は、除くHand（DrillのHand。#117・D116）とその最後のHandのSessionを数えません。`sessionHandIds(handId)`はそのHandと同じSessionの終わったHandを、`finishedHandIds()`は終わったHandすべてを保存の古い順に返します（Session Review・Player Profile。#116。SQLite実装は`hands`の行から読み、進行中のHandはメモリの最初の追記で決まったSessionで引く）。`listHands(limit)`はEventのあるHandを新しい順（メモリの終わっていないHandをこのプロセスで始めた順の逆で先に、続けて保存済みのHandを保存の新しい順）に返し（`handId`・`startedAt`・`finishedAt`・`aborted`。`HAND_FINISHED`の無いHandは`finishedAt`が`null`、`HAND_ABORTED`で打ち切ったHandは`aborted`が`true`）、SQLite実装は保存済みの`hands`の行とメモリの途中のHandを合わせます（Replayの一覧。#68）。append-onlyで、seqが連続しない追記（二重追記・抜け）と、Handの終わり（`HAND_FINISHED` / `HAND_ABORTED`）の後ろへの追記（同じ追記の`SESSION_ENDED` 1つを除く）は何も書かずに拒否します。Handが終わったら、そのSessionのSession Projection（`session-projection.ts`の`nextSessionProjection`。#77・D95）を作り替え、`latestSessionProjection()`で最後にHandが終わった（最後のHandの保存の番号が最大の）Sessionの値を返します（Resumeの入口）。保存時にEventを複製して配下まで凍結し、呼び出し側の参照から書き換えられないようにします。起動時（`index.ts`）は同じInterfaceのSQLite実装（下記）を渡し、メモリ内の実装はテスト用です。
  - `sqlite-event-store.ts`・`db/database.ts`（Event StoreのSQLite実装。Issue #20・D72）: `db/database.ts`がDBファイルを開いてマイグレーションを当て、`SqliteEventStore`がHandの終わり（`HAND_FINISHED` / `HAND_ABORTED`）の時点でHandの全EventとSession Projection（`session_projections`。#77・D95）と保存の論理順序の行（`ordinals`。#132・D117）を1トランザクションで書きます。Sessionの最初のHandなら、同じトランザクションでCPUの席の参加者（`session_participants`。#136・D118）も足します。Hand途中のEventはメモリに持ちます（D62）。DBの場所は環境変数`POKER_DB_PATH`（既定`apps/server/data/poker.sqlite`。gitignore済み）。詳細は`docs/04` §10。
  - `replay.ts`・`routes/replay.ts`（§2 の Replay Service。#68・D38・D93）: 保存済みのEventだけをHeroの視点で再生する材料を作ります。Engine・CPU・AIを動かし直さず（Re-simulationではない）、Event Logの先頭からのprefixを`projectHeroView`に渡すだけです。stepはHeroに見えるEvent 1件ごとで、Actionに決まった裁定（`DEALER_RULING`・`outcome: action`）だけは同じ追記の直後の`ACTION_TAKEN`と1 stepにまとめます（裁定だけのstepでは結果のActionがまだ見えないため）。Replayでは操作しないので、stepの`legalActions`は常に`null`です。Handの一覧は`listHands`（最大`REPLAY_LIST_LIMIT`＝100件。暫定値）の各HandのHeroに見えるEventから、Heroの札と収支（`HAND_FINISHED`の Stack −`HAND_STARTED`の Stack。未完了の Hand は`null`）を作ります。`HAND_FINISHED`の無いHand（進行中・内部エラーで止まったHand）も同じ形で返します（メモリにだけあるので再起動で消える）。AI障害の後に打ち切ったHand（`HAND_ABORTED`。#77・D95）は保存され、一覧と再生の応答で`aborted: true`になります（Heroが自分で選んだ打ち切りなので返す。打ち切りのEvent自体はsystem Visibilityでstepに入らない）。再生の応答には、Jump to Important Spot（#84）の飛び先として`importantSpots`（#78。EngineのImportant Spotを、判断時点＝末尾のEventの`seq`が`decisionPointSeq`のstepの位置`stepIndex`へ写したもの。判断時点はActionに決まった裁定にならないので必ずstepがある）と、Reviewの画面で判断を選ぶための`decisions`（`heroDecisions`のすべての判断を同じ写し方でstepへ写したもの。Hero自身のActionだけ。#84）も入れます。Learning-only Full RevealはReviewのPass B（#83）で扱い、Replayには入れません。
  - `memory/`（Phase 7のCPUのMemory。#137〜）: `memory/observation.ts`（#137・D106・D118）が、CPUのObservation（Raw Evidence）を正本のEvent Logから都度決定論で抽出します（保存しない）。Observerが卓で見聞きした`public`のEvent（Showdownで表にされた札を含む）だけを、Observer・Subject（Hero・Fixed CPU・Guestの参加者の参照）・`hand_id`・`seq`・`ord`・Visibility・context付きで返し、Observer自身や他者のHole Cards・Deck・`system`のEvent・Learning-only Reveal・Heroの弱点（`learning/`）は入れません（`memory/observation-isolation.test.ts`）。参加者は`session_participants`（`opponents/cpu-pool.ts`）から引き、Guestは次のSessionでは読みません。形と規則は`docs/04` §12です。`memory/opponent-hypothesis.ts`（#138・D119）が、1人のObserverの観察からSubject × Context（cash / tournament）ごとのPrivate Hypothesis（観察可能な傾向の頻度。重み付きのnumerator / denominator・Evidence ID・十分か・Policyの Version）を、`memory/memory-policy.ts`の`phase7_memory_v1`（OI-011の暫定値）でrecency decay付きに都度作ります（保存しない）。Heroの弱点の`learning/`とは型・モジュールを共有しません。`memory/memory-summary.ts`（#139・D121）が、それをCPUの`KnowledgeState`に足す上限付きの構造化した要約（`OpponentMemorySummary`。今の卓の他の参加者ごとに上位5項目・Evidence ID付き）に決定論で畳み、Hand OrchestratorがHandの開始時（そのHandをEvent Storeへ書く前）にCPUごとに作ります（`buildOpponentMemoriesFromStore`。保存しない）。`opponents/`・`hand-orchestrator.ts`・`memory/memory-summary.ts`から`learning/`に届かず、Learning-only Revealを参照しないことは`memory/memory-injection-isolation.test.ts`で確かめます。形と規則は`docs/04` §12です。`memory/memory-reset.ts`（#143・D120）がOpponent Memory Resetの区切り（v11の`opponent_memory_resets`）を足し・読み、Hand OrchestratorはCPUごとに、そのCPUに効く最後の区切りより後に保存されたHandだけからMemoryを作ります（`learning/`は import しない）。意味は`docs/04` §11です。`memory/observation-cache.ts`（#165・D124）は、Handごとに抽出した観察をv12の派生の表`observed_hand_cache`にCacheし、Handの開始でMemoryを作るときにCacheに無いHandだけをEvent Logから抽出して足します（Handの保存のトランザクションでは書かない。Reset・Guest・論理順序の判定はEvent Log側のまま。Cacheの有無・失敗でMemoryは変わらない）。起動時（`index.ts`）にSQLiteの実装を渡し、メモリ内のEvent Store（テスト用）では使いません。形と規則は`docs/04` §12です。
  - `notes/`・`routes/notes.ts`（Heroの Note / Tag。#115・D112）: CPUごとのHeroの自由記述Note・Tag（D31）を、Event Logではなくマイグレーションv5の追記型のテーブル（`user_notes` / `user_tags`。`docs/04` §12）に置きます。対象（Subject）はHandと席から`HandOrchestrator.subjectOf`が決める「そのSessionの中の参加者」（`notes/subject.ts`の`session_player`）で、席のplayerIdを永続のIdentityとみなしません（D105）。Note / TagはOrchestrator（CPUの`KnowledgeState`・Prompt）とReviewへは渡しません（不変条件2）。
  - `learning/`（Phase 6のSession Learning。#113・#114）: Pass Aの`reviews`（判断ごとの最新のVersion）とEvent LogからAbility Evidenceを作り、Score（`score.ts`）・Weakness Hypothesis（`hypothesis.ts`）・Player Profile（`profile.ts`）を、Version付きの暫定Policy（`scoring-policy.ts`・`hypothesis-policy.ts`。OI-006）で決定論で計算します。LLMを呼びません。Score・Profileは都度計算し保存せず（D111）、Hypothesisだけをreviewsから作り直せるSnapshot（マイグレーションv6の`hypothesis_snapshots`。`hypothesis-snapshot.ts`。D113）に保存します。Pass B（`reveal_reviews`）は入力にしません。ユーザーの弱点なので、CPUの`KnowledgeState`・Prompt・CPU Memoryへは渡しません（不変条件2。`opponents/`と`hand-orchestrator.ts`からのimportで`learning/`に届かないことを`learning/learning-isolation.test.ts`で確かめる）。表示用の読み出し（#116）は`learning-service.ts`の`LearningService`と`routes/learning.ts`です。Session Review（`session-review.ts`の`computeSessionReview`）はEvent Storeの`sessionHandIds`でそのSessionの終わったHandを読み、Player Profileは`finishedHandIds`で全期間の終わったHandを読んで、どちらも都度計算します。Reviewを作らず（D115）、Pass Bの Store は渡しません。Profileを読むたびに、同じEvidenceから作ったHypothesisでSnapshotを入れ替えます（`HypothesisSnapshotStore`。起動時はSQLite、テストはメモリ内。正本のEvent Log・`reviews`は書き換えない）。Stats（`projectPlayerStats`）はHeroの行だけを返します（D32）。DrillのHand（D116）は、`drills`テーブル（#117）にあるHandのidを`excludeHandIds`に渡して除きます（`LearningService`の`excludeHandIds`）。Learning Reset（#118・D114）は`learning-reset.ts`（マイグレーションv8の追記型の`learning_resets`。`LearningResetStore`）に区切りの行を足すだけで、正本（Event Log・`reviews`・Note / Tag）を消しません。`LearningService`はScore・Hypothesis・自然言語のProfileを、それぞれのカテゴリの最後のResetより後に終わったHandだけで作り（`endedAfter`。区切りの判定は`docs/04` §11）、StatsとSession Reviewは区切りません。
  - `drill/`・`routes/drills.ts`（Targeted Drill。#117・D105・D110・D116・`docs/07` §7）: 過去のHandのHeroの判断1つ（Pass AのReviewがあるもの）から、一要素だけ変えた類題を決定論で作ります。LLMは使いません（D110）。Spotは Engine の`buildDrillSpot` / `startDrillHand`（`packages/engine/src/drill.ts`）が、判断時点のHero Information Set（`heroInformationSets`）だけから作り、Engineで判断の直前まで進めて検証します（合法なAction・Chipの保存・Heroの手番に戻ること。通らないSpotは出さない）。変形の選び方は`drill-plan.ts`（Version付きの暫定Policy `phase6_drill_v1`。OI-006）、記録は`drill-store.ts`（マイグレーションv7の追記型の`drills`。`docs/04` §12）、開始と結果の集計は`drill-service.ts`です。DrillのHandは`HandOrchestrator.startDrill`が専用のSession（そのHandだけ）の通常のHandとして始め（`SESSION_STARTED`を置く。Eventの形は変えない）、判断の直前までは元のHandの公開のActionをScriptとして再現し、その後の相手は`RuleBot`（Drillの設定のPersona、無ければ既定）が決めます（CPUのLLMを呼ばない）。今のSession（Resume・次のHand）は変えません。Heroの操作・SSE・Reviewは通常のHandと同じAPIをDrillの`handId`で使います。`drills`の行はDrillのHandを始める前に足し、`drillHandIds`を通常の集計（Stats・Score・Profile・Hypothesis・Session Review）・Replayの一覧（`ReplayService`）・Resume（`HandOrchestrator`の`excludeFromResume`→`latestSessionProjection(exclude)`）から除きます。Drillの結果は、DrillのHandの練習した判断（Scriptが再現した元の判断を除く。`AbilityEvidenceOptions.firstDecisionIndex`）だけで`computeScoreReport`を呼ぶ別の系列です（D105）。その系列も、Learning Resetのカテゴリ`score`の区切りより後に終わったDrillのHandだけで数えます（`DrillServiceOptions.scoreSince`。D114の暫定）。`drill-plan.ts`は`learning/`をimportしません（`learning/learning-isolation.test.ts`のCPUの入口に入れて確かめる）。
  - `routes/hands.ts`（API。D73）: 下表。Heroの入力はCanonical Action（`/actions`）と物理的な操作（`/physical-actions`。#64）の2つの入口を持ちます。HeroのUser Read（判断の前の読み・意図。#115・D112）は`/reads`で、Heroの手番の間だけ`heroUserRead`が`USER_READ_RECORDED`（Heroだけのprivate）として追記します（`docs/04` §3）。入力の形はJSON Schemaで検証し（型の自動変換・余分な項目の黙った削除はしない）、合法性はEngineが判定します。返す・PushするのはHeroに見えるProjection（`projectHeroView`）だけで、Hand のseedはclientから受け取らず、返しません。
  - 卓の人数・CPUの名前は`config.ts`の`buildTableSetup(人数)`（Hero 1人 + CPU（人数 − 1）人。人数はEngineの`MIN_PLAYERS`〜`MAX_PLAYERS`＝2〜8。CPUの人数・名前はOI-005の暫定値）で作ります。起動時は環境変数`TABLE_SIZE`（2〜8の整数。未設定・不正値は既定の6人に戻す）で選び、既定の`PHASE1_TABLE_SETUP`は6-maxです。人数を選ぶ画面は作りません。CPUのPersonaは`buildTableSetup`が席順で決定論的に割り当て（CPU iに割り当て順の(i − 1)番目。足りなければ先頭から繰り返す）、`TableSetup.personas`（playerId → Preset ID）に持ちます。既定の割り当て順はTAG Regular・LAG・Nit・Calling Station・Weak-tight Recreational・Maniac（OI-005の暫定値）で、環境変数`CPU_PERSONAS`（Preset IDのカンマ区切り。知らないIDは起動時に誤りとして止めます）で上書きします（#51）。Buttonは上記のSessionの規則で決めます（D80）。

| Method・Path | 入力 | 成功時の応答 | 主な失敗 |
|---|---|---|---|
| `POST /api/hands` | `{ afterHandId }`（clientが結果まで見た最後のHand。まだ無ければ`null`） | 201 `{ handId, players: [{ playerId, displayName, kind }], view: HeroView, session: SessionStatus, outage: OutageStatus, fastForward: boolean }`（Heroの手番かHandの終了までCPUを進めた時点。Sessionが続いていればStackを持ち越し、終わっていれば新しいSession）。今のSessionの最後のHandが進行中か、`afterHandId`と違う（clientがまだ見ていない）なら、新しく作らずそのHandを200で返す | — |
| `POST /api/hands/:handId/actions` | `{ lastSeq, action }`。`lastSeq`はclientが見ていた`view.log`の最後の`seq`、`action`は`{ type: fold / check / call / all_in }`か`{ type: bet / raise, amount }`（`amount`はそのStreetの累計＝to額） | 200 `{ view: HeroView, session: SessionStatus, outage: OutageStatus }` | 400 形の不正（schema）／404 Handが無い／409 `stale_view`（`lastSeq`より Log が進んでいる＝二重送信・古い画面）・`not_actor`・`hand_complete`／422 `illegal_action` |
| `POST /api/hands/:handId/physical-actions`（#64） | `{ lastSeq, actions }`。`lastSeq`は`/actions`と同じ、`actions`はHeroの1回の手番の操作をした順に並べた列（1〜20個）: `{ type: declare, declaration: { kind: fold / check / call / all_in } か { kind: bet / raise, amount? } }`（`amount`はそのStreetの累計＝to額で省略可）か `{ type: chip_push / chip_add, chips: [額面, ...] }`（Chipの最初の動作が `chip_push`、2回目以降が `chip_add`） | 200 `{ view: HeroView, session: SessionStatus, outage: OutageStatus }`。裁定は `view.log` の `DEALER_RULING`（`docs/04` §3）。手番なら裁定したActionを適用してCPUを進めた時点、手番でなければ保留（`out_of_turn`）を追記してCPUを進めた時点（Heroの手番が来たら保留を拘束 / 撤回した後） | 400 形の不正（schema）／404 Handが無い／409 `stale_view`・`not_actor`（保留中のOut-of-Turnがあるのにもう一度操作した）・`hand_complete`／422 `invalid_input`（額面に無いChip・Stackを超えるChip・Fold / All-in済み・Chipの動作の順の誤り） |
| `POST /api/hands/:handId/reads`（#115・D112） | `{ lastSeq, targetPlayerId, text }`。`lastSeq`は`/actions`と同じ（応答だけが失われた記録の再送を`stale_view`で弾き、同じ読みを2回残さない。clientは再送でも最初の値を送る）、`targetPlayerId`は読みの対象の席（このHandの`playerId`。相手を特定しない読み・意図は`null`）、`text`は1〜200字 | 200 `{ view: HeroView }`（`USER_READ_RECORDED`〔Heroだけのprivate〕を追記した時点。卓の状態は変わらずCPUも進めない。読みの当たり外れは返さない） | 400 形の不正（schema）／404 Handが無い／409 `stale_view`・`not_actor`（Heroの手番でない）・`hand_complete`／422 `invalid_input`（卓にいない席・Hero自身・空白だけの本文） |
| `POST /api/hands/:handId/fast-forward`（#67） | `{ enabled }`（真偽値）。`true`でFast Forwardを入れる（HeroがFoldした後のHandの途中だけ）、`false`で通常の速さに戻す（いつでも） | 200 `{ fastForward: boolean }` | 400 形の不正（schema）／404 Handが無い／409 `not_spectating`（Heroがまだ Hand にいる・Handが終わっている） |
| `POST /api/hands/:handId/outage`（#52） | `{ revision, choice }`。`revision`はclientが見ていた`OutageStatus`の`revision`、`choice`は`retry` / `emergency_bot` / `end_session`（§6） | 200 `{ view: HeroView, session: SessionStatus, outage: OutageStatus }`（選んだ後、Heroの手番かHandの終了までCPUを進めた時点。`end_session`ならHandは途中のまま`session`が`ended`〔`ai_outage`〕） | 400 形の不正（schema）／404 Handが無い／409 `stale_outage`（障害が無い・`revision`が違う＝二重送信・古いダイアログ） |
| `GET /api/hands/:handId/stream` | なし | SSE（`text/event-stream`）。メッセージは`event: view`（`data`は`HeroView`のJSON）と`event: session`（`data`は`SessionStatus`のJSON）と`event: outage`（`data`は`OutageStatus`のJSON。#52）です。接続時に現在の`outage`とViewを1回ずつ送り、以後はLogが進むたびにViewを、障害が起きる・解けるたびに`outage`を送ります。`status`が`complete`のViewの直前に`session`を1回送り、そのViewを送ったらserverが閉じます（clientは再接続しない）。障害の後に`end_session`が選ばれたら、`outage`の直後に`session`（`ai_outage`）を送ります（Handは途中なので閉じません） | 404 Handが無い |
| `GET /api/hands/:handId/players/:playerId/notes`（#115・D112） | なし | 200 `{ notes: [{ noteId, body, createdAt }], tags: string[] }`（その席＝そのHandのSessionの参加者の今のNote〔書いた順〕とTag〔付けた順〕） | 404 Handが無い（このプロセスで進めたHandだけ）／422 `invalid_input`（Hero・卓にいない席） |
| `POST /api/hands/:handId/players/:playerId/notes`（#115） | `{ noteId, body }`（`noteId`はclientが作るUUID、`body`は1〜500字） | 201 今のNote / Tag（上と同じ形）。同じ`noteId`の2回目は行を足さない（応答だけが失われた追加の再送を冪等にする） | 400 形の不正／404／409 `conflict`（その`noteId`は別の席のNote）／422 `invalid_input`（空白だけ） |
| `DELETE /api/hands/:handId/players/:playerId/notes/:noteId`（#115） | なし | 200 今のNote / Tag（削除はtombstoneの行の追記。`docs/04` §12） | 404 Handが無い・`not_found`（その席のNoteに無い・削除済み）／422 |
| `POST /api/hands/:handId/players/:playerId/tags`（#115） | `{ tag }`（1〜20字・改行なし） | 200 今のNote / Tag（付いていれば何もしない） | 400 形の不正／404／422 `invalid_input` |
| `DELETE /api/hands/:handId/players/:playerId/tags/:tag`（#115） | なし | 200 今のNote / Tag（`remove`の行の追記） | 404 Handが無い・`not_found`（付いていない）／422 |
| `GET /api/replay/hands`（#68） | なし | 200 `{ hands: [{ handId, startedAt, finishedAt, complete, bigBlind, heroHoleCards, heroNet }] }`（新しい順＝進行中のHand、続けて保存の新しい順〔論理順序。D117〕・最大100件。`HAND_FINISHED`の無いHandは`finishedAt`・`heroNet`が`null`で`complete: false`。DrillのHandは入れない。#117・D116） | — |
| `GET /api/learning/session-review/:handId`（#116） | なし | 200 そのHandが属するSessionのSession Review（`{ policyVersion, scoringPolicyVersion, hands, startedAt, endedAt, durationMs, bigBlind, heroNet, decisionQuality: { total, reviewed, scored, insufficientEvidence, assessments, overall }, abilities, strengths, leaks, importantHands, heroStats, recommendedDrill }`。Sessionの終わったHandから都度計算。Reviewを作らない。`docs/07` §6） | 400 形の不正（schema）／404 Eventが無い（`hand_not_found`） |
| `GET /api/learning/profile`（#116・#118） | なし | 200 `{ profile: StructuredProfile（hypothesesはSnapshotの行で computedAt つき）, text, resets: { score, hypothesis, profile }, heroStats }`（終わったHandから都度計算。Hypothesis の Snapshot を作り直す。`profile`のScoreと「M件中N件」・`hypotheses`・`text`は、それぞれ`resets`のカテゴリの最後のLearning Resetより後に保存された〔終わった〕Handだけ。前後は論理順序で決め、`resets`は表示用の時刻〔無ければ null〕。D117。`heroStats`は全期間。`docs/07` §4・`docs/04` §11） | — |
| `POST /api/learning/resets`（#118） | `{ categories: ("score" \| "hypothesis" \| "profile")[] }`（1つ以上・重複なし） | 201 `{ reset: { resetId, createdAt, categories }, resets }`（Learning Reset。`learning_resets`に区切りの行を足すだけで、Event Log・Review・Note / Tag・Statsは変えない。取り消しはない。D114・`docs/04` §11） | 400 形の不正（schema。空・重複・未知のカテゴリ・余分な項目） |
| `POST /api/opponents/memory-resets`（#143） | `{ scope: "all" }`（全CPU）か`{ scope: "cpu_profile", cpuProfileId }`（1つのFixed CPU。`cpuProfileId`は`cpu_profile`のときだけ） | 201 `{ reset: { resetId, createdAt, scope, cpuProfileId } }`（Opponent Memory Reset。`opponent_memory_resets`〔v11〕に区切りの行を足すだけで、Event Log・Review・User Read / Note / Tag・Learning Resetの区切り・Statsは変えない。`cpuProfileId`は`all`なら`null`。返すのは区切りの表示用の時刻と対象だけで、Persona・Poolの名前・Hypothesis / Memoryの中身は返さない。取り消しはない。D120・`docs/04` §11） | 400 形の不正（schema。未知の`scope`・`all`に`cpuProfileId`・`cpu_profile`に`cpuProfileId`が無い・余分な項目）／404 Fixed Poolに無いCPU（`cpu_profile_not_found`） |
| `POST /api/drills`（#117） | `{ handId, decisionIndex }`（元のHandと、Pass AのReviewがあるHeroの判断） | 201 `{ drill: { drillId, createdAt, policyVersion, source: { handId, decisionIndex, reviewId }, variant, change, drillHandId, decisionIndex }, handId, players, view: HeroView, session, outage, fastForward }`（`POST /api/hands`と同じ形に`drill`を足したもの。`view`は練習する判断のHeroの手番。同じ元の判断のDrillのHandがこのプロセスでまだ終わっていなければ、新しく作らずそのDrillを200で返す〔開始の再送を冪等にする〕。seed・Deck・元の相手の札・元のCPUのPersonaは返さない。`docs/07` §7） | 400 形の不正（schema）／404 Handが無い（`hand_not_found`）・判断が無い（`decision_not_found`）／409 Handが終わっていない（`hand_not_finished`）・Pass AのReviewが無い（`review_required`）／422 DrillのHandから・Engineの検証を通る変形が無い（`drill_unavailable`） |
| `GET /api/drills`（#117・#118） | なし | 200 `{ policyVersion, drills: [DrillのView + { finished, assessment }], score: { policyVersion, since, decisions, overall, abilities } }`（Drillの系列。通常のScoreと別。D105。`score`はLearning Resetのカテゴリ`score`の最後のResetより後に保存された〔終わった〕DrillのHandだけ。前後は論理順序で決め、`since`はそのResetの表示用の時刻〔無ければ null〕。D117） | — |
| `GET /api/replay/hands/:handId`（#68） | なし | 200 `{ handId, complete, players: [{ playerId, displayName, kind }], steps: HeroView[], importantSpots: [{ stepIndex, decisionIndex, street, reasons }], decisions: [{ stepIndex, decisionIndex, street, action, amount, toAmount, allIn }] }`（`steps`はHeroに見えるEventのprefixごとのHeroの視点。`legalActions`は`null`。今の卓の設定に無いPlayerは`playerId`を名前にする。`importantSpots`は判断の順で、`stepIndex`のstepがその判断の直前の卓。#78。`decisions`はImportant Spotでないものも含むHeroの判断のすべてで、同じ写し方。#84） | 400 形の不正（schema）／404 Eventが無い（`hand_not_found`） |

`OutageStatus`（#52・D86）は`{ revision, current }`で、`current`は障害で止まっていれば`{ playerId, kind }`（どのCPUの手番か・障害の種類: `timeout` / `unauthenticated`〔未ログイン〕/ `usage_limit`〔利用枠の上限〕/ `error`）、止まっていなければ`null`です。`revision`はHandごとに0から始まり、障害が起きる・解けるたびに1つ進みます（RESTとSSEのどちらが先に届いても新しい方を残す・選択で送り返して古いダイアログからの選択を弾く）。内部のエラー本文（資格情報やパスを含みうる）・Persona・CPUの出力は含めません。

失敗の応答は`{ error: { kind, message } }`です。

- **Basic UI（Issue #19）**: `apps/web`の構成は次のとおりです。表示はすべてserverから届いた`HeroView`に基づき、clientは状態を進めず、合法性も判定しません（D40・D73）。
  - `hooks/useHandSession.ts`: `POST /api/hands`でHandを始め、`EventSource`で`/stream`を購読し、Heroの物理的な操作（宣言・Chipを出す・足す。#65）を`POST .../physical-actions`で送ります（Canonical Actionの`/actions`は画面からは使わない）。RESTの応答とSSEのPushのどちらが先に届いても、同じHandで`log`の最後の`seq`が進んでいる方だけを残します（別Handの遅れた応答は捨てる）。送信中はrefとstateの2層で二重送信を止めます。`complete`のViewを受けたら`EventSource`を閉じます。SSEの`data`は最小の形検査（`parseHeroView`）を通ったものだけを描画へ流します。開始の要求には結果まで見た最後のHandを`afterHandId`として送り、再送でも同じ値を送ります。Sessionの状態はRESTの応答の`session`とSSEの`session`イベント（`parseSessionStatus`で知っている項目だけに組み直す）から受け、同じHandでHand終了後の状態を受けたら遅れて届いた`in_hand`で戻しません。CPUの障害の状態（#52）もRESTの応答の`outage`とSSEの`outage`イベント（`parseOutageStatus`）から受け、同じHandで`revision`が進んでいる方だけを残します。障害で止まっている間は卓の中央にダイアログ（`components/OutageDialog.tsx`。止まったCPUの表示名・障害の種類の説明・Retry / Emergency Botで続行 / Session終了）を出し、選択を`POST .../outage`で送ります（送信中は二重送信を止め、届かなかったら同じ`revision`で再送する）。BB補助表示の設定（#67。`components/BbDisplay.tsx`のContext。保存は`lib/display-settings.ts`の`localStorage`でviewerごと。保存が使えなくても既定の表示で動く）をヘッダーのボタンで切り替え、金額の表示（`Amount`・宣言Button・用語の例）へ渡します（実額は常に出す。D49）。Hero が Fold した後は`components/FastForward.tsx`でFast Forwardを`POST .../fast-forward`で入れる・切ります（送信は操作の送信と別に二重送信を止め、Handが終わった時点で画面でも通常の表示に戻す）。CPUの手番を待っている間は「<CPU 名> の手番…」と出し（Fast Forward中も同じ。AIの応答時間は縮まないため）、同じ手番が`AI_DELAY_NOTICE_MS`（`lib/config.ts`。暫定値10秒。OI-001）を超えて続いたら「AI応答が遅延しています」を補足します（docs/06 §11。使っているAPIの名前は出さない）。Handの結果の欄には、Sessionが続くときだけ「次の Hand へ」を出し、Sessionが終わったら理由（HeroのBust／Heroの勝ち残り）と「この Session を振り返る」（Session Review。#116）・「新しい Session を始める」をHeroの欄に出します（卓の中央の結果の欄は獲得額の一覧だけ。#158）。StackはSessionを通して持ち越した実額で出します（D49）。
  - Replay（#68・D93）: ヘッダーの「Replay を見る」で`components/ReplayScreen.tsx`を開きます（「卓に戻る」で卓へ。Replayを見ている間も`useHandSession`のSSEは続く）。`hooks/useReplay.ts`が`GET /api/replay/hands`の一覧と、選んだHandの`steps`を取り、どのstepを見せるか（前へ / 再生 / 一時停止 / 次へ）だけをclientで持ちます（再生の間隔は`lib/config.ts`の`REPLAY_STEP_MS`。暫定値900ms）。取得のたびに番号を振り、最後に出した要求の応答だけを採ります（一覧とHandで別々）。卓・進行ログ・Chipの構成・Dealer Feedback（`HeroFeedback`）・用語の詳細は卓と同じ部品で描き、stepの1行（`lib/replay.ts`の`stepCaption`）は進行ログと同じ文言に、Heroの宣言・Chipの操作・裁定の行を足したものです。
  - Jump to Important Spot（#84・D93）: Replayの操作の下に、`importantSpots`の`stepIndex`へ移るボタン（「1. Turn」と理由）を並べます（`useReplay`の`jump`。再生は止める）。今のstepがHeroの判断の直前の卓なら「この判断の Review を見る」でその判断のReviewを開けます。狭い画面では1行に並べ、溢れた分はその行の中だけで横に送ります（Hero欄を高くして卓を隠さない）。
  - Hand Review（#84・D04・D05・docs/06 §10）: `components/ReviewScreen.tsx`。Handの終了後のHeroの欄（卓の中央の結果の欄は狭い画面で席と重なるので置かない）・Replayの「この Hand の Review」から開きます（`App.tsx`の画面の状態は`table` / `replay`〔開くHandとstep〕/ `review`〔Handと最初に開く判断〕）。`GET /api/replay/hands/:handId`の`decisions`・`importantSpots`で、Important Spotを先に、ほかの判断を後に並べ（要点先行）、行ごとにPass Aの最新の段階評価か「作成中」「Review 未作成」を出します（一覧にHandの結果は出さない）。判断を選ぶと「判断時点の Review」（Pass A。`ReviewPass.tsx`の`DecisionReviewPanel`）と「Hand 後の答え合わせ」（Pass B。`RevealReviewPanel`。別の色の面）をタブで分け、Pass Bは開いたときだけ読みます。Pass Aは段階評価・確度・要点（Practical）・結論が変わる条件・理論・Exploit・前提を先に、根拠（判断時点の卓とActionの流れ・Math・Range・Solver・KB。`ReviewEvidence.tsx`）を畳んで後ろに出します。SolverはSupportedのときだけ結果（Heads-Upの解で唯一の正解ではない前提つき）を出し、それ以外は使わなかった理由とFallback（Math・Range・KB）を出します（サーバーの`detail`は出さない）。生成は「作る」「作り直す」「詳しく作る」（`depth: "deep"`。D97）で新しいVersionとして追記し、Versionが2つ以上なら選べます（`GET .../versions/:version`）。Follow-up（`FollowUp.tsx`）はPassとVersionごとの欄で、送った質問は答えが届くまで入力欄に残します。状態は`hooks/usePolled.ts`がGETのURLごとに読み、生成の待ちの間は`REVIEW_POLL_MS`（暫定1500ms）ごとに読み直し、最後に出した要求の応答だけを採ります。待ちの案内は「Review を作っています…」だけで、`REVIEW_DELAY_NOTICE_MS`（暫定40秒）を超えたら「時間がかかっています」を足します（モデル名・APIは出さない。docs/06 §11）。生成の失敗は種類ごとの案内ともう一度作るボタン、Insufficient Evidenceは保留の理由（Gate / 検証できなかった）を出します。
  - Targeted Drill（#117・docs/06 §14・docs/07 §7）: Session Reviewの「おすすめの練習（Recommended Drill）」の「Drill を始める」で、`App.tsx`の画面の状態`drill`に移り、2つ目の`useHandSession`（開始の要求を`POST /api/drills`に差し替える。`lib/drill-api.ts`）でDrillのHandを1 Hand遊びます。卓・進行ログ・Heroの欄は通常の卓と同じ部品（`TableScreen`）で、上にDrillの説明（`components/DrillBanner.tsx`。変えた要素と元 → Drillの値。実額が正本でBBは補助）を置き、CPUのNote / Tagの欄は出しません。終わったら「練習した判断の Review」（既存のReviewの画面）と「卓に戻る」（通常の卓のSessionはそのまま）を出します。Session Reviewの画面に、Drillの結果（`GET /api/drills`。通常のScoreと別の欄）を出します。
  - Session Review（#116・docs/06 §14・docs/07 §6）: `components/SessionReviewScreen.tsx`。Sessionが終わったときの案内（画面の幅によらずHeroの欄。#158）の「この Session を振り返る」から開きます（`App.tsx`の画面の状態`session_review`〔SessionのどれかのHand〕）。`GET /api/learning/session-review/:handId`と`GET /api/learning/profile`を別々に読み、それぞれ失敗したら読み直しのボタンを出します（`lib/learning-api.ts`。文言は`lib/learning.ts`）。Strength / Leak・Important Handsの行から、そのHand（判断）のReviewを開きます。Player Profileの下にLearning Resetの入口（`components/LearningReset.tsx`。#118）を置き、`POST /api/learning/resets`の後にProfileとDrillの結果を読み直します。
  - `components/`: 卓（`Table`。席はHeroを画面下の中央に置き、席順＝時計回りに配置。SB / BBは公開Eventの`BLIND_POSTED`から読む）、Card（`PlayingCard`。SVGの構造描画。D60）、金額（`Amount`。実額が正本でBBは補助。D49）、Chipと宣言の操作（`ChipControls`。Stack の Chip を Click で手に取り、手元か Betting Area の Click、または Drag〔`hooks/useChipDrag.ts`。Pointer Events〕で出し、宣言 Button〔Fold / Check / Call / Bet / Raise / All-in を局面によらず全部出す〕と「確定して Dealer に渡す」で `PhysicalAction` の列を送る。操作の列は `lib/chip-ops.ts` の純粋関数で組み、合法性も裁定も判定しない。数値の Bet Box は作らない。docs/06 §4・§5。#65。裁定の結果は `lib/view-model.ts` の `heroRulingStatus` / `latestHeroRulingIndex` で公開 Event の `DEALER_RULING` から読む）、Dealer Feedback（`DealerFeedback`。`lib/dealer-feedback.ts` が `DEALER_RULING` から RULING / ETIQUETTE / COACHING を別の項目として決定論で作る。COACHING は裁定より前の公開 Event だけを読む。docs/06 §6。#66）、Poker Vocabulary（`Vocabulary`。用語の辞書は `lib/vocabulary.ts` のデータで、卓の用語を Hover / Click / キーボードで開くと Definition・Current Hand Example・Related Concept・Advanced Detail を出す。docs/06 §7。#66）、進行ログ（`HandLog`。裁定は Dealer Feedback の分類ごとの行にする）。他者の札は`seats[].holeCards`に入っているもの（Showdownで公開された札）だけを表に向け、それ以外は裏向き（Fold済みの席は札なし）で描きます。HeroがFoldした後もHandの終了まで観戦を続けます（docs/06 §8）。Chipの積み（`ChipStack`。額から`composeChips`で組んだ額面ごとの積みを色付きのCSSで描く〔D60・D92〕。席のStackとBetに添え、実額は隣に常時出す〔D49〕。額面と色の対応は`lib/config.ts`が`PHASE1_CASH_PRESET.chipDenominations`から持ち、色の値は`styles.css`の`--color-chip-<色名>`。ブラウザが使うEngineの値はこの額面と構成の関数と、Dealer Feedback・Poker Vocabularyの例で使うPot Oddsの`potOdds`〔#79〕だけで、`vite.config.ts`の`@proj-poker/source`条件でsrcから読む。#62）。
  - 狭い画面（幅719px以下。`hooks/useNarrowScreen.ts`が`styles.css`の`@media (max-width: 719px)`と同じ境界で判定）では、卓の中央に重ねていたHandの結果・CPU障害のダイアログ・Session終了の案内を画面下に固定したHeroの欄に置きます（`App.tsx`の`HeroDock`。広い画面は卓の中央。#5）。ただしSessionが終わった後は、広い画面でも理由・「この Session を振り返る」「新しい Session を始める」をHeroの欄に置き、卓の中央には獲得額の一覧だけを残します（Buttonが縦に2つ並ぶ結果の欄は背が高く、1280×720でHeroの席に覆われて押せなかったため。`App.tsx`の`sessionEndInDock`。#158）。幅720〜1023pxでは卓は広い画面の配置のまま、Heroの欄だけ狭い画面と同じ詰め方（`styles.css`の`@media (max-width: 1023px)`。手番の案内を1行目の右に置く規則だけ`min-width: 720px`との組。720×600で434px→233px。#163）にします。卓の席のBetの札も、狭い画面では席の面の中に描きます（`Table.tsx`の`Seat`。広い画面は卓の上）。
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

### Claudeの認証（D87。D84を変更）

CPU等のClaude呼び出しは、APIキーではなく、ローカルでログイン済みの**Claude CodeのOAuth認証（サブスクリプション枠）**を**Claude Agent SDK**経由で使います。手順（ユーザー向け）は`README.md`の「Claudeの認証」です。

- **呼ぶ場所**: ローカルの`apps/server`だけです。`apps/web`（ブラウザ）はClaudeを呼ばず、資格情報も受け取りません。
- **資格情報の置き場所**: Claude Codeが`~/.claude/`に持つものをそのまま使います。リポジトリ・`.env`・`apps/web`へ置かない・コピーしない・渡しません（CLAUDE.md 不変条件6）。`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`（ブラウザが使えない環境向け）は本プロダクトでは使いません。
- **API課金への切り替わりを防ぐ**: 環境に`ANTHROPIC_API_KEY`があるとAgent SDKはそちらを優先し、サブスク枠ではなくAPI課金になります。そのため`apps/server`はClaudeを呼ぶ子プロセスの環境から`ANTHROPIC_API_KEY`を外します（実装は#50）。利用者にも、serverを起動するシェルに無いことを確認してもらいます。
- **前提と範囲**: 本人のログインを本人が使うローカル単一ユーザー（D61）に限ります。第三者が自分の製品でclaude.aiログインを提供することは公式に認められていないので、配布・共有・複数ユーザー化の方向には使いません（Auth Providerは§11の非目標のまま。ここでいう認証はClaudeを呼ぶ資格であり、プロダクトのログインではありません）。
- **利用枠**: サブスクの利用枠は開発で使うClaude Codeと共有です。ログイン切れ・上限到達は、Claudeの呼び出しの失敗として§6の「AI障害」で扱います（Retry / Emergency Botで続行 / Session終了。卓上のダイアログで選ぶ。#52）。
- **テスト**: CIと`pnpm test`はClaudeを呼びません（FakeのModelと録画済み応答だけ。D84から変わらず）。開発中の実呼び出しは制限しません。E2E（`docs/09` §8。#85）は、serverを`REVIEW_PROVIDER=fake`（Review AIを固定応答〔`apps/server/src/review/fake-review-query.ts`〕に差し替える。既定は`claude`、それ以外の値は起動時に誤りとして止める）と`POKER_SEED`（Handごとの山札のseedを`POKER_SEED`, +1, …の固定の並びにする。未設定なら乱数、不正な値は起動時に止める）で起動し、CPUはRuleBotのまま通します（D98）。どちらもE2E用で、本番の既定は変えません。
- **CPUをClaudeに切り替える設定（#50）**: 環境変数`OPPONENT_PROVIDER=claude`（既定`rulebot`。それ以外の値は起動時に誤りとして止めます）。モデル名はrole-based config（`apps/server/src/config.ts`の`MODEL_ROLES`。`opponent_fast: claude-haiku-4-5`はD85・OI-001の暫定値）から渡し、Domain Logicには書きません。
- **呼び方（#50。`opponents/claude-opponent.ts`）**: Agent SDKの`query()`を1回の判断として使います。構造化出力（`outputFormat: { type: "json_schema" }`。`action`の候補は今選べるtypeに絞る）でaction / amount / rationaleを受け取り、§5の検証に回します。単発にするため`maxTurns: 1`・組み込みツールなし（`tools: []`）・設定ファイル（CLAUDE.md / settings）を読まない（`settingSources: []`）・MCPを読まない（`mcpServers: {}`・`strictMcpConfig: true`）・セッション履歴を保存しない（`persistSession: false`）・作業ディレクトリをリポジトリの外（OSの一時ディレクトリ）にする（git の状態等をCPUへ渡さない）にします。子プロセスの`env`は`process.env`から`ANTHROPIC_API_KEY`と`ANTHROPIC_AUTH_TOKEN`を外したものです（SDKの`env`は環境を丸ごと置き換えるため）。Promptに入れるのはそのCPUの`KnowledgeState`・Legal Action・前回の不正の理由・そのCPU自身のPersona（`describePersona`の文章。#51。割り当てが無ければ入れない）だけです。そのCPU自身のMemoryの要約（#139・D121）は、あるときだけ「あなたの記憶」の節（固定の読み方の説明と、構造化データのままのJSON）に入れ、Handの情報の節には混ぜません（Memoryの無いCPU・Opponent EvalのSpotのPromptは#139より前と同じ文字列。LLMの呼び出しの回数・経路は変えない）。そのCPU自身のTilt（#140・D107）は、1以上のときだけ「あなたの今の状態」の節（段階と固定の説明）に入れ、0のときは節ごと入れません（Promptは#140より前と同じ文字列）。そのCPUから見たTable Tendency（#141・D106）は、数えたHandが1以上のときだけ「卓の傾向」の節（固定の読み方の説明と、構造化データのままのJSON）に入れ、Handの情報の節には混ぜません（Handが0のとき・Opponent EvalのSpotのPromptは#141より前と同じ文字列。LLMの呼び出しの回数・経路は変えない）。Legal Actionの行のうち額が決まっているcall / all_inには「amount は付けない」と書きます（#53。callに額を付けてSchemaの不正→Retryになる回があったため。検証は緩めない）。代表Spotでの品質の測り方（AI Opponent Eval）は`docs/09` §5です。
- **失敗の分け方（#50）**: ログイン切れ・利用枠の上限（assistant messageの`error`と`is_error`のresult）・実行中の失敗・子プロセスの起動失敗は例外にし、§5の「障害」になります。構造化出力を作れなかった（`error_max_turns` / `error_max_structured_output_retries`）は不正な出力として§5の検証・Retryに乗せます。判断待ちの上限を超えた・アプリを終了したときは、`decide`に渡した`AbortSignal`をabortし、SDKの`abortController`で子プロセスを止めます。
- **呼び出しの共通化（#82）**: `query()`の部分（単発化の設定・子プロセスの`env`・`AbortSignal`・失敗の分け方）は`apps/server/src/claude/structured-query.ts`の`runStructuredQuery`に切り出し、Opponent（`ClaudeOpponent`）とReview AI（§7）の両方が使います。Opponentの挙動は変えていません（失敗は`ClaudeCallError`から`ClaudeOpponentError`へ包み直す。Optionsの項目の並びはOpponent Evalの録画の指紋に入るので変えない）。ReviewのRoleは`MODEL_ROLES`の`review_standard: claude-sonnet-5-5`・`review_deep: claude-opus-5-5`（D97・OI-001の暫定値。`review_deep`はHeroが「詳しく」を選んだSpotだけ）。
- **Latency（#50の実測）**: 1回の判断は中央値約7.2秒・最大約15.5秒で、子プロセスの起動〜初期化は約0.7秒です（残りはAPIの応答）。起動の割合が小さいので事前起動（`startup()`）は使っていません。判断待ちの上限`OPPONENT_TIMEOUT_MS`の暫定値はこの実測で30000msに見直しました（OI-001）。

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

実装（#46）: `packages/engine` の `projectKnowledgeState(events, playerId)` が、そのPlayerに見えるEventだけを畳み込んで `KnowledgeState` を作ります（`docs/04` §5）。中身は卓の見え方（公開Board・Pot / 各席のStack・Commit・Fold / All-in・Showdownで公開された札・手番のときだけLegal Actions〔Legal Amount Rangeを含む〕）に、自分のHole Cards・Position（Buttonからの席の距離と人数）・Public Actionの履歴・決定論のMath（Call額・Pot Odds・有効Stack・SPR）を足したものです。Mathは公開情報だけから計算し、比率は判断の目安でChipの移動には使いません。Heroの操作への裁定があるHandでは、公開の裁定の履歴（`rulingHistory`。#64・`docs/04` §5）も足します（裁定が無いHandでは項目ごと持たず、Promptを変えません）。Phase 7（#139・D121）からは、`apps/server`のOrchestratorがHandの開始時に作ったそのCPU自身のMemoryの要約（`memory`。`docs/04` §5・§12）を足します（参加者の引けないCPUでは項目ごと持たない）。#140（D107）からは、そのCPU自身のInternal StateとしてTiltの段階（`tilt`。今のSessionの保存済みのHandから作る。1以上のときだけ）も足します。#141（D106）からは、そのCPUから見たTable Tendency（`tableTendency`。今のSessionの、そのCPUが座っていた保存済みのHandのpublicのEventだけから作る。数えたHandが1以上のときだけ）も足します。`apps/server` の Orchestrator は `OpponentAgent.decide({ knowledge, legal })` に `KnowledgeState` とEngineが計算したLegal Actionだけを渡します。自分のPersonaは入力ではなくAgentを作るとき（`OpponentFactory`の引数）に渡し、`KnowledgeState`には入れません（#51。他CPUの入力・Heroへの応答に混ざらないようにするため）。StateはそのCPU自身のTiltだけです（#140）。

Validation:
1. Schema
2. Legal Action
3. Amount Range

Invalid時:
- 1回だけ明示的にCorrectionしてRetry
- 再度InvalidならDeterministic Safe Fallback

Invalid OutputはLogへ残します。

実装（#47）: `apps/server` の構成は次のとおりです。

- **出力の形**（`opponents/opponent-agent.ts`）: `decide` はPromiseを返し、期待する形は `OpponentOutput`（`action`: fold / check / call / bet / raise / all_in・`amount`: bet / raiseだけが持つこの Street の累計〔to額〕・任意の `rationale`）です。LLMの出力は何が来るか分からないので、Orchestratorは `unknown` として受けて検証します。
- **検証**（`opponents/opponent-output.ts` の `checkOpponentOutput`）: 1. Schema（オブジェクトであること・知らない項目が無いこと・`action` が上の6つのどれか・bet / raiseの`amount`が整数・それ以外に`amount`が無い・`rationale`が文字列）→ 2. Legal Action（Engineが計算したLegal Actionにその種類があるか）→ 3. Amount Range（bet / raiseの額がLegal Actionの min〜max に入るか）の順で、最初に引っかかった段と理由を返します。通った出力も最後は `applyAction`（Engine）が適用可否を決め、拒否されたらLegal Actionの不正として扱います（D40）。
- **Retry と Fallback（D41）**: 不正なら、同じ `KnowledgeState` とLegal Actionに `correction`（段と理由）を足して1回だけ再要求します。再度不正なら、そのCPUの `RuleBot`（同じseed）の判断で続けます（Deterministic Fallback）。不正な出力（Player・何回目か・段・理由）は `AI_ACTION_INVALID`、Fallbackの利用（Player・Fallbackの種類・理由）は `AI_FALLBACK_USED` としてEvent Logに残し（#48・D83。seqはEvent自身のseq。形は `docs/04` §3）、server のログにも残します。どちらも `system` Visibilityで、HeroのView（APIの応答・SSE）とCPUの `KnowledgeState` には入りません（`docs/04` §4）。記録はその手番のActionより前に置き、`AI_FALLBACK_USED` とFallbackのActionは1回の追記で続けて置きます。
- **障害**: `decide` の例外（Promiseのrejectを含む。API障害など）と、1回の判断が上限（`OPPONENT_TIMEOUT_MS`。暫定値）を超えたことは、不正な出力と区別して「障害」とします。障害のHandはその手番で止め（Retryも`RuleBot`への切り替えも自動ではしない。§6・D86）、障害の内容（seq・Player・種類・理由）を保持します。種類は`timeout`（上限の超過）と、例外の種類から決める`unauthenticated`（未ログイン）/ `usage_limit`（利用枠の上限）/ `error`（それ以外）です。Agentが`OpponentOutageError`（`outageKind`を持つ例外）を投げればその種類、それ以外の例外は`error`です（`ClaudeOpponent`はassistant messageの`error`から分けます。§3）。止まったHandは開始の再送でもそのまま返し、新しいSessionへ進めません。上限の後に届いた判断は捨て、`decide`に渡した`AbortSignal`をabortしてCPU側の処理（Claudeの子プロセス）を止めさせます（#50）。続け方の選択は§6です。

## 6. AI障害

ユーザーに選択させます。

- Retry
- Emergency Botで続行
- Session終了 / Pause

Emergency Botへ自動切替しません。

Fallback利用Hand / ActionにはFlagを付けます。

実装（#52・D86）: 障害（§5）で止まったHandは、Heroが選ぶまで止めたままです（Pause＝ダイアログを出したまま止める形。止まったHandは保存前なので、再起動すると消え、Sessionは最後に終わったHandから戻る。#77・D62）。選択は`HandOrchestrator.resolveOutage(handId, revision, choice)`（API は`POST /api/hands/:handId/outage`。§1の表）で受けます。

- **Retry**: 同じ手番を、同じ`KnowledgeState`とLegal Actionでもう一度CPUに求めます。また障害なら同じ手番でまた止まります（`revision`が進む）。
- **Emergency Botで続行**: そのCPUを、Sessionの終わりまでそのCPUの`RuleBot`（そのCPUのPersonaのまま。§2 `opponents/persona.ts`）で動かします。CPUには判断を求めず、手番ごとに`AI_FALLBACK_USED`（`fallbackKind: emergency_bot`・`reason`はきっかけの障害の種類。内部のエラー本文は入れない）とそのActionを1回の追記で置きます（Opponent Qualityの分析で通常の判断と混同しないFlag。`docs/06` §12）。選んだ時点で、障害で止まったその手番に`EMERGENCY_BOT_ENGAGED`（`cause`はきっかけの障害の種類）を残し（#77・D95。D88のEvent化）、同じSessionの次のHandにも続きます（OrchestratorのSessionはその写しを持ち、再起動後はSession Projectionから戻す）。新しいSessionでは解除します。
- **Session終了**: そのHandを`HAND_ABORTED`（`ai_outage`）で打ち切り、同じ追記で`SESSION_ENDED`（`ai_outage`）を置いてSessionを終えます（#77・D95。D88のEvent化。`SessionStatus`は`ended`・`reason: ai_outage`）。打ち切ったHandはその時点で保存され、Replayの一覧に残ります。打ち切ったHandは開始の再送でも返さず、次の開始は新しいSession（均等Stack）です。打ち切ったHandのPotに入っていたChipは、そのSessionとともに捨てます（次のSessionは均等Stackで始まるので、Chip総量は新しいSessionの中で保たれます）。

Heroに返すのは「どのCPUの手番か・障害の種類」（`OutageStatus`）だけで、内部のエラー本文（資格情報やパスを含みうる）・Persona・CPUの出力は返しません（server のログには本文を残します）。#52ではEventの形・DBのスキーマは変えていません（打ち切り・切り替えのEvent化は#77）。

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

Deterministic MathとRange Analysisは、Engineの`analyzeDecision` / `compareRangeProfiles`（`packages/engine/src/decision-analysis.ts`。#79）が判断時点のHero Information Set（`heroInformationSets`。#78）だけを入力に作ります（Pot Odds・Equity・相手ごとのRangeのAssumption・Alternative Actionの必要Equityと簡易EV。中身は`docs/05` §6）。Math / Equity EngineはPoker Engineと同じ`packages/engine`の純粋関数で、I/O・LLMをimportしません。

実装（#82・#83）: Review Orchestratorは`apps/server/src/review/`です（Pass A＝Decision Review・Pass B＝Reveal Review・Follow-up Q&A。UIは#84）。

- **入口**（`review-service.ts`の`ReviewService`・API は`routes/reviews.ts`）: `GET /api/reviews/hands/:handId/decisions/:decisionIndex`がその判断のReviewの状態（最新のVersion・Versionの数・生成の状態）を、`POST`（body は`{}`か`{ "depth": "deep" }`）が新しいVersionの生成を始めて待ちの状態（202・`generation.state: pending`）を返します。`decisionIndex`はそのHandでのHeroの判断の順番（`heroDecisions`の`index`）。Reviewを作れるのは保存済みで終わったHand（`HAND_FINISHED`か`HAND_ABORTED`）だけで、無いHand・判断は404、進行中のHandは409です。生成はHandの進行と切り離して裏で1つずつ順に進め（Claude・Solverの子プロセスを同時に複数動かさない）、同じ判断を生成中に要求しても新しくは始めません。要求するたびに次のVersionを作り、過去のVersionは残ります（D39）。
- **流れ**: 保存済みのEvent Logから`heroInformationSets`で判断時点のInformation Setを作り（判断より後のEvent・他者の札・`system`のEventは入らない）、`extractImportantSpots`の理由と、判断のHandより前に保存した同じSessionのHandのpublicのEventだけから作ったHeroのTable Tendency（`memory/table-tendency.ts`の`buildHeroTableTendencyFromStore`。D122・#153）を添えて`buildReviewEvidence`（`evidence.ts`）でEvidence（`docs/05` §6）を組みます。Evidence Sufficiency Gate（`sufficiency.ts`）を通ったらReview AI（`generate.ts`の`generateReview`）に構造化出力で書かせ、検証（`review-ai.ts`の`checkReviewOutput`）→不正なら理由を付けて1回だけ再要求→2回続けて不正ならInsufficient Evidenceにして失敗（各回の段と理由）を残し、Review Version Store（`review-store.ts`。`reviews`テーブル。`docs/04` §8）に追記します。Web Fallback（OI-010）は入れず、根拠が足りないときはReview AIを呼ばずにInsufficient Evidenceにします（D94）。
- **Solver Capability Check**（`solver-evidence.ts`）: 判断時点の卓から`AnalysisSpot`の構造（Fold していない人数・Street・Side Pot・Rake 0・Bet Tree）を組んで`supports`を通し、Unsupported（Multiway・Flop・未導入等）はその理由のままFallbackします（Preflopは対象外）。Solverが返すのはStreetの最初の判断（OOP）の戦略だけなので、Heroがその手番（そのStreetでまだ誰も動いていない）のときだけ解き、それ以外（IP・Betへの直面）は`not_applicable`です。Rangeは、相手はRange Model（`villainRange`）、Heroは相手から見たHeroのRange（`heroRange`。#82でEngineに追加）です。解けたらSolver Evidence（HUの近似。全体の頻度とHeroのHand Classの頻度・前提）を、失敗（Timeout等）は決まった文だけをEvidenceに入れます（失敗の本文はserverのログだけ）。
- **失敗**: Claudeの呼び出しの失敗（未ログイン・利用枠・上限`REVIEW_TIMEOUT_MS`〔暫定 120000ms〕の超過・それ以外）はReviewを作らず、生成の状態を`failed`（種類だけ。内部のエラー本文は返さない）にして再要求を待ちます。アプリの終了では進行中のClaude・Solverの子プロセスを止めます。
- **Versionの指定（#84）**: `GET /api/reviews/hands/:handId/decisions/:decisionIndex/versions/:version`（Pass A）と`GET .../decisions/:decisionIndex/reveal/versions/:version`（Pass B）が、指定したVersionのReviewを返します（画面でVersionを選ぶため。無いVersionは404`review_not_found`、Versionは1以上の整数の表記だけ）。
- **Pass B（Reveal Review。#83）**: `GET` / `POST /api/reviews/hands/:handId/decisions/:decisionIndex/reveal`（作法はPass Aと同じ）。終わったHandのEvent Logから、Pass Aと同じ判断時点のInformation Setと、別のProjection `projectLearningReveal`（全員の札）を取り、`buildRevealEvidence`（`reveal-evidence.ts`）が読み（判断時点に仮定した標準のRange）と実際の札の比較・実際のEquity（判断時点のBoardからの、Potを争っていた相手の実際の札に対する勝率）・Bluff / Valueの答え合わせ（判断時点までのBet / RaiseとHeroのBet / Raiseの、実際の札のEquityが公平な取り分〔1 / 人数〕以上ならvalue。暫定の基準）を決定論で作ります。Review AI（`generate-reveal.ts`・`reveal-ai.ts`）は評価（Assessment）を出さず、説明（読みと実際の比較・実際のEquity・Bluff / Value・次に活かす点）だけを書きます（検証・1回だけの再要求・Fallbackの作法はPass Aと同じ）。`reveal_reviews`テーブルに別のVersionの列として追記し、Pass Aの`reviews`は読みも書き換えもしません（`docs/05` §7）。
- **Follow-up Q&A（#83）**: `GET` / `POST /api/reviews/hands/:handId/decisions/:decisionIndex/passes/:pass/versions/:version/followups`（`pass`は`decision` / `reveal`。POSTのbodyは`{ "question": "...", "depth"?: "deep" }`、質問は500字まで）。指定したPass・VersionのReviewのEvidenceと説明、そのVersionのこれまでの質問と答え（古い順）をPromptに入れ、`runStructuredQuery`の単発の問い合わせで答えさせます（D87。SDKのセッションは残さない）。Pass Aへの質問のPromptにはPass AのEvidenceしか入らないので、Hand後の情報が混ざりません。範囲の指示はPassごとに文で出し分け、Evidenceで答えられない質問は`out_of_scope`として答えさせます。答えは`review_followups`テーブルにターンごとに追記します（1つのVersionにつき20ターンまで。暫定値）。前の質問の答えを作っている間の質問は409で受け付けず、無いVersionは404です。Pass A・Pass B・Follow-upの生成は同じ待ち行列で1つずつ順に進めます。`review_deep`は`depth: "deep"`のときだけです（D97）。
- **INV-TEST-008（Runtime）**: Pass BとそのFollow-upを作った後のHandでも、Claude OpponentのPromptに入る札がその時点でそのCPUが知ってよい札だけであることを確かめます（`review/learning-reveal-isolation.test.ts`）。
- **Review Eval**（`apps/server/src/testing/review-eval/`）: `docs/09` §6。

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

実装（#81・D96）: Primary Solverはamaster97/poker_solver（MIT）で、Adapterは`apps/server/src/solver/`にあります（型は`types.ts`、実装は`amaster97-adapter.ts`）。

- **導入**: Solverのソースと成果物はリポジトリに入れません。`apps/server/solver/setup-amaster97.sh`が固定したcommitをリポジトリの外へcloneしてvenvにビルドし、`install.json`（commit・版）を書きます。serverは環境変数`POKER_SOLVER_HOME`でその場所を知ります。未設定・未導入なら、どのSpotも`solver_not_installed`のUnsupportedです（起動は止めません）。
- **Capability**: #76のPoCで動いたHU・Turn / River・Cashだけを宣言します（Rake・ICM・Side Potなし）。`supports(spot)`はPlayer数（All-in済みのPlayerも数える）・Street・Mode・Rake・Side Pot（Spotの`sidePot`）・Bet Tree（Bet Size 5種・Raise倍率 5種・攻撃 4回まで）・導入の有無の順に照らし、Unsupportedは理由（`player_count` / `street` / `mode` / `rake` / `side_pot` / `bet_tree` / `solver_not_installed`）とFallback先（Math・Range Analysis・KB・Review AI）を返す正常系です。
- **呼び出し**: `analyze(spot, options)`はまず入力を検証し（不正なカード・Boardの重複と枚数・正でないPot / Stack・空のRange・Boardと衝突するCombo・未知のStreet / Mode等は`invalid_input`。Capabilityの判定より先に弾き、壊れたSpotをUnsupportedのFallbackに紛れさせない。Solverへ渡さない）、`supports`を通らないSpotは解かず、`apps/server/solver/amaster97_runner.py`を導入先のPythonで子プロセスとして動かし、stdin / stdoutのJSONでやり取りします。Rangeは具体的なCombo（#79のRange Modelの結果を`rangeFromModel`で渡せる）で渡し、Hand Classに丸めません。Timeout（`SOLVER_TIMEOUT_MS`、暫定 60秒。#81で20秒と置き、#82でRange ModelのRangeのTurnが約33秒かかったため見直し）とCancel（AbortSignal）はSIGKILLで止め、プロセスの終了を待ってから返します（孤児を残さない）。同時に動かす数は`SOLVER_MAX_CONCURRENCY`（既定 1）で、超えた分は待ちます。失敗は`SolverError`の`timeout` / `cancelled` / `process_failed` / `parse_failure`で、呼び出し側はUnsupportedと同じくFallbackします。
- **Evidence**: `SolverEvidence`はRoot（Streetの最初の判断・OOP）のRange全体とHand Classごとの行動頻度、Version Metadata（Solverの版・`install.json`のcommit・固定commitとの一致）、Bet Tree、Iteration数、両者のRange Assumption（Range Modelの`RangeAssumption`か、表記と理由）、前提（HUの結果でMultiwayのExact GTOではない・Bet Treeの抽象化・呼び出し側の前提）を持ちます。Action EVは今の呼び出し経路では取れないので`ev.available: false`と理由を返し、推測で埋めません。exploitabilityはTurnで数分かかるため計算しません。
- **テスト**: CIは実Solverを呼ばず、偽のSolver（Nodeのスクリプト）と実Solverの録画で`docs/09` §7の項目を確かめます。実Solverでの確認は`pnpm --filter @proj-poker/server smoke:solver`です。

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

実装（#80・D98）: Local KBは`apps/server/kb/`の**Curated KB**です。docs/researchから、Reviewで使う粒度の要点を1項目1ファイルのMarkdownに書き起こしたもので（研究資料の丸写しではない。数値の根拠はEngineのMath Evidenceが持ち、KBは概念・Practicalな指針だけ）、server（`apps/server/src/kb/`）が起動時に1回だけ読み込み、検索はメモリ上の関数です（Vector DBは使わない）。

- **項目の形**: 先頭のMetadata（front matter）に`id`（ファイル名と同じ。Evidence IDに使う）・`title`・`topic`・`label`（Knowledge Label。`docs/research/README.md` §2の7種）・`formats`・`streets`・`positions`・`players`（`heads_up` / `multiway`）・`spots`（Spotの種類。`preflop_open` / `preflop_facing_raise` / `postflop_aggressor` / `postflop_checked_to` / `postflop_facing_bet`）・`actions`（相手のPreflopのAction列の分類。EngineのPreflopSpot）・`keywords`・`source`（`docs/research/<file>.md §<節> | <元の出典>`）・`date`・`version`（項目のVersion）を持ち、その後ろが本文です。絞り込みの項目は空なら「条件なし」です。Topicは閉じた語彙（`types.ts`の`KB_TOPICS`）で、未知のTopic・未知の項目名・必須項目の欠け・実在しないdateなどは読み込みで弾きます（`parseKbEntry`）。
- **KB全体のVersion**: `apps/server/kb/manifest.json`の`version`（x.y.z）です。項目を足す・変える・消すたびに上げ、`contentHash`（全項目の内容のsha256）を更新します。内容を変えて`contentHash`の更新を忘れるとテストが落ちます。
- **検索**（`searchKb(kb, { spot, topics, text, limit })`）: ①Spotの特徴（Street・Position・Player数・Spotの種類・Action列）のうち渡したものについて、項目の条件に当たらないものを除き ②Spotの種類・Action列・Street等で加点（条件が1つの値だけの項目は少し上）③Topicを渡したらそのTopicだけに絞って加点 ④全文の語（title・keywordsに当たれば3点、本文だけなら1点）で加点し、点の高い順・同点はidの昇順に返します。1点も取らない項目・何も渡さない検索は空です。同じKB・同じ入力なら必ず同じ結果です。加点は暫定値です（`KB_SCORE`）。
- **Evidenceに残す形**: 結果の各hitは`kbVersion`・`id`・`version`・`evidenceId`（`kb:<kbVersion>:<id>@<version>`）・`topic`・`label`・`source`・`matched`（当たった特徴・語）・本文を持ちます。Review Evidence（`docs/05` §6のKnowledge Evidence。#82）はこの`evidenceId`と`kbVersion`を残し、Review Version（`docs/04`のKB Version）に使います。

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
