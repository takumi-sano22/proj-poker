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

Hand Summaryと、Reviewの入力の元になる判断時点のHero Information Setは、Engineの`packages/engine/src/hand-summary.ts`がEvent Logから作ります（#78。保存しない派生）。

- `projectHandSummary(events, heroId)`: Hand Summary（席と開始Stack・終わり方〔`complete` / `aborted` / `in_progress`〕・Board・Potごとの配分・Showdownで公開された札・最終Stack・Heroの収支・Heroの判断の一覧・Important Spot）。Heroに見えるEventだけから作ります。例外として、打ち切り（`HAND_ABORTED`はsystem Visibility）だけはHero自身の選択なので`aborted`として読みます（Replayと同じ。D95）。
- `heroDecisions` / `heroInformationSets(events, heroId)`: Heroの`ACTION_TAKEN`ごとの判断と、その判断時点のInformation Set。判断時点は、そのActionの直前に続くHero自身の操作（宣言・Chipの操作・裁定。`no_action`の後の選び直しを含む）を除いた、その前のHeroに見えるEvent（`decisionPointSeq`）です。判断時点までのEventを先に切り出してからHeroに見えるEventだけを畳み込み、HeroのKnowledgeState（`projectKnowledgeState`と同じwhitelist）を作るので、判断より後のEvent（その後のBoard・Showdown・配分）・他者のHidden Cards・`engine` / `system`のEventは入りません（不変条件3。全判断のProperty Testで確かめる）。Out-of-Turnで保留した操作は手番より前の公開の出来事として判断時点の情報に残り、手番での拘束の裁定（`out_of_turn_binding`）は判断の`rulingNotes`に入ります。HeroのUser Read（`USER_READ_RECORDED`。§3・D112・#115）は、判断時点を探すときにHero自身の操作と同じく飛ばします（読みは卓の状態を変えないので、読みの有無で`decisionPointSeq`・`KnowledgeState`・Replayの飛び先は変わりません）。そのうえで、その判断の`ACTION_TAKEN`より前にHeroが記録した読み（手番の間に記録した直前の読みと、それより前の判断の前の読み）を、判断時点の情報として`userReads`（`seq`・Street・対象の席・本文）に入れます。判断より後に記録した読みは入りません。読みは`events`（判断時点の卓のEvent）には入れず、`userReads`だけを通します。
- `extractImportantSpots(sets, rules)`: Important Spotを判断時点のInformation Setだけから決定論で選びます（結果を見ない）。理由は`big_pot`（判断時点のPotが`bigPotBb`＝20BB以上）・`all_in`（HeroがAll-in、またはAll-inした相手がいてCallが要る）・`river_big_bet`（RiverでPot Odds が`riverBigBetMinPotOdds`＝0.3以上＝3/4 Pot以上のBetに直面）・`ruling`（Heroの操作に理由つきの裁定が入った）です。しきい値は`DEFAULT_IMPORTANT_SPOT_RULES`の暫定値で、永久仕様にしません。

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
- `HAND_METADATA_RECORDED`（Handごとの Best-effort Metadata。§9）

内部実装でEventを統合しても構いませんが、必要な情報を後から復元できることが条件です。

### Engine の Event 構成（`packages/engine/src/hand-events.ts`）

Phase 1（D70）で作り、Phase 2 の Side Pot（#31・D78）で `POT_AWARDED` をPot単位にし、Short All-in の Reopen（#32・D79）で `HAND_STARTED` に `reopenRule` を足し、Phase 3 で CPU の判断の経緯（`AI_ACTION_INVALID` / `AI_FALLBACK_USED`。#48・D83）を、Phase 4 で Hero の宣言・物理的なChipの操作・Dealerの裁定（`PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING`。#64・D90）を、Phase 5 で Session の開始・終了・Handの打ち切り・Emergency Botへの切り替え（`SESSION_STARTED` / `SESSION_ENDED` / `HAND_ABORTED` / `EMERGENCY_BOT_ENGAGED`。#77・D95）と、Handごとの Best-effort Metadata（`HAND_METADATA_RECORDED`。#97・D100）を、Phase 6 で Hero の User Read（`USER_READ_RECORDED`。#115・D112）を、Phase 8 で Tournament の Session の設定の Snapshot（`SESSION_STARTED` の `tournament`。#183・D129）と Hand の Ante・Level（`HAND_STARTED` の `ante`・`tournament` と `ANTE_POSTED`。#184・D128）を足した、1 Hand進行で発行するEventです。Sessionの開始・終了も、そのSessionの最初・最後のHandのEvent Logに置きます（`events` は Hand ごとの表のまま）。上の一覧のうち、統合したものは「統合元」に書きます。Eventは `seq`（Hand内の通し番号・0始まり）と `visibility` を持ち、Stateは `foldHandEvents`（Eventの畳み込み）だけで作ります（D37）。`event_id`・時刻・`session_id` は永続化する側（`apps/server`）が付けます（EngineはI/Oと時刻を持たない）。

| Event | 主な項目 | Visibility | 統合元・備考 |
|---|---|---|---|
| `HAND_STARTED` | `handId`・`ruleProfile`・`smallBlind`・`bigBlind`・`oddChipRule`（Split Potの端数の配り方。D75）・`reopenRule`（Short All-inの後のRaiseの再開規則。D79・D81）・`seats`（席順の `playerId` / `stack`）・`buttonPlayerId`・`ante`（任意。Anteの種類と額 `{ kind: per_player / big_blind_ante, amount }`〔#184・D128〕。`amount`はper_playerは1人分、big_blind_anteはBBの席が払う額。AnteのないHand〔Cash・Anteなし・版 9 までの行〕は項目ごと持たず、Anteなしとして読む）・`tournament`（任意。TournamentのHandの開始時のLevelと経過 `{ level, handNumber, playTimeMs }`〔#184・D128〕。`level`は1始まりのLevel、`handNumber`はSessionの何Hand目か〔論理順序。D117〕、`playTimeMs`はこのHandの開始までのプレイ時間の累計〔前のHandまでの「Handの開始から終わりまで」の長さの合計。Handの間・アプリを閉じていた時間は数えない〕。CashのHandは項目ごと持たない） | public | `BUTTON_ASSIGNED`。次のHandとResumeのLevelは、前のHandの `tournament` とそのHandのプレイ時間から作り直す（`docs/03` §1 の Session の mode） |
| `DECK_SHUFFLED` | `seed`（積んだDeckならnull）・`deck`（配布順の52枚） | engine | 未来のCardを含むため、どのPlayerのProjectionにも入れない。§9のRNG Seedに相当 |
| `BLIND_POSTED` | `playerId`・`blind`（small / big）・`amount` | public | Stackが足りなければStack全額（per_playerのAnteで尽きたら0）。Anteは `ANTE_POSTED` |
| `ANTE_POSTED` | `playerId`・`amount` | public | Anteの支払い（#184・D128）。Dead Moneyで、Call / Raiseの額（そのStreetのCommit）とUncalledの返却に数えない。per_playerは `DECK_SHUFFLED` の直後・Blindより前に、Buttonの左から全員が1つずつ置き（Stackが足りなければStack全額。AnteとBlindの両方に足りなければAnteが先）、各自の拠出としてPotの段（Side Potの境目）に入る。FoldしたPlayerのAnteは返さない（FoldしていないPlayerの誰のCommitも超える分は最後のPotに入る）。big_blind_anteはBBの `BLIND_POSTED` の直後にBBの席が1つ置き（Blindの残りのStackで払う。0なら置かない）、誰のCommitにも数えないMain PotのDead Moneyになる（Main Potに足し、Side Potの段は変えない）。Anteの無いHandには現れない |
| `HOLE_CARD_DEALT` | `playerId`・`cards`（2枚） | private(playerId) | 1 Player 1 Event |
| `ACTION_TAKEN` | `playerId`・`street`・`action`（fold / check / call / bet / raise / all_in）・`amount`（出した額）・`toAmount`（そのStreetの累計）・`allIn` | public | `PLAYER_FOLDED`・`PLAYER_ALL_IN`・`CHIPS_MOVED`（Bet分） |
| `BOARD_DEALT` | `street`（flop / turn / river）・`cards` | public | Burn は省く（`CARD_BURNED` は発行しない） |
| `CARDS_TABLED` | `playerId`・`cards` | public | `SHOWDOWN_STARTED`。River後か、All-inでBettingが終わった時点で、Foldしていない全員が公開する |
| `UNCALLED_BET_RETURNED` | `playerId`・`amount` | public | `CHIPS_MOVED`（返却分）。Betting Roundの終わりに、そのStreetで最も多く出したPlayerの2番目を超える分（Fold決着のBet・Short All-inを超えたBet・Stack不足のBlindを超えたBlind）を返す |
| `POT_AWARDED` | `potIndex`（0がMain Pot、1以降がSide Pot）・`potTotal`・`eligible`（そのPotを争えるplayerId。Buttonの左から時計回りの順）・`awards`（`playerId` / `amount`）・`showdown`（札を比べたか。争えるPlayerが1人のPotはfalse） | public | Potごとに1つ、Main Potから順に発行する（D78）。Σ`awards` = `potTotal`。同着の端数は `oddChipRule` に従って配分済みの額が入る（D75） |
| `HAND_FINISHED` | `stacks`（`playerId` / `amount`） | public | §10のRecovery境界 |
| `PLAYER_DECLARED` | `playerId`・`street`・`declaration`（`{ kind: fold / check / call / all_in }` か `{ kind: bet / raise, amount? }`。`amount` はそのStreetの累計＝to額で、省略するとChipの量で決める） | public | Heroの口頭の宣言（`docs/02` §4の `Declare`）。1宣言1 Event。卓のState（Chip・手番）は変えない |
| `PHYSICAL_CHIP_ACTION` | `playerId`・`street`・`motion`（`chip_push`: 最初の動作 / `chip_add`: 2回目以降）・`chips`（出したChipの額面の列） | public | HeroがChipを出した1回の動作（`ChipPush` / `ChipAdd`）。Chipが動くのは裁定の後の `ACTION_TAKEN` で、このEventは卓のStateを変えない |
| `DEALER_RULING` | `playerId`・`street`・`basis`（`operations`: 直前に同じ追記で置いた操作のEvent / `pending_out_of_turn`: 保留していたOOTの操作）・`outcome`（`action` / `out_of_turn` / `no_action`）・`action`（`outcome` が `action` のときのCanonical Action。それ以外は `null`）・`notes`（裁定の理由 `RulingCode`。`docs/02` §4） | public | Dealerの正式裁定（`docs/02` §8のRULING）。`action` なら直後のEventが同じPlayerのその `ACTION_TAKEN`（同じ追記）。`out_of_turn` は手番を正しいPlayerへ戻して警告し、操作を保留する（Engineの手番は変えない）。保留はそのPlayerの手番が来た時点の `pending_out_of_turn` の裁定で消え、拘束なら `action`、撤回なら `no_action`（`out_of_turn_released`）。卓のState（Chip・手番）は変えない |
| `AI_ACTION_INVALID` | `playerId`・`attempt`（何回目の要求の出力か。1始まり、2はCorrection付きの再要求）・`stage`（schema / legal_action / amount_range）・`reason`（不正と判定した理由） | system | CPUの出力を検証で不正と判定した記録（D41・D83。Retryで正常に戻った不正も残す）。その手番の `ACTION_TAKEN` より前に置く。`reason` はCPUの出力の値を含みうる。卓のState（Chip・手番）は変えない |
| `AI_FALLBACK_USED` | `playerId`・`fallbackKind`（`automatic`: Retryの後も不正だったときの自動Fallback〔D41〕/ `emergency_bot`: 障害の後にユーザーが選んだEmergency Bot〔D86・#52。そのCPUの手番ごとに置き、`reason`はきっかけの障害の種類〕）・`reason` | system | CPUの判断の代わりにBotの判断を使った記録（`docs/03` §6のFlag）。直後のEventが、同じPlayerのFallbackで決めた `ACTION_TAKEN`（同じ追記で置く）。卓のStateは変えない |
| `SESSION_STARTED` | `sessionId`・`tournament`（任意。TournamentのSessionの設定のSnapshot〔#183・D129〕: `presetId`・`version`・`startingStack`・`tableSize`〔参加人数＝卓の人数。入賞の数はこれ以下〕・`levels`〔Levelごとの`smallBlind` / `bigBlind` / `ante`〕・`schedule`〔`{ kind: hand_count, handsPerLevel }`か`{ kind: time_base, levelDurationMs }`〕・`anteKind`〔`none` / `per_player` / `big_blind_ante`〕・`payout`〔`{ kind: percentages, percentages }`。1位から順の整数の%〕・`entryFee`〔pt〕。cashのSessionは項目ごと持たない） | system | Sessionの開始（D95）。`tournament`の無い`SESSION_STARTED`はcashのSessionとして読みます（mode を指定しないSession・#183より前の行。`packages/engine/src/tournament.ts`の`sessionSettingsOf`）。同じSessionの2 Hand目以降とResumeはこのSnapshotで続けます（Presetを後で変えても、始めたTournamentは変わらない）。Snapshotは`recordSessionEvent`が検証してから置きます。Sessionの最初のHandの、開始のEvent（`startHand` の結果）に続けて同じ追記で置く（Sessionの最初のHandは全員が均等Stackで始まるので、開始の時点では終わっていない）。席・Stack・Buttonは `HAND_STARTED` に残る。CPUのPersonaは入れない（他CPUのSecret Persona。§10のSession Projectionに置く）。卓のStateは変えない |
| `SESSION_ENDED` | `sessionId`・`reason`（`hero_busted` / `hero_last_standing` / `ai_outage`） | system | Sessionの終了（D80・D86・D95）。Sessionの最後のHandの終わり（`HAND_FINISHED` か `HAND_ABORTED`）の直後に同じ追記で置く。Handの終わりより後ろに置ける唯一のEvent。卓のStateは変えない。TournamentのSessionでは、`hero_busted` / `hero_last_standing` がTournamentの終了（D129）、`ai_outage` は終える前の打ち切り（下の「TournamentのElimination・終了と順位」） |
| `HAND_ABORTED` | `reason`（`ai_outage`: CPUの障害のダイアログでHeroがSession終了を選んだ） | system | Handの打ち切り（D95。D88のEvent化）。`HAND_FINISHED` の代わりにHandを終える（Stateは `complete` になり、手番は無くなる）。Potは配分せずChipは動かさない（Sessionも一緒に終えるので、Stackを次のHandへ持ち越さない）。直後に `SESSION_ENDED`（`ai_outage`）を同じ追記で置く |
| `EMERGENCY_BOT_ENGAGED` | `playerId`・`cause`（きっかけの障害の種類: `timeout` / `unauthenticated` / `usage_limit` / `error`） | system | 障害の後にHeroがEmergency Botを選んだ記録（D86・D95。D88のEvent化）。障害で止まったそのCPUの手番に置く。そのCPUはSessionの終わりまでRuleBotで動き、手番ごとの記録は `AI_FALLBACK_USED`（`emergency_bot`）。内部のエラー本文は入れない。卓のStateは変えない |
| `HAND_METADATA_RECORDED` | `appVersion`（`apps/server` の `package.json` の `version`）・`ruleProfileVersion`（`HAND_STARTED` の `ruleProfile` と同じ値）・`cpuProfileVersion`（Personaの Preset 一式の版。Persona Profile Version）・`cpuSeats`（そのHandに座ったCPUの席順の `playerId` / `provider`〔`rule_bot` / `claude` / `emergency_bot`〕/ `modelRole`〔`claude` のとき `opponent_fast`。それ以外は null〕/ `model`〔Model Roleを role-based config で解決した具体モデル名。`claude` 以外は null〕） | system | Handごとの Best-effort な Debug / Re-analysis 用 Metadata（§9・#97・D100）。Engineの `startHand` に `metadata` を渡したときだけ、`HAND_STARTED` の直後（seq 1）に置く（Handが開始直後に終わる場合もHandの終わりより前に置けるよう、開始の Event の中に置く）。Hero は `cpuSeats` に入れない。どのCPUにどのPersonaを割り当てたかは入れない（他CPUのSecret Persona。割り当ては§10のSession Projectionに置く）。Emergency Botを選んだCPUは次のHandから `emergency_bot` になり、Handの途中の切り替えは `EMERGENCY_BOT_ENGAGED` に残る。AIのRequest / Responseの生データは入れない（D100）。Replay・Reviewの入力には使わない。卓のStateは変えない |
| `USER_READ_RECORDED` | `playerId`（記録したPlayer＝Hero）・`street`・`targetPlayerId`（読みの対象の席。このHandの`playerId`で、永続のIdentityではない。相手を特定しない読み・Hero自身の意図は`null`）・`text`（前後の空白を除いた1〜200字） | private(playerId) | HeroのUser Read（判断の前の読み・意図。D33・D105・D112・#115）。Hand の途中の、記録するPlayerの手番の間だけ置ける（Engineの`recordUserRead`が判定する）。卓のState（Chip・手番）は変えない。CPUの`KnowledgeState`・他者のProjection・Stats（`publicEvents`）・Learning-only Revealには入らない。判断時点の扱いは§1 |

