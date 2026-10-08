# Issue #153: Table Tendency を Hero の Review の Evidence に入れる

## 概要

人間判断 D122（D35・D106・D117 の具体化）に従い、Hero の Decision Review（Pass A）の Evidence の Opponent Observation に、判断の Hand より前に保存した、同じ Session の Hero が座っていた Hand の public の Event だけから決定論で作った Table Tendency を、項目ごとの Evidence ID 付きの構造化 Evidence として入れた。数値は決定論のコードが正本で、Review AI は説明だけを行う。十分な項目が 1 つも無ければ `unavailable` のままで、Evidence・Prompt・Schema は #153 より前と同じ文字列（Review Eval の録画の paramsHash は変わらない。録画は取り直していない）。Pass B（Reveal Review）の契約は変えていない。テーブル・列・Event の形・`schema_version`・マイグレーションは足していない。CPU 側の Memory / Tilt / Table Tendency の計算・CPU の Prompt・`learning/` の挙動は変えていない。

## 初期調査

- Hero 用の入り口 `buildHeroTableTendencyFromStore`（#141・PR #152）は `beforeOrd` で判断より前の Hand に絞れる。Review の対象は終わった Hand だけ（`ReviewService.target`）なので、その Hand の `ord`（`savedOrder`）と Session（`sessionIdOfHand`）は必ずある。`beforeOrd = その Hand の ord` にすれば、その Hand 自身（判断より後の Event を含む）と後の Hand が入らない。
- `docs/05` §6 の Opponent Observation は `{ status: "unavailable", reason }` 固定で、`exploitBasis` の `observation` はこれが `unavailable` でない時だけ選べる作り（`review-ai.ts`）。Table Tendency はここに入れるのが既存の契約の延長になる（§5 の #141 時点の記述も Opponent Observation の契約の変更として扱っていた）。
- Prompt の指紋: `buildReviewPrompt` は Evidence の JSON・項目の説明（`evidenceGlossary`）・条件付きの節で作る。項目の説明に新しい項目を常に足すと全録画の paramsHash が変わるため、Table Tendency があるときだけ出す構造ゲートが要る（#115 の `USER_READ_GUIDE`・#139 と同じ方式）。Pass B の項目の説明は全項目を出すので、Pass B にも出ないよう絞る必要がある。
- 識別子の置換（#96）の網羅テストは、Evidence に出る camelCase の項目名と snake_case の値がすべて対応表にあることを要求する（`tableTendency`・`policyVersion`・`aggression_frequency`・`phase7_table_tendency_v1`）。
- Review Eval のハーネスは `buildReviewEvidence` を Table Tendency なしで呼ぶ（固定 Hand は前の Hand を持たない）ので、録画の再生は今のまま通る。
- 文の中の数値を Evidence と照合する Grounding は、今の検証（`checkReviewOutput`）にも Eval の指標にも無い（Grounding は id の参照だけ）。

## 設計方針

- **置き場所**: `ReviewEvidence.opponentObservation` を `unavailable | available` の union にし、`available` のときに `tableTendency`（Policy の版・数えた Hand の数・項目ごとの `id`〔`tendency:<handId>/d<判断の番号>/<項目>`〕・`rate`・`numerator`・`denominator`・`hands`・`sufficient`）を持たせた。
- **入れる条件**: 十分な項目（Policy の基準以上）が 1 つ以上あるときだけ（Hand が 0・全項目が保留なら `unavailable` のままで、#153 より前と同じ Evidence）。入れるときは保留の項目も `sufficient: false` のまま残し、保留として読ませる（CPU の「卓の傾向」の節・Hypothesis と同じ扱い）。
- **数値**: 割合は `numerator / denominator` を決定論で小数第 3 位まで計算した値で、Review AI に割り算させない。
- **作る場所**: Evidence の組み立て（`evidence.ts`）は Event Store を読まず、`ReviewService` が `beforeOrd` を渡して作った値を `EvidenceDeps.tableTendency` で受け取る（Review Eval・テストは渡さない＝入らない）。
- **Prompt（構造ゲート）**: あるときだけ、読み方 `TABLE_TENDENCY_GUIDE`（卓全体の傾向で個々の相手の傾向ではない／数値は Evidence の値をそのまま使う／保留の項目は根拠にしない／特定の相手の傾向として断定しない／Exploit の根拠にするなら `observation` と十分な項目の id）と、項目の説明（`tableTendency`・`policyVersion`・`rate`・`numerator`・`denominator`・`hands`・`sufficient`）を添える。`REVIEW_SYSTEM_PROMPT` は変えない（全録画の指紋が変わるため）。
- **Schema / Grounding**: `exploitBasis` の enum に `observation` が入るのは `available` のときだけ（既存の `exploitBases` のまま）。`exploitBasis` が `observation` なら、サンプルが十分な項目の id を `evidenceIds` に 1 つ以上挙げることを求める（保留の項目だけ・id 無しは `grounding` の不正）。
- **Evidence IDs**: Review Record の `evidence_ids` に、卓の傾向があるときだけ `tableTendency` を持たせた（無い Review の記録は #153 より前と同じ形。列は足さない）。
- **Follow-up**: Pass A への質問の Prompt は保存済みの Evidence をそのまま使うので、卓の傾向のある Evidence のときだけ項目の説明を出す（読み方の節は足さない。Follow-up は `USER_READ_GUIDE` も持たない作りに合わせた）。
- **Pass B**: Evidence の形・Prompt を変えない（既存の契約に合わせる。Pass B は判断時点の読みと実際の札の答え合わせで、卓の傾向は答え合わせの対象ではないため）。
- **識別子の置換**: 上の項目名と `aggression_frequency`・`phase7_table_tendency_v1` を対応表に足し、id の検出パターンに `tendency:` を足した。英単語と同じ綴りの `rate`・`hands`・`sufficient` は `name=値` の形のときだけ置換する（`plain`）。

