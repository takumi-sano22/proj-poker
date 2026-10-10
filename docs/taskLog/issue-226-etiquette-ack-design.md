# Issue #226: UX-11 ETIQUETTE の確認（Ack）待ちで CPU の進行を止める仕組みの先行技術設計

## 目的

D142（RULING を先に数秒出して自動で閉じ、続けて ETIQUETTE を Hero が明示的に確認してから進行を再開する。確認待ちでも Home / Learn へ移動でき、進行の待ちは続く）を、**表示だけで止まったふりをせず server の CPU の進行を実際に止めて**実現するための技術設計の候補を出す。製品の挙動は変えず、Fake CPU による検証テストと記録だけを足す。

- **このログの推奨案はすべて人間の承認前の案であり、採用済みの判断ではない**（`docs/decision_log.yaml` には足さない）。Ack の API・状態の置き場所・優先順位は #215 Gate 1 で人間が承認するまで実装しない。
- #226 の機能の本実装、#222（Presentation Controller）、#230（Session Lifecycle）の本実装はしない。#215 Gate 1 / Gate 2 は解除しない。

## 結論（要約）

1. **Ack が要る裁定は Event Log から決定論で特定できる**。今の Dealer Feedback が ETIQUETTE を出すかどうかは、`DEALER_RULING` の `notes`（`RulingCode`）だけで決まり、`outcome`・`basis`・前後の Event に依らない。対象は 7 種（`out_of_turn` / `string_bet` / `oversized_chip` / `declaration_ignored` / `half_raise_completed` / `under_half_raise` / `check_facing_bet`）。全 14 種の `RulingCode` × 3 種の `outcome` で網羅して確かめた（web の検証テスト）。`DEALER_RULING` は `public` なので、**Ack の対象は Hero の View にある裁定の `seq` だけで指せる**（Hidden 情報を使わない）。
2. **今の server は ETIQUETTE の裁定の直後に、Ack を待たず次の CPU に判断を求める**（server の検証テスト）。止める仕組みが無いので、D142 は client の表示だけでは満たせない。
3. **止める位置は `runCpuTurns` のループの先頭（`canRun`）で足りる**。CPU の思考待ち（`wait`）・判断（`cpuTurn`）の前で、拘束した Out-of-Turn の裁定（Hero の要求の外で `resolveHeroOutOfTurn` が置く）の後もループの先頭に戻る。CPU の判断待ちの間に入った Hero の操作は、既存の `isCurrent` で待っていた判断（Timeout の障害を含む）を捨てるので、遅れて届いた判断が Ack より先に適用されることは無い。
4. **推奨（承認待ち）は「案 A: Ack の状態を Event にせず、`HandRuntime` のメモリに持つ」**。Ack が要るかは Event Log から導き、メモリに持つのは「どの裁定まで確認したか（`ackedThroughSeq`）」だけ。Hand 途中の完全復帰を求めない D62 により、再起動で失われても困らない。Event の版・DB・Migration・Replay は変えない。ただし **新しい API（Ack の POST と状態の配信）が要る** ＝ Issue の停止条件「ACK の新しい API 契約が必要」に該当するため、ここで止めて人間判断を求める。
5. 今は **CPU の障害（Outage）で止まっている間も Hero の物理的な操作を受け付ける**ので、障害と Ack 待ちは同時に起こりうる（検証テスト）。優先順位の定義が要る（下の §7）。

## 現行の Dealer Feedback と CPU 進行のデータフロー