Phase 1の`apps/server`（Issue #18）は、Engineが返したEventをEvent Store（`apps/server/src/event-store.ts`）へそのまま追記し、保存時に`eventId`（UUID）と`recordedAt`（ISO 8601・UTC）を付けます。Event Storeはappend-onlyで、先頭のseqがそのHandの保存済み件数と一致し連番である追記だけを受け付けます（`HAND_FINISHED`の後ろへの追記も拒否します）。起動時はSQLiteの実装（Issue #20。§10の「Phase 1 の保存」）を使い、メモリ内の実装はテスト用です。CPUの不正な出力と、RuleBotの判断で続けたFallbackの記録（`docs/03` §5）は、#47ではOrchestratorの運用Metadataでしたが、#48（D83）で `AI_ACTION_INVALID` / `AI_FALLBACK_USED` としてEvent Logに残すように置き換えました。2つのEventは、OrchestratorがEngineの `recordAiEvent`（手番のPlayerの記録だけを受け付け、seqとVisibilityを付ける）で作り、その手番のActionより前に追記します（Actionで `HAND_FINISHED` まで進むと、その後ろへは追記できないため）。

Heroの物理的な操作（#64・D90・D91）は、Engineの `applyPhysicalActions`（Ruling Engineで裁定し、操作ごとの `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION`、`DEALER_RULING`、決まった `ACTION_TAKEN` とそこから自動で進むEventまでを1つの結果で返す）で作り、Orchestratorが1回で追記します。手番でない操作（Out-of-Turn）は `DEALER_RULING`（`out_of_turn`）で保留し、Heroの手番が来た時点でOrchestratorがEngineの `resolvePendingOutOfTurn` で拘束か撤回かを裁定します。保留中かどうかはEventの畳み込み（Stateの `pendingOutOfTurn`）だけで分かるので、「警告 → 間のAction → 拘束 / 撤回」はEventの並びから復元できます（Replay #68の前提）。

Sessionの開始・終了・Handの打ち切り・Emergency Botへの切り替え（#77・D95）は、OrchestratorがEngineの `recordSessionEvent`（置ける時点を検査し、seqとVisibilityを付ける。`SESSION_STARTED` / `HAND_ABORTED` はHandの途中、`EMERGENCY_BOT_ENGAGED` はそのCPUの手番、`SESSION_ENDED` はHandが終わった後）で作ります。4つともsystem Visibilityで、HeroのView・CPUの `KnowledgeState`・Replayには入りません（Heroへは `SessionStatus` をAPIが別に返す。`docs/03` §1）。`SESSION_ENDED` は、Handを終える追記（`HAND_FINISHED` を含むActionの結果、または打ち切り）の時点でSessionの終わりを判定して同じ追記に足します（`HAND_FINISHED` の `stacks` から `nextHandSeating` でHeroのBust / 残りがHeroだけを判定する）。Event Storeは、Handの終わりの後ろには同じ追記の `SESSION_ENDED` 1つだけを受け付けます。

TournamentのElimination・終了と順位（#185・D108・D129）は、新しいEventを足さず、既存のEventから読みます（同じ事実の二つ目の表現をEvent Logに置かない。版 9・10 で保存したTournamentも同じ経路で読めるので、版は 10 のまま）。
- **Elimination**: TournamentのSession（`SESSION_STARTED` に `tournament` を持つSession）のHandで、`HAND_STARTED` の `seats` に座っていて `HAND_FINISHED` の `stacks` が 0 になったPlayerが、そのHandでBustした（Bust = Elimination。D108）Playerです。Bustした席は次のHandに座りません（`nextHandSeating`。D80）。`HAND_ABORTED` で打ち切ったHandはChipを動かさないので、誰もBustしません
- **終了**: `SESSION_ENDED` の `hero_busted`（HeroのBust）/ `hero_last_standing`（Heroが最後の1人）がTournamentの終了です（`session_projections` の `end_reason` のCHECKは変えない。D129）。`ai_outage` は終える前の打ち切りで、残っていたPlayerの順位は決めません（OI-007の暫定Policy。`docs/02` §7）
- **順位**: Engineの `tournamentStandings`（`packages/engine/src/tournament-standings.ts`）が、SessionのHandのEvent Log（論理順序。D117）から都度計算します（保存しない。テーブルを足さない。D129）。BustしたPlayerの順位は「そのHandの後に残った人数 + 1」からで、同じHandで複数人がBustしたらHandの開始時のStack（`HAND_STARTED` の `seats` の `stack`）の多い方を上位、同じなら同順位にします（OI-007の暫定Policy。`docs/02` §7）。Heroが最後の1人（`hero_last_standing`）ならHeroが1位です。HeroのBustで終えたときに残っていたCPUの順位は、残りが1人（Heads-UpでHeroがBust）でも未決（`null`）です（D129）。Orchestratorは `tournamentStandingsOf(handId)` で、そのHandのSessionの終わったHand（`sessionHandIds`）から計算します

TournamentのPayoutとResult（#186・D108・D127・D129）も、新しいEvent・テーブルを足さず、既存のEventから都度計算します（版は 10 のまま）。
- **入力**: Prize Poolは `SESSION_STARTED` の `tournament`（設定のSnapshot）の `entryFee` × 参加人数（Sessionの最初のHandの `HAND_STARTED` の `seats` の人数）、割合は同じSnapshotの `payout` です。Presetを後で変えても、始めたTournamentのPayoutはSnapshotで計算します。順位は上の `tournamentStandings` です
- **Result**: Engineの `tournamentResult`（`packages/engine/src/tournament-payout.ts`）が、順位（`status`・`entrants`・`remaining`・`placements`）に、`entryFee`・`prizePool`・`payoutsByPlace`（順位ごとの賞金。合計はPrize Pool）・`payoutPolicyVersion`（端数・同順位の配り方の版）と、Playerごとの `payout`（pt。順位が未決なら `null`）を足して返します（規則は `docs/02` §7。端数・同順位・打ち切りの扱いはOI-007の暫定Policy）。PayoutはChipとは別の量で、Chipの総量の保存（INV-TEST-002 / 005）の対象ではありません。Orchestratorは `tournamentResultOf(handId)` で、`tournamentStandingsOf` と同じSessionの終わったHandから計算します

HeroのUser Read（#115・D112）は、Orchestratorの `heroUserRead`（API は `POST /api/hands/:handId/reads`。`docs/03` §1）がEngineの `recordUserRead` で作り、Hand の途中のHeroの手番の間だけ追記します。Heroの操作と同じく、clientが見ていた `lastSeq` より Log が進んでいれば `stale_view` で拒否するので、応答だけが失われた記録の再送で同じ読みを2回残しません。手番の間はCPUを動かしていないので、追記がCPUの手番の判断を古い手番として捨てさせることはありません。Event Storeは終わったHandへの追記を拒否するので、Hand が終わった後・Hero が Fold して手番が来ない間は記録できません（`docs/07` §8）。読みの当たり外れ（相手の札・CPU の Persona との照合）は返しません（D105）。HeroのViewの `log` には入り（進行ログ・Replay の step に Hero 自身の行として出る）、CPU には見えません。

Handごとの Metadata（#97・D100）は、OrchestratorがHandの開始時に組み立ててEngineの `startHand` に渡し、`HAND_STARTED` の直後の `HAND_METADATA_RECORDED` として開始の Event と同じ追記に入ります（§9）。system Visibilityなので、HeroのView・CPUの `KnowledgeState`（Opponent の Prompt の入力）・Replayの応答には入りません。Engineの `startHand` は `metadata` を省くとこの Event を置かないので、固定Scenario・Opponent EvalのSpotのEvent列は変わりません。

#### Event の形の版（schema_version）

保存した Event は、後から Engine の `HandEvent` の形が変わっても読み出せる必要があります（Replay・Review は保存済み Event だけを使う。D38）。方針は次のとおりです（D76）。

- `events` の行ごとに、payload の形の版 `schema_version` を持ちます。現在の版は `10`（`apps/server/src/sqlite-event-store.ts` の `EVENT_SCHEMA_VERSION`）です。
  - 版 1: Phase 1（単一Pot）。`POT_AWARDED` に `potIndex`・`eligible` が無い
  - 版 2: `POT_AWARDED` をPotごとに発行し、`potIndex`・`eligible` を持つ（D78）。版 1 の行は読み込み時に `apps/server/src/event-upcast.ts` の `upcastV1ToV2` で補います（`potIndex` は 0、`eligible` はその時点でFoldしていないPlayer。版 1 は単一Potなので、Main Potとして読めば版 2 のEngineが発行する形と一致します）
  - 版 3: `HAND_STARTED` に `reopenRule` を持つ（D79・D81）。版 1・2 の行は読み込み時に（版 1 は `upcastV1ToV2` の後で）`upcastV2ToV3` が `reopenRule: cumulative_full_raise` を補います。`reopenRule` は Event の畳み込み（State 遷移）に使わず Legal Action の計算だけに使うので、保存済み Event の再生結果は変わりません。また版 2 までの Server は全員同じ Stack で Hand を始めるため、最高額を上げる All-in は 1 Street に 1 回までで、累積と単発の Reopen 判定は一致します
  - 版 4: `AI_ACTION_INVALID` / `AI_FALLBACK_USED` を足す（D83）。既存のEventの形は変えていないので、版 3 の行は変換せずに読みます（版 1〜3 の行にこの 2 種類はありません）。版 3 の行を版 2 → 3 の変換に通すと保存した `reopenRule` を上書きするため、変換は版 3 未満の行にだけ通します
  - 版 5: `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING` を足す（D90）。既存のEventの形は変えていないので、版 4 の行も変換せずに読みます（版 1〜4 の行にこの 3 種類はありません）。DBのテーブル・列は変えていません
  - 版 6: `SESSION_STARTED` / `SESSION_ENDED` / `HAND_ABORTED` / `EMERGENCY_BOT_ENGAGED` を足す（D95）。既存のEventの形は変えていないので、版 5 の行も変換せずに読みます（版 1〜5 の行にこの 4 種類はありません）。版 5 までに保存したSessionには `SESSION_STARTED` / `SESSION_ENDED` もSession Projectionも無く、作り直しません（再起動後のResumeの対象にならない）。DBは §10 の `session_projections` を足しただけで、既存のテーブル・列・行は変えていません
  - 版 7: `HAND_METADATA_RECORDED` を足す（#97・D100）。既存のEventの形は変えていないので、版 6 の行も変換せずに読みます（版 1〜6 の行にこの種類は無く、Metadataを補って作り直しもしません）。DBのテーブル・列・行は変えていません
  - 版 8: `USER_READ_RECORDED` を足す（#115・D112）。既存のEventの形は変えていないので、版 7 の行も変換せずに読みます（版 1〜7 の行にこの種類はありません）。`events` のテーブル・列・行は変えていません（Note / Tag のテーブルはマイグレーション v5 で別に足した。§12）
  - 版 9: `SESSION_STARTED` に `tournament`（TournamentのSessionの設定のSnapshot。cashのSessionは項目を持たない）を足す（#183・D129）。版 8 までの `SESSION_STARTED` は `tournament` を持たず、版 9 のcashのSessionと同じ形なので、版 8 の行は変換せずに読み、cashのSessionとして読みます（`sessionSettingsOf`）。D129（Eventの形を変えるときは版を上げる）に従って版を上げたので、版 8 までの読み手は版 9 の行を読めない版として拒否します（TournamentのSessionを黙ってcashとして読まない）。`events` のテーブル・列・行は変えていません
  - 版 10: `HAND_STARTED` に `ante`（Anteの種類と額）・`tournament`（TournamentのHandの開始時のLevelと経過）を、Eventの種類に `ANTE_POSTED` を足す（#184・D128・D129）。AnteのないHand（Cash）・TournamentでないHandは両方の項目を持たず、版 9 と同じ形です。版 9 までの `HAND_STARTED` は `ante` を持たず、版 9 までの行に `ANTE_POSTED` は無いので、版 9 の行は変換せずに読み、Anteなし（none）のHandとして畳み込みます（Engineの `initialState` は `ante` の無い `HAND_STARTED` をAnteなしとして読む。upcastの関数は足さない）。版 9 で保存したTournamentのHand（#183。`tournament` を持たない）の次のHandのLevelは、OrchestratorがSessionの終わったHandの数（論理順序）をHandの番号とし、プレイ時間0から作ります。D129（Eventの形を変えるときは版を上げる）に従って版を上げたので、版 9 までの読み手は版 10 の行を読めない版として拒否します（AnteのあるHandをAnteなしとして黙って再生しない）。DBのテーブル・列・行は変えていません
  - #185（TournamentのElimination・終了と順位）は既存のEvent（`HAND_FINISHED` の `stacks`・`SESSION_ENDED`）から読み、Eventの形を変えていないので版は 10 のままです（上の「TournamentのElimination・終了と順位」）
  - #186（TournamentのPayoutとResult）は既存のEvent（`SESSION_STARTED` の `tournament` と、#185と同じEvent）から読み、Eventの形を変えていないので版は 10 のままです（上の「TournamentのPayoutとResult」）
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

