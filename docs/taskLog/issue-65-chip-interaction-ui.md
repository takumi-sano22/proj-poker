# Issue #65: Chip の Click / Drag と宣言 Button で操作する UI にする

## 概要

Hero の操作を、数値の Bet Box（Slider・Preset）から、Chip の Click / Drag・枚数選択・Betting Area への投入と宣言 Button に置き換えた。操作は `PhysicalAction` の列として #64 の `POST /api/hands/:handId/physical-actions` に送り、裁定はサーバーの Ruling Engine（#63・D91）に任せる。裁定の結果は Hero 欄に最低限（何が適用されたか・保留・決まらなかった）を出す。Engine・Ruling の規則・Event・永続化スキーマ・サーバーの API は変えていない。

## 初期調査

- 前提（main 1ce8e54）: web は `ActionBar`（Legal Action だけのボタン + Preset + Slider）で Canonical Action を `/actions` に送っていた。`/physical-actions`・`DEALER_RULING`（版 5）・`ChipStack` / `composeChips` / `chipDenominations` は揃っている。
- Ruling Engine の入力の規則（`checkInput`）: Chip の最初の動作は `chip_push`・以降は `chip_add`、額面は Config にあるものだけ、出した合計が Stack を超えたら `invalid_input`。保留中の Out-of-Turn があるともう一度の操作は `not_actor`。
- Session 開始の Stack は 200（Blinds 1/2）で、`composeChips(200)` は 100 × 2 枚。Stack の構成どおりの Chip しか出せないと、6 の Raise などが組めない。D14 は「整理 / 両替は Dealer 補助可」。

## 変更内容

- `apps/web/src/lib/chip-ops.ts`（新規）: 手番の操作の下書き（手元 `hand` と卓に出した操作 `ops`）を組む純粋関数。`pickChip`（Click で 1 枚手に取る。持っている額を超えるなら変えない）・`returnHand`（出す前なら戻せる）・`pushHand` / `pushChip`（1 回の動作で出す。最初は `chip_push`、以降は `chip_add`）・`declarationOf`（Bet / Raise は手に Chip があればその額を to 額として宣言、無ければ額なし）・`declare`・`completesTurn`・`countChips`。合法性も裁定も判定しない。
- `apps/web/src/hooks/useChipDrag.ts`（新規）: Pointer Events の Drag。6px を超えて動いたら Drag、離した位置が Betting Area の矩形内なら投入。Drag で終えた押下の直後の click を 1 回捨てる。落とした結果の描画は `setTimeout(0)` で押下の一連のイベントを配り終えてから行う（下の「判断理由」）。
- `apps/web/src/components/ChipControls.tsx`（新規。`ActionBar.tsx` は削除）: Stack の Chip（Config の額面ごと）・手元の山と「戻す」・Betting Area（1 回の動作ごとに積みを分けて置く・宣言も表示）・「確定して Dealer に渡す」・宣言 Button 6 つ（局面によらず全部。手番でも手番でなくても押せる。Call / All-in の額は手番のときだけ Legal Action の額を補助で出す）。
- `apps/web/src/components/ChipStack.tsx`: 積みの描画を `ChipColumns` に分け、出した Chip を枚数のまま描く `ChipPile` を足した（500 の 1 枚を 100 × 5 に組み直さない）。
- `apps/web/src/lib/view-model.ts`: `heroRulingStatus`（直近の Hero の `DEALER_RULING` から pending / action〔直後の `ACTION_TAKEN`〕/ no_action）・`rulingText`（最低限の 1 行。理由の文言は #66）・`operationKey`（下書きを作り直す単位: Hand・Street・Hero への裁定の数）。`sizingPresets` は使わなくなったので削除。
- `apps/web/src/lib/api.ts` / `hooks/useHandSession.ts`: `sendHeroAction`（`/actions`）を `sendHeroPhysicalActions`（`/physical-actions`）に、`act` を `operate(actions)` に置き換え。再送は送ったときの `lastSeq` と操作の列のまま。`not_actor`（保留中の再操作）と `invalid_input` の案内文を足した。
- `apps/web/src/App.tsx`: Hero 欄で、Fold / All-in 済みでなければ手番でなくても `ChipControls` を出す。保留中と送信中は押せない。直近の裁定を `dock__ruling` に出す。
- `apps/web/src/styles.css`: Chip のトークン（既存の `--color-chip-*` を流用）・手元・Betting Area（フェルトの色。Drag 中に上へ来たら金の縁）・宣言の grid・Drag 中の Chip。PC は「Chip・手元・Betting Area・確定」を 1 行、宣言を 1 行。モバイルは「Chip・手元」「Betting Area・確定」「宣言 3 × 2」。360px 未満は手元を次の行へ。`ActionBar` / Slider 用の CSS は削除。
- テスト: `chip-ops.test.ts`（新規 9 件）、`components.test.tsx`（`ChipPile`・`ChipControls` の宣言 6 つ・数値の Bet Box が無いこと・持っていない額の Chip だけ押せない・手番でなくても押せる・送信中 / 保留中は押せない）、`view-model.test.ts`（裁定の表示・下書きの単位）。
- docs: docs/06 §4・§5 に Chip 操作と宣言 Button の実装、docs/03 の web（`useHandSession` の送信先・`ChipControls`）を更新。

## 判断理由

