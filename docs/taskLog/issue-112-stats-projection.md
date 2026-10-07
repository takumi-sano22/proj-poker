# #112 P6-1 Event Log から全 Player の Stats を再計算する Analytics Projection

## 目的

Phase 6 の土台として、Event Log（正本。D37）から全 Player の代表 Stats を再計算する決定論の Projection を作る（D103）。結果は保存しない（D111）。

## 変更内容

- `packages/engine/src/stats.ts`（新規）: `projectPlayerStats(hands, { excludeHandIds })` と、1 Hand を Stats の入力へ畳み込む `toStatsHand`。指標の定義は `STAT_DEFINITIONS` の 1 か所に集め（vpip / pfr / three_bet / fold_to_three_bet / cbet_flop / fold_to_cbet_flop / aggression_frequency / aggression_factor）、指標ごとに Numerator / Denominator / Opportunity Count を返す。Player ごとに全体・Position 別・Street 別の表を持つ。結果に定義の版 `STATS_DEFINITION_VERSION = "phase6_stats_v1"` を付ける。
- `packages/engine/src/projection.ts`: public の Event だけを返す `publicEvents` を足した（`visibleEvents` と同じ whitelist の考え方で、より狭い）。
- `packages/engine/src/range-model.ts`: Raise の判定 `isAggressive` を export した（Range の分類と Stats で Raise の数え方をそろえる。引数の型を `action` / `toAmount` だけに緩めた）。
- `packages/engine/src/index.ts`: 上の公開。
- テスト: `stats.test.ts`（3 人卓の 4 Hand と 6 人卓の固定 Scenario。期待値は手計算）、`stats.property.test.ts`（情報境界・順序非依存・除外・集計の整合）。
- docs: `docs/07` §3 に実装と指標の表、`docs/04` §12 に保存しないこと・入力の範囲。

## 判断理由

- 入力は public の Event だけにした。Stats は Action の公開の事実だけで決まり、Hole Cards・Persona・system の記録・Learning-only Reveal を読む理由が無い。読まない形にすれば、漏れの経路を作らない（新しい Visibility の例外を足さない）。
- 集計に入れるのは `HAND_FINISHED` まで済んだ Hand。打ち切った Hand（`HAND_ABORTED`）は途中で止まっており、機会の数え方が歪むため入れない（定義の版 v1 の条件としてコメントに残した）。
- Preflop の機会は「Preflop で Action した Hand」。Walk・Blind で All-in の Hand は機会に入れない（Tracker で一般的な数え方）。
- 暫定のしきい値は使っていない（指標の定義だけ）。定義は版付きで、永久仕様にしない。
- Hand をまたいで読む Event Store のメソッドは足していない。Engine の純粋関数が完成形で、Server からの呼び出し（最初の利用者は #116 の画面）は既存の `listHands` / `read` で組める。Learning Reset の区切り（D114）は #118 で引数を足す。
- `docs/03` は Component 境界・ディレクトリ構造が変わらないので更新していない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて exit 0（engine 345・web 122・server 445 passed）
- Property を `POKER_PROPERTY_RUNS_FACTOR=30` で 1 回流して passed。最初の 20 倍の実行で、Blind 以下の Stack で開始直後に終わる Hand へ `SESSION_STARTED` を置こうとするテストの生成の誤りが見つかり、生成側を直した（実装の誤りではない）

## 残課題

- Server からの呼び出し・API・画面は #116。Drill の Hand の除外の呼び出しは #117、Learning Reset の区切りは #118。