```text
Hero の操作（client: ChipControls → useHandSession）
  POST /api/hands/:handId/physical-action {lastSeq, actions}
    → HandOrchestrator.heroPhysicalAction
        staleView(lastSeq) … Hero に見える最後の seq と違えば 409 stale_view
        applyPhysicalActions（Engine。Ruling Engine で裁定）
          手番: PLAYER_DECLARED / PHYSICAL_CHIP_ACTION … → DEALER_RULING(outcome: action|no_action) → [ACTION_TAKEN → Street / Showdown / HAND_FINISHED]
          手番外: … → DEALER_RULING(outcome: out_of_turn, notes: [out_of_turn])、State に pendingOutOfTurn を残す
        commit（1 回の追記 → SSE の view を配る）
        proceed → advance → runCpuTurns（botDelayMs = 0 なら同じ要求の中で、> 0 なら非同期に）
          while canRun（closed でない・failure なし・outage なし）:
            手番が Hero: pendingOutOfTurn があれば resolveHeroOutOfTurn（DEALER_RULING basis: pending_out_of_turn。
                         notes は out_of_turn_binding + 裁定の notes / out_of_turn_released）を追記して continue、無ければ return
            手番が CPU: wait（思考待ちの演出。Fast Forward なら飛ばす）→ cpuTurn
                         ask（判断待ち・Timeout で outage）→ isCurrent（Log が進んでいれば捨てる）→ 検証 → commit
  ← 応答: {view, outage}
client
  HeroView.log の DEALER_RULING から dealerFeedbackAt で RULING / ETIQUETTE / COACHING を作る（表示の派生。Event は増やさない）
  ETIQUETTE の文言は dealer-feedback.ts の表（RulingCode → 文言）だけが持つ
```

止める仕組みが無いので、今は「ETIQUETTE の文言を出している間に、server はもう次の CPU を進めている」。

## 検証テストで確かめた事実

| # | 事実 | テスト |
|---|---|---|
| 1 | ETIQUETTE の有無は notes だけで決まり、候補の 7 種と一致する（全 RulingCode × 全 outcome） | `apps/web/src/lib/etiquette-ack-verification.test.ts` |
| 2 | 1 つの裁定の複数の notes は、ETIQUETTE の文言が複数でも裁定は 1 つ（Ack の単位は裁定の `seq`） | 同上 |
| 3 | Hero 以外への裁定・Hero 以外の viewer には ETIQUETTE を出さない（物理的な誤操作は Hero だけ。D91） | 同上 |
| 4 | 手番の Oversized Chip: 裁定と Hero の Call を 1 回で追記した**同じ要求の中で**、次の CPU に判断を求める。Ack の要る裁定の seq は Hero の View と全 Log で一致 | `apps/server/src/etiquette-ack-verification.test.ts` |
| 5 | Out-of-Turn: 保留の裁定の後も CPU は進み、拘束の裁定（`out_of_turn_binding` + `oversized_chip`）は **Hero の操作とは別の追記**で `runCpuTurns` が置く。保留の前に求めた判断は捨てて求め直す | 同上 |
| 6 | CPU の判断が Timeout する前に Hero の Out-of-Turn が入ると、遅れて届いた障害は `isCurrent` で捨てられ、障害の状態は立たない | 同上 |
| 7 | CPU の障害で止まっている間も Hero の Out-of-Turn は追記される（障害と Ack 待ちが同時に立つ）。Retry すると Ack を待たずに CPU が進む | 同上 |
| 8 | Hand を終える裁定（宣言 2 回 → `declaration_ignored` で Fold）は同じ追記に `HAND_FINISHED` を含み、止める CPU の進行が残らない。終わった Hand への追記は Store が拒否する | 同上 |

## 検証項目ごとの分析

### 1. Ack が要る裁定を決定論で特定できるか

できる。条件は「`DEALER_RULING` で `playerId` が Hero、かつ `notes` に 7 種のいずれかを含む」。

- 今この対応表を持つのは client（`dealer-feedback.ts` の `ETIQUETTE`）だけ。server が止めるには同じ集合を server も使う必要がある。実装時は **集合（文言ではない）を Engine の純粋関数（例: `requiresEtiquetteAck(notes)`）へ移し、client の文言の表をその集合に型で縛る**のが最小（文言は client に残す）。文言の表と集合がずれない保証は、今回の web の検証テストを実装時の単体テストへ置き換えて持つ。
- Ack の要否を決める入力は公開の `DEALER_RULING` だけなので、CPU の Hidden Cards・Future Cards・system Event を使わない。

### 2. `action` / `no_action` / `out_of_turn` と、保留した Out-of-Turn の拘束・撤回

