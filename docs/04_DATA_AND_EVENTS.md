# データとEvent設計

## 1. 正本

Hand Event Logを、実際に何が起きたかを表す**唯一の正本**とします。

以下は派生データです。

- Current Game State
- Hand Summary
- Session Summary
- Statistics
- Replay Timeline
- Review Input

独立した二つの「正しいHand表現」を持たないでください。

## 2. 主要ID

推奨:

- `session_id`
- `hand_id`
- `event_id`
- `player_id`
- `cpu_profile_id`
- `action_id`
- `review_id`
- `observation_id`
- `hypothesis_id`
- `drill_id`

## 3. Eventカテゴリ

最低限、以下と同等の情報を復元可能にします。

- `SESSION_STARTED`
- `SESSION_ENDED`
- `HAND_STARTED`
- `HAND_FINISHED`
- `BUTTON_ASSIGNED`
- `BLIND_POSTED`
- `ANTE_POSTED`
- `HOLE_CARD_DEALT`
- `PLAYER_DECLARED`
- `PHYSICAL_CHIP_ACTION`
- `DEALER_RULING`
- `ACTION_TAKEN`
- `CHIPS_MOVED`
- `CARD_BURNED`
- `BOARD_DEALT`
- `PLAYER_FOLDED`
- `PLAYER_ALL_IN`
- `SHOWDOWN_STARTED`
- `CARDS_TABLED`
- `POT_AWARDED`
- `AI_ACTION_INVALID`
- `AI_FALLBACK_USED`
- `HINT_OPENED`
- `USER_READ_RECORDED`

内部実装でEventを統合しても構いませんが、必要な情報を後から復元できることが条件です。

### Engine の Event 構成（`packages/engine/src/hand-events.ts`）

Phase 1（D70）で作り、Phase 2 の Side Pot（#31・D78）で `POT_AWARDED` をPot単位にし、Short All-in の Reopen（#32・D79）で `HAND_STARTED` に `reopenRule` を足し、Phase 3 で CPU の判断の経緯（`AI_ACTION_INVALID` / `AI_FALLBACK_USED`。#48・D83）を足した、1 Hand進行で発行するEventです。上の一覧のうち、統合したものは「統合元」に書きます。Eventは `seq`（Hand内の通し番号・0始まり）と `visibility` を持ち、Stateは `foldHandEvents`（Eventの畳み込み）だけで作ります（D37）。`event_id`・時刻・`session_id` は永続化する側（`apps/server`）が付けます（EngineはI/Oと時刻を持たない）。

