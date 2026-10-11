# Issue #222: UX-07 Presentation Controller・演出速度・Live / Replay 再同期

## 目的

server から届いた最新の `HeroView`（authoritative）と、Hero に今見せている卓（displayed）を分け、Hero に見える Event を 1 つずつ演出する Presentation Controller を `apps/web` に実装する（D140・D143）。表示演出の速度 4 段階・Skip・reduced-motion・Hero の手番の到来時の自動高速化・再接続 / 画面の復帰 / タブの再表示での同期・送信前の整合性（D143・D146）・CPU 障害のダイアログの優先・Live / Replay の部品の共有を扱う。Engine のルール・Event Log・DB・API・CPU の情報境界は変えない。

一次情報: Issue #222 本文と 2026-10-11 の申し送りのコメント、`docs/06` §16.1〜16.5、`docs/decision_log.yaml` の D37・D38・D90・D93・D139・D140・D143・D145・D146、#221 の検証記録（`docs/taskLog/issue-221-live-presentation-verification.md`・PR #229）。

## 着手前の確認

- origin/main = `cfe4ef3`（#218 / PR #245 のマージ）。open な PR は #244（#226 server・Draft）だけ。worktree は #226 server のものだけで、#222 の対象ファイル（`apps/web/src/App.tsx`・`hooks/useHandSession.ts` 等）と重ならない。
- Codex モードは `autonomous`（repo 上書き）。

## 設計（判断理由）

1. **規則は純関数、React は時刻とタイマーだけ**（`lib/presentation.ts` / `hooks/usePresentation.ts`）。状態は `{handId, shownSeq, busyUntil}` だけで、displayed は毎回 `projectHeroView(authoritative.log の prefix)` から作る（D38。Engine を進め直さない）。UI 部品はゲームの正本を持たない。
2. **step の区切りを Replay と共有**: Replay の `replaySteps` にあった「裁定（action）と直後の同じ Player の `ACTION_TAKEN` は 1 step」の規則を Engine の純関数 `heroViewStepEnds` に移し、server の Replay と web の Live の両方で使う（D143。同じ規則を 2 か所に書かない。Engine のルールは変えていない）。
3. **seq の扱い**: 表示済みの位置を seq で持つので、REST / SSE の重複・古い View の遅着は位置を動かさない。Hero から見た seq の飛び番は欠落として扱わず、画面に出さない（D143 UX06-1）。
4. **時間の管理は `busyUntil`**: 今の step の演出が終わる時刻まで次を出さない。しばらく待ちが無かった後に届いた step（Hero 自身の操作など）はすぐ出る。所要時間は step の種類（最後の Event）× 速度の倍率（OI-012 の暫定値は `lib/config.ts` の `PRESENTATION_*`）。Hero の手番が来ていれば通常の演出を速め、Showdown の公開と Pot の配分は速めない（Q20）。
5. **新しい Hand**: このセッションで最初の Hand（読み込み直後・Resume）は最新に合わせ、続く Hand（次の Hand・次の Drill）は Hand の始まり（`HAND_STARTED`・Blind・Ante・Hero の札）までを一度に出してから続きを演出する。
6. **有界のキュー**: 待ちの step が上限（24。OI-012）を超えたら、古い分を動きなしで表示済みにする（最後の卓は authoritative から作るので内容は欠けない）。
7. **送信前の整合性（D143・D146）**: `operate(shown, actions)` は、Hero が見ていた卓（displayed）が最新と同じ Hand・同じ `lastSeq` のときだけ、その `lastSeq` で送る。違えば送らずに表示を最新へ合わせ、「操作はまだ送っていません。卓を確かめて、もう一度確定してください」と案内して `"resynced"` を返す。下書きは `ChipControls` に残るので、Hero が状況を見てからもう一度確定する（暗黙に送らない・`stale_view` で自動再送しない）。手番外の操作と User Read も同じ。比べる最新の View は描画を待たない ref（`latestView`）で持つ。
   - 「同期してから、その値で自動で送る」案は採らなかった: #219 の `anchorContext`（組んだ時点の `currentBet` 等）による再確認が未実装のまま自動で送ると、CPU の Raise の後に古い額の Chip を送りうる（D146 が禁じる暗黙の送信）。送らずに再確定を求める方が D143 の「不一致なら古い操作を送らない」に合い、#219 は `OperateResult` で再確認の UI へつなげられる。