| 裁定 | 例 | Ack が要るか | 止めた時点の卓 |
|---|---|---|---|
| `action` | Oversized Chip → Call、String Bet、50% 規則、宣言の重複 | notes 次第 | Hero の Action は**適用済み**。止めるのは次の CPU の進行だけ（Ack は Hero の Action を保留しない） |
| `no_action` | 相手の Bet があるときの Check の宣言（`check_facing_bet`） | 要る | 手番は Hero のまま。Ack の後に Hero が選び直す |
| `no_action` | 撤回した Out-of-Turn（`out_of_turn_released`） | 要らない | 手番は Hero のまま |
| `out_of_turn` | 手番外の操作（`out_of_turn`） | 要る | 手番は CPU。**Ack まで CPU を動かさない**（保留は State に残る） |
| `action`（basis: `pending_out_of_turn`） | 拘束（`out_of_turn_binding` のみ） | 要らない | Hero の Action は適用済み |
| `action`（basis: `pending_out_of_turn`） | 拘束 + Oversized Chip 等 | 要る | 同上。Hero の要求の外で置かれる 2 つ目の Ack 待ち |

保留の Out-of-Turn は「保留の裁定で一度止まる → Ack で CPU が進む → Hero の手番で拘束 / 撤回の裁定 → 拘束に Ack の要る notes があれば再び止まる」の順になる。拘束・撤回の規則（D91）と Event（D90）は変えない。

### 3. Hero の操作の後、どこで止めるか

- **止める位置: `runCpuTurns` のループの先頭**（実装では `canRun` に「Ack 待ちが無い」を足す）。理由:
  - `wait`（思考待ちの演出）・`cpuTurn`（判断）の両方より前で、Fast Forward の有無に関わらず効く。
  - 拘束の裁定（`resolveHeroOutOfTurn`）の後もループの先頭に戻るので、Hero の要求の外で出た Ack 待ちでも止まる（事実 5）。
  - `cpuTurn` の中の `isCurrent` も `canRun` を使うので、Ack 待ちの間に判断が返っても適用しない。
- `heroPhysicalAction` の中（commit の直後）で止めるだけでは足りない（拘束の裁定は Hero の要求の外で出る）。client だけで止めるのは Issue の DoD に反する（事実 4）。
- Ack を受けたら `ackedThroughSeq` を進め、`running` が残っていれば終わるのを待ってから `proceed` する（`resolveOutage` と同じ形）。

### 4. CPU の思考待ち・推論中に新しい RULING / ETIQUETTE が出る Race

- Hero の手番外の操作は CPU の判断待ちの間に入りうる（`lastSeq` は CPU の判断を追記する前の値で一致する）。追記で Log が進むので、待っていた判断は `isCurrent` で捨てられる（事実 5・6。Timeout の障害も捨てられる）。ループの先頭に戻ったところで Ack 待ちで止まる。
- 残るのは**費用と遅れ**: 捨てた判断の推論（Claude の呼び出し）は無駄になり、Ack の後の再開は、捨てる判断が返る（または Timeout する）まで待つ（`advance` は `running` を共有するため）。実装では、Hero の操作で Log が進んだときに待っている判断の `AbortController` を abort して早く返す案がある（今の `cancelWait` と同じ仕組みで足りる。人間判断は不要な実装の詳細）。
- 二重に進める Race は無い: `advance` は `running` があれば同じ Promise を返し、同じ手番を 2 回判断させない（既存）。

### 5. Ack の識別子・再送・二重クリック・古い Ack・別 Hand への誤送信

推奨の契約（承認待ち）:

- **識別子は `(handId, rulingSeq)`**。`handId` は URL のパス、`rulingSeq` は Hero の View にある公開の `DEALER_RULING` の `seq`。Hero に見えない値（system Event の seq・CPU の情報）を使わない。
- **冪等**: 待っている裁定の `rulingSeq` なら受けて再開する。**すでに確認した `rulingSeq`（`<= ackedThroughSeq` で Ack の要る裁定）なら何もせず 200**（二重クリック・応答の消えた再送）。
- **古い・未来・存在しない `rulingSeq`**（Ack の要らない裁定の seq を含む）は 409 `stale_etiquette`（`stale_outage` と同じ形）。別 Hand の ID は今どおり 404 / その Hand の状態で判定する（Hand をまたいだ誤送信は seq が一致しても Hand が違うので効かない）。
- **Ack 待ちの間の Hero の操作**（`physical-action` / `action`）は 409 `etiquette_ack_required` で拒否する（推奨）。理由: D142 は「明示的に確認」なので操作での暗黙の確認にしない。拒否すれば待ちの裁定は常に 1 つになる（§8）。User Read（`USER_READ_RECORDED`）は CPU を進めないので拒否しなくてよい。
- `stale_view` の契約（D143）は変えない。案 A の Ack は Event を追記しないので、Ack で `lastSeq` は変わらない。

