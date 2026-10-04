---
name: poker-invariant-review
description: proj-poker のドメイン不変条件（情報境界 KnowledgeState・Hindsight Leak・Learning-only Reveal 隔離・LLM に合法性を判定させない・Event Log 正本・Chip 保存・実額表示・Solver の誠実さ）を設計・実装・レビューで点検するチェックリスト。Poker Engine / KnowledgeState / Opponent Agent / Review Pipeline / Solver Adapter / Event Store / Table UI に触れる差分の自己レビュー、reviewer agent への委譲、設計の壁打ちで使う。「情報漏れがないか確認」「不変条件をチェック」「Hindsight Leak」「KnowledgeState をレビュー」「ドメインレビュー」でトリガーする。
---

# poker-invariant-review — ドメイン不変条件の点検

proj-poker の最悪の欠陥は、コードが落ちることではなく、**落ちずに静かに嘘をつくこと**。具体的には、CPU が見えないはずのカードを使う、Review が結果論で採点する、チップが合わない、HU の解を Multiway の正解として見せる、といったもの。どれもテストが緑のまま通りうるので、差分を読む段階で潰す。

本 skill は**点検の観点と確認動作だけ**を持つ。規範の一次情報は docs で、ここに書き写さない（docs と食い違ったら docs が正）。

| 観点 | 一次情報 |
|---|---|
| 情報境界 | `docs/02` §2（INV-INFO-001〜003）・`docs/04` §4〜6・`docs/05` §1・D28 |
| 決定論・LLM の役割 | `docs/02` §1・§4・`docs/03` §4〜6・D40 |
| Review | `docs/05` §6〜10・`docs/03` §7 |
| Event Log・Replay | `docs/04` §1・§8〜10・`docs/02` §9〜10・D37 / D38 |
| Chip・表示 | `docs/09` §3（INV-TEST-002 / 005）・`docs/02` §6・D49 |
| Solver | `docs/03` §8・`docs/05` §10・OI-002 / OI-009・D57 |

## 使い方

- **いつ**: 上表の領域に触れる差分の自己レビュー（`code-review` の差分クラス `poker-engine` / `knowledge-state` / `review-pipeline` / `ai-opponent` / `ui-table` / `persistence-event-log`）。設計段階でも、境界をまたぐ型・関数を決めるときに当てる。
- **reviewer agent / Codex へ**: この SKILL.md の絶対パスを「読むチェックリスト」として渡す。Codex 側の重大度は `AGENTS.md` が持つ。
- **全節を毎回読まない**: 差分クラスに該当する節だけを当てる。どれに当たるか判定できなければ全節を読む。
- 指摘は `[P0]`〜`[P3]` で付ける。基準は `AGENTS.md` と同じ。

## A. 情報境界（knowledge-state / ai-opponent）

- [ ] Opponent Model へ渡す入力は、`KnowledgeState` を **whitelist で組み立てて**いるか。global `GameState` や Event Store を渡してから除外する **blacklist 方式になっていないか**。blacklist 方式だと、フィールドが増えたときに静かに漏れる。
- [ ] `KnowledgeState` の Projection が、`visibility` が `public` の Event と、`private` かつ自分宛ての Event **だけ**から作られているか。`learning_only` の Event を読み込んでいないか（`docs/04` §5）。
- [ ] Fold 済みの Card、Deck の残り（順序や Hash を含む）、他 CPU の Private Memory と Secret Persona、Hero の Weakness DB がどの経路からも入らないか。**ログ・Debug Metadata・Rationale 経由の混入**も確認する。前の Action の Debug 出力を次のプロンプトに貼るケースがありうる。
- [ ] CPU の Observation が Provenance（Observer / Subject / Source Hand・Event / Visibility / Hand Number）を持ち、事実（evidence）と解釈（interpretation）が分かれているか（INV-INFO-003・`docs/04` §6）。
- [ ] CPU の Secret Hypothesis を Hero 向けの UI や Review で「事実」として見せていないか（`docs/05` §5）。
- **確認動作**: 他 Player の Hole Card に既知のマーカー値（固定 seed で配られる特定のカード）を置き、Opponent への入力 JSON をシリアライズして、マーカーが出現しないことを assert するテストがあるか（INV-TEST-007）。Learning-only Reveal の後に CPU Memory を走査するテストがあるか（INV-TEST-008）。

## B. 決定論と LLM の役割（poker-engine / ai-opponent）

