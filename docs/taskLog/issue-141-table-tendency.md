# Issue #141: Public Evidence だけから Table Tendency を作る（P7-6）

## 概要

卓全体の観察可能な傾向（Table Tendency）を、今の Session の保存済みの Hand の public の Event だけから都度数える決定論の純粋関数として実装した（`phase7_table_tendency_v1`）。個々の CPU の Private Observation / Hypothesis・Persona・Tilt を集約せず、import もしない。CPU 用（その CPU が座っていた Hand）と Hero 用（Hero が座って見えた Hand）の入り口を分けた。CPU には `KnowledgeState.tableTendency` として渡し、Claude の CPU は「卓の傾向」の節、RuleBot は Persona の Adaptability の範囲で 2 つのしきい値をずらすだけ。人間判断 D10（とは別物）・D40・D106・D111・D117・D121 の具体。テーブル・列・Event の形・`schema_version`・マイグレーションは足していない。LLM の呼び出しの回数・経路は変えていない。

## 初期調査

- Observation の抽出（#137）の whitelist `isObservable`（保存された Visibility と Engine の `visibilityOf` の両方が public）は非公開だった。Table Tendency も同じ whitelist を使うため export した（中身は変えていない）。
- 傾向の数え方は Engine の `STAT_DEFINITIONS`（public の Event だけを読む）と `toStatsHand` で足りる。Showdown の有無は `POT_AWARDED.showdown` から取れる。
- Tilt（#140）と同じく Hand の開始時に今の Session の保存済みの Hand を読む形にすれば、再要求・Fallback・Emergency Bot も同じ入力になり、Session の最初の Hand（Hand 0）では項目ごと持たずに Prompt を変えずに済む。
- Opponent Eval の Spot（`testing/opponent-eval/spots.ts`）は `projectKnowledgeState` だけで入力を作るので、`tableTendency` の無い Prompt＝録画の paramsHash は変わらない。

## 設計方針

- **項目（OI-011 の暫定値）**: viewer 以外の席の `vpip`（looseness）・`pfr`・`aggression_frequency`（Postflop の aggression）の合算と、卓全体の `showdown`（札を比べて決着した Hand の割合。Hand 単位）。重みは掛けない。viewer 自身の Action を入れないのは、「自分から見た卓の他の参加者の傾向」として使うため。
- **範囲**: 今の Session の、viewer が座っていた Hand のうち `ord` で新しい 100 Hand。座っていない Hand（Bust の後）・打ち切った Hand は数えない。範囲を `ord` で切るので、時計が戻った記録でも結果は同じ（D117）。
- **十分か**: 項目の機会があった Hand が 10 以上かつ機会（denominator）が 20 以上。項目ごとに numerator / denominator・Hand の数・十分か・Policy の Version を持つ。
- **入り口**: `buildCpuTableTendenciesFromStore`（座っている CPU ごと。Hand 0 の CPU は返さない）と `buildHeroTableTendencyFromStore`（Hero が座った Hand。`beforeOrd` で判断より前の Hand に絞れる。Hand 0 でも返す）。
- **反映**: RuleBot は `tableTendencyAdjustedTuning`（`phase7_rulebot_table_tendency_v1`）で、卓の `aggression_frequency`（基準 0.35）で medium の手の Call、卓の `vpip`（基準 0.3）で weak の手の Bluff を、Adaptability × 最大 0.1 だけずらす。十分な項目だけ読み、Memory の調整より先に当てる。乱数の引き方は変えない。Claude の CPU は Hand が 1 以上のときだけ「卓の傾向」の節（固定の説明＋構造化 JSON。Persona があるときだけ「相手への適応」の 1 行）を Memory の節の後・Tilt の節の前に入れる。
- **配置**: 観察から作る Projection なので `memory/table-tendency.ts`・`memory/table-tendency-policy.ts`。ただし `opponent-hypothesis.ts`・`memory-summary.ts`・`memory-policy.ts` は import しない。

## 変更ファイル

