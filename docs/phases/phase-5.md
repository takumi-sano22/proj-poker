# Phase 5 — MVP Review

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 5 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §2（MVP Definition of Done）・§3「Phase 5」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Phase 5 の完了で Close し、再オープンしない） |
| 主な期間 | 2026-10-06〜07 |
| 主な判断 | D94〜D101 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 4](./phase-4.md) ／ 次: [Phase 6](./phase-6.md) |

## 目的と範囲

終わった Hand を、判断時点の情報だけで Review できるようにして MVP を完成させる。Session の永続化と Resume・判断時点の情報の再構築・Math / Equity / Range・Local KB・Solver・Review AI（Pass A）・Learning-only Reveal（Pass B）・Follow-up・Review の画面・E2E。子 Issue は #77〜#85 の 9 つ（D94）と、Solver 選定の PoC（#76）・Hand の Metadata（#97）。

**ここで MVP 完成**（`docs/08` §3「Phase 5」）。MVP は「ポーカーが遊べる」だけでは完成とせず、次が一気通貫で動くことを完成条件としました（旧ルート README の「MVPの完成条件」。詳細な Definition of Done は `docs/08` §1・§2 が正本）。

1. AI CPU 相手に NLHE Cash を 1 Session 遊べる
2. 実卓寄りの 2D UI と Chip 操作を使える
3. Hand の Event Log を保存できる
4. Replay できる
5. 判断時点の情報だけを使って Review できる
6. Hand の終了後に全員の Hole Cards を学習用に確認できる
7. 数学・AI・対応可能な Solver による解析を受けられる
8. 追加質問できる

**Hand Review まで含めて MVP** です。

## 到達した機能