| Event | 主な項目 | Visibility | 統合元・備考 |
|---|---|---|---|
| `HAND_STARTED` | `handId`・`ruleProfile`・`smallBlind`・`bigBlind`・`oddChipRule`（Split Potの端数の配り方。D75）・`reopenRule`（Short All-inの後のRaiseの再開規則。D79・D81）・`seats`（席順の `playerId` / `stack`）・`buttonPlayerId` | public | `BUTTON_ASSIGNED` |
| `DECK_SHUFFLED` | `seed`（積んだDeckならnull）・`deck`（配布順の52枚） | engine | 未来のCardを含むため、どのPlayerのProjectionにも入れない。§9のRNG Seedに相当 |
| `BLIND_POSTED` | `playerId`・`blind`（small / big）・`amount` | public | Ante は Phase 1 で扱わない |
| `HOLE_CARD_DEALT` | `playerId`・`cards`（2枚） | private(playerId) | 1 Player 1 Event |
| `ACTION_TAKEN` | `playerId`・`street`・`action`（fold / check / call / bet / raise / all_in）・`amount`（出した額）・`toAmount`（そのStreetの累計）・`allIn` | public | `PLAYER_FOLDED`・`PLAYER_ALL_IN`・`CHIPS_MOVED`（Bet分） |
| `BOARD_DEALT` | `street`（flop / turn / river）・`cards` | public | Burn は省く（`CARD_BURNED` は発行しない） |
| `CARDS_TABLED` | `playerId`・`cards` | public | `SHOWDOWN_STARTED`。River後か、All-inでBettingが終わった時点で、Foldしていない全員が公開する |
| `UNCALLED_BET_RETURNED` | `playerId`・`amount` | public | `CHIPS_MOVED`（返却分）。Betting Roundの終わりに、そのStreetで最も多く出したPlayerの2番目を超える分（Fold決着のBet・Short All-inを超えたBet・Stack不足のBlindを超えたBlind）を返す |
| `POT_AWARDED` | `potIndex`（0がMain Pot、1以降がSide Pot）・`potTotal`・`eligible`（そのPotを争えるplayerId。Buttonの左から時計回りの順）・`awards`（`playerId` / `amount`）・`showdown`（札を比べたか。争えるPlayerが1人のPotはfalse） | public | Potごとに1つ、Main Potから順に発行する（D78）。Σ`awards` = `potTotal`。同着の端数は `oddChipRule` に従って配分済みの額が入る（D75） |
| `HAND_FINISHED` | `stacks`（`playerId` / `amount`） | public | §10のRecovery境界 |
| `AI_ACTION_INVALID` | `playerId`・`attempt`（何回目の要求の出力か。1始まり、2はCorrection付きの再要求）・`stage`（schema / legal_action / amount_range）・`reason`（不正と判定した理由） | system | CPUの出力を検証で不正と判定した記録（D41・D83。Retryで正常に戻った不正も残す）。その手番の `ACTION_TAKEN` より前に置く。`reason` はCPUの出力の値を含みうる。卓のState（Chip・手番）は変えない |
| `AI_FALLBACK_USED` | `playerId`・`fallbackKind`（`automatic`: Retryの後も不正だったときの自動Fallback〔D41〕/ `emergency_bot`: 障害の後にユーザーが選んだEmergency Bot〔D86・#52。そのCPUの手番ごとに置き、`reason`はきっかけの障害の種類〕）・`reason` | system | CPUの判断の代わりにBotの判断を使った記録（`docs/03` §6のFlag）。直後のEventが、同じPlayerのFallbackで決めた `ACTION_TAKEN`（同じ追記で置く）。卓のStateは変えない |

Phase 1の`apps/server`（Issue #18）は、Engineが返したEventをEvent Store（`apps/server/src/event-store.ts`）へそのまま追記し、保存時に`eventId`（UUID）と`recordedAt`（ISO 8601・UTC）を付けます。Event Storeはappend-onlyで、先頭のseqがそのHandの保存済み件数と一致し連番である追記だけを受け付けます（`HAND_FINISHED`の後ろへの追記も拒否します）。起動時はSQLiteの実装（Issue #20。§10の「Phase 1 の保存」）を使い、メモリ内の実装はテスト用です。CPUの不正な出力と、RuleBotの判断で続けたFallbackの記録（`docs/03` §5）は、#47ではOrchestratorの運用Metadataでしたが、#48（D83）で `AI_ACTION_INVALID` / `AI_FALLBACK_USED` としてEvent Logに残すように置き換えました。2つのEventは、OrchestratorがEngineの `recordAiEvent`（手番のPlayerの記録だけを受け付け、seqとVisibilityを付ける）で作り、その手番のActionより前に追記します（Actionで `HAND_FINISHED` まで進むと、その後ろへは追記できないため）。

#### Event の形の版（schema_version）

保存した Event は、後から Engine の `HandEvent` の形が変わっても読み出せる必要があります（Replay・Review は保存済み Event だけを使う。D38）。方針は次のとおりです（D76）。

- `events` の行ごとに、payload の形の版 `schema_version` を持ちます。現在の版は `4`（`apps/server/src/sqlite-event-store.ts` の `EVENT_SCHEMA_VERSION`）です。
  - 版 1: Phase 1（単一Pot）。`POT_AWARDED` に `potIndex`・`eligible` が無い
  - 版 2: `POT_AWARDED` をPotごとに発行し、`potIndex`・`eligible` を持つ（D78）。版 1 の行は読み込み時に `apps/server/src/event-upcast.ts` の `upcastV1ToV2` で補います（`potIndex` は 0、`eligible` はその時点でFoldしていないPlayer。版 1 は単一Potなので、Main Potとして読めば版 2 のEngineが発行する形と一致します）
  - 版 3: `HAND_STARTED` に `reopenRule` を持つ（D79・D81）。版 1・2 の行は読み込み時に（版 1 は `upcastV1ToV2` の後で）`upcastV2ToV3` が `reopenRule: cumulative_full_raise` を補います。`reopenRule` は Event の畳み込み（State 遷移）に使わず Legal Action の計算だけに使うので、保存済み Event の再生結果は変わりません。また版 2 までの Server は全員同じ Stack で Hand を始めるため、最高額を上げる All-in は 1 Street に 1 回までで、累積と単発の Reopen 判定は一致します
  - 版 4: `AI_ACTION_INVALID` / `AI_FALLBACK_USED` を足す（D83）。既存のEventの形は変えていないので、版 3 の行は変換せずに読みます（版 1〜3 の行にこの 2 種類はありません）。版 3 の行を版 2 → 3 の変換に通すと保存した `reopenRule` を上書きするため、変換は版 3 未満の行にだけ通します
