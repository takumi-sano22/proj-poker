# poker-engine — Poker Engine・Event Log を書く前の判定基準（poker-engine / persistence-event-log 向け）

**本書が一次情報である範囲**: 実装時の確認動作と、docs から導ける実装上の判断への導線。**一次情報が別にある範囲**: ルール・Rule Profile・Replay の定義は `docs/02_DOMAIN_RULES_AND_POLICIES.md`、Event・正本・Auto Save は `docs/04_DATA_AND_EVENTS.md`、テスト要件は `docs/09_TEST_STRATEGY.md`、判断の根拠は `docs/decision_log.yaml`（D37 / D38 / D40）。不変条件の詳細レビュー・テスト手順は `poker-invariant-review` / `poker-engine-testing` skill（#4 で作成予定。未作成の間は `code-review` の H 節）へ寄せる。

## 書く前に決めること

> **レビュー時にも当たる欠陥クラスは台帳が一次情報**（LC-001 失敗経路の握りつぶし / LC-021 補償の行削除 / LC-031 Projection の上書き・削除の二重ガード）。書く前に一読し、ここには繰り返さない。

1. **Poker Rule・Game State は決定論的コードだけで処理し、LLM に裁定させない**（docs/02 §1・D40）。Legal Action・Minimum Raise・Short All-in / Reopening・Side Pot・Winner / Chip Movement は Engine の責務。
2. **Event Log が唯一の正本**（docs/04 §1・D37）。Current Game State・Summary・Stats・Replay Timeline・Review Input は派生。「もう一つの正しい Hand 表現」を保存しない。State 遷移は Event の適用で表し、Projection は Event から再構築できる形にする。
3. **Replay は保存済み Event だけを再生する。Current AI で再生成しない**（docs/02 §9・D38）。Re-simulation（別 Action への仮想分岐）とは API も保存先も分ける。
4. **可変ルールは Rule Profile（Version 付き）で表す**（docs/02 §3）。Min Raise・Short All-in Reopen・Rake・Straddle 等の分岐をコード内の定数や `if` に散らさない。Profile Version は Event / Metadata に残す。
5. **乱数（山札のシャッフル）は Engine 内に閉じ、seed を注入できる形にする**。RNG Seed・Deck Order Hash は best-effort の Replay Metadata として保存候補（docs/04 §9・docs/02 §10）。完全再現は Hard Requirement ではない。
6. **Chip の表現（整数の最小単位で扱い浮動小数を使わない等）は docs に明記が無い**。Phase 0 で決める実装判断なので、決めたら decision-log へ記録する。それまでは Chip 総量保存（INV-TEST-002 / 005）が機械的に検証できる表現を選ぶ。
7. **Completed Hand が Recovery 境界**（docs/04 §10）。`HAND_FINISHED` 時に Hand Events・Session Projection・Stack を保存する。Action 単位の完全 Crash Recovery は MVP で作らない。
8. **Visibility を Event に持たせる**（docs/04 §4）。Hole Cards 等の非公開情報を、誰でも読める Event に混ぜない。

## 確認動作（実装後・自己レビュー前）

- 変更に対応する INV-TEST（docs/09 §3。001 重複 Card なし / 002 Chip 総量 / 003 Fold 後に Action 要求なし / 004 Stack 超過 Commit なし / 005 Pot 配分一致 / 006 合法 Actor / 007・008 は情報境界）を足した、または影響なしと確認した
- 必須 Scenario（docs/02 §5）に該当するルール変更は Scenario Test を足した。Fuzz だけで代替しない（docs/09 §9）
- 同じ seed と同じ Event 列から同じ State・Projection が再構築できることを 1 回確認した
- Projection を消して Event Log から再構築しても Summary / Stats が一致することを確認した
