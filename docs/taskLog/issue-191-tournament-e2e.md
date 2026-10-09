# Issue #191: Tournament の Critical E2E と README（P8-9）

## 概要

Phase 8 の 6-max STT を、開始から Blind / Ante・Resume・Elimination・Heads-Up・終了・Payout / Result・ICM の Review・Replay・新しい Tournament まで 1 本の Playwright の E2E（`e2e/tests/tournament.spec.ts`）で通した。既存の Cash の E2E 11 本はそのまま通る（Cash Regression）。`docs/09` に Phase 8 の E2E（§8）と #107 の DoD の項目とテストの対応（§12）を書き、README を Phase 8 の到達点へ更新した（`release-readme-sync`）。プロダクトのコード・Preset の値（D127）は変えていない。

## 初期調査

- 正本: D98（E2E は RuleBot と固定応答で Claude を呼ばない）・D108・D109・D127〜D130、`docs/02` §7、`docs/06` §15、`docs/09` §8。
- server に Tournament のテスト用の設定（短い Blind 表など）を差し込む口は無い。Preset は `TOURNAMENT_PRESETS`（Engine）の固定値で、開始の API は Preset の ID だけを受け取る。
- 完走の所要: API で同じ設定（`POKER_SEED=20261006`・RuleBot・思考待ち 0）の server を回して測った（使い捨てのスクリプト）。Hero が毎 Hand Call / Check だと 8 Hand 目に 5 位で Bust（Heads-Up に届かない）。Heads-Up までは Check / Fold、Heads-Up では All-in だと 73 Hand 目に Heads-Up に入り、その Hand で 2 位で終わる（API で 3.5 秒）。→ 本番の Preset のままで十分に短いので、テスト用の Blind 表は足さない。
- 再起動すると seed の並び（`fixedSeedSequence`）は先頭から使い直すので、再起動の位置で以降の経路が変わる。再起動の位置（11〜20 Hand 目の後）ごとに同じ方針で測った結果:

  | 再起動の後の Hand | Heads-Up に入った Hand | 終わった Hand | Hero の順位 |
  |---|---|---|---|
  | 11 | 56 | 56 | 3 位（Heads-Up に入る Hand で Bust） |
  | 12 | 51 | 52 | 2 位 |
  | 13 | 54 | 54 | 3 位 |
  | 14 | 53 | 54 | 2 位 |
  | 15 | 無し | 49 | 4 位 |
  | 16 | 50 | 50 | 3 位 |
  | 17 | 無し | 67 | 2 位（2 人同時の Bust） |
  | 18 | 無し | 48 | 4 位 |
  | 19 | 58 | 58 | 3 位 |
  | 20 | 53 | 53 | 3 位 |

  12 Hand 目の後の再起動は、Heads-Up の Hand を 2 つ（Hero が 1 度勝ってから負ける）通るので選んだ。

## 設計方針

- **本番の Preset のまま**（`stt6_hand_count`）。Issue の「完走に時間がかかるならテスト用の設定」は不要と判断した（UI で 20 秒ほど）。プロダクトのコードに E2E 専用の口を足さない。
- **Hero の方針**: Heads-Up までは Check できれば Check、できなければ Fold（Stack を守り、CPU 同士の Elimination で残人数が減るのを待つ）。Heads-Up では All-in → Call → Check（決着を早める）。
- **進行の判定は API、表示は画面**: 残人数・順位・Payout は `GET /api/hands/:handId/tournament` の値で読み、見出し・Tournament の欄・Hero の欄・Review の表をその値と照らす。Hand は handId で特定し、「次の Hand へ」の後は `startNextHand`（#133）で新しい Hand に切り替わるまで待つ。
- **経路の前提が崩れたら落とす**: 「Hero は Level 1 で Bust しない」「Hero は Heads-Up の前に Bust しない」「Heads-Up の前に Elimination を見た」「残り 2 人で続いている」を assert にし、空振りで通さない（RuleBot・Engine の変更で経路が変わったら、再起動の位置か seed を選び直す。`docs/09` §8 に書いた）。
- **Resume**: 12 Hand 目の後に server を止め、同じ DB で起動し直し、画面を読み込み直して同じ Preset で「Hand を始める」。13 Hand 目（Level 2・同じ残人数と順位）として始まり、開始時の Stack が前の Hand の終わりと同じで、Chip の総量 9,000 が変わらないことを確かめる。
- **Restart**: 終わった後に Hero の欄の選択で Tournament を選び、「新しい Session を始める」で 1 Hand 目・Level 1・6 人の新しい Tournament が始まること。

