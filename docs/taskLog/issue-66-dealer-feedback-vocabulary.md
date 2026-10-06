# Issue #66: Dealer Feedback と Poker Vocabulary の詳細表示を作る

## 概要

Hero の操作への Dealer の裁定（#64 の公開 Event `DEALER_RULING`）から、Dealer Feedback を RULING / ETIQUETTE / COACHING の 3 分類で、別の項目として決定論で作り、Hero 欄と進行ログに分類ごとに見た目を分けて出した。Poker Vocabulary（日本語＋標準 Term。D45）の辞書を web 側のデータとして持ち、卓の用語を Hover / Click / キーボードで開くと Definition・Current Hand Example・Related Concept・Advanced Detail を出す。#65 の残課題（次の Street でも直近の裁定が残る）も直した。Engine・Ruling の規則・Event・永続化スキーマ・サーバーの API は変えていない。

## 初期調査

- 前提（main 5dbffe2）: `DEALER_RULING` は `basis`（operations / pending_out_of_turn）・`outcome`（action / out_of_turn / no_action）・`notes`（`RulingCode` 14 種）を持つ public Event。直前に同じ Player の `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION`、outcome が action なら直後にその `ACTION_TAKEN` が同じ追記で並ぶ。CPU は物理的な操作をしない（D91）。
- web は `heroRulingStatus` / `rulingText` で「Dealer の裁定: <Action>」の 1 行だけを出していた。`describeEvent` は `DEALER_RULING` を null にしていた（文言は #66 の担当）。
- docs/03 は「ブラウザが使う Engine の値は Chip の額面と構成の関数だけ。Engine の判定ロジックを動かさない」。判断時点の Pot を出すのに `projectHeroView` をブラウザで動かすとこの境界を変えるので、公開 Event の額の足し算（Blind・Action の額 − 戻った Bet）で求めることにした。
- HeroView の Pot は今の Street の Commit を含む（fixture の Preflop の Pot 3 = Blind 1 + 2）ので、Pot Odds = Call 額 ÷（判断の直前の Pot + Call 額）。

## 変更内容

- `apps/web/src/lib/dealer-feedback.ts`（新規）: `dealerFeedbackAt(log, index, viewerId)` が Hero への裁定 1 つから `DealerFeedbackItem`（category / text / terms）の列を RULING → ETIQUETTE → COACHING の順で返す。
  - RULING: 理由（`RulingCode` ごとの事実の 1 文。Oversized Chip は出した Chip の額面を操作の Event から添える。保留した操作の拘束〔basis: pending_out_of_turn〕は、保留したときの操作を材料にする）＋結果（`describeAction` の実額。理由があるときは「この Rule Profile では」を付ける）。no_action は「もう一度操作してください」。
  - ETIQUETTE: 理由に応じた作法の注意（out_of_turn・string_bet・oversized_chip・declaration_ignored・50% 規則 2 種・check_facing_bet）。同じ文は 1 回だけ。
  - COACHING: 判断時点の Hero の情報だけで作る（`log.slice(0, 裁定の位置)` の公開 Event だけを読む）。Call は Pot Odds、Bet は Pot に対する大きさと相手の Pot Odds（bet ÷（pot + 2 × bet））。結果の `ACTION_TAKEN` は同じ判断の結果（同じ追記）なので使う。
  - `potBefore`（公開 Event の Blind・Action の額 − 戻った Bet）・`potOdds`。
