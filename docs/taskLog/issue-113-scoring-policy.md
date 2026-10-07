# #113 P6-2 Ability Evidence と ScoringPolicy phase6_provisional_v1 で Score を計算する

## 目的

Review Pass A の Version 付き Assessment から Ability Evidence を作り、`ScoringPolicy phase6_provisional_v1` で Ability / Overall Score を計算する（D103）。Score は都度計算し保存しない（D111）。Review 済みの判断だけで計算し、M 件中 N 件を返す（D115）。

## 変更内容

- `apps/server/src/learning/scoring-policy.ts`（新規）: `ScoringPolicy` の型と `PHASE6_PROVISIONAL_V1`（Ability の一覧・Assessment の点・Confidence の Weight・Decision → Ability の割り当て・Live Mechanics の点・Review の Version の選び方・Score の Confidence・Trend）。`SCORING_POLICIES` に Version ごとに置く。
- `apps/server/src/learning/ability-evidence.ts`（新規）: `buildAbilityEvidence`。Event Log の Hero の判断（`heroDecisions`）で M を数え、判断ごとに Pass A の `reviews` の最新の Version から Ability Evidence を作る。`excludeHandIds`（Drill の Hand。D116）を受け取る。
- `apps/server/src/learning/score.ts`（新規）: `computeScoreReport`。Overall（Poker Decision だけ）と Ability ごとの Score を、Policy Version・Confidence・Sample Size・Evidence IDs・Trend と一緒に返す。
- テスト: `apps/server/src/learning/score.test.ts`（13 件。M / N・insufficient_evidence の除外・Confidence の Weight・最新の Version・割り当て・Live Mechanics の分離・Drill の除外・終わっていない Hand・Policy の Version を変えた計算し直し・Trend・Pass B の Store を型で拒否）。
- docs: `docs/07` §2 に実装と暫定値、`docs/04` §12 に保存しないこと・入力の範囲、`docs/11` OI-006 に暫定値を追記（確定扱いにしない）。

## 判断理由

- 置き場所は server（Review の型が server にあるため）。Engine からは `heroDecisions` だけを使う。
- 割り当ては Review が持つ判断時点の Evidence（Pass A の入力）だけから決め、結果・後の Street・Pass B を見ない。
- Live Mechanics は Assessment ではなく裁定の理由（rulingNotes）から決める暫定式にした。Assessment は Poker の判断の評価で、Live Mechanics の評価ではないため（D48）。docs に式が無いので OI-006 の暫定値として Policy に置いた。
- Opponent Adaptation は Hero の Observation の Evidence がまだ無い（`opponentObservation: unavailable`）ので割り当てない。
- Store を読む関数（全 Hand を読む）は足していない。`computeScoreReport` は Event Log の配列と `Pick<ReviewStore, "list">` を受け取る形にし、API（#116）から既存の `listHands` / `read` で組めるようにした。
- マイグレーション・Event の形・reviews の書き込み経路は変えていない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて exit 0（engine 345・web 122・server 458 passed）

## 残課題

- 表示用の API・UI は #116、Learning Reset の区切り（D114）は #118、Drill の Hand の集合（drills テーブル）は #117。
- 暫定値（Weight・割り当て・Live Mechanics の式・Confidence の段階・Trend）は Playtest 後に Policy の Version を上げて見直す（OI-006）。
