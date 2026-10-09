# Phase 8 — Tournament

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 8 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3.1「Phase 8」 |
| Parent | [#107](https://github.com/takumi-sano22/proj-poker/issues/107)（Phase 8 Parent。Close 済み）／ Post-MVP Parent [#104](https://github.com/takumi-sano22/proj-poker/issues/104)（Close 済み） |
| 主な期間 | 2026-10-08〜09 |
| 主な判断 | D127〜D130（方針は Phase 6 の Gate で記録した D108・D109） |
| 分解の記録 | [`phase8-planning.md`](../taskLog/phase8-planning.md) |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 7](./phase-7.md) |

## 目的と範囲

既存の Hand Engine を複製せずに再利用し、その上に Tournament の Session を置いて 6-max STT を遊べるようにする。Blind / Ante・Elimination・Payout・決定論の ICM・Tournament を考える CPU・ICM を Chip EV と分けた Review まで。子 Issue は P8-0〜P8-9（#182〜#191）で直列に進めた。

## 到達した機能

順位・Payout・Result は Event Log から都度計算し、表を足していない（D129）。値は OI-007 の暫定値。

- **Mode / Session / Preset**（[#183](https://github.com/takumi-sano22/proj-poker/issues/183)）: 新しい Session の開始で Cash / Tournament を選ぶ。標準 Preset は 6-max STT（hand-count）と time-base。設定は Session の開始の Event に Snapshot として残す（版 9）
- **Blind / Ante**（[#184](https://github.com/takumi-sano22/proj-poker/issues/184)）: Ante は `none` / `per_player` / `big_blind_ante`（Dead Money）。Level は Hand の開始時に決めて `HAND_STARTED` に固定する（版 10）
- **Elimination と順位**（[#185](https://github.com/takumi-sano22/proj-poker/issues/185)）: Bust = Elimination。Bust の席を除いて Button / Blind を動かし、2 人で Heads-Up へ。Hero の Bust か Hero が最後の 1 人で終える（CPU だけで続けない）
- **Payout / Result**（[#186](https://github.com/takumi-sano22/proj-poker/issues/186)）: Prize Pool は参加費 × 参加人数で 50 / 30 / 20%。Payout は pt で Chip とは別の量
- **ICM**（[#187](https://github.com/takumi-sano22/proj-poker/issues/187)）: 2〜8 人の ICM Equity・Bubble Factor・All-in の判断の Chip EV と ICM の必要 Equity を決定論のコード（Malmuth-Harville）で計算。LLM には計算させない
- **Tournament を考える CPU**（[#188](https://github.com/takumi-sano22/proj-poker/issues/188)）: KnowledgeState に公開の Tournament Context を足し、RuleBot と Claude の CPU が使う。Memory は `tournament` の context で数え、Cash と混ぜない
- **ICM を分けた Review**（[#189](https://github.com/takumi-sano22/proj-poker/issues/189)）: Pass A の Evidence に ICM Equity と Chip EV / ICM の必要 Equity を別の項目・別の Evidence ID で入れる。Tournament の Spot は Solver に対応が無く正常に Fallback
- **Tournament の画面**（[#190](https://github.com/takumi-sano22/proj-poker/issues/190)）: Level・Blind・Ante、次の Level までの残り・残人数・Payout・脱落、Result、Review の Tournament の根拠と Important Spot の理由
- **Critical E2E**（[#191](https://github.com/takumi-sano22/proj-poker/issues/191)）: 6-max STT を開始から Heads-Up・終了・Payout・ICM の Review・Replay・Resume / 新しい Tournament まで CI で通す（`e2e/tests/tournament.spec.ts`）

## 主要な品質成果

- Engine を複製せずに Tournament を載せ、Cash の E2E もそのまま通ることを確かめた
- Phase 8 の Definition of Done の各項目とテストの対応を `docs/09` §12 に置いた。DoD は [#107](https://github.com/takumi-sano22/proj-poker/issues/107) で人間が確認した

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D108・D109: Tournament を Hand Engine の上に置く方針と、CPU の公開の Tournament Context（Phase 6 の Gate で記録）
- D127: 標準の 6-max STT の暫定値（OI-007）
- D128: Ante の扱い（Dead Money・Big Blind Ante）
- D129: Hero の Bust で終える・順位と Result の扱い
- D130: CPU の Tournament Context の中身と、Review の ICM / Chip EV の分け方

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#182](https://github.com/takumi-sano22/proj-poker/issues/182) P8-0 D127〜D130 の記録と docs の同期 | [PR #192](https://github.com/takumi-sano22/proj-poker/pull/192) | [`phase8-planning.md`](../taskLog/phase8-planning.md) |
| [#183](https://github.com/takumi-sano22/proj-poker/issues/183) P8-1 Mode / Session / Preset | [PR #193](https://github.com/takumi-sano22/proj-poker/pull/193) | [`issue-183-tournament-session.md`](../taskLog/issue-183-tournament-session.md) |
| [#184](https://github.com/takumi-sano22/proj-poker/issues/184) P8-2 Blind / Ante | [PR #194](https://github.com/takumi-sano22/proj-poker/pull/194) | [`issue-184-blind-ante.md`](../taskLog/issue-184-blind-ante.md) |
| [#185](https://github.com/takumi-sano22/proj-poker/issues/185) P8-3 Elimination と順位 | [PR #195](https://github.com/takumi-sano22/proj-poker/pull/195) | [`issue-185-elimination.md`](../taskLog/issue-185-elimination.md) |
| [#186](https://github.com/takumi-sano22/proj-poker/issues/186) P8-4 Payout / Result | [PR #196](https://github.com/takumi-sano22/proj-poker/pull/196) | [`issue-186-payout-result.md`](../taskLog/issue-186-payout-result.md) |
| [#187](https://github.com/takumi-sano22/proj-poker/issues/187) P8-5 ICM | [PR #197](https://github.com/takumi-sano22/proj-poker/pull/197) | [`issue-187-icm.md`](../taskLog/issue-187-icm.md) |
| [#188](https://github.com/takumi-sano22/proj-poker/issues/188) P8-6 Tournament の KnowledgeState と CPU | [PR #198](https://github.com/takumi-sano22/proj-poker/pull/198) | [`issue-188-tournament-knowledge.md`](../taskLog/issue-188-tournament-knowledge.md) |
| [#189](https://github.com/takumi-sano22/proj-poker/issues/189) P8-7 Tournament Review と ICM Evidence | [PR #199](https://github.com/takumi-sano22/proj-poker/pull/199) | [`issue-189-tournament-review.md`](../taskLog/issue-189-tournament-review.md) |
| [#190](https://github.com/takumi-sano22/proj-poker/issues/190) P8-8 Tournament の UI | [PR #200](https://github.com/takumi-sano22/proj-poker/pull/200) | [`issue-190-tournament-ui.md`](../taskLog/issue-190-tournament-ui.md) |
| [#191](https://github.com/takumi-sano22/proj-poker/issues/191) P8-9 Critical E2E と README | [PR #201](https://github.com/takumi-sano22/proj-poker/pull/201) | [`issue-191-tournament-e2e.md`](../taskLog/issue-191-tournament-e2e.md) |

## 次へ引き継いだ事項

- Tournament の値（Preset・Blind 表・Payout・端数・同順位・ICM の方式・CPU の調整の係数）は OI-007 の暫定値
- Tournament の Prompt（CPU・Review）の実モデルでの録画は Phase 8 の中では行わず、Phase 8 の後の [#202](https://github.com/takumi-sano22/proj-poker/issues/202) で行った
- Session Review の画面に Tournament の Result を出すか等の [#190](https://github.com/takumi-sano22/proj-poker/issues/190) の残課題（[`issue-190-tournament-ui.md`](../taskLog/issue-190-tournament-ui.md)）

`docs/08` のロードマップは Phase 8 までで、Phase 9 は計画していません。

## Phase 8 完了後の横断整理

Phase 8 の完了後、新しい Phase を作らずに `[横断]` の Issue として次を行いました（どれも Close 済み）。

| Issue | 内容 | PR | 判断 | 作業ログ |
|---|---|---|---|---|
| [#179](https://github.com/takumi-sano22/proj-poker/issues/179) | 裁定（RULING）表示時と 320px で Hero の欄が高くなるずれを直す。残る制約は `docs/06` §1 と `ui-design-recipes` の `references/proj-poker.md` に記録 | [PR #205](https://github.com/takumi-sano22/proj-poker/pull/205) | — | [`issue-179-ruling-narrow-hero.md`](../taskLog/issue-179-ruling-narrow-hero.md) |
| [#168](https://github.com/takumi-sano22/proj-poker/issues/168) | Review の文の数値を Evidence の数値表の参照で書かせ、照合する（Pass A と Pass A への Follow-up） | [PR #206](https://github.com/takumi-sano22/proj-poker/pull/206) | D131 | [`issue-168-review-numeric-grounding.md`](../taskLog/issue-168-review-numeric-grounding.md) |
| [#202](https://github.com/takumi-sano22/proj-poker/issues/202) | Tournament の Claude CPU / Review を実モデルで録画する（`docs/09` §5・§6） | [PR #209](https://github.com/takumi-sano22/proj-poker/pull/209) | D132 | [`issue-202-tournament-claude-eval.md`](../taskLog/issue-202-tournament-claude-eval.md) |
| [#208](https://github.com/takumi-sano22/proj-poker/issues/208) | 保存する Review の文から N の無い波括弧の数値の波括弧を外す | [PR #210](https://github.com/takumi-sano22/proj-poker/pull/210) | — | [`issue-208-bare-brace-number.md`](../taskLog/issue-208-bare-brace-number.md) |

この横断整理の時点で残っていた Open Issue（最新の状態は GitHub を確認してください）:

- [#203](https://github.com/takumi-sano22/proj-poker/issues/203): 人間による実機の受け入れテスト（未完了）
- [#207](https://github.com/takumi-sano22/proj-poker/issues/207): Tournament の Claude CPU で Persona が Stage・ICM より強く効く戦略品質の改善（[#202](https://github.com/takumi-sano22/proj-poker/issues/202) の録画で見つかった派生課題。人間判断待ち）