`engine` はEngine内部専用で、Deckの順序（未来のCard）のようにどのPlayerにも見せない情報に付けます。Heroの宣言・物理的なChipの操作・Dealerの裁定（D90）は、実卓で全員が見聞きする事実なので `public` です。`system` は卓の外の運用記録（CPUの不正な出力・Fallbackの利用〔D83〕・Sessionの開始・終了などの運用〔D95〕・Handごとの Metadata〔#97〕）に付け、CPUの出力の値を含みうるので、Hero・CPU（記録されたCPU本人を含む）のどのProjectionにも入れません。読むのはServer（Debug・Reviewの集計）だけです。HeroのUser Read（`USER_READ_RECORDED`。#115）は、記録した本人だけの `private` です（Heroの主張で、卓の誰も見聞きしていない。CPUの `KnowledgeState`・Stats の `publicEvents` に入らないことを `packages/engine/src/user-read.test.ts` で確かめる）。Engineが発行するのは `public` / `private` / `engine` / `system` で、`learning_only` のEventは発行しません。Learning-only Full Reveal（Hand後に全員の札を見せる情報）はEventのVisibilityを増やさず、別のProjection `projectLearningReveal(events)`（`packages/engine/src/learning-reveal.ts`。#78）で作ります。Handが終わった（`HAND_FINISHED`か`HAND_ABORTED`）後だけ配られた全員の札を返し（進行中は`null`。Deckの残りは含まない）、値に`visibility: "learning_only"`の印を付けます。Hero View・CPUの`KnowledgeState`・判断時点のHero Information Set（Pass Aの入力）はこれを参照せず、そこでだけ見える札が入らないことをProperty Testで確かめます（INV-TEST-008に相当。CPU Memoryはまだ無いので`KnowledgeState`で確かめる）。

これにより以下を再構築できます。

- Heroが当時何を知っていたか
- 各CPUが当時何を知っていたか
- Reviewで何を学習用に開示できるか

**表示の状態は Event Log に入れない（#216・D139〜D141）**: 横断 UI/UX の演出のキュー・表示演出の速度・Hero の未確定の下書き（手に取った Chip・宣言の途中）・効果音の音量とミュートは client の表示状態・viewer の設定で、ゲームの正本ではないので Event に残しません（Event に残すのは今どおり確定して送った物理操作・裁定。D90）。演出は Hero の View と `public` の Event だけを使い、`private`（Hero 以外）・`learning_only`・`engine`・`system` を使いません。ETIQUETTE の確認（Ack）も Event に残しません（UX-11 #226・D145: Ack が要るかは `DEALER_RULING` の `notes` から導き、確認の位置は server の `HandRuntime` のメモリにだけ持つ。Event の版・DB・Session Projection は変えず、Replay は Ack を待たない。確認の前の再起動で待ちが消えるのは D62 の範囲。検証の記録: `docs/taskLog/issue-226-etiquette-ack-design.md`）。Hero から見た `seq` は連続しません（`engine`・`system`・他者宛ての `private` の分が抜ける）。演出・欠落の検出は seq の連続に頼らず、`HeroView.log` が毎回見える Event の全量を運ぶことに頼ります（UX-06 #221 の検証と人間承認 D143。seq の穴から system の記録の有無を間接推測できる既存の残余リスクは受容する。ただし UI で seq や欠番を表示・意味付けしない）。

## 5. KnowledgeState Projection

`KnowledgeState` はglobal Event Storeそのものではなく、PlayerごとのProjectionです。

Phase 1 Engineでは、`public` と自分宛ての `private` のEventだけを畳み込んで作ります（`packages/engine/src/projection.ts` の `projectHeroView` / `projectKnowledgeState`）。`engine`・`system` と他者宛ての `private` は読みません。

`apps/server`は、CPUへそのCPUの`KnowledgeState`（`projectKnowledgeState`の結果）とLegal Actionだけを渡し（`OpponentAgent.decide({ knowledge, legal })`。#46）、APIの応答とSSEには`projectHeroView`の結果だけを載せます（D71・D73）。`KnowledgeState`はHeroViewと違いEventのログを持たず、自分のHole Cards・Position・Public Actionの履歴・決定論のMath（Call額・Pot Odds・有効Stack・SPR）を持ちます（中身は`docs/03` §5）。Heroの操作への裁定があるHandでは、公開の `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING` から組んだ裁定の履歴（`rulingHistory`: 裁定ごとに、対象の操作・結果・Canonical Action・理由。保留したOOTとその拘束 / 撤回を含む。#64）も持ちます。裁定が1つも無いHandでは項目ごと持たず、CPUへの入力（Prompt）を変えません。HeroViewにはこれらのEventが `log` に入ります。他PlayerのHidden Cards・Deck（未来のCard）・`engine` VisibilityのEventが入らないことは、全席・全手番のProperty Testで確かめます（INV-TEST-007。見えないEventの中身を差し替えても`KnowledgeState`が変わらないことも確かめます）。

含めるもの:
- Public Table State
- 自分のHole Cards
- Public Action History
- 自分が観察したShowdown
- 自分が取得した過去Observation / Hypothesis
- 自分自身のInternal State

Learning-only Revealを読み込んで構築してはいけません。

Phase 7（#139・D121）: 過去のObservation / Hypothesisは、`apps/server`がEngineの`KnowledgeState`にそのCPU自身のMemoryの要約（`memory`。`OpponentInput.knowledge`の型は`CpuKnowledgeState`）として足します。EngineのProjection（`projectKnowledgeState`）はHandの中のEventだけを畳み込むままで、Memoryは保存済みのHandから作るので、Handの途中のEventはMemoryに入りません。形・作る時点・上限は§12「Memoryの注入（#139）」です。Memoryを作れないCPU（参加者の行が無いSession・Drill）では項目ごと持たず、CPUへの入力（Prompt）を変えません。

Phase 7（#140・D107）: 自分自身のInternal StateとしてのTiltは、`apps/server`がHandの開始時に今のSessionの保存済みのHandから作り、1以上のCPUだけ`KnowledgeState`に`tilt`として足します（0のCPU・Personaの無いCPU・Drillでは項目ごと持たず、Promptを変えない）。他のCPUのTiltは入りません。形と規則は§12「Tilt（#140）」・`docs/05` §4です。

Phase 7（#141・D106）: 卓全体の観察可能な傾向（Table Tendency）は、`apps/server`がHandの開始時に、今のSessionの、そのCPUが座っていた保存済みのHandのpublicのEventだけから作り、数えたHandが1以上のCPUだけ`KnowledgeState`に`tableTendency`として足します（Handが0のCPU・Drillでは項目ごと持たず、Promptを変えない）。個々のCPUのPrivate Observation / Hypothesis・Persona・Tiltは入りません。形と規則は§12「Table Tendency（#141）」・`docs/05` §5です。

Phase 8（#188・D109・D130）: Public Tournament Contextは、TournamentのHandでだけ`KnowledgeState`に`tournament`として足します（CashのHand・Drillでは項目ごと持たず、CPUへの入力〔Prompt〕を変えない）。Engineの`projectKnowledgeState(events, playerId, { tournament })`が、そのPlayerに見えるEvent（publicの`HAND_STARTED`）と、Sessionの設定のSnapshot・参加人数（`TournamentSessionInfo`。Hand OrchestratorがHandの開始時に`SESSION_STARTED`とSessionの最初のHandの`HAND_STARTED`から作る）だけから、`packages/engine/src/tournament-knowledge.ts`の`tournamentKnowledgeOf`で作ります（whitelist）。中身は残人数・参加人数・Level・Sessionの何Hand目か・Blind / Ante・Prize PoolとPayout・Stage・全席のStackとBB換算・ICM Equity（ptと%）・自分から見た相手ごとのBubble Factorで、ICMの数値は決定論のICM Calculator（`icm.ts`）が正本です（LLMに計算させない）。Hidden Cards・Deck・他CPUのMemory / Persona / Tilt・Learning-only Revealは入りません。形と規則は§12「Phase 8のTournament」・`docs/02` §7です。

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

Phase 7（D106）では、Observationは観察できたPublic / Showdown Evidenceだけを、provenance（Observer / Subject / Source Hand or Event / Visibility / Timestamp or Hand Number。`docs/02` INV-INFO-003）付きでappend-onlyに記録します。Learning-only Reveal・他者のHidden Cards・Future Cardsは入れません。Observerは永続の`cpuProfileId`（GuestはSessionの間だけのIdentity）で持ち、SubjectはHero・Fixed CPU・Guestのどれも表せる、席・player idに依存しない安定した参加者の参照で持ちます（形は#136・#137で決め、Phase 6のUser Note / TagのSubjectの参照と接続した。§12）。Hypothesis / TendencyはRaw Observationから再生成できるProjectionで、集計にrecency decayをかけます（Raw Observationは消さない）。Strategy HypothesisはCash / Tournamentのcontextごとに分けます。Guestの記録はSession終了時に破棄します。

D118で形を決めました（実装は#136・#137。テーブル・列の具体は§12。Identityは#136で実装）。

- **Identity**: マイグレーションv10で追記型の`session_participants`（Session×席 → Fixed CPUの`cpuProfileId`、またはGuestのSession限りのid）を足し、席・player idと永続Identityを分けます。Fixed Pool（`cpuProfileId`・名前・Persona）はDBに置かず、コードのVersion付きConfigに置きます（OI-005の暫定値）。席の編成はSessionの最初のHandのseedから決定論で決め、Resumeでは同じSessionの参加者を戻します（#136。列と編成の決め方は§12）。
- **Observation**: 正本はEvent Logで、Observationの正本となる別の表やEventは作りません。正本のEvent LogからそのObserverが見えたEvent（Publicと、自分が見たShowdown）だけを決定論で抽出します。provenanceは`hand_id`・`events.seq`・`ordinals.ord`で持ちます。Event Logがappend-onlyなので、Raw Observationもappend-onlyです。抽出は`apps/server/src/memory/observation.ts`（#137）で、正本はEvent Logです。#150の測定を受け、Handごとの抽出結果を作り直せる派生の表（マイグレーションv12の`observed_hand_cache`）にCacheします（D124・#165。§12「CPU MemoryのCache」）。Cacheは正本ではなく、消してもEvent Logから同じ結果を作り直せます。形と除外の規則は§12「Observation（#137）」です。
- **Guest**: IdentityがSession限りなので、次のSessionでは読みません（これを破棄とし、Event Logの行は消さない）。

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

実装（#114・D113）: Weakness Hypothesisは、マイグレーションv6の`hypothesis_snapshots`にSnapshotとして保存します。Pass Aの`reviews`から決定論で作り直せる派生データで、正本にしません（作り直しは全行の入れ替え。追記専用のTriggerは付けない）。

| 列 | 内容 |
|---|---|
| `hypothesis_id`（PK） | `<policy_version>/<type>` |
| `policy_version` | 計算した`HypothesisPolicy`のVersion（最初は`phase6_hypothesis_v1`。Ability Evidenceを作る`ScoringPolicy`のVersionもこれで決まる） |
| `type` | 判断の分類（Policyの中のVersion付きの一覧。OI-006の暫定値なのでCHECKで固定しない。一覧は`docs/07` §5） |
| `status` | `suspected` / `supported` / `strong` / `improving` / `resolved` / `insufficient_data`（D104。CHECK） |
| `supporting_evidence_ids` | Supporting EvidenceのID（Ability EvidenceのID `<hand_id>/d<判断の番号>/v<ReviewのVersion>`）のJSON配列（判断の順） |
| `counter_evidence_ids` | Counter EvidenceのID（同上）のJSON配列 |
| `computed_at` | 作り直した時刻（ISO 8601・UTC） |

上の例の`sample_size`はSupporting / Counterの件数の和、`confidence`は`status`（`insufficient_data`を含む）で表すので、列に持ちません。

自然言語Player ProfileはこのEvidence Layerから派生させます。