- **合法性・誤操作を UI で判定しない**: 宣言 Button は局面によらず 6 つとも出し、手番でなくても押せる（Out-of-Turn・相手の Bet があるときの Check・Bet の局面の Raise も裁定の対象。D47・D91）。誤操作の事前警告も出さない。止めるのは「持っていない額の Chip」だけで、これは裁定ではなく物理的にできない操作（Engine も `invalid_input`）。
- **額面は Stack の構成に縛らない**: 200 = 100 × 2 のときに 5 や 1 を出せないと Bet の額が組めない。D14（両替は Dealer 補助可）に沿って、持っている額の範囲でどの額面も選べるようにした。Stack の構成の表示（席の積み）は従来どおり額から組む。
- **確定の Button**: String Bet（2 回目以降の動作）を練習できるよう、1 回の手番で複数の動作をしてから送る必要がある。宣言だけで Action が決まる Fold / Check / Call / All-in は押した時点で送り、Bet / Raise と宣言なしの投入は「確定して Dealer に渡す」で送る。
- **手元は戻せる・卓に出した Chip は戻せない**: 手に取っただけの Chip は卓に出ていない。出した Chip を取り消せると String Bet などの練習にならない。
- **Bet / Raise の額の宣言は手元の Chip で決める**: 数値の入力欄を作らずに額を宣言する方法。手元の額を宣言して同じ Chip を 1 回で出すと、額なしの宣言と同じ結果になる（分けて出したときだけ差が出る）。
- **下書きの単位**: CPU の行動だけでは下書きを捨てない（手番を待つ間に組んだ操作を消さない）。Hero への裁定が増えた（送った操作が裁定された）・Street が進んだ・Hand が変わったら捨てる。
- **直近の裁定は Street をまたいでも出す**: Hero の Call で Street が閉じると、Street で絞ると裁定が見える前に消えた（375px の実測で発見）。no_action は Hero の手番で起き、選び直すまで Street は進まないので、古い「もう一度操作してください」は残らない。
- **Drag の結果の描画を遅らせる**: タッチで手元の山を Drag して落とすと、`pointerup` の時点で山が消え（手元が空になる）、`touchend` が消えた要素に配られて、次のタップが Click にならなかった（Chromium・CDP のタッチで実測）。手元の山を常に置いたうえで、投入の描画を押下の一連のイベントの後に回して直した。
- **BB 換算は狭い画面の宣言 Button だけ省く**: 実額は常に出す（D49）。375px で額と BB が 3 行に割れるため、補助の BB だけを省いた（PC では出す）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 232・server 162・web 59 件すべて成功）/ `pnpm format:check`（ルート）。`pnpm --filter @proj-poker/web build` が通る。
- dev サーバー（worktree・`POKER_DB_PATH` は scratchpad / `:memory:`・`BOT_THINK_DELAY_MS=1500`〜`4000`・RuleBot）と Playwright（headless Chromium。リポジトリ外のスクリプト）で実測。dev サーバーは確認後に停止した。
  - **1280×800（マウス）**:
    - Click だけで Raise: 「レイズ（Raise）」→ 25 と 5 を Click → Betting Area を Click → 確定。送信 `[declare raise, chip_push [25,5]]`、表示「Dealer の裁定: レイズ（Raise） 30 まで」。
    - Drag・宣言なしの Oversized: 相手の Bet（Call 28）に 100 の Chip を 1 枚 Betting Area へ Drag → 確定。送信 `[chip_push [100]]`、表示「Dealer の裁定: コール（Call） 28」。相手の Bet が無い局面では同じ操作が「ベット（Bet） 100」。
    - 宣言: 「チェック（Check）」/「コール（Call）」を押した時点で送られ、「Dealer の裁定: チェック（Check）」。
    - Out-of-Turn: CPU の手番中に 5 を手に取り、手元の山を Drag → 確定。表示「Dealer: 手番ではない操作として保留しました。…」、保留中は Chip のボタンが押せない。Hero の手番で、状況が変わっていれば「Action は決まりませんでした。もう一度操作してください。」、変わっていなければ「ベット（Bet） 5」（拘束）。
    - キーボード: 5 の Chip に focus して Enter × 2 → Tab で 25 → 100 → 手元の山 → 戻す の順に移る。手元の山で Enter → Betting Area に 10、確定で Space → 送信 `[chip_push [5,5]]`、「レイズ（Raise） 11 まで」。
    - Hero 欄の高さ 175px（変更前とほぼ同じ）で、卓の Hero の席が隠れない。横スクロールなし（`scrollWidth` = 1280）。
  - **375×760（タッチ。`hasTouch` / `isMobile` と CDP のタッチ イベント）**: 上の Click だけの Raise（「レイズ（Raise） 30 まで」/ 局面により「ベット（Bet） 30」）・Drag の Oversized（「コール（Call） 2」）・宣言（Check / Call）・Out-of-Turn（保留 → 拘束「ベット（Bet） 5」）を同じ手順で確認。Hero 欄の高さ 353px（変更前 約 370px）。横スクロールなし。375×667 も同じ高さで崩れない。
  - 320×568: 手元が次の行に回り、Chip と重ならない（Hero 欄 422px。卓はスクロールで見える）。
  - タッチで Drag を終えてから 30ms 程度で次のタップをすると Click にならないことがある（Chromium のタッチの扱い。400ms 空ければ通る）。人の操作の間隔では起きないと判断した。

## 残課題

- Dealer Feedback の分類（RULING / ETIQUETTE）と理由の文言・Vocabulary は #66。今は「何が適用されたか」の 1 行だけ。
- Hero への直近の裁定は、次の Street で Hero の手番が来ても次の操作まで残る（例: Preflop の「コール 2」が Flop の手番でも出る）。#66 の表示で見直す候補。
- 320px 幅では Hero 欄が高く、卓の下側はスクロールで見る（従来から 320×568 の残課題あり）。卓 UI のデザイン体系（#5）で Hero 欄と合わせて見直す候補。
- Dealer Change（Stack の Chip の両替の表示）は作っていない。額面は持っている額の範囲で自由に選べる（D14 の Dealer 補助の扱い）。
