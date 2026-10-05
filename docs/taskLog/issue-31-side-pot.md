# Issue #31: Side Pot と不均等 Stack（Multi Side Pot・Side Pot 内の Split）

## 概要

Engine が `unsupported_state`（`side_pot`）で拒否していた不均等 Stack の All-in を扱えるようにした。Commit 額から Main / Side Pot を組み立て、Pot ごとに勝者を決めて配る。Phase 2 の最初の子 Issue で、2026-10-05 のセッション冒頭 AskUserQuestion で確定した人間判断 D77〜D80 を本 PR で `docs/decision_log.yaml` に記録した（実装に関わるのは D78。D79 は #32、D80 は #34・#35 で実装する）。

## 設計方針

- **Pot の組み立ては純粋関数 `buildPots`**（`packages/engine/src/side-pots.ts`）: Fold していない Player の Commit 額（累計）を小さい順に段として切り、各段に全員が「その段までに出した分」を入れる。段は Fold していない Player の額だけで作るので、隣の Pot と争える顔ぶれが必ず違う（同じ顔ぶれの Pot に分けない）。Fold した Player の Chip は入った段の Pot に死に金として残る。最後の段は上限なしにして、Σ Pot = Σ Commit を構造的に保つ。
- **Uncalled Bet は Betting Round の終わりに返す**: そのStreetで最も多く出した Player の 2 番目を超える分を `UNCALLED_BET_RETURNED` で返す。超過が残るのは他の全員が Fold か All-in のときだけなので、Round の終わりに 1 回見れば足りる。これで Fold 決着のBet（従来の `finishByFold` の処理）・Short All-in を超えた Bet・Stack 不足の Blind を超えた Blind を同じ処理で扱う。Street をまたいで返す必要は無い（後の Street で `streetCommitted` が 0 に戻る前に返す）。
- **配分は Pot ごと**: Main Pot から順に、争える Player の中で最強の Hand を選び、同着は既存の `splitPot`（`oddChipRule`）で配る。争える Player が 1 人だけの Pot（Fold 決着・Side Pot の独占）は札を比べずに渡し、`showdown: false`。Fold 決着も同じ `awardPots` を通す（Pot は 1 つ）。
- **`POT_AWARDED` は Pot ごとに 1 つ（D78）**: `potIndex`（0 が Main）と `eligible`（Button の左から時計回り）を追加。State の `awards` は Player ごとの合計に足し込む（UI の結果表示は 1 Player 1 行のまま）。
- **Event の版を 2 に上げた（D76・D78）**: `EVENT_SCHEMA_VERSION = 2`。版 1 の行は読み込み時に `upcastV1ToV2`（`apps/server/src/event-upcast.ts`）で `potIndex: 0`・`eligible`（その時点で Fold していない Player）を補う。版 1 は単一 Pot なので、Main Pot として読めば版 2 の Engine が発行する形と一致する。保存済みの行は書き換えない。テーブル（マイグレーション）は変えていない。
- **`EngineError` から `unsupported_state` を外した**: 理由が `side_pot` だけだったため。Server の HTTP Status 写像からも外した。

## テスト（poker-engine-testing）

- **Scenario**（`hand-scenarios.test.ts`。期待値はコメントに手計算を残した。`expect.pots` で Pot ごとの `potTotal`・`eligible`・`awards`・`showdown` を確かめる形を足した）:
  - `SCN-side-pot-3way-001`: Short Stack の All-in を 2 人が超える。Main は Short Stack、Side は残りの 2 人（docs/09 §4 3-way Side Pot）。
  - `SCN-side-pot-multi-split-001`: 段の違う 2 人の All-in で Pot が 3 つ。Side Pot 1 の同着は端数を Button の左から、Side Pot 2 は均等割り（docs/02 §5 Multi Side Pot・Odd Chip Split）。
  - `SCN-side-pot-dead-money-001`: Fold した Player の Chip が Side Pot に残り、争える Player が 1 人なので札を比べずに渡す。Flop の Bet は Uncalled で返す。
  - `SCN-uncalled-over-short-allin-001`: Short Stack の All-in Call を超えた Raise を Showdown 前に返す（All-in Showdown）。
  - `SCN-blind-allin-sb-001` / `SCN-blind-allin-bb-hu-001`: Stack が Blind に満たない Player の Blind All-in（SB / Heads-Up の BB）。
  - 既存 `SCN-fold-to-bb-001` に Fold 決着の `pots`（eligible は勝者だけ・`showdown: false`）を足した。`SCN-side-pot-unsupported-001` は削除（拒否しなくなったため）。