- 読み出しは現在の版と upcast を持つ旧版だけを受け付け、知らない版の行は `UnsupportedEventSchemaError` で失敗させます。旧形式を黙って新形式として扱いません（例: `oddChipRule` の無い旧 `HAND_STARTED` を、既定値で補って別の結果を再生しない）。
- 互換の無い形の変更（必須項目の追加・意味の変更）をするときは版を上げ、旧版の行を読み込み時に新しい形へそろえる変換（upcast）を同じ PR で足します。保存済みの行は書き換えません（append-only）。任意項目の追加など、旧版の読み手が誤らない変更は版を上げません。

Phase 1で扱えなかった状態（D70）は、Eventを発行せずにEngineが `unsupported_state` エラーを返していました（`side_pot`: All-inした額を他のPlayerのCommitが超える）。Side Potを#31で実装したため、このエラーは無くなりました（D78）。Split Potの端数もD75で実装済みです。

## 4. Visibility

Card / Observation EventにはVisibilityを明示します。

```ts
type Visibility =
  | { type: "public" }
  | { type: "private"; playerId: string }
  | { type: "learning_only" }
  | { type: "engine" }
  | { type: "system" };
```

`engine` はEngine内部専用で、Deckの順序（未来のCard）のようにどのPlayerにも見せない情報に付けます。`system` は卓の外の運用記録（CPUの不正な出力・Fallbackの利用。D83）に付け、CPUの出力の値を含みうるので、Hero・CPU（記録されたCPU本人を含む）のどのProjectionにも入れません。読むのはServer（Debug・Reviewの集計）だけです。Engineが発行するのは `public` / `private` / `engine` / `system` で、`learning_only` はReviewのRevealを実装するときに使います。

これにより以下を再構築できます。

- Heroが当時何を知っていたか
- 各CPUが当時何を知っていたか
- Reviewで何を学習用に開示できるか

## 5. KnowledgeState Projection

`KnowledgeState` はglobal Event Storeそのものではなく、PlayerごとのProjectionです。

Phase 1 Engineでは、`public` と自分宛ての `private` のEventだけを畳み込んで作ります（`packages/engine/src/projection.ts` の `projectHeroView` / `projectKnowledgeState`）。`engine`・`system` と他者宛ての `private` は読みません。

`apps/server`は、CPUへそのCPUの`KnowledgeState`（`projectKnowledgeState`の結果）とLegal Actionだけを渡し（`OpponentAgent.decide({ knowledge, legal })`。#46）、APIの応答とSSEには`projectHeroView`の結果だけを載せます（D71・D73）。`KnowledgeState`はHeroViewと違いEventのログを持たず、自分のHole Cards・Position・Public Actionの履歴・決定論のMath（Call額・Pot Odds・有効Stack・SPR）を持ちます（中身は`docs/03` §5）。他PlayerのHidden Cards・Deck（未来のCard）・`engine` VisibilityのEventが入らないことは、全席・全手番のProperty Testで確かめます（INV-TEST-007。見えないEventの中身を差し替えても`KnowledgeState`が変わらないことも確かめます）。

含めるもの:
- Public Table State
- 自分のHole Cards
- Public Action History
- 自分が観察したShowdown
- 自分が取得した過去Observation / Hypothesis
- 自分自身のInternal State

Learning-only Revealを読み込んで構築してはいけません。

## 6. Opponent Observation

Observationの事実と、そこからの解釈を分けます。

例:

```yaml
observer_player_id: cpu_ken
subject_player_id: hero
source_hand_id: hand_123
evidence:
  - river_bet_75pct
  - showed_bluff
interpretation: bluff_frequency_may_be_high
confidence: low
```

