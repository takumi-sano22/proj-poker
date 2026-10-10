# Issue #221: UX-06 Live 演出用の公開 Event / View 契約の先行技術検証

## 目的

D140（`docs/06` §16.4）の Presentation Controller が、Hero に見える View / Event だけで Live の演出の順序を復元できるかを、今の REST / SSE / Event Log / Replay の経路を追って確かめる。足りなければ API の拡張を設計する。製品の挙動は変えず、検証テストと設計の記録だけを足す。親 #215 の Gate 0 / Gate 1 は解除しない。UX-07（#222）以降の機能は実装しない。

## 結論（要約）

- **API・Event・永続化の拡張は要らない**。今の `HeroView.log` は、Hero に見える Event（`public` と Hero 宛ての `private`）の**全量**を、配るたびに毎回運ぶ。表示側は「表示済みの seq より大きい Event」を seq の順に取り出せば、演出の時系列をそのまま復元できる（重複・順不同・途中の View の欠落・再接続に強い）。
- 各時点の卓は、`projectHeroView(log.slice(0, i + 1))`（Engine の純関数。`apps/web` は既に `@proj-poker/engine` を実行時に import している）で client が作れ、Replay と同じまとめ方（Action に決まった裁定と直後の `ACTION_TAKEN` を 1 つ）をすると Replay API の `steps` と一致する（裁定を含む Hand で確認。Live と Replay で演出の部品を共有できる）。
- 新しい人間判断が要る API / Event / 永続化の契約は見つからなかった。既存の D の変更も要らない。ただし、**情報境界の既存の残余リスク 1 件**（seq の穴）と、**UX-07 の操作の契約 1 件**（表示が追いつくまでの送信）は、人間の確認を #215 Gate 1 で受ける項目として Issue に記録した（下の「人間判断が要る項目」）。

## 現行のデータ経路

```text
Engine（packages/engine）
  startHand / applyAction / applyPhysicalActions …… Event を発行（seq と Visibility は Engine が付ける。hand-events.ts）
        │  1 回の Command の結果 = 複数の Event（例: 最後の Call → 公開 → Board×3 → Pot×n → 終了）
        ▼
HandOrchestrator（apps/server/src/hand-orchestrator.ts）
  commit(): Event Store へ追記 → projectHeroView(全 Event, hero) を購読者へ 1 通配る
  record(): system の記録（AI_ACTION_INVALID 等）は追記だけで配らない（Hero の View は変わらない）
        │
        ├─ REST の応答（POST /api/hands・/actions・/physical-actions・/reads・/outage）: その時点の HeroView
        └─ SSE（GET /api/hands/:id/stream）: 接続時に現在の HeroView を 1 通、以後 commit ごとに 1 通。complete で server が閉じる
        ▼
apps/web/src/hooks/useHandSession.ts
  selectLatestView: 同じ Hand で log の最後の seq が進んだ View だけを残す（REST と SSE のどちらが先でも良い）
  operate: lastSeqOf(最新の View) を付けて送る → server の staleView が「Hero に見える最後の seq」と違えば 409 stale_view

Replay（apps/server/src/replay.ts）
  replaySteps: 保存済みの Event の Hero に見える分の prefix ごとに projectHeroView（legalActions は null）。裁定(action)+ACTION_TAKEN は 1 step
```

- `HeroView`（`packages/engine/src/projection.ts`）= 卓の見え方（Board・Pot・Stack・Commit・Fold / All-in・自分と公開済みの札・手番・Legal Action・配分の合計）＋ `log`（見える Event の全量）。
- `BOT_THINK_DELAY_MS > 0`（既定 600ms）では Hero の操作の応答は CPU を待たずに返り、CPU の行動は 1 手ずつ SSE で届く。0（テスト）では応答の時点で次の Hero の手番か Hand の終了まで進んでいる（1 通に複数の CPU の行動が載る）。

## 演出に必要な事実と取得元の対応表