### 6. Home / Learn への移動・通信断・再接続・再起動

- Ack 待ちは server（`HandRuntime`）が持つので、client が画面を離れても待ちは続く（D142）。Play に戻ったとき・再接続したときは、**今の `outage` と同じく REST の応答と SSE の初回送信で Ack の状態を返し**、client はそれで ETIQUETTE の確認を出し直す（D140 の「再接続では古い演出のキューを捨てて最新の公開状態に合わせる」と両立する。RULING の自動表示は飛ばして ETIQUETTE の確認だけを出し直してよい）。
- **プロセスの再起動**: 進行中の Hand はメモリだけにあり、再起動で消えて最後に終わった Hand から Resume する（D62）。Ack 待ちも一緒に消えるので、復元するものが無い。Ack を Event にしない案 A でも困らない理由はこれ。
- `GET /api/session/current`（D144）は Ack 待ちを `in_hand` として返すだけでよい（状態の種類を増やさない。Ack 待ちを Home に出すかは UX-03 の表示の判断）。

### 7. CPU Outage・Emergency Bot・Session 終了予約（#230）・Hand の自然終了との優先順位

推奨（承認待ち）:

| 状況 | 推奨の扱い | 根拠 |
|---|---|---|
| Hand の自然終了（裁定と同じ追記に `HAND_FINISHED`） | **server は待たない**（止める CPU の進行が無い）。client は ETIQUETTE の確認を出してよいが、次の Hand の開始を server で拒否しない | 事実 8。終わった Hand に Ack を残せない（案 B でも同じ） |
| CPU の障害（Outage）と Ack 待ちが同時 | 障害のダイアログを先に出す（進行を選ぶのが先）。Retry / Emergency Bot を選んでも、Ack の前は CPU を進めない（`canRun` に両方の条件を入れる） | 事実 7。今は Retry で Ack を待たずに進む |
| 障害で Session 終了を選んだ | `HAND_ABORTED` で Hand が終わるので Ack 待ちは消える | 打ち切った Hand は手番が無い |
| Emergency Bot の CPU | 同期の RuleBot でも同じループを通るので、同じく止まる | 停止点がループの先頭なので経路に依らない |
| 内部エラー（`failure`） | 今どおり進行を止める。Ack を受けても進めない | `canRun` |
| Session 終了 / 一時中断の予約（#230 Q30・Q31） | 予約は Hand の完了時に適用され、Ack は Hand の途中だけの待ちなので**直交**。Ack 待ちの間に予約しても Hand は Ack の後に最後まで進む | #230 の契約は未確定。衝突は無い見込みだが #230 の設計 PR で再確認する |
| Fast Forward（Hero Fold 後） | Ack 待ちの間は思考待ちも判断も始めない。Fold の裁定に Ack が要るとき（`declaration_ignored` など）も止まる | 停止点が `wait` の前 |
| Hero の手番の到来 | `no_action` の裁定は Ack の後に Hero が選び直す（Ack 待ちの間の操作は拒否） | §5 |

### 8. 複数の裁定が続いたときの表示順序・Ack 数・再開条件

- **1 回の追記に Hero への裁定は最大 1 つ**（`applyPhysicalActions` も `resolvePendingOutOfTurn` も `DEALER_RULING` を 1 つ置く）。§5 の推奨（Ack 待ちの間の操作を拒否）なら、**待っている裁定は同時に最大 1 つ**になる（保留の裁定と拘束の裁定の間には必ず Ack が入る）。
- 表示順序（D142・D140）: 裁定ごとに RULING（OI-012 の数秒で自動で閉じる）→ ETIQUETTE（Ack まで）→ 後続の Event の演出。同じ裁定の ETIQUETTE が複数の文言でも Ack は 1 回（事実 2）。
- 再開条件: 「Hand が途中・`failure` なし・`outage` なし・Ack の要る裁定のうち最も新しい seq が `ackedThroughSeq` 以下」。
- 防御として、Ack は「その seq までの Ack の要る裁定をすべて確認した」とみなす（`ackedThroughSeq = max(ackedThroughSeq, rulingSeq)`）。最大 1 つの不変条件が将来崩れても、古い裁定の Ack 待ちが残らない。ただし送れるのは待っている（最新の）裁定の seq だけ（§5）。
- Ack の要らない裁定（拘束のみ・撤回・額の調整等）は server を止めない。RULING の自動表示の間に後続の CPU の演出が待つのは client の演出の順序（D140）の責務で、server の契約ではない。

