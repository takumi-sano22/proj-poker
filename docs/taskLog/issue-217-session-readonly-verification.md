# Issue #217: UX-02 Home 向けの副作用の無い Session 状態照会の技術検証

## 目的

D136（起動時は Home・Home は読み取り専用の Session 状態の照会だけを使う）を支える照会を、今の `HandOrchestrator` / Session Projection / SQLite の Resume で作れるかを確かめ、API 契約の案を出す。製品の挙動は変えず、検証テストと記録だけを足す。新しい API・Session Lifecycle の永続化は人間の承認まで作らない。#230（Session の任意終了・一時中断）と #222（Presentation Controller）は実装しない。#215 Gate 1 / Gate 2 は解除しない。

## 結論（要約）

- **照会に要る値は、読むだけの経路から揃う**。今の Session の指し先（`HandOrchestrator` の private な `session`）・その Hand の Event（`sessionStatus`）・Session の種類（`sessionKindOf`。Tournament は `SESSION_STARTED` の Snapshot）で、`none` / `in_hand` / `ready_for_next_hand` / `ended` と cash / Tournament（Preset）を区別できる。読む経路を何度呼んでも、Event の追記・Hand の開始・Opponent の生成と判断（Claude の呼び出しの唯一の入口）は起きない（検証テスト）。
- **ただし今は公開の読み取り経路が無い**。Session の指し先は private で、Home が使える HTTP の GET も無い（今の Hand の API は `POST /api/hands` の開始と、Hand ID を知っている前提の GET だけ）。照会には Orchestrator の新しい読み取り専用のメソッドと GET の Route が要る ＝ **API の追加**（D136 の「API の形は UX-02 で決める」の対象。人間の承認が要る）。
- **Store（Session Projection）だけから作ってはいけない**。Projection が `ready_for_next_hand` でも、卓の設定が変わっていれば Orchestrator は続けない（照会は `none` が正しい）。また内部エラーで止まった Hand は Event だけ見ると `in_hand` だが、開始は新しい Session を作る。照会は **開始（`startHand`）と同じ判定**（`resumeSession`・`unseenLatestHand`）から作る必要がある（検証テストでずれを再現）。
- 永続化・Event・DB の変更は要らない（照会は今の Event Log と Projection を読むだけ）。#230 の Pause / End の状態は今は存在せず、照会の状態の列は #230 の設計で増える（拡張の境界は下の「#230 との互換の境界」）。

## 現行の経路と保証の範囲

```text
起動（index.ts → buildApp → new HandOrchestrator）
  constructor → resumeSession(): store.latestSessionProjection(Drill の Hand を除く) を読むだけ
      Projection が ready_for_next_hand で、最後の Hand の席が今の卓の設定にそろい、次 Hand の席を決められるときだけ
      Session の指し先（sessionId・lastHandId・設定・参加者・Emergency Bot）を戻す。追記・Opponent の生成はしない
POST /api/hands（開始。冪等）
  unseenLatestHand(afterHandId): このプロセスの最後の Hand が進行中、または結果を client がまだ見ていなければその Hand を返す
      （内部エラーで止まった Hand・打ち切った Hand・再起動前の Hand は返さない）
  それ以外は次の Hand を作る（Session が続けば持ち越し、終わっていれば新しい Session）
SqliteEventStore
  進行中の Hand はメモリ（pending）だけ。HAND_FINISHED / HAND_ABORTED で Hand と Session Projection を 1 トランザクションで保存
  → 再起動で途中の Hand は消え、最後に終わった Hand から Resume（D62。Hand 途中の完全復帰は無い）
apps/web
  起動時に自動で開始しない（開始はボタンの操作だけ）。Home の画面と照会はまだ無い（UX-03 #218）
```

| 状況 | 照会の答え（PoC） | 「続きから」を押したとき（今の `POST /api/hands`、`afterHandId: null`） | テスト |
|---|---|---|---|
| Cold Start（DB が空） | `none` | 新しい Session（cash） | ✅ |
| このプロセスの Hand の途中（Hero の手番） | `in_hand`・Hand ID | その Hand を返す（`created: false`） | ✅（読んでも Log・CPU は進まない） |
| CPU の思考の途中 | `in_hand` | 同上 | ✅（判断の要求を増やさない） |
| このプロセスで Hand が終わり Session が続く | `ready_for_next_hand`・Hand ID | 結果を見ていなければその Hand、見ていれば次の Hand（`afterHandId` で区別） | 既存（hand-orchestrator.test.ts） |
| このプロセスで Session が終わった（AI 障害の後の終了・Bust・勝ち残り） | `ended` | 新しい Session | ✅（AI 障害の後の終了） |
| 再起動（Hand の合間） | `ready_for_next_hand`・Hand ID なし | 同じ Session の次の Hand | ✅（起動と照会で追記・Opponent の生成なし） |
| 再起動（Hand の途中） | 最後に終わった Hand から `ready_for_next_hand` | 同じ Session の次の Hand（途中の Hand は消える） | ✅ |
| 再起動（卓の設定を変えた） | `none`（Projection は ready のまま） | 新しい Session | ✅ |
| 再起動（Session は終わっていた） | `none` | 新しい Session | ✅ |
| Tournament の再起動 | `ready_for_next_hand`・Preset | 同じ Preset の次の Hand | ✅ |
| Drill の Hand が最後に保存された | 通常の Session を指す（Drill は `excludeFromResume` で除く） | 通常の Session の次の Hand | ✅ |
| 内部エラーで止まった Hand | **PoC は `in_hand`（ずれ）** | 新しい Session | ✅（ずれの再現） |

