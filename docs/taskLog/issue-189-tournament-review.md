# Issue #189: Tournament Review に ICM Evidence を Chip EV と分けて足す（P8-7）

## 概要

Tournament の Hand の Decision Review（Pass A）に、公開の Tournament の状況と、判断時点の ICM Equity、All-in の関わる判断の Chip EV / ICM の必要 Equity を、別の項目・別の Evidence ID で足した（D109・D130）。数値の正本は Engine の ICM Calculator（#187）で、Review AI は説明だけを行う（Prompt と Grounding）。P8-2（#184）からの引き継ぎ（Drill と Tournament の Hand の Ante / Level）もこの Issue で決めた。

## 初期調査

- 正本: D109・D122・D125・D130、`docs/05` §6〜§10、`docs/02` §7、`docs/04` §8。
- 既存の Evidence の作法: `apps/server/src/review/types.ts`（`ReviewEvidence` / `EvidenceIdSet`）・`evidence.ts`・`identifiers.ts`（`EVIDENCE_TERMS` と構造ゲート）・`sufficiency.ts`・`review-ai.ts`（Prompt・Schema・Grounding）。Table Tendency（#153）と同じく、無い Evidence では Prompt を前と同じ文字列に保つ（Review Eval の録画の指紋）。
- ICM: `packages/engine/src/icm.ts` の `icmEquities` / `icmCallAllIn` / `icmShove`（Shove の比較点で Pot を取る Player は呼び出し側が渡す）。CPU の Context（#188）は Hand の開始時の Stack で、Review は判断時点の Stack で取ると `docs/02` §7 に書かれていた。
- Solver: `solver-evidence.ts` が `mode: "cash"` 固定。amaster97 の `supports()` は `mode` を見て Unsupported を返す。
- Drill: `buildDrillSpot` は Ante / Level を写さない（#194 の P3 引き継ぎ）。

## 設計方針（暫定 Policy。人間判断を経ていない。OI-007）

- **Evidence の形**: `ReviewEvidence.tournament?`（Tournament の Hand だけ）。id は `tournament:` / `icm:` / `chipev:<…>/<相手>` / `icmreq:<…>/<相手>`。`EvidenceIdSet.tournament?` に残す（列・マイグレーションは無し）。
- **判断時点の ICM Equity**: 判断時点の手元の Stack にこの Hand で出した額を戻した Stack（Pot の行方を決めない。BBA の Dead Money は戻さない）。版 `phase8_review_tournament_v1`。
- **All-in の判断の見分け方**: Hero の All-in が相手の誰の額も超え、Call できる相手がいれば Shove。All-in に直面・Call で Hero が All-in・相手を超えない All-in は All-in への Call（相手は出した額が最も大きい Player）。
- **Shove の比較点で Pot を取る Player**: 出した額が最も大きい相手 → 同額なら最後に Bet / Raise した相手 → 席順で先。
- **範囲外**: ICM Calculator が拒否する All-in（Multiway 等）は `out_of_scope` とし、Sufficiency Gate が `tournament_icm` で Review AI を呼ばない（Chip EV だけで評価しない）。
- **Grounding**: All-in の判断では `icmreq:` の id を 1 つ以上求める。
- **Prompt**: Tournament の Evidence があるときだけ System Prompt の 1 行目をトーナメントにし、`TOURNAMENT_GUIDE` を添える。All-in・Shove の節はその値があるときだけ（構造ゲート）。Follow-up（Pass A）も同じ。
- **Important Spot**: Engine の `tournamentImportantSpotReasons`（版 `phase8_tournament_spot_v1`。`bubble` / `pay_jump` / `short_stack`〔10BB 以下〕）。Review の Pass A / Pass B と Review Eval が `reviewSpotReasons` を通る（LC-050）。Replay・Hand Summary・Session Review の Important Spot は変えていない（#190）。
- **Solver**: `buildSolverEvidence` に `mode` を渡す（Tournament は `unsupported: mode` の正常な Fallback）。
- **Drill**: KISS で可逆な方として、Tournament の Hand を Drill の題材にしない（`phase8_drill_tournament_v1`）。Session Review の Recommended Drill も Tournament の Session では出さない。
- **Review Eval**: Tournament の固定 Hand 2 つを `TOURNAMENT_REVIEW_EVAL_CASES` に足し、Fake で本番と同じ経路を通す。実モデルの録画はしない（人間判断）。

## 変更ファイル

- `packages/engine/src/hand-summary.ts`・`index.ts`: `ImportantSpotReason` に `bubble` / `pay_jump` / `short_stack`、`tournamentImportantSpotReasons` と規則の版。
- `apps/server/src/review/tournament-evidence.ts`（新規）: Tournament の Evidence と Important Spot の理由。
- `apps/server/src/review/types.ts`・`evidence.ts`・`sufficiency.ts`・`review-ai.ts`・`generate.ts`・`followup.ts`・`identifiers.ts`・`solver-evidence.ts`・`review-service.ts`・`fake-review-query.ts`
- `apps/server/src/tournament-session-info.ts`（新規）: Hand の Session の設定と Tournament の情報を Event Log から読む。
- `apps/server/src/drill/drill-service.ts`・`learning/session-review.ts`: Tournament の Hand を Drill の題材にしない。
- `apps/server/src/testing/review-eval/hands.ts`・`harness.ts`: Tournament の固定 Hand と Eval の判断。
- `apps/web/src/lib/review.ts`: Important Spot の理由の表記（型を満たすだけ。画面は #190）。
- テスト: `review/tournament-evidence.test.ts`（新規）・`review/review-tournament.test.ts`（新規）・`review/identifiers.test.ts`・`testing/review-eval/harness.test.ts`・`routes/drills.test.ts`・`learning/session-review.test.ts`・`packages/engine/src/hand-summary.test.ts`
- docs: `docs/02` §7・`docs/03`・`docs/04` §8・`docs/05` §6・§8・§10・`docs/07` §6・§7・`docs/09` §6・`docs/11` OI-007

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて通過（engine 480・web 147・server 833 件）。
- 既存の Review Eval の録画の再生（`harness.test.ts`）が通る＝Cash の Evidence・Prompt・Schema の指紋は変わっていない。
- Bubble の Shove / All-in への Call の Evidence を出力して値を目視（All-in への Call の Chip EV の必要 Equity 45.0% は Math の Pot Odds と一致、ICM は 62.0%）。

## 残課題

- Tournament の Review Eval の実モデルの録画（Claude の利用枠を使うので人間判断）。
- Replay・Hand Summary・Session Review の Important Spot に Tournament の理由を足すか、画面での Evidence の見せ方（#190）。
- Pass B（Reveal Review）の Prompt は Cash の文のまま（ICM の Evidence は Pass A だけ）。
- Drill で Tournament の Ante / Level を写すかは、Drill を Tournament に広げるときに版を上げて決める。