| 演出（D140・§16.4） | 必要な事実 | 取得元（今の経路） | 判定 |
|---|---|---|---|
| Blind / Ante | 誰が・いくら | `BLIND_POSTED` / `ANTE_POSTED`（public） | 既存で可（Ante は Scenario 未検証。同じ public の経路） |
| 自分の札の配布 | Hero の札 | `HOLE_CARD_DEALT`（Hero 宛て private）。他者の配布は Event が見えないので、枚数の演出は席数から表示側で作る | 既存で可 |
| 連続する CPU の Action・Chip の移動 | 誰が・種類・出した額・to 額・All-in | `ACTION_TAKEN`（`amount` / `toAmount` / `allIn`）。手番の表示は各時点の卓の `actorId` | 既存で可 |
| Hero の宣言・Chip の操作・裁定 | 操作の列と裁定 | `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING`（public）。裁定(action)と直後の `ACTION_TAKEN` は Replay と同じく 1 つにまとめる | 既存で可 |
| Street の移行（Bet を Pot に集める） | Street の終わり | `BOARD_DEALT` の直前と直後の卓の `streetCommitted` の差（Event は無いが、各時点の卓から決定論で求まる） | 既存で可（派生） |
| Flop 3 枚を順に・Turn・River | Street と札 | `BOARD_DEALT`（Flop は 3 枚を 1 Event）。3 枚を順に出すのは表示側 | 既存で可 |
| Showdown の公開 | 誰が・どの札・順序 | `CARDS_TABLED`（Button の左から。Fold していない全員。All-in の決着待ちでは Runout の Board より前） | 既存で可 |
| 役の名前・勝者 | 役・勝者 | 役は公開の札と Board から `evaluateHand` で表示側が求める。勝者は `POT_AWARDED.awards` | 既存で可（派生） |
| Uncalled の返却 | 誰に・いくら | `UNCALLED_BET_RETURNED` | 既存で可 |
| Main / Side Pot ごとの配分 | Pot の番号・額・争えた人・配分・札で決めたか | `POT_AWARDED`（Pot ごとに 1 つ・Main が先。`potIndex` / `potTotal` / `eligible` / `awards` / `showdown`） | 既存で可 |
| Split Pot・端数 | 配分 | `POT_AWARDED.awards` に複数（端数の行き先も値で入る） | 既存で可 |
| Hand の途中の Pot の内訳（Side Pot の形成の表示） | Pot ごとの額 | Event は無い。各時点の卓の `totalCommitted` / `folded` から `buildPots`（Engine の純関数）で求まる。`big_blind_ante` の Dead Money は `HAND_STARTED.ante` と `ANTE_POSTED` から | 既存で可（派生・未検証） |
| Fold で終わる Hand | 公開なし・獲得 | `POT_AWARDED.showdown: false`・`CARDS_TABLED` 無し | 既存で可 |
| Hand / Session の終了 | 終了・最終 Stack・Session の状態 | `HAND_FINISHED`・SSE の `session` イベント（`SessionStatus`） | 既存で可 |
| Hero の手番の到来 | 手番か・選べる操作 | 最新の View の `legalActions`（Hero の手番のときだけ非 null）・`actorId` | 既存で可 |
| AI 障害で止まった | 止まった CPU・種類 | SSE の `outage` イベント（`OutageStatus`）。Event Log の Event ではない | 既存で可 |

**不足する情報は無い**。Event に無い 3 つ（Street の終わりの Bet の集め、役の名前、途中の Pot の内訳）は、公開の情報だけから Engine の純関数で決定論に求まるので、API を足さない。

## 検証したシナリオと結果

検証テスト（製品のコードは変えない）:

- `packages/engine/src/live-presentation.test.ts`（9 件。参照実装 `presentationSteps` は Replay と同じまとめ方）: 積んだ Deck と Metadata（system の Event）付きで Hand を進め、Orchestrator の `commit` と同じ粒度（Command 1 回 = 1 通の View）で View を作る。
- `apps/server/src/routes/live-presentation.test.ts`（4 件）: 実際に listen した app で REST / SSE / Replay API を使う。

