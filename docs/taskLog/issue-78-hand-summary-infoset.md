# Issue #78: Hand Summary Projection と判断時点の Hero Information Set を作り Important Spot を抽出する

## 概要

Phase 5 の 2 つ目の子 Issue。Event Log（正本。D37）から、Hand Summary Projection・Hero の判断ごとの判断時点の Hero Information Set（Decision Review〔Pass A〕の入力の元）・Important Spot を作る Engine の関数を足した。Learning-only Full Reveal（Hand 後に全員の札を見せる情報）は別の Projection にした。Replay の再生の応答に、Jump to Important Spot（#84）の飛び先として Important Spot を step の位置で入れた。Event・スキーマ・DB は変えていない。

## 初期調査

- 前提（main fb7a599）: Event は版 6。`projectHeroView` / `projectKnowledgeState` / `visibleEvents`（`packages/engine/src/projection.ts`）は public と自分宛て private だけを畳み込む whitelist。`learning_only` の Visibility は docs/04 §4 に定義だけあり、Engine は発行しない。
- Replay（#68）の step は Hero に見える Event 1 件ごとで、Action に決まった裁定（`DEALER_RULING`・`outcome: action`）だけ直後の `ACTION_TAKEN` と 1 step にまとめる。→ Important Spot を「判断時点の Event の seq」で表せば、step の末尾の Event の seq で必ず引ける（判断時点が Action に決まった裁定になることは無い）。
- Hero の物理的な操作（D90）: 手番の操作は `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` → `DEALER_RULING` → `ACTION_TAKEN` を同じ追記で置く。`no_action` の後の選び直しも Hero が手番のまま続く。Out-of-Turn は保留の操作と `out_of_turn` の裁定が手番より前にあり、手番で `pending_out_of_turn` の裁定 → `ACTION_TAKEN`。
- `HAND_ABORTED` は system Visibility で Hero の Projection に入らない。Replay は打ち切りだけを `events.some(HAND_ABORTED)` で例外的に読んでいる（D95）。

## 設計方針

- 置き場所は Engine（純粋関数。I/O・LLM を持たない）。Hand Summary・Information Set は保存しない派生。
- 判断時点 = Hero の `ACTION_TAKEN` の直前に続く Hero 自身の操作（宣言・Chip の操作・裁定）を除いた、その前の Hero に見える Event（`decisionPointSeq`）。Hero 自身の操作は判断そのものなので判断時点の情報に入れず、裁定の理由は判断の `rulingNotes` に残す。
- Information Set は「判断時点までの Event を先に切り出す → Hero に見える Event だけ → `projectKnowledgeState`」で作る（ai-boundary の「入力組み立て関数が判断時点までだけを受け取る形」）。CPU へ渡すものと同じ whitelist を使い、新しい漏れ経路を作らない。
- Important Spot は判断時点の Information Set だけを入力にする（結果を見ないので、抽出そのものも Hindsight を含まない）。しきい値は `DEFAULT_IMPORTANT_SPOT_RULES` の暫定値（コメントに根拠）で、引数で差し替えられる。
- Learning-only Full Reveal は Event の Visibility を増やさず（Event の形を変えない）、別の関数 `projectLearningReveal` にした。Hand が終わった後だけ返し、値に `visibility: "learning_only"` の印を付ける。他の Projection はこれを参照しない。

## 変更内容

- `packages/engine/src/hand-summary.ts`（新規）: `heroDecisions` / `heroInformationSets` / `extractImportantSpots` / `projectHandSummary` / `DEFAULT_IMPORTANT_SPOT_RULES`（`bigPotBb: 20`・`riverBigBetMinPotOdds: 0.3`）。理由は `big_pot` / `all_in` / `river_big_bet` / `ruling`。
- `packages/engine/src/learning-reveal.ts`（新規）: `projectLearningReveal`。
- `packages/engine/src/index.ts`: 上記を公開。
- `packages/engine/src/testing/view-leaks.ts`: `hiddenMarkers` に Session の system Event の種別名と `learning_only` を足した。`tamperHiddenEvents` で Session の system Event の中身も差し替える。
- `packages/engine/src/hand-summary.test.ts`（新規・Scenario 17 件）: 判断と判断時点・River の Card だけを入れ替えても Turn までの判断は同じ・未来の Board / 他者の札 / 結果が入らないこと・切り落としても同じ・裁定と Out-of-Turn の扱い・Important Spot の各理由としきい値・Summary（Pot・Showdown・収支・system Event・打ち切り・進行中）・Learning-only Reveal と INV-TEST-008 相当。
- `packages/engine/src/hand-summary.property.test.ts`（新規）: Hero が Canonical Action と物理的な操作（Out-of-Turn を含む）を混ぜ、CPU の手番に system の記録を置き、時々打ち切る Hand で、全判断の Information Set に未来の Card・他者の Hidden Cards・system / engine の Event・Learning-only Reveal が入らないこと（判断時点の全情報の State との比較・見えない Event の差し替え・判断後の切り落とし）、Summary の Chip 保存、Reveal でだけ見える札がどの CPU の KnowledgeState（全 prefix）にも入らないことを確かめる。空振りしていないこと（裁定・OOT の拘束・打ち切り・River・Important Spot・system を通った）も確かめる。
- `apps/server/src/replay.ts`: `ReplayHand.importantSpots`（`stepIndex` / `decisionIndex` / `street` / `reasons`）と `replayImportantSpots`。step が見つからなければ黙って落とさず投げる。
- `apps/server/src/routes/replay.test.ts`: 各 Important Spot の step が判断の直前（Hero の手番・Action は未反映）であること、裁定の入った判断が Spot になることを確かめる。
- docs: `docs/04` §1（Hand Summary・Information Set・Important Spot）・§4（Learning-only Full Reveal の Projection）、`docs/03`（Replay の応答の `importantSpots`）、`docs/05` §7（Pass A / Pass B の入力の元）、`docs/09` INV-TEST-008（CPU Memory が出来るまでの確かめ方）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 254・server 195・web 109 件が通過）/ `pnpm format:check`: すべて通過。
- Property テストは 3 回続けて実行し通過（空振り検査を含む）。

## 残課題

- Review の Evidence Model（Math / Range / Solver / KB）への接続は #79〜#82、Jump to Important Spot の UI は #84。
- Important Spot のしきい値（20BB・Pot Odds 0.3）は暫定値。Review の運用を見て見直す。
- Out-of-Turn で拘束した判断は、判断時点を「手番が来た時点」としている（保留した操作は過去の公開の出来事として情報に残る）。Review で「OOT の時点の判断」として扱うかは Review（#82）で必要になったら決める。
