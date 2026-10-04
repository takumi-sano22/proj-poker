---
name: poker-engine-testing
description: proj-poker の決定論的 Poker Engine のテスト規約。Invariant（INV-TEST-001〜008）・固定 Scenario Regression・Property / Fuzz の使い分け、Scenario の記述形式、seed 注入と Chip 保存の assert を定める。Poker Engine・Betting・Pot / Side Pot・Showdown・Hand Ranking・Ruling（Oversized Chip 等）・KnowledgeState Projection を実装・修正するとき、「エンジンのテスト」「Scenario を追加」「Poker の回帰テスト」「property test」でトリガーする。
---

# poker-engine-testing — 決定論エンジンのテスト規約

`docs/09` §1 にあるとおり、最優先は **Poker Engine の正しさ**。AI の戦略は不完全でもよいが、Chip Accounting・Legal Action・Pot Distribution・Hidden Information Isolation は壊れてはいけない。本 skill は、その「壊れてはいけない」をテストとしてどう書くかを定める。テストの要求範囲（何を最低限テストするか）の一次情報は `docs/09` と `docs/02` §5 で、ここには書き写さない。

> **ランナーと配置（D69）**: テストランナーは Vitest、Property / Fuzz は fast-check。テストは `packages/engine/src/**/*.test.ts` に実装と並べて置き（コロケーション）、Property テストは `*.property.test.ts` とする。実行はルートの `pnpm test`（Engine だけなら `pnpm --filter @proj-poker/engine test`）。§4 の Scenario ファイルの置き場は、最初の Scenario ランナーを作る Issue で決めてここへ追記する。

## 1. Engine を変えたら何を足すか（必須）

| 変更の種類 | 足すテスト |
|---|---|
| ルールの追加・修正（Minimum Raise、Reopen、Side Pot、Showdown 順など） | **Scenario Regression を 1 本以上**。境界の両側（Reopen する / しない）を別 Scenario にする |
| 状態遷移・Betting の構造変更 | 関連する **Invariant テスト**の再確認と、Property テストへの組み込み |
| バグ修正 | **修正前に失敗する Scenario** を先に追加し、修正後に通ることを確認する（回帰の固定） |
| Ruling（Physical → Canonical） | Rule Profile ごとの Scenario（同じ Physical Action が Profile で別の裁定になるケースを含む） |
| KnowledgeState Projection | INV-TEST-007 / 008 系の情報漏えいテスト（`poker-invariant-review` A 節の確認動作） |

Fuzz テストだけで明示的な Rule Scenario を置き換えない（`docs/09` §9）。

## 2. 決定論の前提

- Engine は RNG を**注入**で受け取る。テストは固定 seed、または **Deck を明示的に積んだ（stacked deck）RNG** を使う。`Math.random()` や実時刻に依存するテストを書かない。
- 同じ seed と同じ Action 列から、同じ Event 列と同じ最終 State が得られることを、少なくとも 1 本のテストで assert する（再現性の保存候補は `docs/02` §10。Projection が Event から再構築できることは `docs/04` §1）。
- Chip の数値表現（整数の最小単位など）は docs で未確定。決めたら `decision-log` で記録し、ここに追記する。それまでは assert を**完全一致**で書く（誤差を許容する比較で保存則の破れを隠さない）。

## 3. Invariant テスト（INV-TEST-001〜008）

定義は `docs/09` §3。実装では **1 つの invariant チェック関数群**を作り、次の 3 か所で共通に呼ぶ。

1. 各 Scenario の各 Event 適用後
2. Property / Fuzz の各ステップの後
3. （任意）開発ビルドの Engine の内部 assert

| ID | assert の書き方の要点 |
|---|---|
| 001 | 全 Card の所在（Deck / 各 Hand / Board / Burn / Muck）を集計し、52 枚が重複も欠落もないこと |
| 002 / 005 | Σ Stack + Σ Pot + Rake 控除累計 = 初期総量 + 明示的な追加（Rebuy / Top-up）。配分の後は Σ 配分 = Distributable Pot |
| 003 / 006 | Engine が **Canonical Action** を受け付ける Actor は、Active（Fold・All-in していない）かつ手番の Player に限られる。合法でない Actor の Canonical Action は Reject されて State が不変。Out of Turn などの **Physical Action** は Rule Profile の裁定（`DEALER_RULING`）を経るので、State が変わりうる。これは Invariant 違反ではなく Scenario で検証する（`docs/02` §3〜4） |
| 004 | どの Commit も、その時点の Stack 以下 |
| 007 / 008 | KnowledgeState や CPU Memory をシリアライズし、他者の Hidden Card や Learning-only Reveal のマーカーが含まれないこと |