| シナリオ | 確かめたこと | 結果 |
|---|---|---|
| 連続する CPU Action + Hero の物理操作 + Flop / Turn / River + 通常の Showdown | 1 通の View が運ぶ Event の並び（例: Hero の Check の宣言 → 裁定 → Action → Flop が 1 通。River の最後の Check → 公開×3 → Pot → 終了が 1 通）。Board は Street ごとに 1 Event（Flop は 3 枚）。公開は Button の左から、公開の前の時点の卓にはその CPU の札が無い | 通過 |
| All-in の後の Runout + Main / Side Pot + Uncalled | 最後の 1 通に Action → Uncalled → 公開×3 → Board×3 → Pot×2 → 終了。公開の時点の Board は空（先の札が見えない）。Pot の演出の前の Pot は配る Pot の合計（900 + 600）で、Uncalled を二重に数えない | 通過 |
| Split Pot（端数あり） | Pot 25 を 13 / 12（端数は Button の左の勝者）。Fold した CPU の札は最後まで出ない | 通過 |
| Fold で Showdown に至らない終了 | Action → Uncalled → Pot（`showdown: false`）→ 終了。`CARDS_TABLED` 無し、どの時点の卓にも CPU の札が無い | 通過 |
| 情報漏えい（上の 4 つすべて） | 全時点の卓で、その時点で Hero が知り得ない札が無い（`leakedCards`）・Deck / seed / engine / system の語が無い（`hiddenMarkers`）・Board が全 Event で畳んだ State と一致（Future Cards が無い）・見えない Event の中身を差し替えても全時点の卓が同じ（`tamperHiddenEvents`）・各時点で Σ Stack + Pot が開始の合計 | 通過 |
| View だけで最新の卓を作り直せる | `projectHeroView(view.log)` が配られた View と一致（`legalActions` も含む） | 通過 |
| 受信の重複・順不同・欠落 | 同じ View の 2 回受信・古い View の遅着・途中の View が届かない、のどれでも、最後の View を受ければ積んだ Event は全量で、同じ Event を 2 回積まない | 通過 |
| SSE の再接続（server） | 切って張り直した最初の 1 通の log は、切る前の log をそのまま先頭に持ち、切断中に進んだ Event を全部含む | 通過 |
| REST と SSE の重複（server） | REST の応答の View は同じ時点の SSE の View と同一。両方を seq で積むと全量で重複なし | 通過 |
| 古い表示からの操作（server） | 演出の途中（1 通の途中の Event まで表示）の seq で送ると 409 `stale_view`・Event Log は不変。最新の seq なら 200 | 通過 |
| Replay との共有（server） | 物理操作（宣言）で進めた裁定を含む Hand で、Live の log から client で作る演出の単位（裁定(action)＋直後の `ACTION_TAKEN` を 1 つ）= Replay API の `steps`。engine 側でも同じまとめ方で Event より 1 つ少ないことを確認 | 通過（Codex の P2 の指摘で、裁定を含む Hand に広げた） |
| Hero の手番の到来 | 最新の View だけが `legalActions` を持ち、途中の時点の卓（演出中の表示）は持たない | 通過 |

### 検証で分かった注意点

1. **Hero から見た seq は連続しない**。`DECK_SHUFFLED`（engine）・他者の `HOLE_CARD_DEALT`・`HAND_METADATA_RECORDED` / `AI_ACTION_INVALID` / `AI_FALLBACK_USED` 等（system）の分が抜ける。欠落の検出に「seq が 1 ずつ進むか」を使ってはいけない（View は毎回全量を運ぶので、欠落の検出自体が要らない）。
2. **1 通に複数の Event が載る**。表示側が Event 単位に分けずに最新の View を描くと、Flop の 3 枚・All-in の Runout・Showdown と Pot の配分が一度に出る（今の画面の挙動）。D140 の順序の演出には、表示側の分割が必須。
3. **途中の時点の卓は操作を持たせない**。Replay と同じく `legalActions: null` で描き、操作の可否は最新の View（authoritative）だけで決める。