検証テスト: `apps/server/src/session-readonly-verification.test.ts`（10 件。SQLite の再起動は同じ DB の開き直しで代える）。

## 副作用の無いことの確かめ方

- Event の追記: Event Store の指紋（Hand ごとの Event の件数と論理順序の最後の番号）を照会の前後で比べる
- Hand の開始: 指紋の Hand の数が増えないこと（`startHand` を呼ばない）
- CPU の進行・Claude の呼び出し: Opponent の生成と `decide` の回数を数える（Claude の CPU も `decide` からしか呼ばれない）。CPU の思考の途中（判断を止めた状態）でも照会で回数が増えない
- 課金: Claude の呼び出しが起きないことで代える（照会の経路は Claude Client を持たない）

## API 契約の案（未承認。人間の判断の材料）

```text
GET /api/session/current        ← 名前は案
200 { "session": null }                                   … 続けられる Session が無い（Cold Start・終わった・続けられない）
200 { "session": {
        "state": "in_hand" | "ready_for_next_hand" | "ended",
        "kind": { "mode": "cash" } | { "mode": "tournament", "presetId": "stt6_hand_count" | … }
      } }
```

- 載せない: Session ID・Hand ID・Stack・席・Persona・札・seed（Home の表示に要らない。Issue の「不要な機密を載せない」）。
- 「続きから遊ぶ」は今の `POST /api/hands`（冪等な開始。進行中ならその Hand、再起動後なら同じ Session の次の Hand）を、Hero の明示の操作で呼ぶ（UX-03 #218 の経路）。GET の結果で POST を自動で呼ばない。
- 実装は Orchestrator に読み取り専用のメソッドを足し、`resumeSession` / `unseenLatestHand` と同じ判定から作る（Store だけから作らない）。`in_hand` には CPU の障害の待ち（`outage`）を含む。
- 同時に開いた複数のタブ・照会と開始の競合: 照会は値を返すだけで状態を変えないので競合しない。照会の後に状態が変わる（CPU が進む・Hand が終わる）ことはあり、Home は押した時点の `POST /api/hands` の応答を正とする。

## #230 との互換の境界

- 「Home への移動」は Session の Pause / End ではない（Q31=B・D136）。照会は画面の移動で何も書かない。
- #230 の `active / paused / ended` と Hand の間だけ確定する Pause / End・Hand 中の予約（揮発）は、今は存在しない。照会の状態の列は **追加で拡張** する（例: `paused` を足す）。client は知らない `state` を「続きから」を出さない扱いにする、を契約に入れておくと #230 で壊れない。
- Hand 中の予約は揮発（再起動で失効。Q44=A）なので、照会に予約を出すとしても再起動後は出ない。#217 では予約を扱わない。
- 途中の Hand を推測して新しい Session の開始・mode の変更をしない（照会は書かない）。

## 人間の判断が要る項目（#215 Gate 1 / #217 の DoD。AI は確定していない）

1. **照会の API の追加と形**（上の案。経路の名前・`state` の列・`kind` を返すか）
2. **`ended` を Home に返すか**（このプロセスで終わった Session の結果を Home で見せるか、`session: null` に畳むか）
3. **#230 との順序**（今の状態の列で #217 を先に実装し #230 で拡張するか、#230 の Lifecycle の設計の承認を待ってから #217 のスキーマを確定するか）

## 実行した確認

- `pnpm --filter @proj-poker/server exec vitest run src/session-readonly-verification.test.ts`: 10 件 pass
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: 結果は PR の Test plan に記載

## 残課題

- 照会の API の実装（人間の承認の後。docs/03・04 と型・Route のテストを同じ PR で同期する）
- Home の画面と「続きから遊ぶ」（UX-03 #218）
- Session の Pause / End（#230）の設計と、その後の照会の状態の拡張
