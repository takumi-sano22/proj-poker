# Issue #36: Phase 2 の Scenario 総点検と README 更新

## 概要

Phase 2（Full Poker Engine。#31〜#35）の最終 PR。`docs/02` §5 の必須 Scenario のうち Phase 2 範囲を既存の固定 Scenario と突き合わせ、不足していた 2 本を足した。2〜8 人・不均等 Stack のランダム Hand と、Stack を持ち越す複数 Hand の Session で Chip 保存を確かめる Property Test を足し、ルート README を Phase 2 の到達点に更新した。Engine・Server の挙動、Event の形、永続化スキーマは変えていない（テスト・テスト補助・README・作業ログだけ）。

## 初期調査

- 固定 Scenario は `packages/engine/src/hand-scenarios.test.ts`（データ + 汎用ランナー）に 20 本、Hand をまたぐ Scenario は `packages/engine/src/position.test.ts` に 3 本、Heads-Up の席と Blind は `hand-engine.test.ts` にあった。
- Property は `hand-engine.property.test.ts`（均等 Stack 2〜8 人・不均等 Stack 2〜6 人・再現性）と `position.property.test.ts`（nextHandSeating 単体）。不均等 Stack が 6 人まで、Hand をまたぐ Chip 保存は Property で見ていなかった。
- 不足: 「Fold 後の Action 順」を主題にした Scenario が無かった（6-max Standard の中で BB の Fold 後の拒否を 1 回見るだけ）。「Minimum Raise の Total と Increment」は Preflop だけで、Postflop の最小 Bet と Street ごとの Increment の数え直しが無かった。

## docs/02 §5 必須 Scenario との対応表

| 必須 Scenario | 範囲 | 対応する固定 Scenario / テスト |
|---|---|---|
| Minimum Raise の Total と Increment | Phase 2 | `SCN-min-raise-001`（Preflop。直前の Raise 幅を引き継ぐ）・**`SCN-min-raise-postflop-001`（本 PR。最小 Bet = BB・Street ごとに数え直す）**・`SCN-6max-standard-001`（Raise 3 の拒否） |
| Short All-in | Phase 2 | `SCN-short-allin-no-reopen-001`・`SCN-uncalled-over-short-allin-001` |
| 累積 Short All-in | Phase 2 | `SCN-cumulative-short-allin-reopen-001`・`SCN-cumulative-short-allin-no-reopen-001`・`SCN-cumulative-reopen-per-player-001` |
| Action Reopening | Phase 2 | `SCN-full-allin-reopens-001`（再開する）・`SCN-short-allin-no-reopen-001`（再開しない）・累積の 3 本 |
| Multi Side Pot | Phase 2 | `SCN-side-pot-3way-001`・`SCN-side-pot-multi-split-001`・`SCN-side-pot-dead-money-001`・`SCN-blind-allin-sb-001`・`SCN-cumulative-short-allin-reopen-001` |
| Odd Chip Split | Phase 2 | `SCN-odd-chip-2way-001`・`SCN-odd-chip-3way-001`・`SCN-odd-chip-order-001`・`SCN-side-pot-multi-split-001`（Side Pot 内の端数） |
| Heads-Up Button/SB | Phase 2 | `SCN-hu-standard-001`（Preflop 先手・Postflop 後手）・`SCN-blind-allin-bb-hu-001`・`SCN-min-raise-postflop-001`（Heads-Up の Postflop は BB が先手）・`hand-engine.test.ts`「2 人卓（Heads-Up）」「Heads-Up で Button（SB）の Stack が SB に満たなければ」 |
| 3 人→Heads-Up 移行 | Phase 2 | `position.test.ts` の `SCN-position-3to2-001`（Bust した BB を外し、Heads-Up では Button = SB）・`SCN-position-consecutive-bust-001` |
| All-in Showdown | Phase 2 | `SCN-allin-showdown-001`（札を公開してから Board を最後まで配る）・Side Pot の各 Scenario |
| Fold 後の Action 順 | Phase 2 | **`SCN-fold-order-001`（本 PR。Fold した Player を飛ばす・Postflop は Button の左で残っている Player から・同じ Street で Fold した Player には Raise の後も回らない）**・`SCN-6max-standard-001`・`SCN-fold-to-bb-001` |
| Blind / Ante | 一部 Phase 2・Ante は Phase 8 | Blind の投入と Blind での All-in は `SCN-fold-to-bb-001`・`SCN-blind-allin-sb-001`・`SCN-blind-allin-bb-hu-001`。Ante・Blind Level は Phase 8（Tournament）で足す |
| Oversized Chip | Phase 4 | Chip Physical Action・Ruling Engine（Phase 4）で足す |
| String Bet / Raise | Phase 4 | 同上 |
| Representative Out-of-Turn | Phase 4 | 同上 |

`docs/09` §4 の固定 Scenario も同じ表で追える（Standard Heads-Up / 6-max → `SCN-hu-standard-001`・`SCN-6max-standard-001`、Multiway All-in・3-way Side Pot → Side Pot の各 Scenario、Short All-in で Reopen しない Case → `SCN-short-allin-no-reopen-001`、累積 Short Raise → 累積の 3 本、Odd Chip Split → 端数の各 Scenario、Heads-Up 移行 → `SCN-position-3to2-001`、Oversized Chip・String Raise・Representative Out-of-Turn → Phase 4）。

対応表は `docs/09` に置き場（Scenario ID の一覧を持つ節）が無いため、ここに置いた。

## 変更内容

### 固定 Scenario（`packages/engine/src/hand-scenarios.test.ts`）