`status`の遷移はSupporting / Counter Evidenceから決定論で決め（D104）、LLMを正本にしません。

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

実装（#82・D95・D39）: マイグレーション v3 で `reviews` テーブルを足しました（既存のテーブル・行は変えない）。Pass A（Decision Review）の Review を Hero の判断ごとに Version 付きで追記し、`UPDATE` は Trigger（`reviews_append_only`）で拒否します。再生成は同じ Hand・判断・Pass の次の `version` の行で、`(hand_id, decision_index, pass, version)` は一意です（Version の採番と追記は 1 つの書き込みトランザクション）。`hand_id` は `hands` を参照するので、Review を作れるのは保存済みの Hand だけです。書き読みは `apps/server/src/review/review-store.ts`（`SqliteReviewStore`。DB は Event Store と共有）。

| 列 | 上の項目 | 中身 |
|---|---|---|
| `review_id` | — | UUID |
| `version` | Review Version | 同じ Hand・判断・Pass の中の版（1 から） |
| `created_at` | Created At | ISO 8601（UTC） |
| `hand_id`・`decision_index`・`action_seq` | Target Hand / Action | `decision_index` は Hero の判断の順番（`heroDecisions` の `index`）、`action_seq` はその `ACTION_TAKEN` の seq。Session は `hands.session_id` から引く |
| `pass` | — | `decision`（Pass A）。Pass B は別のテーブル `reveal_reviews`（下記） |
| `depth`・`model_role` | Model Role | `standard` → `review_standard`、`deep`（Hero が「詳しく」を選んだ Spot）→ `review_deep`（D97） |
| `concrete_model` | Concrete Model | 呼んだ具体モデル名。Evidence Sufficiency Gate で止めた（Review AI を呼んでいない）ときは NULL |
| `kb_version` | KB Version | Local KB 全体の Version（`apps/server/kb/manifest.json`） |
| `solver_version` | Solver Adapter / Version | `<id>@<version>+<commit>`。Supported の Solver Evidence を使わなかったときは NULL |
| `generated_by` | — | `review_ai`（Review AI の出力）/ `sufficiency_gate`（根拠不足で呼ばずに Insufficient Evidence）/ `invalid_output_fallback`（出力が 2 回続けて不正で Insufficient Evidence） |
| `assessment`・`confidence` | Assessment・Confidence | 6 段階（`docs/05` §8）と `low` / `medium` / `high` |
| `assumptions` | Assumptions | JSON の文字列の配列 |
| `evidence_ids` | Math / Solver / User Read Evidence IDs | JSON。渡した Evidence の ID を種類ごと（`context` / `math` / `range` / `solver` / `knowledge` / `userRead`、卓の傾向があるときだけ `tableTendency`、Tournament の Hand の判断だけ `tournament`）と、Review AI が根拠に挙げた ID（`cited`） |
| `explanation` | Explanation | JSON。`practical` → `theory`（`basis`: `solver` / `general_theory` / `none`）→ `exploit`（`basis`: `observation` / `none`）と `conclusionChangers`（何が変わると結論も変わるか） |
| `evidence` | （構造化された根拠） | Review AI に渡した Evidence そのもの（判断時点の情報だけ。`docs/05` §6） |
| `failure` | — | 出力の検証に失敗したときだけ。各回の段（`schema` / `grounding`）と理由 |

`evidence_ids.userRead` は、その判断の前にHeroが記録したUser Read（§3の `USER_READ_RECORDED`。#115）のID（`read:<handId>/<seq>`）です。読みの無い判断は空で、`evidence` の `userRead` は `not_collected` のままです（Review Interview〔`docs/05` §12〕で後から聞く経路はまだ無い）。`evidence_ids.tableTendency` は、`evidence` の Opponent Observation に入れた卓の傾向（§12「Table Tendency」・`docs/05` §6。D122・#153）の項目のID（`tendency:<handId>/d<判断の番号>/<項目>`）で、卓の傾向が入らなかった Review（#153 より前の Review を含む）には項目ごとありません。列・テーブルは足していません（JSON の中身だけ）。`evidence_ids.tournament`（#189）は、Tournament の Hand の判断の `evidence` の `tournament`（`docs/05` §6・§10。D109・D130）の ID で、公開の状況（`tournament:<handId>/d<判断の番号>`）・判断時点の ICM Equity（`icm:…`）と、All-in の関わる判断だけ相手ごとの Chip EV の必要 Equity（`chipev:…/<相手の playerId>`）と ICM の必要 Equity（`icmreq:…/<相手の playerId>`）です。Cash の Hand の Review と #189 より前の Review には項目ごとありません（列・テーブル・マイグレーションは足していない）。Claude の呼び出しの失敗（未ログイン・利用枠・Timeout 等）では行を作りません（生成の状態はサーバーのメモリにだけ持ち、再起動で消える）。

**Pass B と Follow-up（#83・D99）**: マイグレーション v4 で、追記だけのテーブルを 2 つ足しました。`reviews` を含む既存のテーブルの行・列の定義は変えていません（D76）。どちらも `UPDATE` と `DELETE` は Trigger で拒否し、`hand_id` は `hands` を参照します。追記専用を機械で守るため、v4 では既存の `events`（D37）と `reviews`（D39）にも `DELETE` を拒否する Trigger（`events_no_delete`・`reviews_no_delete`）だけを足しました（v1・v3 は `UPDATE` だけを拒否していた）。Reset / Hand History Delete（§11）を設計するときに、削除の経路と一緒にこの Trigger の扱いを決めます。書き読みは `apps/server/src/review/reveal-store.ts`（`SqliteRevealReviewStore` / `SqliteFollowUpStore`）です。

`reveal_reviews`（Reveal Review = Pass B。`docs/05` §7）: Hero の判断ごとに Version を付けて追記します（`(hand_id, decision_index, version)` が一意。Version の採番と追記は 1 つの書き込みトランザクション）。Pass B は判断時点の評価を付け直さないので、`assessment`・`confidence` の列を持ちません（結果論を判断の評価に混ぜない）。

| 列 | 中身 |
|---|---|
| `review_id`・`version`・`created_at`・`hand_id`・`decision_index`・`action_seq`・`depth`・`model_role`・`concrete_model`・`generated_by`・`failure` | `reviews` と同じ意味（`version` は同じ Hand・判断の Pass B の中の版） |
| `evidence_ids` | JSON。`context` / `reveal` / `equity` / `aggression` と、Review AI が根拠に挙げた ID（`cited`） |
| `explanation` | JSON。`readComparison`（読みと実際の比較）・`actualEquity`（実際の Equity）・`bluffValue`（Bluff / Value の答え合わせ）・`takeaways`（次に活かす点） |
| `evidence` | Review AI に渡した Pass B の Evidence。判断時点の卓（Pass A と同じ Decision Context）と、Hand 後に見せた全員の札（`visibility: "learning_only"`。Deck の残りは含まない）・判断時点に仮定した Range との比較・実際の Equity・Bluff / Value の答え合わせ |

`review_followups`（Follow-up Q&A）: Review の Version ごとに、質問と答えを 1 ターン 1 行で追記します（`(review_id, turn)` が一意）。`review_id` は `pass` が `decision` なら `reviews`、`reveal` なら `reveal_reviews` の行を指します。外部キーは 1 つのテーブルしか指せないので、挿入の Trigger（`review_followups_target`）で、指す行が実在し Hand・判断・Version が合うことを確かめます。

| 列 | 中身 |
|---|---|
| `followup_id` | UUID |
| `pass`・`review_id`・`review_version` | 質問の対象の Review（Pass と Version） |
| `hand_id`・`decision_index` | 対象の Review の Hand と判断 |
| `turn` | その Review の Version の中のターンの順番（1 から） |
| `created_at`・`depth`・`model_role`・`concrete_model` | `reviews` と同じ意味（Follow-up は必ず Review AI を呼ぶので `concrete_model` は NOT NULL） |
| `generated_by` | `review_ai` / `invalid_output_fallback`（答えが 2 回続けて不正。答えは `unanswered`） |
| `question` | Hero の質問（500 字まで） |
| `answer` | JSON。`scope`（`answered` / `out_of_scope` / `unanswered`）・`text`・`evidenceIds` |
| `failure` | 出力の検証に失敗したときだけ。各回の段と理由 |

Pass B・Follow-up でも、Claude の呼び出しの失敗では行を作りません。

## 9. Replay Metadata

Replayそのものは保存済みEventだけで再生します。

実装（#68・D38・D93）: Replay Service（`apps/server/src/replay.ts`）は、Event Store の `read` で読んだEventの、Heroに見える分（public と Hero 宛ての private）の先頭からのprefixを `projectHeroView` に渡して、一手ずつのHeroの視点を作ります。Engine・CPU・AIは動かしません。stepはHeroに見えるEvent 1件ごとで、Actionに決まった `DEALER_RULING` だけは直後の `ACTION_TAKEN` と1 stepにまとめます。Hand の一覧は Event Store の `listHands`（`hands` テーブルの行と、メモリにある終わっていない Hand）から作ります（#68 ではテーブル・列・Event の形・`schema_version` は変えていません）。終わっていない Hand（進行中・内部エラーで止まった Hand。§10）は「未完了」として同じ形で返し、再起動すると消えます。AI 障害の後に打ち切った Hand（`HAND_ABORTED`。#77・D95）は保存され、一覧・再生の応答で `aborted: true`（`finishedAt` は null。打ち切りの Event は system Visibility なので step には入らない）として返し、再起動後も残ります。下のMetadataはReplayには使いません。

Best-effortなDebug / Re-analysis用Metadata:

- RNG Seed
- Deck Order Hash
- Rule Profile Version
- App Version
- Model Role / Version
- AI Request / Response
- CPU Profile Version / Snapshot

これらを保存しても、完全なRe-simulationを保証するものではありません。

何を記録しているか（#97・D100。Eventの項目は§3）:

