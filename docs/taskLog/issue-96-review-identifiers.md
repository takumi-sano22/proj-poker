# Issue #96: Review の文に内部の識別子が出ないようにする

## 概要

実際の Claude（review_standard）で作った Review の文に、`cpu3`（playerId）や `userRead`（Evidence の項目名）のような内部の識別子がそのまま出ることがあった。Hero が読む学習用の文なので、表示名と自然な言葉にする。人間判断（D101。親が decision_log に記録）: **出力に識別子が見つかっても Retry はしない**。保存前に既知の識別子を機械的に置換し、Prompt でも識別子を出さないよう指示し、Evidence に表示名と項目の説明を添える。Eval には識別子の残存率を足す。

## 変更内容

- `apps/server/src/review/identifiers.ts`（新規）: 識別子の扱いを 1 か所に集めた。
  - `EVIDENCE_TERMS`: Evidence の項目名 → 自然な言葉の説明（boolean の項目は true / false ごとの言い回し）。Prompt の「Evidence の項目の説明」と出力の置換の両方がこの表を見る。`pass: "reveal"` の項目は Pass A・その Follow-up の Prompt に出さない（Pass A の Prompt に Hand 後の項目の名前を出さない）。
  - `sanitizeText` / `sanitizeOutput`: playerId → 表示名、項目名（`name=値`・`name が true`・`` `name` ``）→ 説明、`monte_carlo` 等の値 → 書き方。未知の識別子は推測せず残す。根拠の id と enum（assessment・basis・scope・evidenceIds）は触らない。`hero` のように表示名と大文字小文字しか違わない id、`folded` / `trials` / `spr` のように普通の英単語と同じ綴りの項目名は、文中の語と区別できないので置換しない（後者は `name=値` のときだけ）。
  - 対応表の網羅: Codex レビューの指摘（`playerId` `displayName` `decisionIndex` など Prompt へ実際に渡す項目名が表に無かった）を受け、Evidence の型を洗って camelCase の項目名（`playerId` `handId` `toAmount` `winnablePot` `requiredEquity` `betPotFractions` ほか）と enum の値（Preflop の Spot・役・Solver の理由・裁定の記録など）を表に足した。KB の項目の id は Evidence 自身が持つタイトルに置換する（`replacementNamesOf`）。固定 Hand の全判断の実際の Evidence（Pass A・Pass B）から camelCase の項目名・enum の値を集め、対応表に無いものがあればテストが落ちる（`identifiers.test.ts`「対応表の網羅」）。
  - `findIdentifiers`: 識別子の疑い（`cpu\d+`・camelCase・snake_case・`math.equity.method` のような位置・`math:...` のような Evidence の id）の検出。置換の後に残っていないかの検査と Eval の指標に使う。
- Evidence: `DecisionContextEvidence.seats[]` と Pass B の `villains[]` に `displayName`（Hero の画面に出ている名前。`ReviewServiceDeps.players` = 卓の `SeatPlayer`）を添える。型は optional（#96 より前に保存された Evidence には無い。その Follow-up は置換の対応が空になり、置換しない）。
- Prompt（Pass A・Pass B・Follow-up）: 「文は Hero が読む。識別子は書かず、席は seats の displayName、項目は項目の説明の言葉で書く」を追加し、Evidence の JSON の後ろに項目の説明を添える。Prompt 自身が `math.equity.method` `solver.status` `equity.actual` のような識別子で項目を指していた文を自然な言葉に直した。
- 生成: `generateReview` / `generateRevealReview` / `generateFollowUp` が、検証を通った出力を `sanitizeOutput` で置換してから返す（Retry なし）。検証（schema・grounding）は置換前の出力に対して行う。
- Review Eval: harness が置換前（Review AI の出力）と置換後（保存する Review）の識別子を記録し、`metrics.ts` に `identifierMentionRate`（出現率）・`identifierResidualRate`（残存率）・`residualIdentifiers`、合格ライン `maxIdentifierResidualRate: 0` を追加した。`run.ts` の表示に出す。録画（`recordings/review-eval.json`）は Prompt の変更で引数の指紋が変わるので取り直した。
- docs: `docs/05`（§6 Decision Context に表示名・識別子の方針の節）と `docs/09` §6（指標の表・検証の項目）を更新した。`docs/03` / `docs/04` の構造・永続化の記述は変わらない（Evidence の JSON に任意の `displayName` が増えるだけで、スキーマ・マイグレーションは無い）。

## 判断理由