- `apps/server/src/memory/table-tendency-policy.ts`（新規）: `TableTendencyPolicy`・`PHASE7_TABLE_TENDENCY_V1`・`TABLE_TENDENCY_POLICIES`・`DEFAULT_TABLE_TENDENCY_POLICY`
- `apps/server/src/memory/table-tendency.ts`（新規）: `buildTableTendency`・`loadTableTendencySources`・`buildCpuTableTendenciesFromStore`・`buildHeroTableTendencyFromStore`
- `apps/server/src/memory/observation.ts`: `isObservable` を export（中身は不変）
- `apps/server/src/opponents/opponent-agent.ts`: `CpuKnowledgeState.tableTendency`
- `apps/server/src/opponents/rule-bot.ts`: `RULEBOT_TABLE_TENDENCY_V1`・`tableTendencyAdjustedTuning` と choose での反映
- `apps/server/src/opponents/claude-opponent.ts`: 「卓の傾向」の節
- `apps/server/src/hand-orchestrator.ts`: Hand の開始時に CPU ごとの Table Tendency を作り（新しい Session は空）、CPU の入力に足す。Drill は持たない
- テスト: `memory/table-tendency.test.ts`・`memory/table-tendency-isolation.test.ts`（新規）、`opponents/rule-bot.test.ts`・`opponents/claude-opponent.test.ts`（追加）
- docs: `docs/03`（opponents・Claude の呼び方・KnowledgeState）・`docs/04` §5・§12・`docs/05` §5・`docs/09`（情報境界のテスト）・`docs/11` OI-011（新しい暫定値を未確定の側に追記）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 54 files / 685 tests）
- 数え方: cpu1 から見た h1・h2（h3 は座っていない・h4 は打ち切り）の各項目の numerator / denominator / Hand 数、Hero から見た h1〜h3 の値、十分の判定、範囲（windowHands）
- 決定論: 入力の並びを逆にしても同じ／ord の重複・不正は拒否／時計が後ろへ戻った記録でも `ord` の順で範囲が決まる（メモリ内と SQLite の Store。記録時刻で選ぶと別の Hand になる並びで確かめた）
- Isolation: 他者の Hole Cards・Deck・`system` の Event を差し替えても、保存された Visibility が public でない `ACTION_TAKEN` を混ぜても同じ。Table Tendency のモジュールから `learning/`・`opponent-hypothesis.ts`・`memory-summary.ts`・`memory-policy.ts`・Tilt のモジュールに届かず、Learning-only Reveal を参照しない。Fake の `query()` で 1 Session 5 Hand を進め、CPU の全 Prompt の卓の傾向の節が、その CPU が座っていた、その Hand より前の Hand から作った値と一致（最初の Hand は節が無い）・Review の Prompt・Hero への API の応答・Event Log に出ない
- 変異の確認（手元で入れて戻した）: CPU の入力に別の CPU の Table Tendency を入れるようにすると、Isolation の動的テストが落ちる
- RuleBot: Table Tendency が無い・Sample 不足・Adaptability 0 なら元のしきい値。ずれは maxShift × Adaptability まで。Persona なしの RuleBot は判断を変えない。選ぶ Action は Legal Action の中
- 速さ: `hand-orchestrator.test.ts` の 8 人卓の Session のテストが 1.9 秒 → 2.1 秒（上限 20 秒）

## 残課題

- **Hero の Review への接続は入れていない**: `docs/05` §6 の Opponent Observation は `unavailable` のままで、Table Tendency を Evidence に入れると Review の Evidence・Prompt の契約（Review Eval の録画の指紋を含む）が変わるため。Hero 用の入り口（`beforeOrd` で判断より前の Hand に絞る）だけを用意した。入れるなら Review の契約の変更として別 Issue・人間判断で扱う。
- Table Tendency を反映した Claude の CPU の品質はまだ測っていない（Opponent Eval の Spot は Table Tendency の無い入力だけ）。
- 項目・範囲・十分の基準・RuleBot の係数は OI-011 の暫定値。Playtest / Eval で見直す（変えるときは Version を上げた Policy を足す）。
