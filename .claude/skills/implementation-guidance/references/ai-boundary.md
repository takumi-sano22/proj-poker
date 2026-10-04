# ai-boundary — LLM への情報境界・出力検証・Review を書く前の判定基準（knowledge-state / ai-opponent / review-pipeline 向け）

**本書が一次情報である範囲**: 実装時の確認動作と、実装上の判断への導線。**一次情報が別にある範囲**: 情報境界は `docs/02_DOMAIN_RULES_AND_POLICIES.md` §2（INV-INFO-001〜003）、Opponent 入出力の検証・AI 障害・Solver Adapter・Model Role は `docs/03_SYSTEM_ARCHITECTURE.md` §3 / §5 / §6 / §8、Persona・Two-pass Review・Solver 利用は `docs/05_AI_OPPONENTS_AND_REVIEW.md`、KnowledgeState Projection は `docs/04_DATA_AND_EVENTS.md` §5、判断の根拠は `docs/decision_log.yaml`（D28 / D40 / D57）。不変条件のレビュー・テスト手順は `poker-invariant-review` / `poker-engine-testing` skillへ寄せる。

## 書く前に決めること

> **レビュー時にも当たる欠陥クラスは台帳が一次情報**（LC-001 失敗経路の握りつぶし・空出力の上書き / LC-050 評価ハーネスと本番の引数組み立て経路の一致）。書く前に一読し、ここには繰り返さない。

1. **KnowledgeState は whitelist で組み立てる**（D28・INV-INFO-001）。global `GameState` から「隠すものを削る」のではなく、渡してよい項目（自分の Hole Cards・公開 Board・Public Action・Pot/Stack/Position・自分が観察した Showdown・自分の Observation と Persona）だけを積む。項目を足すときは INV-TEST-007 に影響するか確認する。
2. **Learning-only Reveal はゲーム世界の Observation ではない**（INV-INFO-002）。CPU Memory へ入れない（INV-TEST-008）。Observation は Observer / Subject / Source / Visibility / Timestamp を持つ（INV-INFO-003）。
3. **LLM は合法候補から戦略を選ぶだけ**（D40）。Legal Action と Amount Range は決定論的コードで列挙して渡す。
4. **LLM 出力は Schema → Legal Action → Amount Range の順で検証し、不正なら 1 回だけ修正を促して Retry、再度不正なら Deterministic Safe Fallback**（docs/03 §5）。Invalid Output は Log に残し、Fallback を使った Hand / Action には Flag を付ける。
5. **AI 障害時に Emergency Bot へ自動切替しない**。Retry / Emergency Bot で続行 / Pause をユーザーに選ばせる（docs/03 §6）。
6. **Decision Review の入力は判断時点の Information Set から作る**（docs/05 §7 Pass A）。Reveal Review（Pass B）は別 Pass で、Pass B の情報を理由に Pass A を変えない。Hindsight Leak を防ぐため、入力組み立て関数が Event Log の「判断時点まで」だけを受け取る形にする。
7. **Solver は Capability Gate を通してから使う**（docs/03 §8・D57）。`supports()` が false の Spot は正常系として Fallback し、Range Assumption を明示する。HU Solver の結果を Multiway の Exact GTO と表示しない。Solver は Evidence の一つ。
8. **モデル名は Domain Logic へ直書きせず role-based config で解決する**（docs/03 §3・OI-001。名前は未確定）。Role は `opponent_fast` / `review_standard` / `review_deep`。

## 確認動作（実装後・自己レビュー前）

- LLM へ渡す直前の入力を 1 回ログ出力し、他者の Hole Cards・Future Cards・Reveal・他 CPU の Memory が含まれないことを目視した（INV-TEST-007 / 008 に反映）
- LLM 出力が不正な 3 パターン（Schema 違反・非合法 Action・Amount 範囲外）で、Retry 1 回 → Fallback になることを確認した
- Decision Review の入力に、判断より後の Event が混ざっていないことを確認した
- Unsupported Spot で Solver を呼ばず Fallback 表示になることを確認した
