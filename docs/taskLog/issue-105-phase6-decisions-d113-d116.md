# Issue #105: Phase 6 の実装前の人間判断（D113〜D116）を記録する

## 概要

Phase 6 の子 Issue（#112〜#119）の実装に入る前に sync-check で Issue・正本 docs・既存実装を照合し、人間判断が要る 4 点をセッション冒頭の AskUserQuestion で確認した。4 点とも推奨案で確定したので D113〜D116 として記録し、docs/04・07・08・10 を同期した。コード・スキーマは変えていない。

## 初期調査（sync-check の結論）

- docs/04 §12 は Hypothesis を「再計算できる Projection」とする一方、D104・D111 は「構造化して保存」とし、保存の形は #114 に持ち越していた。
- D111 で Stats / Score / Profile を保存しないため、docs/04 §11 の Learning Reset（削除）に消す実体がなかった。`events` / `reviews` / `reveal_reviews` / `review_followups` は削除拒否の Trigger を持つ（`apps/server/src/db/database.ts`）。
- Pass A の Review は Hero が要求した判断にしか作られないため、Score の母集団を決める必要があった（API 課金に関わる）。
- Drill の Hand を通常の Event Log に入れると、Stats・Replay・Resume が通常 Play と区別できない。
- D112 は Note / Tag をマイグレーション v5 と定めており、#114 を先に実装すると Hypothesis のテーブルが v5 になって食い違う。

## 判断（AskUserQuestion の回答。すべて推奨案）

- D113: Hypothesis は reviews から作り直せる Snapshot のテーブル（v6）。#115 を #114 より先に実装する（D110 の順序のうちこの 2 つだけ入れ替え。D110 の status に注記）。
- D114: Learning Reset は追記型の区切りの行。正本と Trigger はそのまま。User Read / Note / Tag は消さない。
- D115: Score と Decision Quality Summary は Review 済みの判断だけを数え、M 件中 N 件を表示する。
- D116: Drill は専用 Session の通常 Hand と追記型の `drills` テーブルで区別し、通常の集計から除く。

## 変更内容

- `docs/decision_log.yaml`: D113〜D116 を追記。D110 の status に入れ替えの注記。
- `docs/04_DATA_AND_EVENTS.md` §11・§12、`docs/07_LEARNING_AND_ANALYTICS.md` §5・§6・§7、`docs/08_MVP_AND_ROADMAP.md`（Phase 6 の実装順）、`docs/10_DECISION_TRACEABILITY.md`（判断グループの行）。
- 範囲表記 D01〜D112 → D01〜D116（decision_log 先頭・docs/00・docs/10・README・sync-check / test-and-review skill）。

## 実行した確認

- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 333・server 445・web 122 件が通過）: すべて通過。

## 残課題

- #114 / #115 の Issue 本文の Depends on を実装順に合わせて直す（この PR のマージ後）。