- `SCN-fold-order-001`: 6-max。Preflop で CO・BTN が Fold → Flop は SB から（BB・BTN の Action は `not_actor`）。BB の Bet 10 の後に UTG が Fold、Preflop で Fold した CO は飛ばして HJ が Raise、SB が Fold、Fold した UTG には Raise の後も回らず BB が Call。Turn は SB が Fold 済みなので BB から。Pot 84 を BB の AA が取る（期待値は手計算）。
- `SCN-min-raise-postflop-001`: Heads-Up。Flop の最小 Bet は BB の 2（Bet 1 は拒否）、Bet 10 への最小 Raise は 20（19 は拒否）、Raise 25（増分 15）への最小 Re-raise は 40。Turn は Increment を引き継がず最小 Bet が 2 に戻り、Bet 2 → Raise 4 → 最小 Re-raise 6。
- 汎用ランナー: Hand が終わったら `checkHandFinished` も確かめる（全 Scenario に掛かる）。

### テスト補助（`packages/engine/src/testing/invariants.ts`）

- `checkHandFinished(events, initialTotal)` を追加。終わった Hand の Event だけで、HAND_FINISHED の Player が HAND_STARTED の席と同じ順・Σ 終了時 Stack = 開始時の総量・Σ POT_AWARDED の potTotal = Σ Commit（Blind + Action − Uncalled 返却）・各 Player の終了時 Stack = 開始 − Commit + 配分、を確かめる。State ではなく Event Log から数え直すので、Session が Event Log から Stack を持ち越す前提（D37）を直接確かめられる。

### Property（`packages/engine/src/hand-engine.property.test.ts`）

- 不均等 Stack の Property を 2〜6 人 → 2〜8 人（`MIN_PLAYERS`〜`MAX_PLAYERS`）へ広げ、Hand 終了時に `checkHandFinished` を足した。均等 Stack の Property にも足した。
- Session の Property を追加: 2〜8 人・不均等 Stack から最大 12 Hand、各 Hand の HAND_STARTED（席順・Button）と HAND_FINISHED（Stack）から `nextHandSeating` で次 Hand の席を作って続ける。各 Hand で Invariant・畳み込み・`checkPotAwards`・`checkHandFinished`、Hand 間で「Bust（Stack 0）だけが席順を保って抜ける」「持ち越した Stack の合計 = 開始時の総量」、終了時は「勝ち残った 1 人が全 Chip を持つ」を確かめる。Projection の漏れ検査は既存の Property が担うので、ここでは省いた（多数 Hand で重くなるため）。
  - 網羅の確認（一時的な計測で、コミットしていない）: 100 run で Hand 間の移行 392 回・そのうち Bust を伴うもの 110 回・Session の終了 46 回を通った。

### README

`release-readme-sync` skill に従い、現在の状態・セットアップの遊び方・現在のフェーズ（Phase 2）・できていること（2〜8 人・不均等 Stack・Side Pot・Reopen・Position Engine・Session の Stack 持ち越し・Bust 退席・Session 終了）・制約（TABLE_SIZE は起動時・Rebuy なし・再起動後の Resume は Phase 5・BB 表示 / Fast Forward / Ruling は Phase 4・Ante は Phase 8）・次の Phase（Phase 3）を更新した。「Stack は毎 Hand 均等」「2〜8 人は Phase 2」の記述を消した。

## 判断理由

- 新しい Scenario の期待値は手計算で書き、Engine の出力をコピーしていない（初回の実行で全 Step の Legal Action・最終 Stack が手計算と一致した）。
- `checkHandFinished` は既存の `checkInvariants`（State 側）・`checkPotAwards`（Pot 単位）と重なる部分があるが、Event だけで Player ごとの増減まで数え直す点が新しい。Session は Event Log から次 Hand を作るので、Event 側の保存則を独立に確かめる価値がある。
- `docs/03`・`docs/04` は実装を変えていないので更新不要（テスト補助は docs/03 の構成に影響しない）。

## 実行した確認

worktree のルートで実行:

- `pnpm lint`: エラーなし
- `pnpm typecheck`: engine / server / web とも Done
- `pnpm test`: engine 14 files / 153 tests・server 7 files / 61 tests・web 2 files / 31 tests すべて成功
- `pnpm format:check`: All matched files use Prettier code style!

## 変更ファイル

- `packages/engine/src/hand-scenarios.test.ts`
- `packages/engine/src/hand-engine.property.test.ts`
- `packages/engine/src/testing/invariants.ts`
- `README.md`
- `docs/taskLog/issue-36-phase2-scenarios.md`（本ファイル）
- `.claude/skills/sync-check/SKILL.md`・`.claude/skills/test-and-review/SKILL.md`（Decision の範囲表記を D01〜D81 に更新。親セッションのコミット）

## 残課題

- 親 #2 の DoD のうち Phase 2 で満たした項目（NLHE Cash 2〜8 人・Dealer / SB / BB の Rotation・Short All-in / Reopen・Side Pot・Split Pot・Heads-Up Transition）はチェックが未更新。親 #2 の更新は親セッションの持ち分なので、ここでは提案に留める。
- `PHASE1_CASH_PRESET` のコメント「全員 100BB の均等 Stack を前提にする（D70）」は Phase 2 で前提でなくなった（初期 Stack の既定値として使っている）。挙動に関わらないので本 PR では触れていない。
- Oversized Chip・String Bet / Raise・Representative Out-of-Turn は Phase 4、Ante は Phase 8 で Scenario を足す。