## API 拡張の要否（代替案・推奨・トレードオフ）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A（推奨）: 今の API のまま、client で分割** | 最新の View の log から「表示済みの seq より大きい Event」を取り出し、各時点の卓を `projectHeroView(prefix)` で作る | server・Event・永続化を変えない。情報境界は今の `projectHeroView` の whitelist のまま。Replay と同じ関数で部品を共有できる。重複・欠落・再接続に強い（毎回全量） | 1 通ごとに log の全量を送る（1 Hand は数十〜100 Event 程度で、ローカル単一ユーザーでは無視できる量）。prefix の Projection を client で Event 数だけ作る（同じ理由で軽い） |
| B: SSE に差分（新しい Event だけ）を送る | `event: delta` 等を足し、`Last-Event-ID` で再送 | 通信量が減る | 欠落・再送・順序の契約（`Last-Event-ID`・再送の範囲）を新たに持つ必要がある。Hero に見える seq が連続しないので、欠落の検出に別の番号が要る。API の契約の変更で人間判断が要る |
| C: server が演出用の「表示 step」を作って送る | Replay の `steps` と同じものを Live でも配る | client の計算が要らない | 1 通の大きさが Event 数 × 卓の大きさになる。server に表示の都合（まとめ方）を持ち込む |

案 A を推奨する。B・C は、通信量が問題になる（オンライン化等、非目標）まで要らない。

## UX-07（#222）への実装引き継ぎ（推奨の契約。#215 Gate 1 で人間が承認するまで採用済みの事実として扱わない）

1. **2 つの View を分ける**: `authoritative`（受け取った中で seq の最も進んだ View。今の `selectLatestView`）と `displayed`（演出し終えた時点の卓）。演出のキューは「`displayed` の seq より大きい Event」で、`authoritative` が進むたびに後ろへ足す（seq で重複を捨てる）。
2. **各時点の卓**は `projectHeroView(authoritative.log.slice(0, k))` を `legalActions: null` で作る（Replay の `replaySteps` と同じ。裁定(action)と直後の `ACTION_TAKEN` は 1 つにまとめる）。Hidden Cards・Future Cards・system Event は入力に無いので、演出に入りようがない。
3. **操作の契約（stale_view を防ぐ）**: 送る `lastSeq` は**表示中（`displayed`）の View の値**とし、`authoritative` の値で送らない（演出が追いついていない画面から、Hero が見ていない情報を前提に操作させない）。操作の部品を有効にするのは `lastSeq(displayed) === lastSeq(authoritative)` のときだけ。送信の失敗の再送は今どおり最初の `lastSeq` のまま（server の `stale_view` が二重適用を止める。今回の server テストで確認）。
4. **Hero の手番の到来（Q20）**: `authoritative.legalActions` が Hero の手番を示し、キューが残っていたら、残りの通常の演出を自動で速める。`CARDS_TABLED` / `POT_AWARDED` の内容は省かない（動きだけ短くする）。
5. **再接続・Home からの復帰（Q26）**: `EventSource` の `error` → 次の `view`（今の `connection` が `reconnecting` → `open`）と、Play への復帰を「再同期」とみなし、キューを捨てて `displayed = authoritative` にする。切断中に Hand が終わっていた場合も、最新の View（公開済みの札・Board・`awards`）と log の `POT_AWARDED`（Pot ごとの内訳）で結果を静的に出し、内容は省かない。見逃した分は Replay で見られる（log に残っていることを確認済み）。
6. **Live と Replay の共有**: 演出の部品は「直前の卓・Event・直後の卓」を受け取る形にすると、Live（client の prefix を Replay と同じまとめ方にしたもの）と Replay（API の `steps`）の両方へそのまま渡せる（裁定を含む Hand で一致を確認済み）。再生 / 一時停止 / 速度は Replay 側が別に持つ。
7. **Fast Forward と別**: Fast Forward は server の思考待ちを縮める。表示演出の速度は `displayed` の進み方だけを変え、`authoritative` の受信・server の進行は変えない。
8. **テスト**: 今回の 2 つのテストファイルの参照実装（`pendingEvents` / `stepViews` / `consume`）を製品のコードに移すときは、同じ Scenario（連続 CPU・Runout・Side / Split・Fold・重複・欠落・再接続・stale）を製品のコードに対するテストへ置き換える。