### 9. Ack や待機状態を Event Log に追記する必要があるか

推奨は**追記しない（案 A）**。比較は次節。

## 設計候補の比較

| 観点 | **案 A（推奨・承認待ち）: server のメモリに Ack の位置を持つ** | 案 B: Ack を Event（例: `ETIQUETTE_ACKNOWLEDGED`、schema_version 11）にする | 案 C: client の表示だけで待つ |
|---|---|---|---|
| CPU の停止の保証 | server（`canRun`）で保証 | server で保証 | **保証しない**（事実 4。Issue の DoD に反する） |
| Ack の要否 | Event Log から導く（決定論） | 同左 | client の表 |
| 持つ状態 | `HandRuntime.ackedThroughSeq`（Outage・Fast Forward と同じメモリだけの進行制御） | Event Log だけ（Orchestrator は状態を持たない） | client の state |
| Event / DB / Migration | 変えない | 版 11・upcast（無い版は「Ack 無し」と読む）・Projection / Replay / Stats / KnowledgeState の除外の確認が要る | 変えない |
| Hand を終える裁定 | 待たないので問題なし | **Ack を残せない**（終わった Hand への追記は拒否。事実 8）→ 例外の規則が要る | — |
| `lastSeq` / `stale_view`（D143） | 影響なし（Ack は seq を進めない） | Ack が seq を進めるので、client は Ack の応答の View で `lastSeq` を取り直す必要がある | 影響なし |
| 再起動 | 進行中の Hand ごと消える（D62）ので復元不要 | 同じく進行中の Hand は保存されない（SQLite は Hand の終わりで保存）ので、Event にしても再起動の復元には効かない | — |
| Replay / Review | 変えない（Replay は Ack を待たない） | Replay で Ack の位置を再生できるが、表示の状態を Event に入れない方針（`docs/04`・D139〜D141）と緊張する | 変えない |
| 学習の分析（確認までの時間など） | できない | できる | できない |
| 新しい API | 要る（Ack の POST・状態の配信） | 要る（同左） | 要らない |

推奨理由: 停止の保証は案 A と B で同じで、案 B の利点（Ack の記録）は今の要件（D142・Issue の DoD）に無い。案 B は Hand を終える裁定で例外が要り、`stale_view` の契約にも影響する。Event Log の正本性（D37）は、Ack の**要否**を Log から導き、メモリに持つのを「確認した位置」だけにすることで保つ（Outage の待ちと同じ扱い）。

## 推奨の Ack スキーマ案（承認待ち・Hero の公開情報だけ）

```ts
// REST の応答（POST /api/hands・action・physical-action・outage・etiquette-ack）と SSE の `etiquette` イベントで返す。
// Hero に見える公開の DEALER_RULING の seq だけを持つ（文言・notes は client が HeroView.log から作る）。
interface EtiquetteAckStatus {
  /** 状態が変わるたびに増える（REST と SSE のどちらが先に届いても新しい方を選ぶ。OutageStatus と同じ）。 */
  readonly revision: number;
  /** Ack を待っている裁定の seq（Hero の View の DEALER_RULING）。待っていなければ null。 */
  readonly pendingRulingSeq: number | null;
}

// POST /api/hands/:handId/etiquette-ack
interface EtiquetteAckBody {
  readonly rulingSeq: number; // 待っている裁定の seq
}
// 200 {view, outage, etiquette}: 受けた（待ちが解けて CPU の進行を再開した）、またはすでに確認済みの seq（何もしない）
// 409 stale_etiquette: 待っている裁定の seq でない（古い・未来・Ack の要らない裁定）
// 404 hand_not_found
// Ack 待ちの間の action / physical-action: 409 etiquette_ack_required（Hand の状態は変えない）
```

## 状態遷移と停止ポイント

