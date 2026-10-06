# Issue #51: Persona の Preset を作り、Prompt と卓編成に反映する

## 概要

Phase 3（AI Opponents）の子 Issue。docs/05 §2 の 11 軸で Persona を表し、6 つの Preset（TAG Regular・LAG・Calling Station・Nit・Maniac・Weak-tight Recreational。D85）を置いた。卓の CPU に席順で決定論的に割り当て、Claude の Prompt と RuleBot のしきい値に反映する。Persona は KnowledgeState・Event・DB・Hero への応答に入れない（Secret Persona。D28）。Tilt（Transient State）は扱わない（Phase 7）。Event の形・`schema_version`・永続化スキーマは変えていない。

## 初期調査

- 前提（main 594f5c1）: #50 で `ClaudeOpponent` に `persona?: string`（空なら Prompt に入れない）の口があった。`OpponentFactory` は `(seed, playerId)`。
- `POST /api/hands` の応答は `players: orchestrator.players`（`TableSetup.players` そのもの）を返すため、`SeatPlayer` に Persona を足すと Hero へ漏れる。そこで Persona は `TableSetup.personas`（playerId → Preset ID）に分けた。
- 既存テストの漏れ検査 `forbiddenKeys` は Hero の応答・SSE・CPU の入力に掛かっているので、ここへ Persona の語を足せば既存の経路すべてで漏れを検査できる。
- docs/02 §2 は「自分自身の Persona」を CPU の入力に許すが、KnowledgeState は Engine が Event から作る Projection で、Persona は Event に入れない。そこで自分の Persona は入力ではなく Agent を作るとき（`OpponentFactory` の 3 つ目の引数）に渡す形にした。

## 変更内容

- `apps/server/src/opponents/persona.ts`（新規）: `PersonaTraits`（11 軸。0〜1・0.5 が平均）、`PERSONA_PRESET_IDS` / `PERSONA_PRESETS`（数値・Leak は OI-005 の暫定値）、`describePersona`（Prompt 用の文章。Tilt の 2 軸は入れず、Leak は持つときだけ節ごと入れる）、`isPersonaPresetId`。
- `apps/server/src/opponents/opponent-agent.ts`: `OpponentFactory = (seed, playerId, persona?)`。
- `apps/server/src/opponents/claude-opponent.ts`: `createClaudeOpponentFactory` が割り当てられた Persona を `describePersona` で Prompt の「あなたの性格」の節に入れる。
- `apps/server/src/opponents/rule-bot.ts`: しきい値を `RuleBotTuning` にまとめ、Persona なしは D71 のときの値（`DEFAULT_TUNING`）のまま。`tuningFromPersona` は各軸の 0.5 からのずれで、strong / medium の Bet・Raise の確率（Aggression）、weak の Bet（Bluff Tendency）、medium の大きい Call（Risk Tolerance）、Limp の確率と Preflop の参加 Range（Preflop Looseness。tight / standard / loose）を変える。Persona なしの既定では medium の手で Raise しない（`mediumRaiseFrequency: 0`）ので、既定の挙動は変わらない。
- `apps/server/src/config.ts`: `TableSetup.personas`、`DEFAULT_PERSONA_ROTATION`（TAG Regular・LAG・Nit・Calling Station・Weak-tight Recreational・Maniac。6-max の CPU 5 人では Maniac が出ない並び＝弱い CPU は少数。FR-CPU-003）、`buildTableSetup(人数, 割り当て順)`、`parsePersonaRotation`（環境変数 `CPU_PERSONAS`。知らない ID は起動時に RangeError）。
- `apps/server/src/hand-orchestrator.ts`: 席の CPU ごとに `PERSONA_PRESETS[personas[playerId]]` を Factory と Fallback の RuleBot に渡す。
- `apps/server/src/index.ts`: `CPU_PERSONAS` を読んで `buildTableSetup` に渡す。`testing/claude-smoke.ts`: 包んだ Factory が Persona を通すようにした（本番と同じ経路。LC-050）。
- `apps/server/src/testing/leaks.ts`: `personaTerms`（Preset の ID・名前・"persona"）を足し、`forbiddenKeys` に含めた。
- テスト: `persona.test.ts`（新規。6 Preset・11 軸・0〜1・difficulty に縮約しない・`describePersona` の出し分け）、`rule-bot.test.ts`（全軸 0.5 の Persona は Persona なしと同じしきい値・同じ判断／全 Preset で合法 Action だけ／Persona で参加率と Raise 率が変わる／再現性）、`config.test.ts`（席順の割り当て・繰り返し・`players` に Persona が無い・`parsePersonaRotation`）、`hand-orchestrator.test.ts`（Claude の Fake で 1 Hand を進め、各 CPU の Prompt に自分の Persona だけが入り、CPU の入力・Event Log・Hero の View に Persona の語が無い）。
- docs: docs/03 §1（`opponents/persona.ts`・割り当てと `CPU_PERSONAS`）・§3（Prompt に入れるもの）・§5（Persona の渡し方）、docs/11 OI-005（数値・係数・割り当て順も暫定値）、README（環境変数表に `CPU_PERSONAS`）。