## 変更ファイル

- `e2e/tests/tournament.spec.ts`（新規）
- `docs/09_TEST_STRATEGY.md`: §8 に「Phase 8（Tournament）の Critical E2E（Issue #191）」、§12「Tournament（Phase 8）のテスト」（#107 の DoD の項目とテストの対応表）
- `docs/08_MVP_AND_ROADMAP.md` §3.2: Phase 8 の DoD とテストの対応の在りか（`docs/09` §8・§12）を 1 文足した
- `README.md`: 現在のフェーズを Phase 8 に、できていること（Tournament の節）・制約・E2E の実行・`pnpm e2e` の説明を更新（D 範囲表記は D01〜D130 のまま）
- `docs/taskLog/issue-191-tournament-e2e.md`（この作業ログ）

`docs/03` / `docs/04` は、Component 境界・Event・永続化・ディレクトリ構造を変えていないので更新していない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過。`pnpm test`: engine 480・web 160・server 843 がすべて passed。
- `pnpm e2e`（全 12 本）: 12 passed（1.5 分）。Cash の 11 本（`session` 4・`session-end-layout` 3・`table-layout` 1・`learning` 1・`opponent-memory` 1・`review-tendency` 1）と `tournament` 1 本。`tournament` は 1 回 21 秒前後。
- 安定性（過去の E2E の一度だけの失敗の教訓）: `playwright test tests/tournament.spec.ts --repeat-each=10` を 2 回続けて実行した。
  - 最初の版: 1 回目 10 passed（3.9 分。1 回 20.6〜32.7 秒）、2 回目 10 passed（3.6 分。1 回 20.2〜21.1 秒）
  - Codex の P2 を直した最終版（19872d4）: 1 回目 10 passed（3.6 分。1 回 20.3〜21.6 秒）、2 回目 10 passed（3.6 分。1 回 20.5〜21.4 秒）
- 画面の経路の Hand の番号: 一時的に `console.log` を足して 1 回通し（コミットしていない）、50 Hand 目の後に残り 2 人、52 Hand 目で終わることを確かめた（API で測った値と同じ。Heads-Up は 51・52 Hand 目）。

## レビュー対応

- 自己レビュー: 前提の assert の文言を「12 Hand 目までに」に合わせた（60adcda）。
- Codex（1 回目。clean・P2 が 2 件。どちらも CONFIRMED で修正。19872d4）:
  - ①Payout の合計を Prize Pool「以下」でしか見ていなかった → 順位の決まった Player の Payout をその順位の賞金と完全一致で確かめ、合計は終わり方ごとに完全一致（Hero が優勝なら 600pt。Heads-Up で Bust したら残った CPU 1 人が未決〔D129〕で 300pt）。常に 600pt を求めると D129 と矛盾するので分けた。
  - ②新しい Tournament で Level・人数だけを見ていた → 最初の Hand の開始時に全員 1,500 であることを Replay で確かめる。
  - P2 だけの修正で、条件付き再レビューの①〜④に当たらないので Codex は再実行していない。

## #107 の DoD の根拠（親が #107 へコメントする材料）