| 項目 | 記録先 | 備考 |
|---|---|---|
| RNG Seed | `DECK_SHUFFLED` の `seed`（engine Visibility） | 積んだDeckならnull。配布順の52枚（`deck`）も同じEventにあるので、Deck Order Hashは別に持たない |
| Rule Profile Version | `HAND_STARTED` の `ruleProfile`、`HAND_METADATA_RECORDED` の `ruleProfileVersion` | 版つきID（例: `phase4_provisional_v1`） |
| App Version | `HAND_METADATA_RECORDED` の `appVersion` | `apps/server` の `package.json` の `version`（`apps/server/src/app-version.ts`） |
| Model Role / Version | `HAND_METADATA_RECORDED` の `cpuSeats`（席ごとの `provider`・`modelRole`・`model`） | CPUの判断に使った実装（RuleBot / Claude / Emergency Bot）と、Claudeのとき `opponent_fast` を role-based config（`apps/server/src/config.ts` の `MODEL_ROLES`）で解決したモデル名。HandのMetadataはHandの開始時点の値で、途中の切り替えは `EMERGENCY_BOT_ENGAGED`、手番ごとの代わりの判断は `AI_FALLBACK_USED` に残る。Reviewのモデルは§8のReview Recordに残す |
| CPU Profile Version | `HAND_METADATA_RECORDED` の `cpuProfileVersion` | Personaの Preset 一式の版（`apps/server/src/opponents/persona.ts` の `PERSONA_PROFILE_VERSION`。Presetの値を変えたら上げる）。どのCPUにどのPresetを割り当てたかはEventに入れず、§10のSession Projectionに置く（Secret Persona） |
| AI Request / Response | 保存しない | 容量と機密（Prompt・応答の本文）の観点から保存しない（D100）。CPUの不正な出力の理由とFallbackの利用だけを `AI_ACTION_INVALID` / `AI_FALLBACK_USED` に残す |
| CPU Snapshot | 保存しない | CPU Memory はまだ無い |

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
- テーブルは `sessions`（`session_id`・`started_at`）/ `hands`（`hand_id`・`session_id`・`started_at`・`finished_at`）/ `events`（`event_id`・`hand_id`・`seq`・`type`・`schema_version`・`recorded_at`・`payload`）です。`payload` は Engine の `HandEvent` をそのまま入れた JSON 列で、`(hand_id, seq)` は一意です。`events` の UPDATE は Trigger で拒否します（append-only）。DELETE も v4（#83）から Trigger で拒否します（削除の経路は §11 の Reset と一緒に設計する）。
- マイグレーションは自前の小さな仕組みで、SQL の配列（`apps/server/src/db/database.ts` の `MIGRATIONS`）を `PRAGMA user_version` より新しい分だけ 1 版ずつトランザクションで当てます。アプリより新しい版の DB は開きません。
- Review（#82）は Hand の保存とは別に、生成が終わった時点で `reviews` テーブルへ追記します（§8。Hand の保存のトランザクションには入れない）。
- Hand 途中の Event はメモリに持ち、Hand の終わり（`HAND_FINISHED`、または AI 障害の後の打ち切り `HAND_ABORTED`。#77・D95）を追記した時点で、その Hand の全 Event と `hands` の行（その Session の最初の Hand なら `sessions` の行も。`started_at` はその Hand の開始時刻、`finished_at` は Hand の終わりの時刻）と、その Session の Session Projection（下記）を 1 トランザクションで書きます。再起動すると途中の Hand は消え、終わった Hand だけが残ります。終わった Hand への追記は拒否します。
- AI 障害の後に Hero が選んだ Session 終了（Hand の打ち切り）と、Emergency Bot に切り替えた CPU の Session 単位の登録（#52）は、Phase 3 では Orchestrator のメモリに持っていました（D88）。#77（D95）で、打ち切りは `HAND_ABORTED` と `SESSION_ENDED`（`ai_outage`）、切り替えは `EMERGENCY_BOT_ENGAGED` として Event Log に残すように置き換えました（§3）。打ち切った Hand は保存され、Replay の一覧に残ります。内部エラーで止まった Hand は従来どおり Event を足さず、保存されません（次の開始は新しい Session）。
- Session（#35・D80）は Hand Orchestrator が決め、Hand の最初の追記で Event Store へ渡した Session ID が `hands.session_id` に入ります。Session の最初の Hand は均等 Stack で始め（開始の Event に続けて `SESSION_STARTED`）、2 Hand 目以降は前 Hand の `HAND_FINISHED` の `stacks` を持ち越します（席と Button は `HAND_STARTED` に残る）。Hero の Bust か、残りが Hero だけになったら `SESSION_ENDED` を置いて Session を終え、次の Hand は新しい Session になります。Session の状態は最後の Hand の Event（`SESSION_ENDED`、無ければ `HAND_STARTED`・`HAND_FINISHED`）から作り直せます。Memory Update はまだ保存しません。
- **Session Projection（#77・D95）**: マイグレーション v2 で `session_projections`（`session_id`〔PK〕・`last_hand_id`・`state`〔`ready_for_next_hand` / `ended`〕・`end_reason`〔`ended` のときだけ。CHECK で組を守る〕・`stacks`〔最後に確定した席順の Stack。打ち切った Hand は開始時の Stack〕・`personas`〔CPU → Persona の Preset ID〕・`emergency_bots`〔切り替えた CPU ときっかけの障害の種類〕・`updated_at`）を足しました。Session ごとに 1 行で、Hand が終わるたびに書き替える派生データです（作り方は `apps/server/src/session-projection.ts` の `nextSessionProjection`。前の Projection に終わった Hand の Event を畳み込む）。Persona の割り当てだけは Event に入れない（他 CPU の Secret Persona）ので、Session の開始時の設定を Event Store への最初の追記で渡して引き継ぎます。それ以外は Session の Hand の Event を順に畳み込めば作り直せます。終わった Session（`ended`）に Hand を足す書き込みは拒否します（Projection を `ended` から戻さない）。
- **論理順序（#132・D117）**: 「どちらが先か」は壁時計（`started_at`・`finished_at`・`recorded_at`・`updated_at`・`created_at`。OS の時刻は後ろへ戻ることがある）ではなく、マイグレーション v9 で足した追記型の `ordinals` の番号で決めます（`apps/server/src/logical-order.ts`）。壁時計の列は消さず、表示・監査の Metadata として残します。時刻を clamp して戻らないように見せる解決はしません。
  - `ordinals`: `ord`（INTEGER PRIMARY KEY AUTOINCREMENT。番号を使い回さない）・`kind`（`hand_saved` / `learning_reset`。CHECK）・`ref_id`（`hand_saved` は `hand_id`、`learning_reset` は `reset_id`。1 回の Reset に 1 行）。`(kind, ref_id)` は一意です。挿入の Trigger `ordinals_target` で参照先（`hands` / `learning_resets`）の実在を確かめ、`UPDATE` / `DELETE` は Trigger で拒否します。既存のテーブル・列・行は変えません（D76。マイグレーション v9 は D117 の人間判断の範囲）。
  - 書き込み: Hand の保存（上の 1 トランザクション）と Learning Reset の追加（§11）の同じトランザクションで 1 行足します。メモリ内の Store（テスト用）は、Event Store と Learning Reset Store が同じカウンタで番号を振り、同じ意味にそろえます（カウンタは既定ではプロセスで1つ。`buildApp` が `learningResetStore` を省いたときは、渡された（またはその既定の）メモリ内の Event Store のカウンタを共有するので、Event Storeだけに独自のカウンタを渡しても Hand の番号と比べられる。メモリ内以外の Event Store を渡して `learningResetStore` を省くと、順序の源を共有できないので組み立てで拒否する。#157）。
  - 順序の表現: Hand の中の Event の順は従来どおり `events.seq` です。Hand の順は保存の `ord` です。Replay の一覧（`listHands`）は、メモリにある終わっていない Hand（このプロセスで始めた順の逆）を先に、保存済みの Hand を `ord` の大きい順に並べます。Session 内の Hand（`sessionHandIds`。Session Review）と終わった Hand（`finishedHandIds`。Recent・Trend・Hypothesis の判断の順）は `ord` の小さい順、最新の Session Projection（`latestSessionProjection`。Resume）は `last_hand_id` の `ord` が最大の行です。Learning Reset の前後は §11。
  - 意味の変化: Hand の順を「開始の順」から「保存（終わり）の順」で表します。1 つの卓では Hand を順に進め、打ち切った Hand もその時点で保存するので、保存済みの Hand では開始の順と一致します。ずれうるのは、Drill の Hand（D116）と通常の Hand を並行して進めたときの Replay の一覧の並びだけです（後に終わった方が上に来る）。
  - レガシーの扱い（v8 までの DB）: v9 の中で `ordinals` へ INSERT するだけで backfill します（既存の行は書き換えない。best-effort）。Hand どうしは `hands` の挿入の順（rowid）、Reset どうしは `learning_resets.seq` の順を保ち、両方の先頭を記録時刻（`hands.finished_at` と `learning_resets.created_at`）で比べて早い方を先に並べます（同じ時刻なら Hand を先に。v8 までの判定と同じ）。番号は併合の手順の番号を明示して入れ、挿入の順に頼りません。記録時刻が既に巻き戻っていた行の Hand と Reset の前後は、この best-effort の結果になります。backfill の後は、すべての保存済みの Hand と Learning Reset が `ordinals` に 1 行ずつあることを不変条件とし、読み出しで欠けを見つけたら例外（`MissingOrdinalError`）にします。
- **Resume（#77・D62・D95）**: Hand Orchestrator は起動時に、最後に Hand が終わった Session の Projection（`latestSessionProjection`。Drill の専用の Session は除く。#117・D116）が `ready_for_next_hand` で、その最後の Hand の席の Player が今の卓の設定にそろっていれば、その Session を戻します（Emergency Bot の CPU と Persona の割り当ては Projection から）。次の開始は、最後の Hand の `HAND_STARTED`・`HAND_FINISHED` から `nextHandSeating` で席・Button・Stack を決めて同じ Session で続けます（`SESSION_STARTED` は置かない）。Hand 途中で止まった Hand は保存されていないので戻さず、最後に終わった Hand から続けます（Hand 途中の完全復帰は求めない）。Session が終わっていた・卓の設定（人数・Player）を変えて起動した場合は、新しい Session で始めます（後者は warn を残す）。続ける Session の CPU の席の参加者（Fixed CPU / Guest。§12・D118・#136）は `session_participants` から戻し、選び直しません。

## 11. Reset Semantics

### Learning Reset

削除:
- User Hypothesis
- Ability Score
- Generated Player Profile

Hand Historyは別指定がない限り保持します。

### Opponent Memory Reset

CPUのPersistent Observation / Hypothesisを削除します。

Phase 7のOpponent Memory Reset（D120。実装は#143）: D114と同じく正本を消さず、マイグレーションv11で足す追記型の区切りの表に行を足します。区切りは追加した時点の`ordinals`の最大の`ord`を列に持って判定し、`ordinals`の`kind`のCHECKは変えません。対象は全CPUか1つの`cpuProfileId`（Fixed CPU Factory Reset）です。Event Log・`reviews`・User Read / Note / Tag・Learning Resetの区切りは変えません。

実装（#143。`apps/server/src/memory/memory-reset.ts`・`POST /api/opponents/memory-resets`）:

- **区切りの表**: マイグレーションv11の追記型の`opponent_memory_resets`に1回のResetで1行足します（列は§12）。`ordinals`には行を足しません。
- **区切りの判定（決定論・D117）**: 区切りは追加した時点の`ordinals`の最大の`ord`（Handが0件なら0）で、取得と挿入は1トランザクション（1つの`INSERT … SELECT`）で行います。メモリ内のStore（テスト用）は、Memoryを作るEvent Storeの最後の番号（`EventStore.lastOrdinal`）を読んで区切りにします（別の順序の源を既定にしない）。ObserverのObservation・Private Hypothesis・Memoryの注入は、そのObserverに効く最後の区切りより`ord`が**大きい**保存済みのHandだけを入力にします（`ObservationQuery.afterOrd`。`loadObservationSources`は区切り以前のHandのEventを読まず、`extractObservedHands`も外す）。Fixed CPU Xに効くのは`scope = all`の最後の行と`cpu_profile_id = X`の最後の行のうち`ord`が大きい方（同じなら`seq`が大きい方）、Guestに効くのは`scope = all`の行だけです。壁時計（`created_at`・Handの`recorded_at`）では比べません（時計が戻った状態でResetしても前後が変わらないことをメモリ内とSQLiteのStoreで確かめる。#129・#130の再発防止）。Learning Resetと同じく保存（Handの終わり）の順で切るので、Resetの時点で進行中だったHandはResetの後に保存されて入ります。Hand Orchestratorは今のHandのMemoryをHandの開始時に作るので、Handの途中のResetはその次のHandから効きます。
- **Observer側だけ**: ResetはそのCPUがObserverとして持つMemoryを区切ります。「そのCPUについて他のCPUが持つMemory」（Subject側）は消しません（D120に書かれていない範囲を広げない）。`all`は全CPU（今のSessionのGuestを含む）を区切ります。
- **作り直し**: Hypothesis / MemoryはProjectionで保存しないので、区切りの後は正本（Event Log）から都度作り直します。Reset後のHandが無ければ空（初めての相手と同じ）、あれば同じ入力から同じ結果です。区切りを外せば前のHandを含めたHypothesisもEvent Logから作れます（Raw Evidenceは消さない）。
- **Guest**: GuestはSession限りで、もともと次のSessionでは読みません（§6・D118）。Resetに追加の後始末はありません（行も消さない）。
- **Cache（D124・#165）**: v12の`observed_hand_cache`の行もResetでは消しません。区切りは候補のHandを選ぶときにEvent Log側で当てるので、区切り以前のHandの行は使われません（§12「CPU MemoryのCache」）。
- **変えないもの**: Event Log・`reviews`・`reveal_reviews`・`review_followups`・`drills`・User Read（Event）・Note / Tag（`user_notes` / `user_tags`。`cpu_profile`のSubjectを含む）・`learning_resets`・`ordinals`・`session_participants`・`session_projections`の行。Stats・HeroのScore / Profile / Hypothesis・Table Tendency（PublicのSession内のProjection）・Tilt（transient）はResetの対象ではなく、変わりません（`memory/memory-reset.test.ts`が、区切りの表以外の全テーブルの全行と、これらの値が変わらないことを確かめる）。
- **API**: `POST /api/opponents/memory-resets`（`docs/03` §1）。対象は全CPUか、Fixed Pool（`PHASE7_CPU_POOL`）にある1つの`cpuProfileId`です。返すのは区切りの表示用の時刻と対象だけです（`cpuProfileId`は要求で受け取った値をそのまま返すだけで、Poolの一覧・名前・Persona・区切りの`ord`は返さない）。画面の入口は今は置いていません（HeroにはFixed CPUの名前・`cpuProfileId`を見せていないため。#143の作業ログ）。

### Hand History Delete

Hand / Session Historyと派生Projectionを削除します（`session_projections`・`reviews` も含む。#77・#82。v12の`observed_hand_cache`も派生のCacheなので一緒に消す〔#165〕。Reset の実装時に、Event を消したのに Projection が残る・Projection だけ残った Session を Resume する、を作らない）。

### Factory Reset

アプリ本体・Asset以外のLocal User Data / Configを初期化します。

Phase 6のLearning Reset（D114。実装は#118）: Stats / Score / Profileは保存しない（D111）ので、上のLearning Resetの「削除」は行の削除ではなく、追記型のテーブルに区切りの行（Resetの時刻・対象カテゴリ）を足します。Score / Profile / Hypothesisはそれぞれ、そのカテゴリを対象に含む最後のLearning Resetより後のEvidenceだけで計算し、HypothesisのSnapshot（D113）はその条件で作り直します。Event Log・`reviews`等の正本は消さず、削除拒否のTriggerも外しません。User Read / Note / TagはLearning ResetでもOpponent Memory Resetでも消しません。Hand History Delete / Factory ResetはPhase 6の範囲外です。

実装（#118。`apps/server/src/learning/learning-reset.ts`・`POST /api/learning/resets`）:

| カテゴリ | 上の「削除」の項目 | Resetより後のEvidenceだけで計算するもの |
|---|---|---|
| `score` | Ability Score | Player ProfileのRecent / Long-termのScore（Overall・Ability）と「M件中N件」、Drillの系列のScore（`docs/07` §7。暫定） |
| `hypothesis` | User Hypothesis | Weakness Hypothesis（Profileの`hypotheses`）と、その`hypothesis_snapshots`（v6）の全行 |
| `profile` | Generated Player Profile | 自然言語のPlayer Profile（決定論のテンプレート文。`renderProfileText`） |

- **区切りの判定（決定論・#132・D117）**: Handの保存（Handの終わり。`HAND_FINISHED` / `HAND_ABORTED`）の論理順序の番号（§10「論理順序」の`ordinals.ord`）が、そのカテゴリの最後のResetの番号より**大きい**Handだけを、そのカテゴリのEvidenceにします。最後のResetは、カテゴリごとに`learning_resets.seq`が最大の行です。壁時計（Handの終わりの`recorded_at`・Resetの`created_at`）では比べません（#130: 時刻の比較では、時計が戻るとResetの前に終わったHandがResetの後に数えられた）。#118の時刻の比較と、時刻が戻ったときに区切りを前へ戻さない処理（clamp）は廃止しました。`created_at`はAPIの表示用の時刻として返します（最後のResetの行の値をそのまま）。Reviewの作成の順では切りません。Reset前に終わったHandをReset後にReviewしても、そのReviewはReset後のEvidenceに入りません（「M件中N件」のMとNを同じHandで数えるため）。Reset前に始まりReset後に終わったHandは入ります。
- カテゴリは独立です（Hypothesisだけを Resetすれば、ScoreとProfileの文は前のまま）。1回のResetで複数のカテゴリを選べます。
- **変えないもの**: Event Log・`reviews`・`reveal_reviews`・`review_followups`・`drills`・User Read（Event）・Note / Tag（`user_notes` / `user_tags`）・`session_projections`の行。Stats（D114の対象に無い）とSession Review（1 Sessionの振り返りで、HandのReviewと同じく過去の記録の見方。暫定）はResetで変えません。Replay・Hand Review・Drillの一覧もそのまま開けます。
- **Snapshotの作り直し**: `hypothesis`を含むResetの時点と、Profileを読むたびに、Resetより後のEvidenceから作ったHypothesisで`hypothesis_snapshots`の全行を入れ替えます（D113）。前のSnapshot・前の自然言語のProfileは次の計算の入力にしません。
- **Policy Version**: Score・Hypothesis・Profileはどれも、計算するときのPolicy（`ScoringPolicy`・`HypothesisPolicy`・`ProfilePolicy`）で正本（Event Logと`reviews`）からResetより後のHandだけを計算し直します。Policyを変えても、保存済みの結果を読み替えません。
- **Opponent Memory Reset**（Phase 7・P7-8）は`learning_resets`に入れず、カテゴリの名前も分けます。