## 4. Scenario Regression の書き方

固定ハンドは**データとして記述**し、1 つの汎用ランナーで再生・検証する（ハンドごとに手続き的なテストを書かない）。Scenario は Human-reviewed Hand の回帰ケースにもそのまま使える（`docs/09` §6）。

推奨形式（形式は、最初の Scenario ランナーを作る Issue〔Phase 1 / 2〕で確定する。Phase 0 はツールチェーンだけでランナーを作っていないため。要素はこれを満たすこと）:

```yaml
id: SCN-side-pot-3way-001
title: 3-way All-in で Main Pot と Side Pot が 1 つずつできる
rule_profile: live_cash_training_v1
source: docs/09 §4 3-way Side Pot           # 根拠（docs 節 / 実バグの Issue 番号）
table: { players: 3, button: 0, sb: 1, bb: 2, blinds: [1, 2] }
stacks: [100, 40, 250]
deck: [As, Kd, ...]                         # 積んだ Deck（配布順）
actions:                                    # Canonical Action または Physical Action
  - { seat: 0, action: raise, to: 10 }
  - { seat: 1, action: all_in }
  ...
expect:
  events_include: [POT_AWARDED]
  # 手計算: seat1 の 40 × 3 人 = Main 120 / 残りの seat0・seat2 の超過分 = Side（値は例）
  pots: [{ amount: 120, eligible: [0,1,2] }, { amount: 120, eligible: [0,2] }]
  final_stacks: [..]
  rejected_actions: []                      # 合法でない Actor の Canonical Action など、Reject されるべき入力
  rulings: []                               # Physical Action の裁定結果（Rule Profile 依存。例: Out of Turn・Oversized Chip）
```

- **命名**: `SCN-<領域>-<内容>-<連番>`。`docs/09` §4 と `docs/02` §5 の必須 Scenario を、それぞれ最低 1 本ずつ用意する（一覧との対応は Scenario の `source` で追える）。
- **期待値は手計算**で書き、計算過程を YAML コメントに残す。Engine の出力をコピーして期待値にしない（バグを固定してしまうため）。
- Rule Profile で結果が変わるものは、Profile ごとに Scenario を分ける。

## 5. Property / Fuzz

- 生成するもの: Player 数 2〜8、ランダムな Stack、ランダムな**合法** Action 列（Engine が返す Legal Actions から選ぶ）、ランダムな seed（`docs/09` §9）。
- 各ステップで §3 の invariant を全部チェックする。
- 失敗したら、**縮小された反例を Scenario として §4 の形式で保存する**（Fuzz の発見を回帰テストに昇格させる）。
- 実行時間は CI で許容できる範囲に固定する（ケース数と seed を記録して再現可能にする）。

## 6. Engine の外のテスト

- AI Opponent Eval と Review Eval は Engine の正しさとは別に評価する（`docs/09` §5〜6 → `llm-quality-improvement` skill）。Engine のテストに LLM 呼び出しを混ぜない。
- Solver Adapter は Capability / Unsupported / Timeout / Cancellation / Invalid Input / Parse Failure / Version Metadata を、外部 Solver を Fake / Stub にしてテストする（`docs/09` §7）。実 Solver との結合テストは別系統にする。
- E2E（`docs/09` §8）は MVP DoD の Quality 項目（`docs/08` §2）。Engine の Unit / Scenario を置き換えない。

## 7. レビュー時の確認

- [ ] Engine の差分に対応する Scenario や Invariant の追加があるか。無ければ理由が PR に書いてあるか（`AGENTS.md` 8）。
- [ ] 期待値が手計算か（Engine の出力のコピーでないか）。
- [ ] seed 固定、または積んだ Deck で決定論になっているか。
- [ ] 保存則の assert が完全一致か。