- Retry しない理由: 言い直しを求めても残ることがあり、呼び出しの回数と利用枠が増えるだけ。置換は決定論で、対応表を直せば直る。
- 置換を検証の後に置いた理由: 識別子の有無で schema / grounding を不正にすると Retry 経路に入ってしまう。検証は「形と根拠」、置換は「表示」に分けた。置換で文が少し長くなることがあり、文字数の上限（REVIEW_TEXT_MAX 等）は置換の前の値で見ている（保存側に上限の検証は無い）。
- 表示名は Hero の画面に出ている名前だけ。Persona・Hidden Cards・Future Cards は渡さない（Evidence の `forbiddenKeys` / 漏れ検査はそのまま通る。`generate.test.ts` で確認）。

## Eval の前後比較（実際の Claude・サブスク枠・D87。ANTHROPIC_API_KEY は使っていない）

条件: `pnpm --filter @proj-poker/server eval:review`・review_standard（claude-sonnet-5-5）・Solver なし・固定 4 判断。前（Before）は main の Prompt・Evidence に、**測定コード（harness / metrics / identifiers の検出）だけを載せて**取った（置換は効かない状態）。後（After）はこの PR。指標は `metrics.ts` が機械的に出した値。

| | Before（`--repeats 3`） | After（`--repeats 3 --record`） | After（`--repeats 5`） |
|---|---|---|---|
| reviews / calls | 12 / 12 | 12 / 12 | 20 / 20 |
| 識別子の出現率（置換前） | **0.333**（4/12。`cpu3` が 2 件・`userRead` が 2 件） | **0**（0/12） | **0**（0/20） |
| 識別子の残存率（置換後） | 0.333（置換なし。合格ライン 0 に届かない） | **0** | **0** |
| Structured Output Valid率 | 1 | 1 | 1 |
| Retry率 / Fallback率 | 0 / 0 | 0 / 0 | 0 / 0 |
| Math / KB Grounding率 | 1 / 1 | 1 / 1 | 1 / 1 |
| Hindsight Leak・障害 | 0・0 | 0・0 | 0・0 |
| Exact GTO の言及（否定も数える） | 0 | 0 | 1 |
| Latency median / p90（ms） | 12,793 / 17,848 | 12,283 / 19,209 | 13,016 / 19,094 |

- After は最終の対応表（Codex 指摘で拡張した後）の Prompt での値。拡張前の Prompt でも同じ条件で `--repeats 3`（0/12）・`--repeats 5`（0/20）を取り、出現率・残存率はともに 0 だった（Prompt の項目の説明が増えただけで、結果は変わらなかった）。

- After の文では席が「CPU 3」「UTG（CPU 3）」と書かれるようになった（Prompt と Evidence の表示名の効果）。Prompt だけで出現率が 0 になり、置換が効く場面は今回の測定では出なかった（置換の効きは単体テストで確かめた。下記）。母集団が小さい（Before 12・After 12 + 20）ので「0」は「出にくくなった」の目安で、保証は置換の側が持つ。
- 参考: 同じ Prompt・Evidence での Pass B・Follow-up を `smoke:reveal`（実際の Claude）で 1 回ずつ通した。Pass A・Pass B・Follow-up（Pass A / Pass B 2 ターン）の文に識別子は無く、「CPU 3」と書かれていた（Pass B・Follow-up の指標は Eval に無いので、目視と `findIdentifiers` の対象外。人が読んで確認）。

## 実行した確認

- 単体テスト: `identifiers.test.ts`（置換・検出・enum と id を触らない・項目の説明の Pass 分離）、`generate.test.ts`（Evidence の表示名・Prompt・識別子があっても Retry せず置換して保存）、`reveal.test.ts`（Pass B と Follow-up も同じ置換・Pass A の Prompt に Pass B の項目を出さない）、`review-service.test.ts`（Service が卓の表示名を Evidence に添える）、`harness.test.ts`（出現率・残存率・合格ライン）。
- ルートで `pnpm lint`（エラー 0）・`pnpm typecheck`（4 パッケージ Done）・`pnpm test`（engine 333・web 117・server 441 件 passed）・`pnpm format:check` を通した。録画の再生（CI）は取り直した録画で通る。

## 残課題

- Pass B・Follow-up の識別子の残存率は Eval に無い（Review Eval は Pass A だけ）。必要なら別 Issue。
- 置換の対応表（`EVIDENCE_TERMS`）に無い項目名は残る。Eval の `residualIdentifiers` に出たら表へ足す運用。
- #96 より前に保存された Evidence（`displayName` 無し）への Follow-up は、playerId の置換が効かない（Prompt の指示だけ）。