- **Session の永続化と Resume**（[#77](https://github.com/takumi-sano22/proj-poker/issues/77)）: Session の開始・終了・Hand の打ち切り・Emergency Bot への切り替えを Event にし（版 6）、再起動後も同じ Session を続ける（Stack・Button・Emergency Bot を持ち越す）
- **判断時点の Hero Information Set と Important Spot**（[#78](https://github.com/takumi-sano22/proj-poker/issues/78)）: Event Log から判断時点に Hero が知り得た情報だけを再構築し、見直す価値の高い判断を決定論で選ぶ
- **Math / Equity / Range**（[#79](https://github.com/takumi-sano22/proj-poker/issues/79)）: Pot Odds・必要 Equity・仮定した Range に対する Equity・Alternative Action の簡易 EV を決定論で計算
- **Local KB**（[#80](https://github.com/takumi-sano22/proj-poker/issues/80)）: `apps/server/kb/` の Curated KB（Metadata 付き・Version 付き）と決定論の検索
- **Solver**（[#76](https://github.com/takumi-sano22/proj-poker/issues/76)・[#81](https://github.com/takumi-sano22/proj-poker/issues/81)）: PoC で amaster97/poker_solver を Primary Solver に選び、Heads-Up の Turn / River だけを扱う Adapter を作った。Flop・Multiway・Side Pot・Rake・未導入は Unsupported として正常に Fallback
- **Decision Review（Pass A）**（[#82](https://github.com/takumi-sano22/proj-poker/issues/82)）: Evidence（Math・Range・Solver・KB）を構造化してから Review AI に書かせ、Schema と根拠の参照を検証。根拠が足りなければ評価しない。Version 付きで保存
- **Reveal Review（Pass B）と Follow-up**（[#83](https://github.com/takumi-sano22/proj-poker/issues/83)）: Hand 後に全員の札を学習用にだけ見せて答え合わせをし（評価は付け直さない・CPU には渡さない）、追加質問を続けられる
- **Review の画面**（[#84](https://github.com/takumi-sano22/proj-poker/issues/84)）: Important Spot を先に並べた一覧・Pass A / Pass B のタブ・Evidence・Version・Follow-up と、Replay の Important Spot へのジャンプ
- **6-max Session の E2E**（[#85](https://github.com/takumi-sano22/proj-poker/issues/85)）: Play → Review → Replay → 次の Hand → 再起動して Resume を Playwright で CI に載せた
- **Hand ごとの Metadata**（[#97](https://github.com/takumi-sano22/proj-poker/issues/97)）: App Version・Rule Profile・Persona の版・席ごとの CPU の実装を system の Event に残す（版 7。Hero の画面・CPU・Replay には出ない）

## 主要な品質成果

- Critical E2E（`e2e/tests/session.spec.ts`）を CI の別ジョブで回す形にした。CPU は RuleBot、Review AI は固定応答で Claude を呼ばない
- Review Eval の最小形（`docs/09` §6）を作り、実モデルは手動の Eval で測る運用にした
- 横断で、Property Test の一度きりの失敗に seed を記録できるようにし（[#95](https://github.com/takumi-sano22/proj-poker/issues/95)）、Review の文に内部の識別子が出ないようにした（[#96](https://github.com/takumi-sano22/proj-poker/issues/96)）

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D94: Phase 5 の子 Issue の分解
- D95: Session の Event（版 6）
- D96: Primary Solver と Capability（HU の River / Turn。OI-002 の暫定値）
- D97: Review のモデル（`review_standard` / `review_deep`。OI-001 の暫定値）
- D98: Local KB の形と、E2E の構成
- D99: Pass B と Follow-up の保存（マイグレーション v4）
- D100: Hand ごとの Metadata（版 7）
- D101: Review の文に残った内部識別子の扱い

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#76](https://github.com/takumi-sano22/proj-poker/issues/76) Primary Solver 選定 PoC（OI-002） | D96 は [PR #86](https://github.com/takumi-sano22/proj-poker/pull/86) で記録 | — |
| [#77](https://github.com/takumi-sano22/proj-poker/issues/77) Session の永続化と Resume（版 6） | [PR #86](https://github.com/takumi-sano22/proj-poker/pull/86) | [`issue-77-session-resume.md`](../taskLog/issue-77-session-resume.md) |
| [#78](https://github.com/takumi-sano22/proj-poker/issues/78) Hand Summary と Hero Information Set・Important Spot | [PR #87](https://github.com/takumi-sano22/proj-poker/pull/87) | [`issue-78-hand-summary-infoset.md`](../taskLog/issue-78-hand-summary-infoset.md) |
| [#79](https://github.com/takumi-sano22/proj-poker/issues/79) Equity・Range・Alternative Action | [PR #88](https://github.com/takumi-sano22/proj-poker/pull/88) | [`issue-79-equity-range.md`](../taskLog/issue-79-equity-range.md) |
| [#80](https://github.com/takumi-sano22/proj-poker/issues/80) Local KB | [PR #89](https://github.com/takumi-sano22/proj-poker/pull/89) | [`issue-80-local-kb.md`](../taskLog/issue-80-local-kb.md) |
| [#81](https://github.com/takumi-sano22/proj-poker/issues/81) Solver Adapter | [PR #90](https://github.com/takumi-sano22/proj-poker/pull/90) | [`issue-81-solver-adapter.md`](../taskLog/issue-81-solver-adapter.md) |
| [#82](https://github.com/takumi-sano22/proj-poker/issues/82) Review AI（Pass A） | [PR #91](https://github.com/takumi-sano22/proj-poker/pull/91) | [`issue-82-review-ai-pass-a.md`](../taskLog/issue-82-review-ai-pass-a.md) |
| [#83](https://github.com/takumi-sano22/proj-poker/issues/83) Pass B と Follow-up | [PR #92](https://github.com/takumi-sano22/proj-poker/pull/92) | [`issue-83-reveal-review-followup.md`](../taskLog/issue-83-reveal-review-followup.md) |
| [#84](https://github.com/takumi-sano22/proj-poker/issues/84) Review の UI と Jump to Important Spot | [PR #93](https://github.com/takumi-sano22/proj-poker/pull/93) | [`issue-84-review-ui.md`](../taskLog/issue-84-review-ui.md) |
| [#85](https://github.com/takumi-sano22/proj-poker/issues/85) 6-max Session の E2E と README | [PR #94](https://github.com/takumi-sano22/proj-poker/pull/94) | [`issue-85-e2e-readme.md`](../taskLog/issue-85-e2e-readme.md) |
| [#97](https://github.com/takumi-sano22/proj-poker/issues/97) Hand ごとの Metadata（版 7） | [PR #98](https://github.com/takumi-sano22/proj-poker/pull/98) | [`issue-97-hand-metadata.md`](../taskLog/issue-97-hand-metadata.md) |
| [#95](https://github.com/takumi-sano22/proj-poker/issues/95)（横断）Property Test の seed | [PR #99](https://github.com/takumi-sano22/proj-poker/pull/99) | [`issue-95-property-test-flake.md`](../taskLog/issue-95-property-test-flake.md) |
| [#96](https://github.com/takumi-sano22/proj-poker/issues/96)（横断）Review の内部識別子 | [PR #100](https://github.com/takumi-sano22/proj-poker/pull/100) | [`issue-96-review-identifiers.md`](../taskLog/issue-96-review-identifiers.md) |

## 次の Phase へ引き継いだ事項

- MVP の後は Post-MVP Parent [#104](https://github.com/takumi-sano22/proj-poker/issues/104) の下に Phase 6〜8 の Parent を置く（D102。[Phase 履歴の索引](./README.md)）
- E2E の固定応答は文の中身を検証しない。説明の質は Review Eval（`docs/09` §6）で扱う
- 実際の Claude（OAuth）での通しは手動（結果の例は [`issue-85-e2e-readme.md`](../taskLog/issue-85-e2e-readme.md)）