```text
                     Hero の操作 / 拘束の裁定で、Ack の要る DEALER_RULING を追記
   ┌──────────┐  ───────────────────────────────────────────▶  ┌──────────────────┐
   │ Running  │                                                │ AwaitingAck(seq) │
   │（CPU 進行）│  ◀───────────────────────────────────────────  │ CPU を進めない     │
   └──────────┘   POST etiquette-ack {rulingSeq: seq}（冪等）     │ Hero の操作は 409 │
        │  ▲                                                    └──────────────────┘
        │  │ resolveOutage（retry / emergency_bot）                 │   │
        ▼  │                                                     │   │ Outage が同時に立つ（Hero の手番外の操作が障害中に入る）
   ┌──────────┐                                                  │   ▼
   │ Outage   │  ── retry / emergency_bot ──▶ Ack 待ちが残っていれば AwaitingAck へ
   └──────────┘  ── end_session ──▶ HAND_ABORTED（Ack 待ちは消える）
        Hand の完了（HAND_FINISHED / HAND_ABORTED）: どの状態からでも Ack 待ちは消える（server は待たない）

停止ポイント: runCpuTurns の while 条件（canRun）＝ wait（思考待ち）と cpuTurn（判断）の前。
              cpuTurn 内の isCurrent も canRun を使うので、待ちの間に返った判断は適用しない。
```

## Outage / Resume / Replay / Tournament / Drill への影響（案 A）

- **Outage**: §7 のとおり `canRun` に両方の条件を入れる。`OutageStatus` と `EtiquetteAckStatus` は別の revision を持つ（片方の更新で他方の古い選択を弾かない）。
- **Resume（D62・D95）**: 進行中の Hand は再起動で消えるので変化なし。Session Projection は変えない。
- **Replay（D38・D93・D140）**: Event を足さないので変化なし。Replay は保存済みの裁定を出すが Ack を待たない（Replay の再生・一時停止は Live と独立。D140）。
- **Review**: Hero の判断時点の情報は変わらない（Ack は判断ではない）。COACHING は今どおり Hero が開いたときだけ。
- **Tournament（D128）**: Level の経過は Hand のプレイ時間（`playClock`）で測るので、Ack 待ち（と Home / Learn にいる時間）もプレイ時間に入る。今の Hero の思考時間・障害の待ちと同じ扱いになる（変える場合は人間判断。下の UX11-5）。
- **Drill（D116）**: `startDrill` も同じ `HandRuntime` と `runCpuTurns` を通るので同じく止まる。追加の分岐は要らない。
- **CPU の KnowledgeState（D28）**: Ack は CPU に見せない（案 A は Event を足さないので自動的に満たす）。CPU は今どおり公開の裁定（`rulingHistory`）だけを見る。

## 実装時の検証テスト（server の結合テスト）と E2E への引き継ぎ

server（Fake CPU。今回のテストの `fakeCpus` の「判断を求めた時点の Log を記録する」形を流用）:

- Ack の要る裁定の後、Ack まで `decide` が呼ばれない（`botDelayMs` = 0 と > 0 の両方。Fake Timers で思考待ちも確かめる）。Ack の後に再開し、Hand を最後まで進めて Chip の総量が変わらない
- 保留の Out-of-Turn: 保留の裁定で止まる → Ack → CPU → 拘束（+ Oversized Chip）で再び止まる → Ack → 進む / 撤回なら止まらない
- 冪等: 同じ `rulingSeq` の二重の Ack は 200 で何もしない / 古い・未来・Ack の要らない seq は 409 / 別 Hand は 404 / Ack 待ちの間の操作は 409 で Log を変えない
- Race: 判断待ちの間の手番外の操作 → 返った判断を適用しない・障害を立てない（今回の事実 6 を回帰に）
- 障害と同時: 障害の間の手番外の操作 → Retry / Emergency Bot の後も Ack まで止まる / Session 終了で Ack 待ちが消える
- Hand を終える裁定は待たない / Fast Forward 中 / Drill / Tournament / アプリの終了（`close`）で待ちを残さない
- SSE: 接続時に Ack の状態を 1 回送り、変わるたびに送る（再接続・Home からの復帰）

E2E（UX-12 #227 へ引き継ぐ条件）:

- 実際の画面で RULING が OI-012 の秒数で自動で閉じ、ETIQUETTE の確認まで卓の CPU の Action が増えない（server の Log と画面の両方）
- Ack 待ちのまま Home / Learn へ移って戻ると ETIQUETTE の確認が出直す / ブラウザの再読み込み・SSE の切断と再接続でも同じ
- 二重クリック・Enter の連打で Ack が 1 回だけ効く / 狭い画面で Overlay が Hero 欄に隠れない（#226 WHAT）
- 障害のダイアログと ETIQUETTE が重なったとき、障害が先に出る

