# Issue #218: UX-03 App Shell と Home・Play・Learn ナビゲーション基盤

## 目的

卓中心の画面分岐（`table` / `replay` / `review` / `session_review` / `drill`）だった `App.tsx` に、Home / Play / Learn の App Shell を載せる（D136）。起動は必ず Home にし、Home は `GET /api/session/current`（D144）を読むだけにする。Hand・Session の開始は Hero の明示の操作（「続きから遊ぶ」・「新しい Session を始める」）だけで、既存の冪等な `POST /api/hands` を使う。

一次情報: Issue #218 本文と「着手方針の人間承認（2026-10-11）」のコメント、`docs/06` §16.2〜16.3、`docs/decision_log.yaml` の D135〜D139・D144・D146。

## 初期調査

- `useHandSession` は `App` で持ち、`start`（`afterHandId` = 結果まで見た最後の Hand）と `startNewSession`（選んだ種類を送る）を持つ。開始の判定は server の `unseenLatestHand`（進行中の Hand・結果を見ていない終わった Hand はその Hand を返す。再起動後の Session は次の Hand を作る）。
- client の照会は `lib/api.ts` の `fetchCurrentSession` と `parseCurrentSession`（#217）が実装済みで、画面からは未使用だった。`session: null` と知らない state がどちらも `null` になっていた。
- 既存 E2E は全 spec が「起動 → `Hand を始める`」を前提にしていた（`session.spec.ts` の 5 か所・`learning.spec.ts`・`support/play.ts` の `startFirstHand`）。

## 設計方針（判断理由）

1. **画面の状態は純粋関数（`lib/shell.ts` の `shellReducer`）**: 移り方が API を呼ばないことを型と単体テストで固定する。Learn の画面は戻り先（Learn に入る前の領域）を持ち、Learn を離れるときに見ていた画面を覚える。
2. **閲覧位置は画面の指定と分ける**: Review の判断・Replay の Hand と step は、画面が `onPositionChange` で知らせ `viewing` に重ねる。開いた画面の指定（`screen`）は書き換えないので、知らせるたびに画面を作り直さない（key が変わらない）。Learn の画面を隠したまま残す案は、隠れた Replay の `.table` が卓の E2E の CSS セレクタに混ざる・再生のタイマーが走り続けるので採らなかった。
3. **「続きから遊ぶ」は、この画面で続けている Session があれば卓へ移るだけ**: `useHandSession` に View があるとき開始を送ると、結果を見た終わった Hand の後では `afterHandId` が一致して次の Hand を作ってしまう（Hero が「次の Hand へ」を押していないのに Hand が進む）。View が無いとき（起動の直後・再読み込みの後）だけ既存の `start` を送り、server の冪等な判定（進行中 / 結果を見ていない Hand / 再起動後の次の Hand）にそのまま任せる。
4. **照会の「Session が無い」と「知らない state」を分ける**（`parseCurrentSessionLookup`）: 知らない state（#230 の paused 等）で「新しい Session を始める」を出すと、server が続けている Session の扱いを Home が知らないまま開始の要求を送る。D144 の安全側に合わせ、知らない state・通信の失敗では開始の Button を出さず「もう一度読み込む」だけにした。
5. **Drill の卓は Learn の中の画面**: Play は通常の卓だけにして、通常の Session と Drill の Session を混同しない。`drillSession` も `App` で持つので、Play へ移っても Drill を捨てない。
6. **Play で卓が無い間は開始を送らず Home へ誘導**（旧 `StartScreen` は削除）。開始の入口を Home に 1 つにする。
7. **ナビは画面に固定しない**（見出しの行）。下に固定した Hero の欄・卓を覆わない。
8. **卓の上の余白**: 上の席（札を含む）は卓の枠の上へはみ出す（720×600 で約 44px）。ナビが見出しの中央寄りに入ったことで、720〜1279px で上の席の箱が Learn の Button の中心を覆った（E2E の hit-test で検出）。席の位置は席数で変わるので、ナビの位置をずらす案は採らず、`.app__table` の上に余白（広い画面 36px・狭い画面 8px）を取った。Drill の卓は説明の面の下の余白が同じ役目なので重ねない（`.drill-banner + .app__main .app__table`）。320px 級では題とナビを 1 行に収める詰め方（題 16px・Button の左右 6px）を足し、見出しが 3 行になるのを 2 行に戻した（見出しの高さ 192px → 155px）。

## 先取りしなかったもの

- #219 TurnDraft の本実装（下書きは今どおり `ChipControls` の中にあり、Play を離れると消える。D146 の App 層での保持は #219）
- #222 Presentation Controller・#220 Hero 操作 UI・#224 演出・#225 SFX・#226 Ack UI・#230 Pause / End / Resume
- server（`apps/server/**`）と Engine（`packages/engine/**`）は変更していない

## 変更ファイル

