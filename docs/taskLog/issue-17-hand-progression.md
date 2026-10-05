# Issue #17: Engine の 6-max 1 Hand 進行（Legal Action・Street・Showdown・単一 Pot）と Event 発行

## 概要

`packages/engine` に 1 Hand の進行（Button・Blind → Preflop〜River → Showdown → Pot の配分）を、Event を発行して畳み込む決定論的な状態遷移として実装した。Player ごとの可視 Projection（Hero 表示用・CPU Bot 用）も提供する。範囲は D70（均等 Stack・単一 Pot。Side Pot・端数の Split は明示エラー）。

## 設計方針

- **Command / Event / Reducer の分離**: `startHand` / `applyAction`（Command）が入力を検証して Event を作り、`applyEvent`（Reducer）で畳み込んだ State と新しい Event を返す。State は Event の畳み込みでしか変わらない（D37）。`foldHandEvents(events)` で全 Event から同じ State を再構築できる（テストで毎ステップ確認）。
- **純粋関数**: I/O・時刻・`Math.random` を使わない。Deck は `{ seed }` か `{ deck }`（積んだ Deck）で注入する。`event_id`・時刻は永続化側の責務。
- **Visibility**: `public` / `private(playerId)` / `engine`。Deck の順序（未来の Card）は `DECK_SHUFFLED`（engine）にだけ入れ、Projection は読まない。`engine` は docs/04 §4 に追記した（どの Player にも見せない情報の区分）。
- **Projection は whitelist**: 見える Event（public と自分宛て private）だけを Reducer で畳み込み、出力型に渡してよい項目だけを積む。他者の Hole Cards・Deck は State にすら入らない。Legal Action は公開情報だけで決まるので、Projection 側の State からも同じ結果が出る（Property テストで一致を確認）。
- **Legal Action**: Fold / Check / Call / Bet / Raise / All-in。Minimum Raise は「最高額 + 直前の Full Raise の増分」。Short All-in（増分が最小 Raise 幅未満）は Raise を再開しない（行動済みの Player は Call / Fold のみ）。相手が全員 All-in / Fold なら Raise を出さない。Fold は Check できる局面でも合法として出す。累積 Short All-in による再開は Phase 2（D70）。
- **Phase 1 で扱えない状態（D70）**: Ruleとしては合法でも、`applyAction` / `startHand` が `unsupported_state` を返して拒否し、State を変えない。
  - `side_pot`: All-in した Player の Commit を他の Player の Commit が超える
  - `odd_chip_split`: Split Pot が人数で割り切れない
  - 均等 Stack では `side_pot` は起きない（All-in 額＝全員の上限）。`odd_chip_split` は起きうる（ランダムな Action で約 0.5%。下記「残課題」）。
- **Chip の表現**: 最小単位の整数（`number`・`Number.isSafeInteger` で検証・浮動小数なし。Blind / Stack / Bet / Pot は同じ単位）。当初は OI として暫定値を置く方針だったが、作業中に人間が AskUserQuestion で確定したため `decision_log.yaml` に **D74** として記録し、範囲表記（`decision_log.yaml` 先頭・`docs/00`・`docs/10`）と `docs/10` の判断グループ表を同期した（`docs/11` には OI を追加していない）。Preset は `PHASE1_CASH_PRESET`（SB 1 / BB 2 / Stack 200。OI-004 / OI-008 の暫定値）。
- **進行の細部**: Heads-Up は Button = SB（Preflop 先手・Postflop 後手）。配布は Button の左から 1 枚ずつ 2 周。Burn は省いた（`CARD_BURNED` は発行しない）。Showdown は Fold していない全員が Button の左から公開する（Muck・Showdown 順の Rule Profile 化は OI-008）。All-in で Betting が終わったら、Board を配る前に公開する。全員 Fold なら Call されなかった額を返してから Pot を渡す。BB が Stack 不足で短く出しても、Call 額は BB の全額。

## 公開 API（`packages/engine/src/index.ts`）

- Command: `startHand(input: StartHandInput): EngineResult<HandProgress>`、`applyAction(state: HandState, playerId, action: PlayerAction): EngineResult<HandProgress>`
- 照会: `getLegalActions(state): LegalActionSet | null`、`foldHandEvents(events): HandState`
- Projection: `projectHeroView(events, heroId): HeroView`、`projectBotView(events, botId): BotView`、`visibleEvents`、`isVisibleTo`
- 型: `HandEvent` / `Visibility` / `EngineError`（`invalid_input` / `not_actor` / `illegal_action` / `hand_complete` / `unsupported_state`）/ `LegalAction` / `TableConfig` / `PHASE1_CASH_PRESET`

## テスト（poker-engine-testing）