## 人間判断が要る項目（#215 Gate 1 で確認）

1. **（情報境界・既存の残余リスク）Hero から見た seq の穴**: Hero に見えない Event の分だけ seq が飛ぶので、`HeroView.log` の seq の差から「CPU の手番の前に system の記録（`AI_ACTION_INVALID` / `AI_FALLBACK_USED`）があった」ことを推測できる（札・Deck・Persona は分からない）。今の REST / SSE / Replay から既にある性質で、今回の検証で新しく作ったものではない。
   - 選択肢: (a)【推奨】今のまま受け入れ、表示側は seq を画面に出さず、穴を意味づけない（契約に明記）。ローカル単一ユーザーで、分かるのは AI の運用の記録の有無だけ。 (b) Hero 用の通し番号（view seq）を Projection で振り直し、`lastSeq` もそれに切り替える（REST / SSE / Replay / `stale_view` の契約の変更・既存テストの更新が要る）。 (c) system の記録の seq を Hand の末尾側へ寄せる（Event の並びの変更で、`docs/04` の「記録はその手番の Action より前」の規則の変更になる）。
2. **（UX-07 の操作の契約）表示が追いつくまで送信させない**: 上の引き継ぎ 3 は、D91 の手番外の操作（Out-of-Turn）も「表示が追いついてから送る」ことになる（演出の時間の分だけ、手番外の操作の送信が遅れる）。
   - 選択肢: (a)【推奨】下書き（D139）は演出中も作れ、送信だけを追いつくまで止める。Hero が送ろうとしたら残りの演出を自動で速めて追いつかせる。 (b) 演出中の送信を許し、表示中の `lastSeq` で送って `stale_view` を案内で吸収する（誤送信は起きないが失敗が増える）。 (c) 送信時に最新の `lastSeq` を使う（演出を見ていない情報で操作させうるので非推奨）。

どちらも今回の PR では何も変えていない（検証テストと記録だけ）。

## 変更ファイル

- `packages/engine/src/live-presentation.test.ts`（新規・検証テスト）
- `apps/server/src/routes/live-presentation.test.ts`（新規・検証テスト）
- `docs/06_UI_UX.md` §16.4・§16.8: 検証の結果（事実）と、Gate 1 待ちの推奨の契約への導線
- `docs/03_SYSTEM_ARCHITECTURE.md` §2: UX-06 の検証の結果（API 拡張は不要の見込み・承認待ち）
- `docs/04_DATA_AND_EVENTS.md` §4: Hero から見た seq が連続しないこと
- `docs/11_OPEN_ITEMS.md` OI-012: UX-06 の行に検証の結果と人間判断が要る 2 項目
- `docs/taskLog/issue-221-live-presentation-verification.md`（本ファイル）

## 判断理由

- API を足さない案を推奨したのは、今の View が全量を運ぶ性質だけで、重複・欠落・再接続・情報境界の要件を満たせることをテストで示せたため（KISS・Event Log 正本と Projection の whitelist を変えない）。
- 検証の参照実装を製品のコード（`apps/web`）に置かなかったのは、#215 の Gate 0 / Gate 1 が未解除で、UX-07 の機能実装に当たるため。テストファイルの中に閉じた。
- seq の穴と操作の契約は、情報境界と D91 の体験に関わるので、自分では確定せず選択肢と推奨を記録した（`CLAUDE.md` 不変条件 7）。

## 実行した確認

- `pnpm --filter @proj-poker/engine exec vitest run src/live-presentation.test.ts` → 9 passed
- `pnpm --filter @proj-poker/server exec vitest run src/routes/live-presentation.test.ts` → 4 passed（3 回繰り返して安定）
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan に記録）

## 残課題

- Ante（`ANTE_POSTED`）の Tournament の Hand・Hand の途中の Side Pot の内訳（`buildPots` の派生）は、同じ public の経路だが今回の Scenario では検証していない（UX-07 / UX-09 のテストで扱う）。
- 演出の所要時間・自動高速化の度合いは OI-012 の暫定値のまま（今回は決めていない）。
- 上の「人間判断が要る項目」2 つ（#215 Gate 1）。
