# Issue #140: Tilt を Version 付きの決定論 State Machine にする（P7-5）

## 概要

CPU の Tilt を `phase7_tilt_v1` の決定論 State Machine として実装した。今の Session の保存済みの Hand を論理順序（`ordinals.ord`）で頭から畳み込む純粋関数で、保存しない transient な状態（Session が変われば 0 から＝ Session 終了で Reset）。RuleBot は Persona の Preflop Looseness / Aggression を段階ごとに上限付きでずらすだけ、Claude の CPU には 1 以上のときだけ自分自身の Internal State として段階を Prompt で渡す。人間判断 D27・D40・D107・D117・D119 の具体。テーブル・列・Event の形・`schema_version`・マイグレーションは足していない。LLM の呼び出しの回数・経路は変えていない。

## 初期調査

- `persona.ts` の `tiltSusceptibility` / `recoverySpeed` は値だけあって未使用（Prompt にも RuleBot にも使っていない）。
- Memory（#139）は Hand の開始時に保存済みの Hand から作り、`CpuKnowledgeState` に足して Prompt では別の節に出す形。Tilt も同じ時点・同じ経路に乗せれば、再要求・Fallback・Emergency Bot も同じ入力になる。`docs/04` §5 の KnowledgeState の「含めるもの」に「自分自身の Internal State」があるので、`tilt` を `CpuKnowledgeState` に足した。
- Event Store には Session の Hand を引く `finishedHandIds`・`sessionIdOfHand`・`savedOrder` がある（#137 と同じ読み方で足りる。Store の変更なし）。
- Engine の `visibilityOf` と保存された Visibility の両方で public の Event だけに絞れる。Trigger の判定に要るのは public の Event（自分の札も Showdown の `CARDS_TABLED`）だけなので、席をまたいで Hand ごとに 1 回絞れば足りる。

## 設計方針

- **単位と寿命**: Session の中の席（playerId）ごと。Fixed CPU の Memory（cpuProfileId で Session を跨ぐ）・Persona とは別の層。今の Session の Hand だけを読むので、`SESSION_ENDED` の無い放置された Session の後でも持ち越さない。Resume は同じ Session の Hand から同じ値。壁時計を使わない（D117）。
- **Trigger の定義（public の Event と自分の結果だけから。OI-011 の暫定値）**: Showdown の負け＝Fold せずに札を比べた Pot まで残り、1 枚も受け取らなかった。40BB 以上の Pot の負け／3 連敗（Fold した Hand は連敗を切らない、Pot を受け取ると切れる）／Bluff が見つかる（最後に額を引き上げたのが自分で、自分の 2 枚で Board 5 枚の役から上がらず One Pair 以下で負けた）／大勝ち（収支プラスで受け取った Pot が 40BB 以上）。
- **遷移**: 0〜3 の整数。上がり幅 `ceil(Trigger の数 × tiltSusceptibility × 2)`（整数で計算し浮動小数の端数で段を変えない）。Trigger の無い Hand が `round(10 − 8 × recoverySpeed)` 回続くごとに 1 段下げる。
- **反映**: RuleBot は `tiltedPersona`（1 段 +0.05、3 段で +0.15 上限）から `tuningFromPersona` でしきい値を作り、Memory の調整はその後に掛ける。乱数は 1 判断 1 回のまま。Persona なしの RuleBot は Tilt を読まない（D71 のまま）。Claude は「あなたの今の状態」の節（段階と固定の説明）を 1 以上のときだけ入れ、Hand の情報の JSON には混ぜない（0 のときは #140 より前と同じ文字列＝録画の paramsHash を変えない）。
- **配置**: Tilt は Memory とは別の層なので `memory/` ではなく `opponents/tilt.ts`・`opponents/tilt-policy.ts`（Policy は `memory-policy.ts` と同じ形）。

## 変更ファイル

- `apps/server/src/opponents/tilt-policy.ts`（新規）: `TiltPolicy`・`PHASE7_TILT_V1`・`TILT_POLICIES`・`DEFAULT_TILT_POLICY`
- `apps/server/src/opponents/tilt.ts`（新規）: `tiltHandOutcome`・`stepTilt`・`foldTilt`・`loadTiltSources`・`buildTiltsFromStore`・`tiltPolicyOf`
- `apps/server/src/opponents/opponent-agent.ts`: `CpuKnowledgeState.tilt`
- `apps/server/src/opponents/rule-bot.ts`: `tiltedPersona` と choose での反映
- `apps/server/src/opponents/claude-opponent.ts`: 「あなたの今の状態」の節
- `apps/server/src/opponents/persona.ts`: Tilt の 2 軸のコメント
- `apps/server/src/hand-orchestrator.ts`: Hand の開始時に Tilt を作り（新しい Session は空）、CPU の入力に足す。Drill は持たない
- テスト: `opponents/tilt.test.ts`・`opponents/tilt-isolation.test.ts`（新規）、`opponents/rule-bot.test.ts`・`opponents/claude-opponent.test.ts`（追加）
- docs: `docs/03`（opponents・Claude の呼び方・KnowledgeState）・`docs/04` §5・§12・`docs/05` §4・`docs/09`（情報境界のテスト）・`docs/11` OI-011（未確定の側に暫定値の細部を追記。確定はしない）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過
- 決定論・Reset: 入力の並びを逆にしても同じ／ord の重複・不正は拒否／前の Session（`SESSION_ENDED` 無し）を持ち越さない／同じ Store から同じ値／時計が後ろへ戻った記録でも ord の順で決まる（メモリ内と SQLite の Store。記録時刻の順に読むと結果が変わる並びで確かめた）
- Isolation: `review/`・`learning/` から import をたどっても Tilt のモジュールに届かない。Fake の `query()` で 2 Session・12 Hand を進め、CPU の全 Prompt の Tilt の節がその CPU 自身の席の値だけ（同じ Hand で Tilt の違う CPU がいることも確認）・Session 2 の最初の Hand は全員 0・Review の Prompt・Hero への API の応答・Event Log に Tilt が出ない
- 変異の確認（手元で入れて戻した）: CPU の入力に他の CPU の Tilt を入れるようにすると、Isolation の動的テストが落ちる
- RuleBot: 全 Preset が Tilt 3 でも Legal Action の中（額も範囲内の整数）、Tilt 3 の TAG は参加が増える

## CI の対応

- 初回 push の CI で `hand-orchestrator.test.ts` の「8 人卓で Session を通して…」（20 seed × 最大 30 Hand）が既定の 5 秒を超えた（5.2 秒。main の CI では 2.5 秒）。Hand の開始ごとに Memory（#139）と Tilt が Session の保存済みの Hand を読み直すため。
- Tilt 側は、public の Event への絞り込みを席ごとから Hand ごとに 1 回へ減らし、Event の複製をやめた（手元の計測で Tilt の時間は 271ms → 185ms / 422 回）。判定は変えていない。
- あわせて、そのテストの上限を 20 秒に広げた（判定の中身は変えない）。Memory を含む Hand の開始ごとの読み直しは、遅くなった時点で Cache を別 Issue で足す方針（D111 と同じ）。

## 残課題

- Tilt を反映した Claude の CPU の品質はまだ測っていない（Opponent Eval の Spot は Tilt の無い入力だけ。測るなら手動の Eval で別 Issue）。
- Trigger の定義・係数は OI-011 の暫定値。Playtest / Eval で見直す（変えるときは Version を上げた Policy を足す）。