- `apps/web/src/lib/vocabulary.ts`（新規）: 24 語の辞書（Pot・Stack・Effective Stack・BTN・SB・BB・4 つの Street・Showdown・Uncalled Bet・6 つの Action・Min Raise・Pot Odds・宣言・Oversized Chip・String Bet・Out of Turn）。日本語と Term は既存の `format.ts` の `TERMS` / `ACTION_TERMS` / `STREET_TERMS` を流用。Current Hand Example は HeroView の公開された値と公開 Event だけで作る関数。Pot Odds の例は手番中の計算を出さず（Hint の役割。docs/06 §9）、Hero の直近の Call の判断時点の Pot から作る。
- `apps/web/src/components/Vocabulary.tsx`（新規）: `VocabularyProvider`（開いている用語の状態と、詳細の面 1 つを body 直下に portal で出す）・`Term`（用語の button。`aria-haspopup="dialog"` / `aria-expanded`。記号の表記〔D・SB・BB〕でも読み上げは用語の名前）・`VocabBody`（4 項目）。マウスは pointerType で判定して 250ms 後に開き、用語から詳細の面へ移る間は 200ms 閉じない。Click / タップで開いた詳細は外を押すか Escape で閉じる。キーボード（Enter / Space）で開くと詳細へ focus を移し、Escape で用語へ戻す。位置は用語の下（入らなければ上）で、左右は画面端から 16px で止める。開いた用語が描き直しで消えたら閉じる。
- `apps/web/src/components/DealerFeedback.tsx`（新規）: Hero 欄の Dealer Feedback。RULING を常に出し、ETIQUETTE / COACHING は分類の名前の button（`aria-expanded`）で開く。前の Street の裁定には「<Street> の裁定:」を添える。分類の札（`FeedbackTag`）は色と名前の両方で分ける。
- `apps/web/src/components/HandLog.tsx`: `DEALER_RULING` の位置で `dealerFeedbackAt` を呼び、3 分類を分類の札付きの別の行にする。
- `apps/web/src/lib/view-model.ts`: `latestHeroRulingIndex`（Hero 欄に出す裁定の位置）を足し、`heroRulingStatus` はそれを使う。`rulingText` は削除（文言は dealer-feedback.ts）。`describeAction` を export。
- `apps/web/src/App.tsx`: 画面を `VocabularyProvider` で包む。`dock__ruling` の 1 行を `HeroFeedback`（`DealerFeedback`、裁定が変わったら key で開いた補足を閉じる）に置き換え。Hero の Stack の見出しを用語にした。
- `apps/web/src/components/Table.tsx`: Street・Pot の見出し、Dealer Button（D）・SB / BB の札、席の Fold / All-in を用語（`Term`）にした。
- `apps/web/src/lib/format.ts`: `formatPercent`。
- `apps/web/src/styles.css`: 分類の色のトークン（`--color-feedback-ruling` 金 / `-etiquette` 薄紫 / `-coaching` 薄緑）、Dealer Feedback の項目・札・補足の button、用語（`:where(.term)` で詳細度 0 にして Dealer Button や SB / BB の見た目を上書きしない。点線の下線）、詳細の面（`position: fixed`・幅 min(340px, 100vw − 32px)・高さ上限 min(70vh, 480px)）。狭い画面では札を文の先頭に流し込む。使わなくなった `.dock__ruling` を削除。
- テスト: `dealer-feedback.test.ts`（新規 11 件）・`vocabulary.test.ts`（新規 7 件）・`view-model.test.ts`（P3 の振る舞い）・`components.test.tsx`（用語の button と 4 項目・卓の用語・Dealer Feedback の分類・進行ログの分類ごとの行）。
- docs: docs/06 §5（裁定の表示は §6 へ）・§6（Dealer Feedback の実装）・§7（Vocabulary の実装）、docs/03（web の構成）。docs/04 は Event を変えていないので変更なし。

## 判断理由