Post-MVPのReset（D64。実装はP6-7・P7-8）: Learning ResetとOpponent Memory ResetはEvent Log・Reviewの正本を壊さず、派生Projectionは正本から作り直せるようにします。Opponent Memory Resetで、HeroのUser Read / Note / Tag（Phase 6）を誤って消さないよう、カテゴリを分けます。

## 12. Post-MVPのProjectionと永続化の方針（D102〜D106）

Phase 6以降で足すデータは、次の方針で置きます。具体的なテーブル・Eventの形は各子Issue（P6-1以降）で決め、その時点でこの文書を更新します。

- **Projectionを正本にしない**: Handの事実の正本はEvent Log、ReviewはVersion付きで上書きしない`reviews`・`reveal_reviews`（D39・D99）のままです。Stats / Ability Evidence / Score / Hypothesis / Profile / Table Tendency / CPUのHypothesisは、そこから再計算できるProjectionとします。Projectionを保存するのは速さのためのCacheで、消しても正本から作り直せることを条件にします。Phase 6のStats / Score / Profileは都度計算し、保存しません（D111。遅くなった時点でCacheを別Issueで足す）。Weakness HypothesisはD104どおりSupporting / Counter Evidenceを構造化して保存し、保存の形はreviewsから作り直せるSnapshotのテーブル（マイグレーションv6の`hypothesis_snapshots`。D113。列は§7）です。
- **Versionを残す**: Score・Ability Evidence・HypothesisのProjectionには、計算したPolicy（`ScoringPolicy`等）のVersionを持たせます。Policyを変えたときは、正本から計算し直します（古い結果を書き換えて正本にしない）。
- **数と分母を持つ**: StatsはPercentageだけでなくNumerator / Denominator / Opportunity Countを持ちます（`docs/07` §3）。
- **Stats Projection（#112）**: Engineの `projectPlayerStats`（`packages/engine/src/stats.ts`）が、HandごとのEvent LogのpublicのEventだけ（`publicEvents`）から全PlayerのStatsを都度計算します。テーブル・列・Eventの形は足していません（D111）。集計に入れるのは `HAND_FINISHED` まで済んだHandで、除くHandのid（DrillのHand。D116）を引数で受け取ります。結果には指標の定義の版（`STATS_DEFINITION_VERSION`）を付けます。Learning Reset（§11）の対象ではないので、Resetの後も全期間で数えます。指標の一覧と数え方は `docs/07` §3。
- **Ability Evidence / Score（#113）**: serverの `computeScoreReport`（`apps/server/src/learning/score.ts`）が、HandのEvent Log（Heroの判断の数）とPass Aの`reviews`（判断ごとの最新のVersion）からAbility Evidenceを作り、`ScoringPolicy`（`phase6_provisional_v1`）で都度計算します。テーブル・列・Eventの形は足していません（D111）。Pass Bの`reveal_reviews`は入力にしません。結果は計算したPolicyのVersionと、対象の判断の数・Review済みの数（D115）を持ちます。除くHandのid（DrillのHand。D116）を引数で受け取ります。Learning Reset（§11）の区切りは呼び出し側（`LearningService`・`DrillService`）が、区切りより後に終わったHandだけを渡して当てます。式と暫定値は `docs/07` §2。
- **Weakness Hypothesis / Player Profile（#114）**: serverの`buildHypotheses`（`apps/server/src/learning/hypothesis.ts`）が、Scoreと同じAbility Evidence（Pass Aの`reviews`の判断ごとの最新のVersion）から`HypothesisPolicy`（`phase6_hypothesis_v1`）でHypothesisを作り、`rebuildHypothesisSnapshot`が§7の`hypothesis_snapshots`の全行を入れ替えます（マイグレーションv6で足したのはこのテーブルだけで、既存のテーブル・列・Eventの形は変えていない。D76）。Player Profile（`computePlayerProfile`。Recent / Long-term・Hypothesis）は都度計算し、保存しません（D111）。自然言語のProfileはStructured Profileからの決定論のテンプレート文（LLMを呼ばない）です。除くHandのid（DrillのHand。D116）を引数で受け取ります。Learning Reset（§11）の後は、Hypothesis・Profileの文・ScoreをそれぞれのカテゴリのResetより後に終わったHandだけで作ります。式と暫定値は`docs/07` §4・§5。
- **人が入力したもの**: User Read・Note・Tagは、Heroが入力した記録で、Projectionではありません（D112。#115で実装）。
  - **User Read**: 判断時点の情報なので`USER_READ_RECORDED`（§3。Heroだけのprivate）としてEvent Logに残します（schema_version 8）。対象の席はそのHandの`playerId`（`ACTION_TAKEN`と同じHandの中だけの参照）で、永続の対象はHandが属するSession（`hands.session_id`）と席の組から引きます。判断時点の扱いは§1、Reviewへの入れ方は§8・`docs/05` §6です。
  - **Note / Tag**: Handに属さないので、マイグレーションv5で足した追記型の`user_notes` / `user_tags`に置きます（既存のテーブル・列は変えない。D76）。書き読みは`apps/server/src/notes/note-store.ts`（`SqliteNoteStore`。DBはEvent Storeと共有）。どちらも`UPDATE` / `DELETE`をTriggerで拒否し、今のNote / Tagは行の列から作る派生（保存しない）です。
    - `user_notes`: `seq`（追記の順。INTEGER PRIMARY KEY）・`note_id`（Noteの識別子。追加のときにclientが作るUUIDで、revisionをまたいで同じ。同じ`note_id`の追加の再送は行を足さない）・`revision`（1から）・`created_at`・`subject_key`・`subject`・`body`（1〜500字。`NULL`は削除）。**削除は同じ`note_id`の次の`revision`に本文の無い行（tombstone）を足して表します**。編集を足すときも次の`revision`の行にします（今はUIに編集が無い）。最初の`revision`は本文を持ち、次の`revision`は同じ対象の、まだ消していない直前の`revision`にだけ続けられます（Trigger `user_notes_revision_follows`。消したNoteは戻さない）。今のNoteは`note_id`ごとの最後の`revision`が本文を持つもの。
    - `user_tags`: `seq`・`created_at`・`subject_key`・`subject`・`tag`（1〜20字）・`op`（`add` / `remove`）。**Tagの付け外しは行の追記で表し**、対象とTagごとに最後の行が今の状態です（付いているTagの`add`・付いていないTagの`remove`は行を足さない）。
    - **対象（Subject）**: `subject`はJSON（kindごとの形）、`subject_key`はその検索の鍵です。Phase 6は`{ kind: "session_player", sessionId, playerId }`（そのSessionの中の参加者。`apps/server/src/notes/subject.ts`）で、席のplayerId（`cpu1`等）を永続のIdentityとみなしません（D105。同じ席でも別のSessionは別の対象）。Phase 7で永続の`cpuProfileId`（D106）ができたら、kindを足して（例: `{ kind: "cpu_profile", cpuProfileId }`）同じ列に入れ、既存の`session_player`の行はSessionの席と`cpuProfileId`の対応から永続のCPUへ引きます（保存済みの行は書き換えない）。Sessionの行は最初のHandが終わるまで無いので、`sessions`を外部キーで参照しません。
  - User Read / Note / TagはCPUの`KnowledgeState`・Prompt・CPU Memoryへ渡しません（不変条件2）。Note / TagはReviewのEvidenceにも入れません。Learning ResetでもOpponent Memory Resetでも消しません（§11・D114）。
- **Drill（#117）**: Drillは元のHand / Decision / Evidenceのprovenanceを持ち、結果は通常Playと別の系列に置きます（D105）。DrillのHandは専用のSession（そのHandだけ）の通常のHandとしてEvent Logに残し（`HAND_STARTED` → … → `SESSION_STARTED` → 判断の直前までのScriptの`ACTION_TAKEN` → 以降は通常どおり。Eventの形・`schema_version`は変えない）、マイグレーションv7で足した追記型の`drills`テーブルで区別します（既存のテーブル・列・行は変えない。D76。マイグレーションv7はD116の人間判断の範囲）。Stats・Score・Profile・Hypothesis・Session Review・Resume・Replayの一覧は`drills`にあるHandを除きます（D116）。式・変形・選び方は`docs/07` §7。
  - `drills`: `drill_id`（PK）・`created_at`・`source_hand_id`（`hands`を参照）・`source_decision_index`・`source_review_id`（`reviews`を参照。挿入のTrigger `drills_source_review`で、その元のHand・判断のPass AのReviewであることを確かめる）・`variant_kind`（変形の種類。`effective_stack` / `bet_size` / `opponent_tendency`。Policyの Version付きの暫定値なのでCHECKで固定しない）・`variant`（変形の値のJSON object）・`policy_version`（`phase6_drill_v1`）・`seed`（0以上の整数）・`drill_hand_id`（一意。元のHandと違う）。`UPDATE` / `DELETE`はTriggerで拒否します。
  - 行はDrillのHandを始める前に足します（Handが保存されるより先に、通常の集計・Resumeから除く対象に入れる）。そのため`drill_hand_id`は`hands`を参照しません（途中で止まったDrillのHandは保存されず、行だけが残る）。同じ元の判断・`variant`・`seed`・`policy_version`から、同じSpotを作り直せます。
  - Event Storeの`listHands(limit, exclude)`（Replayの一覧）と`latestSessionProjection(exclude)`（Resume）は、`drills`のHandと、最後のHandがそのHandのSession（Drillの専用のSession）を除きます（SQLiteは`json_each`で除く。`session_projections`の行・列は変えない）。
- **Learning Reset（#118）**: マイグレーションv8で足した追記型の`learning_resets`に、Resetの区切りの行を足します（既存のテーブル・列・行は変えない。D76。マイグレーションv8はD114の人間判断の範囲）。意味と区切りの判定は§11です。
  - `learning_resets`: `seq`（追記の順。INTEGER PRIMARY KEY）・`reset_id`（1回のReset。カテゴリごとの行が同じ値）・`created_at`（Resetの時刻。ISO 8601・UTC。1回のResetの行は同じ値）・`category`（`score` / `hypothesis` / `profile`。CHECK）。`(reset_id, category)`は一意で、1回のResetの行は1トランザクションで足します。`UPDATE` / `DELETE`はTriggerで拒否します。
  - API（`docs/03` §1）: `POST /api/learning/resets`（`{ categories }`）が区切りを足し、`GET /api/learning/profile`の応答の`resets`（カテゴリごとの最後のResetの時刻）と`GET /api/drills`の`score.since`で区切りを返します。返すのは表示用の時刻で、区切りの判定は論理順序で行います（§11・D117）。