- `apps/web/src/lib/shell.ts`（新規）: Screen / ShellState / `shellReducer`（area・open・back・position）/ `backLabel`
- `apps/web/src/lib/shell.test.ts`（新規）: 起動は Home・戻り先・閲覧位置・Learn の押し直し・Drill の分離
- `apps/web/src/hooks/useCurrentSession.ts`（新規）: Home の照会（表示のたびに 1 回・古い応答を捨てる・読み直し）
- `apps/web/src/components/AppShell.tsx`（新規）: `ShellNav` / `HomeScreen` / `HomeSessionPanel` / `LearnHub` / `LearnBackBar`
- `apps/web/src/components/app-shell.test.tsx`（新規）: Home の欄の照会の結果ごとの Button・Learn の入口・ナビの `aria-current`
- `apps/web/src/App.tsx`: App Shell の配線（`useReducer`）・Home の「続きから遊ぶ」/「新しい Session を始める」・`PlayEmpty`・`StartScreen` の削除・ヘッダーの「Replay を見る」の削除
- `apps/web/src/components/ReviewScreen.tsx` / `ReplayScreen.tsx`: `onPositionChange`（任意の prop）
- `apps/web/src/lib/api.ts` / `view-model.ts` / `view-model.test.ts`: `CurrentSessionLookup` と `parseCurrentSessionLookup`
- `apps/web/src/styles.css`: 見出しの折り返し・`.shell-nav`・`.learn-bar`・`.home`・`.learn-hub`・`.app__table` の余白
- `e2e/tests/app-shell.spec.ts`（新規）、`e2e/support/play.ts`（`startFirstHand` を Home 経由に・`countHandStarts`）、`session.spec.ts` / `learning.spec.ts` / `tournament.spec.ts` / `session-end-layout.spec.ts`
- docs: `docs/03`（Basic UI に App Shell・画面の状態）、`docs/06`（§10 の Replay の入口・§15 の種類の選択・§16 の冒頭と §16.2 の実装）、`docs/09`（Tournament E2E の手順・App Shell の E2E）、`docs/guides/USAGE_AND_LIMITATIONS.md`、`README.md`

## 既存 E2E の前提の置き換え（検査は削除・緩和していない）

| 旧 | 新 |
|---|---|
| 起動 → 「Hand を始める」 | 起動 → Home の見出しを確かめ → 「新しい Session を始める」（`startFirstHand`） |
| 再起動後の再読み込み → 「Hand を始める」 | Home → 「続きから遊ぶ」（Hero の明示の操作が起点）。Tournament は Home が「続きから遊ぶ」だけを出し、種類の選択を出さないことも足した |
| 再読み込み → 見出しの「Replay を見る」 | Home → ナビの Learn → 「Replay を開く」 |
| Session の終わりの後 → 新しい Session | 途中で Home（`ended` は新しい Session だけ・「続きから」なし・移動で開始を送らない）を確かめてから |
| Drill | Play へ移っても Drill を捨てず、Learn に戻ると同じ Drill の卓・移動で Hand / Drill の開始を送らない、を足した |

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 489・web 206・server 926 件）/ `pnpm format:check`: 通過
- `pnpm e2e`（全 16 本。新規 `app-shell.spec.ts` の 4 本を含む）: 16 passed
- 画面の実測（Playwright のスクリーンショット）: Home 1280×720・320×568、Learn 1280×720・375×667、Play 1280×900・720×600・320×568、Review 375×667（Learn の一覧から開いた「Learn の一覧へ」）
- 720×600 で上の席とナビの重なりを `elementFromPoint` で測り、余白を足した後に 320×568〜1280×900 で席・ナビ・表示設定が重ならないことを確かめた（`app-shell.spec.ts` に固定）

## レビューでの修正（Codex round 1・P2）

- **終わった Session の後の再読み込みで「新しい Session を始める」が二度押しになる**: 再読み込みの直後は client が終わった Session の最後の Hand を知らず（照会は Hand ID を返さない。D144）、`afterHandId=null` の開始に server の冪等な判定が「結果を見ていない最後の Hand」を返していた。`useHandSession` の開始で、新しい Session を求めた（種類を送った）応答が「見ていない・終わった Session の Hand」（`lib/view-model.ts` の `isUnseenEndedHand`）なら、その Hand を見たものとしてもう 1 回だけ送るようにした。続いている Session の Hand・種類を送らない「続き」・進行中の Hand には当てない（勝手に次の Hand へ進めない）。server の契約は変えていない。E2E（`session-end-layout.spec.ts` の狭い画面の 2 本）に「再読み込み → Home → 1 回で新しい Session」を足し、修正を外すと失敗することを確かめた。

## 残課題・既知の挙動

- 別のタブで新しい Session を始めた後に、このタブの Home で「続きから遊ぶ」を押すと、このタブが持っている前の Hand へ移る（この画面の Session を優先するため）。二重タブは #230 の Session Lifecycle の設計で扱う。
- `ui-design-recipes` の `references/proj-poker.md`「横断 UI/UX の新しいレイヤー」の App Shell の行は「設計のみ・予定」のまま（`.claude/` の資産は本 PR で編集しない）。実装の置き場所（`lib/shell.ts`・`components/AppShell.tsx`・`.app__table` の余白）への更新が別途必要。
- Learn の Review の Pass（判断時点 / 答え合わせ）のタブ・Session Review の Profile のタブ・ページのスクロール位置は覚えない（覚えるのは開いた判断と Replay の Hand・step）。