8. **同期の契機**: SSE の切断後の最初の View・「卓に戻る」で同じ Hand が返った・Play / Drill の卓への復帰（`App` の `screen.kind` の変化）・`visibilitychange`（visible）で `syncNow`。画面の移動では開始・操作を送らない（#218 の契約を維持）。
9. **優先する表示**: CPU 障害のダイアログ（`outage.current`）がある間は `flush` で最新まで一度に出す（§16.5）。Session の状態（終わりの案内・「次の Hand へ」）は表示が追いついてから渡す。Tournament の欄も、演出の途中は追いついていたときの値を出し続ける（server ではもう Hand が終わった後の Elimination・順位を先に見せない）。
10. **ETIQUETTE（#226 の client）の接続点**: `holdThroughSeq`（その seq を含む step までで止め、Skip・同期も越えない）。今は `null` 固定で使わない。Ack の API・Overlay は実装しない。
11. **reduced-motion**: `prefers-reduced-motion: reduce` では選んだ速度に関わらず演出なしで進め、その旨を速度の欄に添える。演出なしでも内容は省かない（最後の卓 = authoritative）。
12. **Replay**: 卓・進行ログ・Dealer Feedback・速度の部品（`PresentationControls`）を共有し、再生の速度は `useReplay` が別に持つ（Live の速度・Hand・CPU を変えない）。
13. **lint（react-hooks の純粋性）**: 描画の中では時刻を読まず、時刻に依らずに決まる分（受け取り・演出なし・障害の優先）だけを `settleWithoutClock` で反映し、時刻で次の step を出すのはタイマーだけにした。

## 実装中に見つけた不具合

- **演出が途中で止まる**: 最初の版はタイマーが予定より少し早く発火すると `settle` が進めず状態が変わらないため、タイマーが張り直されずに待ちの step が残ったまま止まった（既存 E2E の長い Session で「Hero の手番…（AI応答が遅延しています）」のまま 30 秒止まる形で検出）。発火のたびに `tick` を進めて必ず張り直すようにした。

## 先取りしなかったもの

- #219 の TurnDraft を App 層へ移すこと・`anchorContext` の再確認 UI（今の下書きは `ChipControls` が `operationKey` で持つ）
- #220 Hero 操作パネル・#224 視覚演出（Chip の移動・Side Pot の内訳等）・#225 効果音
- #226 の Ack API の呼び出し・Ack Overlay（`holdThroughSeq` の接続点だけ）。#244 は取り込んでいない
- 新しい Feature Flag・自動 Ack・互換モード

## 変更ファイル

- `packages/engine/src/projection.ts`・`index.ts`: `heroViewStepEnds`（Replay と Live の step の区切り）
- `apps/server/src/replay.ts`: `replaySteps` を `heroViewStepEnds` で作る（結果は不変。既存の Replay のテストで確認）
- `apps/web/src/lib/presentation.ts`（新規）・`presentation.test.ts`（新規）
- `apps/web/src/hooks/usePresentation.ts`（新規）・`usePresentationSpeed.ts`（新規）
- `apps/web/src/hooks/useHandSession.ts`: authoritative / displayed の分離・`operate(shown, actions)`・`resync`・同期の契機
- `apps/web/src/hooks/useReplay.ts`・`components/ReplayScreen.tsx`: Replay の再生の速度
- `apps/web/src/components/PresentationControls.tsx`（新規）・`Table.tsx`（Board の札の置き方と Flop の順）
- `apps/web/src/App.tsx`: 速度の設定・復帰時の同期・送信の配線・Tournament の欄の保持
- `apps/web/src/lib/config.ts`・`display-settings.ts`（+ テスト）・`styles.css`
- `e2e/tests/presentation.spec.ts`（新規）・`e2e/playwright.config.ts`（E2E のブラウザの速度の保存値を超高速に）
- `docs/03_SYSTEM_ARCHITECTURE.md`・`docs/06_UI_UX.md` §16・`docs/11_OPEN_ITEMS.md` OI-012

## 実行した確認

- `pnpm format:check`: All matched files use Prettier code style
- `pnpm lint`: エラーなし
- `pnpm typecheck`: engine / server / web / e2e すべて Done
- `pnpm test`: engine 489 passed・web 239 passed（うち `presentation.test.ts` 28 件・`display-settings.test.ts` に速度の 2 件を追加）・server 926 passed（Replay の既存テストで `heroViewStepEnds` への置き換えの不変を確認）
- `pnpm e2e`: 19 passed（6.8m。新規 `presentation.spec.ts` 3 件を含む）
  - 標準の速さのまま既存の E2E を通すと、長い Session の spec が CI の上限（15 分）を超え（ローカル 14.8m）、review-tendency は 120 秒の上限を超えた。E2E のブラウザの保存値を超高速にして演出のタイマーの経路は通し、標準の速さの挙動は `presentation.spec.ts` が `page.clock` で時計を止めて確かめる形にした（検査の削除・緩和はしていない）
  - 途中の 1 回は、実行中に `App.tsx` を編集したことで Vite が画面を再読み込みし（Home に戻る）、learning / tournament が落ちた。編集を止めて全体を回し直して 19 passed

## 残課題・既知の挙動

- 送信前に表示が古かったときは送らずに再確定を求めるので、演出中に手番外の操作を確定すると 1 回余分に押すことになる（D146 の再確認 UI は #219）。
- Replay の「演出なし」は Play の間隔を超高速と同じにする（Replay は step を自動で進めるため。OI-012）。
- 所要時間・上限・倍率はすべて OI-012 の暫定値（Playtest で見直す）。