- **Invariant**（`testing/invariants.ts` の `checkPotAwards`）: potIndex の連番・Pot ごとの Σ awards = potTotal・受け取るのは eligible だけ・eligible は Fold していない・Side Pot ほど顔ぶれが狭まる・各 Player の受け取りは Σ_q min(自分の Commit, q の Commit) 以下（Pot の組み立てとは独立の上限）。Scenario のランナーと Property の両方で呼ぶ。
- **単体**（`side-pots.test.ts`）: 単一 Pot・段の切り方・死に金・Fold した額で段を作らない・最後の段の上の取りこぼし無し・不正入力。Property で Σ Pot = Σ Commit と顔ぶれの単調性。
- **Hand 進行の Property**（`hand-engine.property.test.ts`）: 不均等 Stack（1〜400。Blind に満たない Stack を含む）でも全 Hand が `complete`・Pot 0 になり、毎ステップ Invariant・畳み込み・INV-TEST-006・情報漏れを確かめる。`unsupported_state` を許す分岐は削除した。
- **Engine 単体**（`hand-engine.test.ts`）: Heads-Up で Button（SB）の Stack が 1 のとき、行動なしで Showdown まで進み、BB の超過 1 を返す。
- **upcast**（`apps/server/src/sqlite-event-store.test.ts`）: Fold 決着の Hand と、Fold した Player がいて Showdown まで進んだ Hand を版 1 の形で行として書き、読み出すと版 2 の Engine が発行した Event と一致し、行は版 1 のまま（payload も書き換えない）ことを確かめる。

## 変更ファイル

- `packages/engine/src/side-pots.ts`（新規）・`side-pots.test.ts`（新規）
- `packages/engine/src/hand-engine.ts`・`hand-events.ts`・`hand-state.ts`・`projection.ts`（コメント）・`index.ts`・`testing/invariants.ts`
- `packages/engine/src/hand-engine.test.ts`・`hand-engine.property.test.ts`・`hand-scenarios.test.ts`
- `apps/server/src/event-upcast.ts`（新規）・`sqlite-event-store.ts`・`sqlite-event-store.test.ts`・`routes/hands.ts`
- `apps/web/src/lib/view-model.test.ts`（Event の型に合わせた fixture のみ）
- `docs/decision_log.yaml`（D77〜D80 追記・D70 の status を「D75・D78 で一部変更」に・範囲表記）・`docs/00_DOCUMENTATION_INDEX.md`・`docs/10_DECISION_TRACEABILITY.md`（範囲表記・判断グループ）・`docs/11_OPEN_ITEMS.md`（OI-008 に暫定値の一覧）・`docs/08_MVP_AND_ROADMAP.md`（Phase 2 の分解・除外先）・`docs/03_SYSTEM_ARCHITECTURE.md`・`docs/04_DATA_AND_EVENTS.md`（§3 の Event 表・schema_version）・`README.md`（範囲表記）

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan を参照）。
- UI は変えていない。現状の Orchestrator は全 Hand を均等 Stack で始めるため Side Pot は起きず（同額の All-in は 1 Pot になる）、画面の挙動は変わらない。そのため dev サーバーでの実測は行っていない（web のテストは通過）。

## 残課題

- `apps/web` は `unsupported_state` を API の失敗種別として残している（`lib/api.ts`・`hooks/useHandSession.ts`。Server はもう返さないので届かない）。UI 構造に触れない範囲として本 PR では変えていない。
- 進行ログは Pot ごとに「〜がポットを獲得」を 1 行ずつ出す。Main / Side Pot の区別の表示は UI の Issue で扱う。
- `legal-actions.ts` のコメント「累積 Short All-in による再開は Phase 2（D70）」は #32（D79）で更新する。
- 範囲表記 `D01〜D76` が統制面に残っている: `.claude/skills/sync-check/SKILL.md`・`.claude/skills/test-and-review/SKILL.md`（担当外のため親が更新する）。
