# Issue #138: Observer×Subject×Context の Private Hypothesis を recency decay 付きで作る（P7-3）

## 概要

CPU の Observation（#137 の `ObservedHand`）から、Observer × Subject × Context（cash / tournament）ごとの Private Hypothesis を recency decay 付きで都度作る純粋関数を `apps/server/src/memory/opponent-hypothesis.ts` に足し、Version 付きの Policy `phase7_memory_v1` を `apps/server/src/memory/memory-policy.ts` に置いた。人間判断 D106・D111・D117・D119 の具体。表・列・Event の形・`schema_version` は足していない。KnowledgeState・Prompt・RuleBot への注入は #139。

## 初期調査

- 入力: `memory/observation.ts` の `ObservedHand`（Observer・席 → 参加者・public の Event だけ・`ord`・`context`）。Guest・v10 より前の Session・Observer が座っていない Hand の除外は抽出側で済んでいる。
- 傾向の数え方: Engine の `STAT_DEFINITIONS` / `toStatsHand`（`packages/engine/src/stats.ts`）は public の Event だけから Hand 単位の寄与（numerator / denominator / opportunities・Street）を返す。Hero の Stats と同じ定義を CPU の観察にもそのまま使える。
- Policy の形: `learning/scoring-policy.ts` の「const ＋ Version → Policy の Record ＋ 既定」。`learning/` は import しない（形だけ合わせる）。
- 既存の `memory/observation-isolation.test.ts` は `memory/` の全モジュールを入口に import をたどるので、新しいモジュールも自動で検査に入る。

## 設計方針

- **項目**: Observation から数えられる観察可能な頻度に限り、Engine の Stats の定義のうち割合で読む 7 指標（VPIP・PFR・3-bet・Fold to 3-bet・Flop C-bet・Flop Fold to C-bet・Aggression Frequency）。比で読む Aggression Factor は重み付き機会数と分母が一致しないので入れない。一覧は Policy の `items` に置き、Version で増やせる。Showdown での Bluff の見え方は、何を Bluff とみなすかの定義が要るので今回は入れていない（残課題）。
- **recency decay（D119）**: Observer がその Subject を同じ context で見た Hand（両者が座っていて終わった Hand）を `ord` の順に並べ、最新を age 0 として `0.5^(age/150)`。壁時計を使わない（D117）。context ごとに数えるのは Hypothesis が context ごとの Projection だから（Tournament は Phase 8 まで無いので今の結果は変わらない）。
- **十分な Sample（D119）**: 重み付きの機会数（denominator）が `15 × (0.5 + Skill)` 以上。D106 の「集計に recency decay をかける」に合わせ、Sample の判定も減衰後の機会数で行う（重みを掛けない機会数 `opportunities` も別に返す）。OI-011 の暫定値の範囲の解釈で、Version 付きの Policy に閉じている。
- **Skill**: 呼び出し側が渡す（Fixed CPU は Pool の Persona、Guest は席の Persona。引き方は #139 の注入側）。
- **Evidence**: 項目に寄与した Street の Subject の `ACTION_TAKEN` の `hand_id`・`seq`・`ord`。古い Evidence も消さない（重みが小さくなるだけ）。
- **Isolation**: 入力は 1 人の Observer の観察だけ。別の Observer の `ObservedHand` を混ぜたら RangeError。Observer 自身・誰か引けない席は Subject にしない。
- **決定論**: Hand を `ord` 順に並べ直し、古い順に足す（浮動小数の和の順を固定）。出力は context・Subject の鍵の順。`ord` の重複は RangeError。打ち切った Hand（`HAND_FINISHED` が無い）は Stats と同じく数えない。

## 変更ファイル

- `apps/server/src/memory/memory-policy.ts`（新規）: `MemoryPolicy`・`PHASE7_MEMORY_V1`・`MEMORY_POLICIES`・`DEFAULT_MEMORY_POLICY`（数値は OI-011 の暫定値とコメント）
- `apps/server/src/memory/opponent-hypothesis.ts`（新規）: `buildOpponentHypotheses`・`buildOpponentHypothesesFromStore`
- `apps/server/src/memory/opponent-hypothesis.test.ts`（新規）: Policy の値・集計と decay・Evidence・Skill の差・Isolation（Observer ごと・別 Observer の混入拒否・Guest・Cash / Tournament）・決定論・時計が戻った記録の回帰（メモリ内 / SQLite）
- `apps/server/src/memory/observation-isolation.test.ts`: 新しいモジュールが検査の入口に入っていることを明示
- docs: `docs/03`（`memory/` の節）・`docs/04` §12（「Private Hypothesis（#138）」）・`docs/05` §5

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 618 件・engine 363 件・web 141 件）
- 変異の確認（手元で入れて戻した）: decay の age を逆にすると decay・時計が戻った記録のテスト 3 件が落ちる／Observer の検査を外すと混入拒否のテストが落ちる

## 残課題

- まだどこからも呼ばない（KnowledgeState・Prompt・RuleBot への注入は #139。Subject ごと上位 5 項目の要約は D121）。
- Showdown での Bluff の見え方の項目は、Bluff の判定の定義（Hand の強さのしきい値等）が要るので未実装。後の Issue で Policy の Version を上げて足す。
- 全 Hand を都度読むので、遅くなったら Cache を別 Issue で足す（D111 と同じ方針）。