- [ ] 合法 Action、Amount Range、Minimum Raise、Reopen、Pot / Side Pot、Showdown、Chip Movement を、Engine が計算しているか。LLM の出力を採用する前に **Schema → Legal Action → Amount Range** の順で検証しているか。
- [ ] Invalid Output は 1 回だけ Correction して Retry し、再度 Invalid なら Deterministic Safe Fallback に移るか。Invalid Output と Fallback の使用を Event として残しているか（`AI_ACTION_INVALID` / `AI_FALLBACK_USED`）。
- [ ] Model の障害時（Timeout や API エラー）に Emergency Bot へ**自動で切り替えず**、Retry / Emergency Bot / End-or-Pause をユーザーに選ばせているか。Fallback を使った Hand / Action にフラグを付けているか（`docs/03` §6）。
- [ ] 弱い CPU の「弱さ」を、Illegal Action や意味のない Random Action で表現していないか。Leak として表現しているか（`docs/05` §3）。
- [ ] Physical Action（Chip を出す・宣言する）と Canonical Action が分離されているか。裁定（Oversized Chip 等）が Rule Profile 経由で Engine 側にあるか（`docs/02` §3〜4）。Dealer Feedback の RULING / ETIQUETTE / COACHING を混同していないか（§8）。
- [ ] Engine の乱数は注入された RNG / seed を経由しているか。State 遷移が実時刻に依存していないか。

## C. Review（review-pipeline）

- [ ] Decision Review（Pass A）の入力を、**その Decision Point までの Event と Hero の Visibility から再構築**しているか。Hand 終了後の状態（Showdown のカード、最終的な Board、勝敗）から作っていないか。
- [ ] Pass B（Reveal）の結果で Pass A の評価を書き換えていないか（`docs/05` §7）。
- [ ] Review の根拠（Math / Range / Solver / KB / Observation / User Read）を構造化してから文章を生成しているか。Hidden な CPU 設定を根拠にしていないか。
- [ ] Assessment が段階評価で、Confidence・Assumptions・「何が変われば結論が変わるか」を伴っているか（§8）。Rake を無視する Solver / Review では、その制約を表示しているか（`docs/02` §6）。
- [ ] Review Record が Version 付きで、過去の Review を上書きしていないか（`docs/04` §8）。
- [ ] Web Evidence は、Local Evidence が不足したときだけ使い、Source / Date / Scope / Confidence を保持しているか（`docs/03` §10）。
- **確認動作**: 同じ Hand で River のカードだけを入れ替えたとき、Turn の Decision に対する Pass A の入力が**変わらない**ことを assert するテストがあるか。

## D. Event Log・Replay（persistence-event-log）

- [ ] 状態の変更が Event の追記として表現され、既存 Event を更新・削除していないか（Reset 系の明示操作を除く。`docs/04` §11）。
- [ ] Hand Summary や Stats を、Event から再構築できる Projection として扱っているか。2 つ目の「正しい Hand 表現」を作っていないか。
- [ ] Replay が保存済み Event の再生だけで動くか。Replay の中で LLM や Solver を呼んでいないか（D38）。
- [ ] Card / Observation の Event に Visibility があるか。Auto Save の境界が Completed Hand（`HAND_FINISHED`）か。

## E. Chip・表示（poker-engine / ui-table）

- [ ] Rake / Rebuy / Top-up などの明示操作を除き、Chip の総量が変わらないか。配分した Pot の総額が、Rake 等を控除した後の Distributable Pot と一致するか（INV-TEST-002 / 005）。Odd Chip の扱いが Rule Profile に従っているか。
- [ ] Stack を超える Commit を許していないか（INV-TEST-004）。
- [ ] UI で実額が常時表示され、BB は補助になっているか（D49）。

## F. Solver（review-pipeline）

- [ ] `supports()` で Capability を判定してから `analyze()` を呼んでいるか。Unsupported・Timeout・Parse Failure を正常系の Fallback（Math / Range / KB / Review AI）に流しているか（`docs/09` §7）。
- [ ] HU Solver の結果を Multiway の Exact GTO として表示・説明していないか。Range Assumption と Solver の Version を Evidence に残しているか。
- [ ] Model 名・Solver 名を Domain Logic にハードコードしていないか（role-based config）。

## 出力

指摘ごとに `[Pn] file:line — 観点（A〜F の項目）— 何が漏れる / 崩れるか — 根拠の docs 節` を返す。該当する節が無い差分なら「該当なし（差分クラス: …）」と明記する（黙って省略しない）。繰り返し出る指摘は `review-learning` で Capture する。