## 判断理由

- **Fallback の RuleBot にも同じ Persona を渡した**: 既存のテスト「出力が常に不正なら、各 CPU は同じ seed の RuleBot と同じ判断になる（Fallback は決定論）」は、Fallback と本来の RuleBot が同じであることを前提にしている。Persona を Fallback だけ外すとこの関係が崩れ、不正な出力が続いた CPU だけ性格が変わる。決定論であることは変わらない。Persona なしの RuleBot（D71）の挙動は変えていない。Emergency Bot（#52）で Persona をどう扱うかは #52 で決める。
- **割り当ては席順**（seed ではなく）: 同じ設定なら毎 Hand・毎 Session で同じ CPU が同じ性格になり、Bust で席が詰まっても playerId で引くので変わらない。
- **Tilt の 2 軸は値だけ持ち、使わない**: Transient State が無い今 Prompt に書くと、条件無しに Tilt した振る舞いを促しかねない（条件付きの指示は節ごと出し分ける。llm ガイダンス 4）。
- **`CPU_PERSONAS` の知らない ID は起動時に止める**: `OPPONENT_PROVIDER` と同じく、綴り違いで黙って既定に戻ると試しているつもりで試せていないことに気づきにくいため。

## 手動確認（実際に Claude を呼んだ結果）

- 条件: 2026-10-06、`claude-haiku-4-5`（`opponent_fast`）、claude.ai でログイン済み（`claude auth status`）、`ANTHROPIC_API_KEY` は子プロセスの環境から外す（`buildClaudeEnv`）。6 人卓の最初の Actor（UTG・BB に直面）の同じ入力を、6 つの Persona の `ClaudeOpponent` に渡した（seed 1〜8 の 8 Spot × 6 = 48 回）。一時スクリプトで実行し、コミットしていない。
- 結果（参加 = call / raise）:

| Persona | 参加 | うち raise | 例 |
|---|---|---|---|
| TAG Regular | 4/8 | 4 | TT・AJs・AKo・KQo を raise、ほかは fold |
| LAG | 4/8 | 4 | TAG と同じ 8 Spot の選び方 |
| Calling Station | 8/8 | 0 | 全部 call（36o も call） |
| Nit | 3/8 | 0 | TT を fold、AJs・AKo・KQo は call |
| Maniac | 8/8 | 8 | 全部 raise（36o・J3o も） |
| Weak-tight Recreational | 4/8 | 0 | TT・AJs・AKo・KQo を call、ほかは fold |

- Persona ごとに参加の広さと攻撃性がはっきり分かれた（Calling Station は全部 call、Maniac は全部 raise、Nit・Weak-tight は raise しない）。TAG と LAG はこの 8 Spot（UTG）では同じ選び方だった。
- 障害（例外）0 回。Calling Station が call に amount を付けた（`call(2)`）回が 2 回あり、Orchestrator の検証では Schema 違反（→ 1 回 Retry）になる。#50 の計測（Persona なし・63 回）では 0 回だった。本 PR では Prompt を変えず、残課題に置く。
- Latency は 1 回 5.5〜10.2 秒（#50 の計測と同程度）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて exit 0。`pnpm test` は engine 158・web 31・server 124 件が通過。`pnpm test` は Claude を呼ばない（Fake の `query` と RuleBot だけ）。
- RuleBot の Preflop（seed 1〜400 の最初の Actor）の分布を一時テストで確認した（コミットしていない）: Persona なし fold 272 / call 115 / raise 13、Nit 372 / 15 / 13、Calling Station 195 / 197 / 8、Maniac 150 / 199 / 51、LAG 227 / 131 / 42、TAG 299 / 76 / 25、Weak-tight 328 / 63 / 9。

## 残課題

- Calling Station の Prompt で call に amount を付ける出力が出た（48 回中 2 回）。測定を伴う Prompt の調整は `llm-quality-improvement` の手順で別に行う。
- Emergency Bot（#52）で Persona を引き継ぐかは #52 で決める。
- Preset の数値・係数・割り当て順は OI-005 の暫定値。Playtest で見直す。