- **Scenario Regression**（`hand-scenarios.test.ts`）: Scenario を TS のデータで書き、1 つの汎用ランナーで再生する。各ステップで Invariant と `foldHandEvents(events) == state` を確認する。期待値は手計算（コメントに計算過程）。
  - Standard 6-max / Standard Heads-Up（docs/09 §4）、全員 Fold で BB（Uncalled 返却）、Minimum Raise の Total と Increment、All-in Showdown、Split Pot（等分）、端数 Split の拒否、Side Pot の拒否、Short All-in で再開しない / Full Raise の All-in で再開する（境界の両側）
- **Invariant**（`testing/invariants.ts`）: INV-TEST-001（Card の重複なし・Deck 内）/ 002（Σ Stack + Pot = 初期総量、Pot = Σ Commit − Σ 配分）/ 003（Fold・All-in の Player が手番にならない）/ 004（Stack が負にならない）/ 005（配分 = Pot、終了後 Pot 0）。006 は Command の拒否で確認。
- **Property**（`hand-engine.property.test.ts`）: 2〜6 人・ランダム seed・Legal Action からのランダム選択で Hand を最後まで進め、毎ステップ Invariant・畳み込み・手番外の拒否（006）・全 Player の View の情報漏れ（007 の Engine 側）・View の Legal Action と全情報の一致を確認。均等 Stack では `odd_chip_split` 以外で止まらないこと、不均等 Stack でも合法入力が `unsupported_state` 以外で拒否されないこと、同じ seed と Action 列から同じ Event 列ができること。
- **Projection**（`projection.test.ts`）: 他者の札・未配布の Board にマーカーを積み、View を丸ごと走査して出てこないこと。Showdown で公開された札は見え、Fold した札は本人以外に見えないこと。
- **入力検証**（`hand-engine.test.ts`）: 人数・ID 重複・Button・Stack / Blind / seed の整数性・Deck の 52 枚一意・小数や NaN の額・Stack 超過。

## 変更ファイル

- 新規: `packages/engine/src/{table-config,hand-events,hand-state,legal-actions,hand-engine,projection}.ts`
- 新規（テスト）: `packages/engine/src/{hand-scenarios,hand-engine,hand-engine.property,projection}.test.ts`、`packages/engine/src/testing/{invariants,stacked-deck,view-leaks}.ts`（テスト補助）
- 変更: `packages/engine/src/index.ts`（export 追加）、`packages/engine/tsconfig.build.json`（`src/testing/**` を dist から除外）
- 変更（docs）: `docs/04_DATA_AND_EVENTS.md`（§3 Phase 1 の Event 構成表、§4 `engine` Visibility、§5 Projection の作り方）、`docs/03_SYSTEM_ARCHITECTURE.md`（Engine の入口・見出しの範囲 D70〜D74）、`docs/decision_log.yaml`（D74 追記・範囲表記）、`docs/00_DOCUMENTATION_INDEX.md` / `docs/10_DECISION_TRACEABILITY.md`（範囲表記・判断グループ表）
- 触っていない: `apps/**`・`.claude/**`・`CLAUDE.md`・`AGENTS.md`・`README.md`・`docs/11_OPEN_ITEMS.md`

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 100 件）/ `pnpm format:check`: すべて成功
- `pnpm --filter @proj-poker/engine build`: `dist` にテスト・`testing/` が出ないことを確認（確認後に `dist` は削除）
- 一時スクリプト（コミットしない）で 2〜6 人・均等 Stack・ランダム Action の 2,000 Hand を回し、終了の内訳を確認: Showdown 1,812 / Split 78 / Fold 101 / 端数 Split で停止 9

## 残課題

- **端数の出る Split は Phase 1 では止まる**（D70）。#18 の Hand ループは `unsupported_state`（`odd_chip_split`）を受け取ったときの扱い（その Action を別の合法 Action に差し替える等）が要る。実装は Phase 2（Odd Chip Split）。
- `poker-engine-testing` skill §4 の「Scenario ファイルの置き場」を追記する（`.claude/**` は本 Issue の担当外のため、親へ内容を返す）: Scenario は `packages/engine/src/hand-scenarios.test.ts` に TS のデータとして置き、同ファイルのランナーで再生する。テスト補助は `packages/engine/src/testing/`（build 対象外）。
- `implementation-guidance/references/poker-engine.md` 項目 6 と `poker-engine-testing` §2（Chip 表現は未確定）は、D74 で確定した内容へ更新が要る（同上、親の担当）。
- 範囲表記 `D01〜D7x` が統制面と README に古いまま残っている: `README.md`、`.claude/skills/{sync-check,decision-log,test-and-review}/SKILL.md`（担当外のため親が更新する）。