| DoD の項目 | PR | テスト |
|---|---|---|
| 既存 Hand Engine を再利用して 6-max STT を完走 | #193・#195・#200・#201 | `packages/engine/src/tournament.test.ts`「Rule Profile は Cash と共有し、Blind と Ante を Level の額にする」・`apps/server/src/tournament-session.test.ts`「Tournament は Preset の Starting Stack と 1 Level 目の Blind で始め、設定の Snapshot を SESSION_STARTED に残す」・`packages/engine/src/tournament-standings.test.ts`（既存の `nextHandSeating` で Heads-Up へ）・`e2e/tests/tournament.spec.ts`（開始から終了まで） |
| Blind / Ante が Versioned Config で動く | #193・#194 | `packages/engine/src/tournament.test.ts`（標準 Preset・`validateTournamentConfig`・SESSION_STARTED の Snapshot）・`hand-engine.test.ts`「startHand の Ante と Tournament の Level」・`hand-engine.property.test.ts`「Ante（per_player / big_blind_ante）・不均等 Stack …」・`apps/server/src/tournament-session.test.ts`「hand_count: Session の Hand の数で 10 Hand ごとに Level を上げ、その Level の Blind と Big Blind Ante で始める」・Resume の Level の再構築 |
| time-base / hand-count-base の契約がある | #194・#200 | `packages/engine/src/tournament.test.ts`「hand_count は Session の Hand の数で handsPerLevel ごとに 1 つ上げ」「time_base はプレイ時間の累計で levelDurationMs ごとに 1 つ上げ」・`apps/server/src/tournament-session.test.ts`（time_base の累計・時計の巻き戻り）・`apps/server/src/tournament-table.test.ts`（次の Level までの残り） |
| 標準 Preset は hand-count + BBA | #193・#194 | `packages/engine/src/tournament.test.ts`「標準 6-max STT は Starting Stack 1,500・10/20 から 10 Hand ごと・BBA の額は BB・50/30/20・参加費 100pt」・`e2e/tests/tournament.spec.ts`（Level 1 の 10 / 20・BB Ante 20、Level 2 の 15 / 30・BB Ante 30） |
| Elimination / Placement / Payout が deterministic | #195・#196 | `packages/engine/src/tournament-standings.test.ts`・`tournament-payout.test.ts`・`tournament-payout.property.test.ts`・`apps/server/src/tournament-session.test.ts`（Elimination と順位）・`e2e/tests/tournament.spec.ts`（Elimination・Result） |
| 50 / 30 / 20 Preset が動く | #196 | `packages/engine/src/tournament-payout.test.ts`「標準 6-max STT は 100pt × 6 = 600pt を 50 / 30 / 20 で 300 / 180 / 120」・`e2e/tests/tournament.spec.ts`（Hero の Payout・3 位 120pt・Prize Pool 600pt） |
| ICM Calculator が deterministic で 2〜8 人を扱う | #197 | `packages/engine/src/icm.test.ts`「8 人を扱える」「2〜8 人以外・重複・負や小数の Stack … は拒否する」・手計算の Scenario・`icm.property.test.ts` |
| Chip EV と ICM を別 Evidence として Review できる | #199・#200 | `apps/server/src/review/tournament-evidence.test.ts`「All-in への Call: 相手 1 人で、Chip EV（Pot Odds と同じ）と ICM の必要 Equity を別の id で並べる」・`review-tournament.test.ts`（Grounding）・`apps/web/src/components/tournament.test.tsx`（TournamentEvidenceView）・`e2e/tests/tournament.spec.ts`（Review の欄が別項目・2 つの列） |
| Tournament Context が CPU KnowledgeState に Public 情報として入る | #198 | `packages/engine/src/tournament-knowledge.test.ts`「Session の情報を渡すと、viewer から見た Tournament Context を持つ」「Tournament の値に Hole Cards・Deck は入らない（構造の whitelist）」・`apps/server/src/opponents/rule-bot.test.ts`「RuleBot と Tournament Context」・`claude-opponent.test.ts`「Tournament の Prompt」 |
| Phase 7 Private Memory の Isolation が Tournament でも維持 | #198 | `apps/server/src/memory/tournament-isolation.test.ts`「Tournament の Prompt は公開の Tournament Context と tournament の Memory だけを足し …」・`observation-cache.test.ts`「Tournament の context」 |
| Push/Fold Nash Solver を Phase 8 完了条件にしない | #197・#199 | `apps/server/src/review/review-tournament.test.ts`「Tournament の Spot は Solver の Capability Gate に mode: tournament で渡り、Unsupported（mode）の正常な Fallback になる」。Tournament の Solver は置いていない（Shove の ICM の必要 Equity は条件付き。D130） |
| Tournament Critical E2E と Cash Regression が通る | #201 | `e2e/tests/tournament.spec.ts` と既存の Cash の E2E 11 本（CI の `e2e` ジョブ。上の「実行した確認」） |

## 残課題

- Tournament の E2E の経路は seed・RuleBot・再起動の位置に依る。RuleBot・Engine を変えて前提の assert で落ちたら、上の表と同じ測り方で再起動の位置か seed を選び直す。
- 狭い画面での Tournament の配置は #190 で実測済みで、この E2E は既定の画面（1280×720）だけで通す。
- #190 からの残課題（Session Review に Tournament の Result を出すか・Session の終わりの Hero 欄の `select` で狭い画面が 1 行高くなる）と、Tournament の Prompt（CPU・Review）の実モデルの録画（#188・#189）は未着手。