- **Event を増やさない**: ETIQUETTE / COACHING を Event Log に足すとスキーマ変更（停止条件）になる。裁定の理由（`notes`）と操作・結果の Event から決定論で作れるので、Event Log から作る派生の表示にした（D37）。分類は表示の項目として分け、1 つの文に混ぜない。
- **COACHING の入力は裁定の位置で切る**: 入力の組み立てが「判断時点まで」の Event だけを受け取る形にして Hindsight Leak を構造的に防ぐ（ai-boundary.md の 6）。さらに公開 Event だけを読む whitelist にし、他者の private・engine・system Event が紛れても結果が変わらないことをテストした。
- **ブラウザで Engine の Projection を動かさない**: docs/03 の境界（ブラウザの Engine は額面と構成の関数だけ）を保つため、判断時点の Pot は公開 Event の額の足し算で求めた。Pot と Call 額だけで足りる COACHING（Pot Odds・Bet の大きさ）に絞った。
- **Pot Odds の例は手番中に出さない**: 手番中の Pot Odds は Hint の「計算」の層（docs/06 §9。標準では非表示・開いた Layer を Log する）に当たる。用語の詳細から Hint を出し抜かないよう、済んだ判断の例にした。
- **Hero 欄では ETIQUETTE / COACHING を畳む**: 3 分類を全文で出すと 1280px で Hero 欄が 181px → 347px になり、卓の下側の席を覆った。Game State に影響する RULING だけを常に出し、残りは分類の名前の button で開く形にした（1280px で 226px）。進行ログには全文を残す。
- **P3（次の Street でも直近の裁定が残る）**: #65 は Call で Street が閉じると裁定が見える前に消えるのを避けるため、次の操作まで残していた。CPU の手番の間は「<Street> の裁定」と添えて残し、次の Street で Hero の手番が来たら消すことで両方を満たした（保留中は裁定されるまで出す）。同じ Street で Hero の手番が戻った場合は、同じ Street の直近の裁定なので出し続ける。
- **詳細の面は body 直下の 1 つ**: 卓のフェルト・席の要素の overflow / transform に切られず、どの用語からでも同じ位置計算で出せる。body 直下にあるので、キーボードで開いたときは focus を移す（位置を測るまでは visibility: hidden で focus できないため、位置が決まってから移す）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 232・server 162・web 85 件すべて成功）/ `pnpm format:check`（ルート）。`pnpm --filter @proj-poker/web build` が通る。
- dev サーバー（worktree・`POKER_DB_PATH=:memory:`・`BOT_THINK_DELAY_MS=1500`・RuleBot）と Playwright（headless Chromium。リポジトリ外のスクリプト）で実測。dev サーバーは確認後に停止した（3001 / 5173 の LISTEN が無いことを確認）。
  - **1280×800（マウス）**:
    - Oversized Chip（相手の Bet 2 に宣言なしで 100 を 1 枚 → 確定）: Hero 欄に「裁定（Ruling） 相手の Bet に対し、宣言なしで Call 額を超える Chip（100）を 1 枚出しました。この Rule Profile では コール（Call） 2 として扱います。」＋用語「オーバーサイズチップ（Oversized Chip）」＋「作法（Etiquette）」「学習（Coaching）」の button。学習を開くと「このときの Pot は 15、Call 額は 2 でした。… ≒ 12% です。…」（`aria-expanded="true"`）、作法に切り替えると「大きい Chip 1 枚で Raise するときは、先に「Raise」と宣言しましょう。」。進行ログには 3 分類が札付きの別の行で残る。
    - Hero 欄の高さ: 裁定なし 181px / 裁定あり（補足を閉じた状態）226px / 学習を開いた状態 285px / 保留中 205px。横スクロールなし（`scrollWidth` = 1280）。
    - P3: Turn の裁定の後、River で CPU の手番の間は「ターン（Turn）の裁定:」付きで出て、River で Hero の手番が来ると Hero 欄の Dealer Feedback は 0 件（別の Hand では Preflop → Flop でも同じく 0 件）。
    - Vocabulary: Pot の用語に Hover して 100ms では出ず、400ms で 4 項目（意味 / この Hand では / 関連 / 詳しく）、例「今の Pot は 23（11.5 BB）。」。用語から詳細の面へマウスを移しても閉じず、離れると閉じる。Dealer Button（D）を Click で開く（`aria-expanded="true"`・画面内）→ 関連「スモールブラインド（SB）」を選ぶと切り替わる → 外を押すと閉じる。Pot の用語に focus して Enter で開くと focus が詳細の面へ移り、Tab で閉じる button、Escape で閉じて Pot の用語へ戻る。
    - Out-of-Turn（CPU の手番に 5 を出す）: 「手番ではない操作です。操作を保留し、Hero の手番が来たら裁定します。」＋作法の button。
  - **375×760（タッチ。`hasTouch` / `isMobile`）**: 同じ Oversized Chip で Hero 欄 477px（補足を閉じた状態。裁定なしは 371px）、学習を開いて 596px、保留中 433px。横スクロールなし（`scrollWidth` = 375）。P3: Preflop の裁定が Flop の CPU の手番の間は見出し付きで出て、Flop の Hero の手番で 0 件。D をタップで開いた詳細は x = 19・幅 340 で画面内、関連の切り替え・外のタップで閉じる・Enter / Escape の focus も 1280px と同じ。
- 自己レビュー前の不変条件の確認（ai-boundary.md の確認動作）: COACHING と Current Hand Example の入力に、他者の Hole Cards・Deck・system Event・裁定より後の Event が混ざっても出力が変わらないことをテストで確認した（`dealer-feedback.test.ts` / `vocabulary.test.ts`）。

## レビュー対応

- Codex（round 1・STATUS=clean）の [P2]「All-in の Current Hand Example が Call・Bet・Raise に伴う All-in を見落とす」: CONFIRMED。`action: all_in` だけでなく `allIn: true` の `ACTION_TAKEN` を直近の All-in として探すように直し、テストを足した（同じ根の sweep: 他の Action の例は Action の種類で探すのが正しく、席の All-in 表示は `seats[].allIn` を読むので該当なし）。

## 残課題

- 375px では裁定があるときの Hero 欄が約 106px 高くなる（RULING の文が 4 行＋用語・補足の button が 2 行）。次の Street の Hero の手番で消えるが、卓の UI のデザイン体系（#5）で Hero 欄と合わせて見直す候補。
- COACHING は Call の Pot Odds と Bet の大きさだけ。Fold・Raise の補足や、Review（Phase 5）との接続は扱っていない。
- 用語は卓の見出し・札・Dealer Feedback に付けた。進行ログの文中の用語（「コール（Call）」など）は文字列のままで、開けない。
- Dealer の進行速度の変更（D15）は #67 の Fast Forward と合わせて扱う（Issue の指示どおり）。