## 人間判断が必要な論点（#215 Gate 1 で承認を求める。いずれも未採用）

| ID | 論点 | 推奨 | 他の選択肢 |
|---|---|---|---|
| UX11-1 | Ack の状態の置き場所 | **A**: server のメモリ（`ackedThroughSeq`）。要否は Event Log から導く。Event / DB は変えない | B: Event（版 11）に残す（記録できるが、終わった Hand で例外・`stale_view` への影響・Migration） |
| UX11-2 | Ack の API 契約 | `POST /api/hands/:handId/etiquette-ack {rulingSeq}`、REST の応答と SSE の `etiquette` イベントで `{revision, pendingRulingSeq}` を返す。二重は 200、古い seq は 409 `stale_etiquette` | 状態を `HeroView` に埋め込む（Engine の Projection の契約を変えるので非推奨） |
| UX11-3 | Ack 待ちの間の Hero の操作 | **拒否**（409 `etiquette_ack_required`）。明示の確認だけで再開（D142） | 操作を暗黙の Ack として受ける（待ちの裁定が複数になりうる） |
| UX11-4 | 優先順位 | §7 の表: 自然終了は待たない・障害のダイアログが先で Retry の後も Ack まで止める・Session 終了で消える・#230 の予約とは直交 | 自然終了の後も次の Hand の開始を Ack まで server で拒否する |
| UX11-5 | Tournament のプレイ時間 | 今どおり Ack 待ちもプレイ時間に入れる（Hero の思考・障害の待ちと同じ） | Ack 待ちの間は Level の時計を止める（`playClock` の扱いの変更） |

いずれかを承認した後、実装の前に `docs/decision_log.yaml` へ新しい D 番号で記録し、`docs/02`・`03`・`04`・`06`・`11` を同期する（`decision-log` skill）。

## 変更ファイル

- `apps/server/src/etiquette-ack-verification.test.ts`（新規。Fake CPU で今の Orchestrator の振る舞いを固定する検証テスト 5 件）
- `apps/web/src/lib/etiquette-ack-verification.test.ts`（新規。ETIQUETTE の要否が notes だけで決まることの網羅テスト 17 件）
- `docs/taskLog/issue-226-etiquette-ack-design.md`（このファイル）
- `docs/03_SYSTEM_ARCHITECTURE.md`・`docs/04_DATA_AND_EVENTS.md`・`docs/06_UI_UX.md`・`docs/11_OPEN_ITEMS.md`（UX-11 の検証の記録への参照を 1 行ずつ。採用済みとは書かない）

製品のコード（Engine・Orchestrator・Route・client）・Event・DB は変えていない。

## 判断理由

- 停止の保証を server に置くのは、Issue の DoD（表示制御だけで止まったふりをしない）と事実 4 から。
- 案 A を推奨するのは、§「設計候補の比較」のとおり、停止の保証が案 B と同じで、Event の版・Migration・`stale_view` の契約を動かさずに済むため（KISS・D37 / D62 との整合）。
- 検証テストは今の振る舞いを固定する形にした（実装の先取りをしない）。実装時はこのテストの期待（「Ack を待たずに進む」）が反転する。その時点で本テストは実装のテストへ置き換える。

## 実行した確認

- 検証テスト単体: `apps/server` で `npx vitest run src/etiquette-ack-verification.test.ts`（5 passed）、`apps/web` で `npx vitest run src/lib/etiquette-ack-verification.test.ts`（17 passed）
- 品質チェック（ルート）: `pnpm lint` 0 / `pnpm typecheck` 0 / `pnpm test` 0（engine 489・web 179・server 926 passed）/ `pnpm format:check` 0

## 残課題

- UX11-1〜5 の人間判断（#215 Gate 1）。承認の後に D 番号の採番と docs の正本化（別 PR）、その後に #226 の実装
- 捨てた判断の推論の abort（§4）は実装時の最適化として扱う
- #230 の Session Lifecycle の設計 PR で、予約と Ack 待ちの直交を再確認する
- 今回の検証テストは実装時に反転・置き換える（実装 PR の DoD に含める）