AIが過去に書いた自然言語だけを正本にしないでください。

## 7. User Learning Hypothesis

例:

```yaml
id: hyp_001
type: river_bluff_catch_overcall
supporting_action_ids: [...]
counter_evidence_action_ids: [...]
sample_size: 6
confidence: medium
status: improving
```

自然言語Player ProfileはこのEvidence Layerから派生させます。

## 8. Review Record

Reviewは「構造化された根拠」と「説明文」の両方を保存します。

最低限:

- Review Version
- Created At
- Target Hand / Action / Session
- Model Role
- Concrete Model
- KB Version
- Solver Adapter / Version
- Assumptions
- Math Evidence IDs
- Solver Evidence IDs
- User Read IDs
- Assessment
- Confidence
- Explanation

過去Reviewを上書きしてはいけません。

## 9. Replay Metadata

Replayそのものは保存済みEventだけで再生します。

Best-effortなDebug / Re-analysis用Metadata:

- RNG Seed
- Deck Order Hash
- Rule Profile Version
- App Version
- Model Role / Version
- AI Request / Response
- CPU Profile Version / Snapshot

これらを保存しても、完全なRe-simulationを保証するものではありません。

## 10. Auto Save境界

**Completed Hand**を安定したRecovery Boundaryとします。

`HAND_FINISHED` 時に:

- Hand Events保存
- Session Projection保存
- Stack保存
- 必要なMemory Update保存

アプリがHand途中で終了した場合、直前のCompleted Hand終了時点から再開できればMVPとして十分です。

Action単位の完全Crash RecoveryはMVPで過剰実装しません。

### Phase 1 の保存（Issue #20。D62・D72）

- 保存先は SQLite（`node:sqlite`）で、`apps/server` だけが扱います。DB ファイルは環境変数 `POKER_DB_PATH`（`:memory:` も可）で変えられ、既定は `apps/server/data/poker.sqlite`（gitignore 済み）です。
- テーブルは `sessions`（`session_id`・`started_at`）/ `hands`（`hand_id`・`session_id`・`started_at`・`finished_at`）/ `events`（`event_id`・`hand_id`・`seq`・`type`・`schema_version`・`recorded_at`・`payload`）です。`payload` は Engine の `HandEvent` をそのまま入れた JSON 列で、`(hand_id, seq)` は一意です。`events` の UPDATE は Trigger で拒否します（append-only。削除は §11 の Reset と一緒に設計する）。
- マイグレーションは自前の小さな仕組みで、SQL の配列（`apps/server/src/db/database.ts` の `MIGRATIONS`）を `PRAGMA user_version` より新しい分だけ 1 版ずつトランザクションで当てます。アプリより新しい版の DB は開きません。
- Hand 途中の Event はメモリに持ち、`HAND_FINISHED` を追記した時点で、その Hand の全 Event と `hands` の行（その Session の最初の Hand なら `sessions` の行も。`started_at` はその Hand の開始時刻）を 1 トランザクションで書きます。再起動すると途中の Hand は消え、終わった Hand だけが残ります。終わった Hand への追記は拒否します。
- Session（#35・D80）は Hand Orchestrator が決め、Hand の最初の追記で Event Store へ渡した Session ID が `hands.session_id` に入ります（テーブル・列・Event の形は変えていない）。Session の最初の Hand は均等 Stack で始め、2 Hand 目以降は前 Hand の `HAND_FINISHED` の `stacks` を持ち越します（席と Button は `HAND_STARTED` に残る）。Hero の Bust か、残りが Hero だけになったら Session を終え、次の Hand は新しい Session になります。Session の終了を表す Event（`SESSION_ENDED` 等）・Session Projection・Memory Update はまだ保存しません。Session の状態は最後の Hand の `HAND_STARTED`・`HAND_FINISHED` から作り直せます。再起動後の Session の再開（Resume）は Phase 5 の範囲で、再起動すると新しい Session から始まります。

## 11. Reset Semantics

### Learning Reset

削除:
- User Hypothesis
- Ability Score
- Generated Player Profile

Hand Historyは別指定がない限り保持します。

### Opponent Memory Reset

CPUのPersistent Observation / Hypothesisを削除します。

### Hand History Delete

Hand / Session Historyと派生Projectionを削除します。

### Factory Reset

アプリ本体・Asset以外のLocal User Data / Configを初期化します。