- **Phase 7のMemory**: CPUのObservationはappend-onlyのRaw Evidenceとして持ち、Hypothesis / TendencyはProjectionです（§6。D106）。TiltはSession終了でResetするtransientな状態で、Persona / Long-term Memoryと分けて持ちます（D107）。Identityの`session_participants`（v10）とObservationの抽出はD118（§6）、Opponent Memory Resetの区切りの表（v11）はD120（§11）、decay・Sample・Tiltの暫定値はD119（`docs/05` §4・§5。OI-011）です。
  - **Identity（#136）**: マイグレーションv10で追記型の`session_participants`を足しました（既存のテーブル・列・行は変えない。D76。マイグレーションv10はD118の人間判断の範囲）。列は`seq`（追記の順。INTEGER PRIMARY KEY）・`session_id`（`sessions`を参照）・`player_id`（その Session の CPU の席。Hand の Event の`playerId`と同じ値）・`kind`（`fixed` / `guest`。CHECK）・`cpu_profile_id`（`fixed`のときだけ）・`guest_id`（`guest`のときだけ。一意で、別のSessionで同じidを使わない）・`pool_version`（編成に使ったFixed Poolの版。`phase7_pool_v1`）です。`kind`とIDの列の組はCHECKで守り、`(session_id, player_id)`と`(session_id, cpu_profile_id)`は一意です。`UPDATE` / `DELETE`はTriggerで拒否します。Fixed CPUのSessionを跨いだ参照のため`(cpu_profile_id, seq)`の索引を持ちます。IDの一覧・人数・Personaは列に持たず（PersonaはSecret。D28）、Pool（`apps/server/src/opponents/cpu-pool.ts`の`PHASE7_CPU_POOL`）はコードのVersion付きConfigです（OI-005の暫定値）。
  - 書き込み: 新しいSessionの最初のHandの保存（§10の1トランザクション）で、そのSessionのCPUの席ごとに1行足します。参加者はEvent Storeへの最初の追記で渡し（`AppendContext.participants`）、同じSessionの2 Hand目以降の値は見ません。参加者を渡さないSession（Drillの専用のSession。D116）とv10より前のSessionには行がありません（推測でIdentityを作らない。backfillしない）。読み出しは`EventStore.sessionParticipants(sessionId)`（席順）です。
  - 編成（`composeSessionParticipants`）: Hand Orchestratorが新しいSessionの最初のHandのseedから導いたseedで決定論に決めます。Guestは`guestSeatChance`（暫定値0.5）の確率でCPUの席のどれか1つに座り（1卓に最大1席）、残りの席は席順に、席のPersona（卓の設定の既定の割り当て順・`CPU_PERSONAS`の上書き。D85）と同じPersonaのまだ座っていないFixed CPUからseedで選びます。それを全席で済ませた後、席のPersonaを満たすFixed CPUがPoolに残っていない席（`CPU_PERSONAS`で同じPersonaをPoolの人数より多い席に当てたとき）を席順に、残りのFixed CPUからseedで選びます。Fixed CPUは常にPoolのPersonaで打ち（同じ`cpuProfileId`はSessionを跨いで同じPersona。D118）、その席では上書きが効かず、効かなかった席をserverのwarnに残します（座ったCPUのPersonaは書かない）。GuestはSession限りなので席のPersonaで打ちます。既定の割り当て順ではどの人数（2〜8）でも全席が同じPersonaのFixed CPUかGuestで埋まり、席のPersonaは従来と変わりません。そのSessionで使うPersonaの割り当ては従来どおりSession Projectionの`personas`に残し、Resumeで戻します。Guestのidは`guest/<session_id>/<player_id>`です。席の表示名は従来どおり「CPU n」で、Poolの名前・`cpuProfileId`はHeroへの応答・Event Logに入れません。
  - **Observation（#137）**: `apps/server/src/memory/observation.ts`が、保存済みの（終わった）HandのEvent Logから、Observerが卓で見聞きしたEventだけを決定論で抽出する純粋関数です（`extractObservedHands`。Event Storeから読む入口は`loadObservationSources`・`extractObservedHandsFromStore`）。テーブル・列・Eventの形・`schema_version`は足していません（D118）。Event Storeには、HandのSessionを引く`sessionIdOfHand`だけを足しました（既存の`hands.session_id`を読む）。
    - **参照**: Observerは`{ kind: "cpu_profile", cpuProfileId }`（Fixed CPU。Note / TagのSubjectと同じ形）か`{ kind: "guest", guestId }`（Session限り）。SubjectはそれにHeroの`{ kind: "hero" }`を足した参加者の参照で、席・player idに依存しません。HandごとにそのSessionの`session_participants`で席を参加者へ引き、Heroの席は呼び出し側が渡します（`heroPlayerId`）。
    - **入れるもの**: 保存されたEventの`visibility`と、Engineが種類から決めるVisibility（`visibilityOf`）の両方が`public`のEventだけ（行為・Blind・Board・Showdownで表にされた札`CARDS_TABLED`・Potの配分・Heroの宣言 / Chipの操作 / 裁定等）。Observer自身のHole Cards・他者のHole Cards（`private`）・Deck（`engine`。Future Cards）・CPUの判断の経緯や運用の記録・Metadata（`system`）・HeroのUser Readは入りません。Learning-only Reveal（`learning-reveal.ts`）とHeroの弱点（`apps/server/src/learning/`）は参照しません（`memory/observation-isolation.test.ts`がimportをたどって確かめる）。
    - **観察しないHand**: Observerが参加者にいないSession（v10より前のSession・Drillの専用のSessionは参加者の行が無いので、ここに入る。推測でIdentityを作らない）と、Observerが座っていないHand（Bustした後のHand）と、そのObserverに効くOpponent Memory Resetの区切り以前に保存されたHand（§11。#143）。Guestは、Observerとしては今のSession（`currentSessionId`）のHandだけを観察し、Subjectとしては今のSessionのHandでだけ引きます。前のSessionのHandでは、Guestの席は誰か引けない席（`null`）になり、そのEventはSubjectのObservationになりません（次のSessionでは読まない＝破棄。行は消さない）。
    - **形**: Handごとの`ObservedHand`（Observer・Observerの席・`handId`・`sessionId`・`ord`・`context`・席→参加者・見たEventの列〔`seq`・`visibility`・行為者のSubject〔卓全体のEventは`null`〕・Event〕）。Pot・Board等の文脈もここに入ります。`observationsOf`はそれをSubjectごとのObservation（Observer・Subject・`hand_id`・`seq`・`ord`・Visibility・`context`・Event）に平らにし、Observer自身のEventと誰か引けない席のEventを除きます。`context`はHandが属するSessionのmode（`SESSION_STARTED`の設定のSnapshot。D129）で決め、Cashの`cash`・Tournamentの`tournament`です（#188。`sessionContextOf`。Sessionの最初の保存済みのHandから読むので、版9のTournamentのHand〔Levelを持たない〕も`tournament`。Snapshotが壊れていれば例外）。
    - **順序**: Handは`ordinals.ord`の小さい順、Handの中は`events.seq`の小さい順で、入力の並び・壁時計（`recorded_at`等）に依りません（D117。時計が戻った記録でも順序が変わらないことをメモリ内とSQLiteのStoreで確かめる）。同じ入力からは同じ結果です。
  - **Private Hypothesis（#138）**: `apps/server/src/memory/opponent-hypothesis.ts`の`buildOpponentHypotheses`が、1人のObserverの観察（上の`ObservedHand`）から、Subject × Context（`cash` / `tournament`）ごとのHypothesisを都度作る決定論の純粋関数です（Event Storeから読む入口は`buildOpponentHypothesesFromStore`）。テーブル・列・Eventの形・`schema_version`は足していません（D111と同じく保存しない。HypothesisはD124でもCacheせず都度計算し、Cacheするのは観察の抽出結果だけ）。Raw Observationは共通に使い、Hypothesisだけをcontextで分けます（D106）。
    - **Policy**: `apps/server/src/memory/memory-policy.ts`のVersion付きの`MemoryPolicy`（`phase7_memory_v1`。`MEMORY_POLICIES`・`DEFAULT_MEMORY_POLICY`）。数値はOI-011の暫定値（D119）で、変えるときはVersionを上げたPolicyを足します。Heroの`ScoringPolicy`・`HypothesisPolicy`（`learning/`）とは別物で、importも型の共有もしません（`memory/observation-isolation.test.ts`が`memory/`の全モジュールからimportをたどって確かめる）。
    - **項目**: Observationから数えられる観察可能な頻度に限り、Engineの Stats の定義（`STAT_DEFINITIONS`。publicのEventだけを読む。`docs/07` §3と同じ数え方）のうち割合で読む指標を使います（`phase7_memory_v1`はVPIP・PFR・3-bet・Fold to 3-bet・Flop の C-bet・Flop の Fold to C-bet・Postflop の Aggression Frequency）。比で読むAggression Factorは入れません。項目はPolicyのVersionで増やせます。
    - **形**: Hypothesisは Observer・Subject・context・Policyの Version・見たHandの数・最後に見たHandの`ord`・項目ごとの推定を持ちます。項目ごとの推定は、recencyの重みを掛けたnumerator / denominator・重みを掛けない機会の数・十分か（`sufficient`）・Policyの Version・Evidence（その項目の寄与を決めたSubjectの`ACTION_TAKEN`の`hand_id`・`events.seq`・`ordinals.ord`。Engineの Stats の寄与〔`StatContribution.actions`〕が判定を決めたActionを持つ）です。古いEvidenceも重みが小さくなるだけで消しません。
    - **recency decay**: ObserverがそのSubjectを同じcontextで見たHand（両者が座っていて終わったHand）を`ord`の順に並べ、最新のHandをage 0として`0.5^(age / 150)`の重みを掛けます（半減期150 Hand）。壁時計を使わないので、時計が後ろへ戻った記録でも結果は変わりません（D117。メモリ内とSQLiteのStoreで確かめる）。
    - **十分なSample**: 重み付きの機会数（denominator）が`15 × (0.5 + Skill)`以上（ObserverのPersonaのSkill 0〜1で0.5〜1.5倍。弱いCPUは少ないSampleで早合点し、強いCPUは保留しやすい）。Skillは呼び出し側が渡します（Fixed CPUはPoolのPersona、Guestは席のPersona）。
    - **Isolation**: 入力は1人のObserverの観察だけで、別のObserverの観察を混ぜた入力は拒否します（CPU AのBへの仮説をCの観察から作らない）。Observer自身と誰か引けない席はSubjectにしません。GuestはObservationの抽出と同じく次のSessionでは読まないので、Hypothesisも持ち越しません。打ち切ったHand（`HAND_FINISHED`の無いHand）はStatsと同じく数えません。
  - **Memoryの注入（#139・D121）**: `apps/server/src/memory/memory-summary.ts`が、1人のObserverのHypothesisを、そのCPUの`KnowledgeState`に足す上限付きの構造化した要約（`OpponentMemorySummary`）に決定論で畳みます。テーブル・列・Eventの形・`schema_version`は足していません（保存しない）。
    - **作る時点**: Hand OrchestratorがHandの開始時、そのHandをEvent Storeへ書く前に、座っているCPUごとに作ります（`buildOpponentMemoriesFromStore`。CPUの数だけ同じHandを読み直さないよう、1回の計算の間だけ読み出しを使い回す）。入力は保存済みの（終わった）Handだけで、Handの途中のEventはそのHandの`KnowledgeState`が持ちます。Handの間は同じ要約を使います（再要求・Fallback・Emergency Botも同じ入力）。順序は`ordinals.ord`と`events.seq`で、壁時計を使いません（D117）。同じEvent Storeからは同じ要約になります（メモリ内とSQLiteのStoreで確かめる）。
    - **Observer**: そのSessionの`session_participants`の参加者（Fixed CPU / Guest）。参加者の行が無いCPU（v10より前のSession・Drillの専用のSession）には作りません。ObserverのSkillはPersona（Fixed CPUはPoolのPersona、Guestは席のPersona。無ければ平均の0.5）で、十分なSampleの基準に使います（D119）。
    - **Subject**: 今のHandの他の参加者（Heroと他のCPU）を席順に並べ、その席の`playerId`（このHandの中だけの対応）・参加者の参照・ObserverがそのSubjectを見たHandの数（0は初めての相手）・項目を持ちます。Observer自身と誰か引けない席は入れません。`context`は今のHandのSessionのmodeのHypothesisだけを使います（CashのHandは`cash`、TournamentのHandは`tournament`。#188。Raw Observationは共通で、Hypothesisは混ぜない。D106）。
    - **上限（`phase7_memory_injection_v1`）**: 項目は機会のあるものを重み付きの機会の多い順（同じならPolicyの項目の順）にSubjectごと5つまで（D121）。項目ごとに割合（重み付き。小数第2位で丸める）・重み付きの機会の数・機会の数・十分か（不十分は保留）・Evidenceの全件の数・新しいEvidence ID（`<hand_id>#<events.seq>`）3件までを持ちます（3件はOI-011の暫定値）。自然言語のMemoryは作らず、Claudeの CPUにはこの構造化データをそのままPromptで渡します（`docs/05` §1）。
    - **Isolation**: 入力は1人のObserverのHypothesisだけで、別のObserverのHypothesisが混ざった入力は拒否します。Hidden のPersona・他CPUのHypothesis・Heroの弱点（`learning/`）・Learning-only Reveal・Tiltは入りません。`memory/memory-injection-isolation.test.ts`が、`opponents/`・`hand-orchestrator.ts`・`memory/memory-summary.ts`からのimportで`learning/`に届かず、Learning-only Revealを参照しないことと、Fakeの`query()`で複数のSessionを進めたClaudeのCPUの全Promptで、Memoryの全EvidenceがObserver自身の座っていたHandのSubjectのpublicの`ACTION_TAKEN`であること・前のSessionのGuestが出ないこと・他者の札・Persona・Pass Bの文・Heroの弱点のHypothesisが出ないことを確かめます。
  - **Tilt（#140・D107・D119）**: `apps/server/src/opponents/tilt.ts`が、今のSessionの保存済み（終わった）Handを`ordinals.ord`の順に頭から畳み込み、席ごとのTiltの段階（0〜3の整数）を作る決定論の純粋関数です（Event Storeから読む入口は`loadTiltSources`・`buildTiltsFromStore`。Policyは`opponents/tilt-policy.ts`の`phase7_tilt_v1`）。Tiltは保存しないtransientな状態で、テーブル・列・Eventの形・`schema_version`は足していません。Sessionの中の席ごとの状態なので、Memory（参加者のIdentityで持つLong-term Memory）・Personaとは別の層で、Sessionが変われば0から始まります（Session終了でReset。`SESSION_ENDED`の無いSessionも持ち越さない）。入力は卓の全員が見た`public`のEvent（そのCPU自身の結果を含む）だけで、壁時計を使いません（D117。時計が後ろへ戻った記録でも結果が変わらないことをメモリ内とSQLiteのStoreで確かめる）。Hand OrchestratorがHandの開始時にCPUごとに作り、1以上のCPUだけ`KnowledgeState`に`tilt`（段階・上限・PolicyのVersion）として足します（§5の「自分自身のInternal State」。0のCPUでは項目ごと持たない）。Trigger・遷移・反映の定義は`docs/05` §4です。
  - **Table Tendency（#141・D106）**: `apps/server/src/memory/table-tendency.ts`が、今のSessionの保存済み（終わった）Handを`ordinals.ord`の順に並べ、viewerから見た卓全体の観察可能な傾向を数える決定論の純粋関数です（Policyは`memory/table-tendency-policy.ts`の`phase7_table_tendency_v1`）。保存しないProjectionで、テーブル・列・Eventの形・`schema_version`は足していません（D111）。
    - **入力**: Observationの抽出と同じwhitelist（`isObservable`。保存されたVisibilityとEngineが種類から決めるVisibilityの両方が`public`）を通したEventだけです。Hole Cards（`private`）・Deck（`engine`。Future Cards）・`system`の記録・Learning-only Revealは読みません。個々のCPUのPrivate Observation / Hypothesis（`opponent-hypothesis.ts`・`memory-summary.ts`）・Persona・Tiltを集約して作らず、importもしません（`memory/table-tendency-isolation.test.ts`が確かめる）。D10の「ユーザーが選ぶ卓の傾向（卓の編成）」とは別のものです。
    - **範囲**: 今のSessionの、viewerが座っていたHand（`HAND_STARTED`の席にいる）のうち、`ord`で新しいものから`windowHands`（100）までです。座っていないHand（Bustの後）と`HAND_FINISHED`の無いHand（打ち切ったHand）は数えません。壁時計を使わないので、時計が後ろへ戻った記録でも結果は変わりません（D117。メモリ内とSQLiteのStoreで確かめる）。Sessionが変われば前のSessionのHandは入りません。
    - **項目**: Engineの Stats の定義（`STAT_DEFINITIONS`）の`vpip`（looseness）・`pfr`・`aggression_frequency`（Postflopのaggression）を、viewer以外の席の寄与で合算したものと、`showdown`（札を比べて決めたPot〔`POT_AWARDED`の`showdown`〕があったHandの割合。Hand単位）です。重みは掛けません。
    - **形**: `TableTendency`はPolicyのVersion・数えたHandの数・項目の列です。項目ごとにnumerator / denominator・その項目の機会があったHandの数・十分か（Handの数が`minHands`〔10〕以上かつ機会の数が`minOpportunities`〔20〕以上。不十分は保留）・PolicyのVersionを持ちます。数値はOI-011の暫定値です。
    - **入り口**: CPU用の`buildCpuTableTendenciesFromStore`は、Hand OrchestratorがHandの開始時（そのHandをEvent Storeへ書く前）に、座っているCPUごとに、そのCPUが座っていたHandだけから作ります（Sessionの最初のHand・数えたHandが0のCPU・Drillは持たない）。Hero用の`buildHeroTableTendencyFromStore`は、Heroが座って見えたHandだけから作り、`beforeOrd`より前に保存したHandに絞れます（ある判断の時点の値にするため）。Hero用は、`ReviewService`がPass AのEvidenceを作るときに、判断のHandの`ord`を`beforeOrd`にして使います（D122・#153。十分な項目があるときだけOpponent Observationに入る。`docs/05` §6）。
  - **Opponent Memory Reset（#143・D120）**: マイグレーションv11で追記型の`opponent_memory_resets`を足しました（既存のテーブル・列・行と`ordinals`の`kind`のCHECKは変えない。D76。マイグレーションv11はD120の人間判断の範囲）。列は`seq`（追記の順。INTEGER PRIMARY KEY）・`reset_id`（一意）・`created_at`（Resetの時刻。ISO 8601・UTC。表示用）・`scope`（`all` / `cpu_profile`。CHECK）・`cpu_profile_id`（`cpu_profile`のときだけ。空文字は不可）・`ord`（追加した時点の`ordinals`の最大の`ord`。Handが0件なら0）です。`scope`と`cpu_profile_id`の組はCHECKで守り、`ord`がその時点の最大であることを挿入のTrigger（`opponent_memory_resets_ord`）で確かめ、`UPDATE` / `DELETE`はTriggerで拒否します。DBはPoolのIDの一覧を知りません（知らないIDはAPIで拒否する）。意味と判定は§11です。
  - Note / Tag（D105）: Subjectに`{ kind: "cpu_profile", cpuProfileId }`を足しました（鍵は`["cpu_profile", cpuProfileId]`）。既存の`session_player`の鍵（`["session_player", sessionId, playerId]`）はバイト単位で変えず、保存済みの行は書き換えません。`session_player`の対象は`persistentSubjectOf`でそのSessionの`session_participants`から永続のCPUへ引きます（Fixed CPUなら`cpu_profile`、Guest・v10より前のSessionはnull）。Note / TagのAPIの対象は今も`session_player`です。