## 変更ファイル

- `apps/server/src/review/types.ts`: `TableTendencyEvidenceItem`・`TableTendencyEvidence`、`OpponentObservationEvidence` を union に、`EvidenceIdSet.tableTendency`（任意）
- `apps/server/src/review/evidence.ts`: `EvidenceDeps.tableTendency`、`opponentObservationEvidence`・`tableTendencyIdsOf`、Evidence IDs と選べる id に追加
- `apps/server/src/review/review-ai.ts`: `TABLE_TENDENCY_GUIDE`、項目の説明の出し分け、`observation` の Grounding
- `apps/server/src/review/identifiers.ts`: 卓の傾向の項目の説明（`tableTendency` 付きの項目は、あるときだけ出す）、値の対応、id の検出パターン
- `apps/server/src/review/followup.ts`: Pass A の Evidence に卓の傾向があるときだけ項目の説明を出す
- `apps/server/src/review/review-service.ts`: `heroTableTendencyBefore`（判断の Hand の Session と ord から作る）を Evidence に渡す
- `apps/server/src/memory/table-tendency.ts`: Hero 用の入り口のコメントだけ（計算は不変）
- テスト: `review/review-table-tendency.test.ts`（新規）・`testing/table-tendency-fixture.ts`（新規）・`review/generate.test.ts`・`review/identifiers.test.ts`・`memory/table-tendency-isolation.test.ts`
- docs: `docs/03` §7・`docs/04` §8・§12・`docs/05` §5・§6・§7・`docs/09` §3（INV-TEST-008）・§6・`docs/11` OI-011・`README.md`（Phase 7）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 58 files / 741 tests、engine 363、web 141）
- 録画の指紋: `testing/review-eval/harness.test.ts`（録画の再生）が変更なしで通る＝卓の傾向の無い入力の Prompt・Schema・options は #153 より前と同じ。加えて `generate.test.ts` で、卓の傾向が無い・Hand 0・全項目保留の入力の Evidence・Prompt・Schema が無い場合と一致することを確かめた
- 境界（`review/review-table-tendency.test.ts`。Fake の Review AI）: 別の Session の Hand 3 → 前の Hand 11 → Review の対象の Hand → 後の Hand 5 の Store で、Evidence の卓の傾向が前の Hand 11 だけから作った値と一致（後の Hand を含めると値が変わることも確かめ、空振りでないこと）・後の Hand が無い Store と同じ・見えない Event（他者の札・Deck。Learning-only Reveal の元）を差し替えても、前の Hand の Pass B を先に作っても同じ・前の Hand が 0 / 4 なら `unavailable`・Pass B の Evidence に入らない
- 境界（`memory/table-tendency-isolation.test.ts` を拡張）: Claude の CPU（Fake）で 12 Hand の Session を進め、5 Hand 目（前が 4 Hand）と 12 Hand 目（前が 11 Hand）の判断を Review。前者は `unavailable`、後者は Hero 用の入り口に `beforeOrd` を渡した値と一致。どちらの Review の Prompt にも CPU の Memory の節・Tilt の節・`phase7_memory` / `phase7_tilt` / `phase7_pool` / `phase7_rulebot`・Persona の Preset ID が無い。Review 以外の Hero への応答・Event Log に Table Tendency は出ない
- Prompt / Grounding（`review/generate.test.ts`）: 項目ごとの id と割合（0.3・0.117・0.333）、Evidence IDs と選べる id、読み方と項目の説明はあるときだけ、`exploitBasis` の enum、`observation` で id 無し・保留の項目だけは `grounding` の不正・十分な項目の id で通る、Follow-up の項目の説明
- 識別子（`review/identifiers.test.ts`）: 卓の傾向のある Evidence の項目名・値が対応表で網羅される、項目の説明は Pass A で卓の傾向があるときだけ（Pass B には出ない）、置換の結果
- 変異の確認（手元で入れて戻した）: `ReviewService` の `beforeOrd` を後の Hand まで含む値にすると、`review-table-tendency.test.ts` と `table-tendency-isolation.test.ts` の境界のテストが落ちる

## 判断理由

- 十分な項目が無いときに入れない理由: 保留の値だけでは Exploit の根拠にならず、入れると Prompt の指紋が変わる（Session の序盤の Review の録画・挙動を #153 より前と同じに保てる）。
- 保留の項目も残す理由: 「この項目はまだサンプルが足りない」と書けるようにするため。保留の項目だけを根拠にした `observation` は Grounding で弾く。
- Pass B に入れない理由: 親の指示（既存の契約に合わせる）と、Pass B の役割（判断時点の読みと実際の札の答え合わせ）に卓の傾向が要らないため。Pass B の録画の指紋も変えない。

## 残課題

- **実モデルの品質は未測定**: 卓の傾向が入った Review を実モデルで録画していない（Review Eval の代表の判断は前の Hand を持たない固定 Hand）。説明が数値を作らない・個々の相手の傾向として断定しない・保留の項目を根拠にしない、の実測には Review Eval に前の Hand を持つ判断を足して録画し直す必要がある（実モデルの呼び出しが要るので、この PR では行わない。親へ報告）。
- **文の中の数値の照合は無い**: Grounding は id の参照だけで、Review AI の文の数値を Evidence と照合する検証は今の検証・Eval のどちらにも無い（この PR では足していない）。
- **画面には卓の傾向を出していない**: Review の根拠の区分（`apps/web` の `ReviewPass.tsx`）に卓の傾向の区分は無い。説明が卓の傾向の id を根拠に挙げても、その区分の「説明の根拠」の印は出ない。出すかは UI の判断として別に扱う。