- **CPU MemoryのCache（D124・#165）**: Handの開始の遅さ（#150: 実SQLiteで5,000 Handのとき約0.98秒）を受け、Handごとに抽出したObservation（Observer別・抽出のVersion付き）をマイグレーションv12の派生の表`observed_hand_cache`に持ちます（`apps/server/src/memory/observation-cache.ts`）。Hypothesisのrecency・Sampleの集計は今どおり都度計算で、Cacheしません。既存のテーブル・列・行・Triggerは変えていません（D76。マイグレーションv12はD124の人間判断の範囲）。測定の結果は`docs/taskLog/issue-165-observation-cache.md`です。
  - `observed_hand_cache`: `observer_key`（Observerの参加者の参照の鍵。`participantKey`）・`hand_id`・`extraction_version`・`hero_player_id`（抽出に使ったHeroの席）・`ord`（そのHandの`ordinals.ord`）・`observed`（Observerの席・`context`・席→参加者・Eventごとの行為者のJSON object）・`events`（Observerが見た`public`のEventの列のJSON array。同じHandならObserverに依らず同じ）。主キーは`(observer_key, hand_id)`です。Observerが座っていないHand（Bustの後）は`observed`・`events`ともNULLの行を持ち（読み直さないため）、片方だけNULLの行はCHECKで拒否します。`hands`を外部キーで参照しません（Cacheが正本の行の削除を妨げない）。DELETE / UPDATEを許し、追記専用のTriggerは付けません（v6の`hypothesis_snapshots`と同じ扱い）。
  - **Version**: `extraction_version`は抽出の規則のVersion（`OBSERVATION_EXTRACTION_VERSION`。`extractObservedHands`の規則を変えたら上げる）とEventの版（`EVENT_SCHEMA_VERSION`。Cacheの`events`はupcastした後の形なので）の組です。今のVersionと違う行は読まず、プロセスで最初に読むときに消して、足りない分として作り直します。#165の`phase7_observation_v1`は`context`を常に`cash`にしていたので、#188で`context`をSessionのmodeで決めるときに`phase8_observation_v2`へ上げました（v1の行は消えて作り直される。表・列は変えない。D124の範囲）。CacheにないHandを抽出するときだけ、そのHandのSessionの最初のHandを読んでmodeを決めます（1回の計算の間はSessionごとに使い回す）。
  - **更新**: Hand OrchestratorがHandの開始でMemoryを作るとき（`buildOpponentMemoriesFromStore`に`observationCache`を渡す）に、Observerごとに候補のHand（`observationCandidates`。下の判定）のうちCacheに行の無いHand（`ord`と`hand_id`で引く。壁時計は使わない）だけをEvent Logから抽出して足します。Handの保存のトランザクションでは書きません。Cacheの行の形が合わない（Eventの数と行為者の数が違う・JSONとして読めない）ときは無いものとして作り直して置き換えます。Cacheの読み書きに失敗してもMemoryはEvent Logから計算を続け、結果を変えません（失敗はserverのwarnに残す）。1回の計算の間は、同じHandの`events`の復元をObserver間で使い回します。メモリ内のEvent Store（テスト用）ではCacheを使いません。
  - **判定はEvent Log側**: Observerが参加者か（`session_participants`）・GuestのObserverは今のSessionだけ（D118）・Opponent Memory Resetの区切り（`opponent_memory_resets`。D120）・論理順序（`ordinals`。D117）は、今どおりEvent Log側の情報で候補を選ぶときに判定し、Cacheに持ちません。Cacheの行は「そのHandをそのObserverが見たら何が見えるか」を、そのHandのSessionを今として抽出したもので、前のSessionのHandではGuestのSubjectを誰か引けない席（`null`）にする扱い（D118）を読むときに当てます。Resetの後もCacheの行は消さず、区切り以前のHandの行は候補に入らないので使いません。Learning-only Reveal・他者のHidden / Future Cardsは抽出（`public`のwhitelist）どおり入りません。
  - **確かめること**（`memory/observation-cache.test.ts`）: Cacheあり（初回・温まった状態）/ なし / 全部消した後 / メモリ内のEvent Storeで、観察とMemory（注入の要約まで）が同じこと。Versionの違う行・形の合わない行を使わないこと。Reset・Guest・Observerが座っていないHand・参加者の無いSessionの扱いがCache前と同じこと。時計が後ろへ戻った記録でも同じこと。Cacheの失敗で結果が変わらないこと。Hand OrchestratorがCacheの有無で同じMemoryをCPUに渡すこと。
- **Phase 8のTournament（D129）**: TournamentはEvent Logだけに残し、テーブルを足しません。TournamentのProjection（順位・Payout・Result・現在のLevel）はEvent Logから都度計算します（D111と同じ。遅くなった時点でCacheを別Issueで足す）。
  - **Eventに残すもの**: Tournamentの設定のSnapshot（Preset・Starting Stack・Blind構造・Ante・Payout・参加費）をSessionの開始のEvent（`SESSION_STARTED`の`tournament`。#183で実装。形は§3）に、Handごとの現在のLevel・Blind・Ante（と`ANTE_POSTED`）を`HAND_STARTED`の側（`ante`・`tournament`。#184で実装。形は§3）に、Elimination・Tournamentの終了をHandの終わりの側に置きます。Elimination・終了は#185で、既存の`HAND_FINISHED`の`stacks`（Stack 0 = Bust）と`SESSION_ENDED`（`hero_busted` / `hero_last_standing`）で表すと決め、新しいEventを足していません（§3「TournamentのElimination・終了と順位」）。Payoutは#186で、`SESSION_STARTED` の設定のSnapshot（参加費・割合）と順位からResultを都度計算すると決め、新しいEventを足していません（§3「TournamentのPayoutとResult」）。
  - **版**: Eventの形を変えるPRごとに`schema_version`を上げ、旧版の行はupcastで読みます（Anteの無い旧版の`HAND_STARTED`はAnte無しとして読む）。旧版のSession（Tournamentの設定の無いSession）はCashとして読みます。保存済みの行は書き換えません（D76）。#183で`SESSION_STARTED`に`tournament`を足して版を9にしました（版 8 までの行は変換せずcashとして読む。§3）。#184で`HAND_STARTED`に`ante`・`tournament`を、`ANTE_POSTED`を足して版を10にしました（版 9 までの行は変換せずAnteなしとして読む。§3）。
  - **Sessionのmode（#183）**: Sessionのmode（`cash` / `tournament`）と設定は`SESSION_STARTED`のSnapshotだけから読みます（`session_projections`の行・列とテーブルは変えない）。Resumeは最後のHandのSessionの最初の保存済みのHandを`sessionHandIds`で引き、その`SESSION_STARTED`から設定を戻します。Snapshotが壊れていればcashとして扱わずにResumeしません（新しいSessionで始め、理由をwarnに残す）。
  - **終了理由**: HeroのBustは既存の`hero_busted`、Heroの優勝は`hero_last_standing`を使い、`session_projections`の`end_reason`のCHECKは変えません（D129）。
  - **CPUのPublic Tournament Context（#188・D109・D130）**: TournamentのHandでだけ、CPUの`KnowledgeState`に`tournament`（`TournamentKnowledge`。§5）を足します。保存しないProjectionで、テーブル・列・Eventの形・`schema_version`は足していません。
    - **入力**: そのCPUに見えるEventのうちpublicの`HAND_STARTED`（席順・Handの開始時のStack・Blind / Ante・`tournament`のLevelと経過）と、`TournamentSessionInfo`（Sessionの設定のSnapshotと参加人数）だけです。参加人数はSessionの最初のHandに座った人数（Resultの Prize Poolと同じ。新しいSessionの最初のHandはそのHandの席）で、Hand OrchestratorがHandの開始時に作りHandの間は同じ値を使います（再要求・Fallback・Emergency Botも同じ入力）。Levelと経過を持たない`HAND_STARTED`（CashのHand・版9のHand）からは作らず例外にします（今のコードが始めるTournamentのHandは必ず持つ）。
    - **形**（`phase8_tournament_knowledge_v1`。OI-007の暫定Policy）: 組み立ての版・ICMのPolicyの版・Payoutの配り方の版・`stackBasis`（`hand_start`）・参加人数・残人数（この Handに座っている人数）・Level・Sessionの何Hand目か・SB / BB・Anteの種類と額（無ければ`none`と0）・Prize Pool・順位ごとの賞金・Stage・全席（席順）の`stack`・`stackBb`・`icmEquity`・`icmEquityPercent`・自分から見た相手ごとの`bubbleFactors`（`riskedChips`・`bubbleFactor`。賭けられないときはnull）。数値は倍精度のまま持ち、丸めるのはPromptに出すときだけです（`docs/02` §7）。
    - **StackはHandの開始時**: ICM EquityとBubble Factorは、Handの開始時（Blind・Anteを払う前）の公開のStackで計算します（Handの途中のStack・Potは`KnowledgeState`の`seats`・`pot`にある。Potに入ったChipの持ち主を決めない）。Handの途中で値は変わりません。判断時点のStackで取るReviewのEvidence（#189）とは時点が違います（OI-007の暫定Policy）。
    - **Stage**（OI-007の暫定Policy）: 残り2人は`heads_up`、残人数が入賞の数以下は`in_the_money`、入賞の数 + 1は`bubble`、それより前は`before_bubble`（D130の3つの段階のどれにも当たらない段階の名前として足した）。
  - **Resume**: 最後のHandのEventから、席・Button・Stackに加えて現在のLevelと経過（hand-countはSession内のHandの数、time-baseはプレイ時間の累計。D128）を作り直します（#184）。最後のHandの`HAND_STARTED`の`tournament`（Levelと、そのHandの開始時のHandの番号・プレイ時間の累計）に、そのHandのプレイ時間（保存した最初のEventと`HAND_FINISHED`の記録時刻の差。負なら0）を足して次のHandのLevelを決めます。同じプロセスの中では、Handのプレイ時間をプロセスの単調な時計で測ります（`docs/03` §1）。
- **意味上の順序（D117）**: 「どちらが先か」で結果が変わる判定（Learning Resetの前後・Opponent Memory Resetの前後・Replayの新しい順・Session内のHandの順・Recentの順・最新のSession Projectionの選択・Resume）は、永続的な単調増加の論理順序で決めます。`created_at`・`started_at`・`recorded_at`等の壁時計の列は表示・監査のMetadataとして残しますが、順序の正本にしません（OSの時刻は後ろへ戻ることがある）。具体（#132）は、マイグレーションv9の追記型の`ordinals`と各順序の表現・レガシーの扱いが§10「論理順序」、Learning Resetの前後とOpponent Memory Resetの前後（v11の区切りは`ordinals`の最大の`ord`を持ち、`ordinals`に行を足さない）が§11です。
- **マイグレーション**: 既存のテーブル・列・保存済みのEventは書き換えず、足すだけにします（D76）。Eventの形を変えるときはschema_versionを上げてupcastを足します。
