# Issue #33: 2〜8 人の卓（人数を Config で選ぶ・UI の席配置）

## 概要

卓の人数を 2〜8 人から選べるようにした。Engine の上限（`MAX_PLAYERS`）を 6 → 8 に上げ、Server の卓設定を人数から組み立てる関数にし、Web の卓 UI が 2〜8 席を崩れず描くようにした。あわせて #31 の残件（Engine が返さなくなった `unsupported_state` の扱いを Web から削除）を整理した。Event の形（`HandEvent`・`schema_version`）は変えていない。

## 設計方針

- **Engine**: `MAX_PLAYERS = 8`。人数に依存するロジック（Hole Cards の配布・Blind・手番・Side Pot）は元々 `players.length` から導いており、定数以外の変更は要らなかった。
- **Server**: `config.ts` に `buildTableSetup(人数)`（Hero 1 人 + CPU（人数 − 1）人。範囲外は `RangeError`）と `parseTableSize(raw)`（環境変数 `TABLE_SIZE`。未設定・不正値は既定の 6 人に戻す。`parseBotDelayMs` と同じ作法）を追加。既定の `PHASE1_TABLE_SETUP` は `buildTableSetup(6)`（既存テスト・docs の参照を壊さないため名前を残した）。起動時（`index.ts`）だけ環境変数を読む。UI の人数選択画面は作らない。CPU の人数・名前は OI-005 の暫定値（コメントに明記）。
- **Web**: `seatDirections` は元々角度を `席数` で等分する式で、2〜8 席に対応済みだった（テストで固定）。実測で見つかった崩れを CSS で直した:
  - 横の半径が `45%`（または `36%`）固定だと、真横に来る席（4・8 席卓の 180°）が表の左右端から出る（768px 幅で横スクロール）。半径を `calc(50% - 席の半幅)` に変えた。
  - 狭い画面の 7・8 席卓は、上段の席（CPU 4 と CPU 5）が重なる。`Table` に `data-seat-count` を付け、7・8 席だけ札と席の面を一段小さくした。
- **#31 の残件**: `apps/web/src/lib/api.ts` の `ApiErrorKind` / `KNOWN_KINDS` と `useHandSession.ts` の通知文言から `unsupported_state` を削除。

## テスト

- Engine: 8 人卓の開始（Hole Cards 16 枚・重複なし・Blind・UTG）・2 人卓（Heads-Up）の開始。人数の拒否境界を 7 → 9 に更新。Property の人数を 2〜8 に広げた（Chip 保存・情報境界・同着の端数）。
- Server: `parseTableSize`（2〜8 と不正値）・`buildTableSetup`（2・6・8 の席順・重複なし・範囲外は拒否）・Orchestrator（2・6・8 人卓で Button を一周させ、Chip 総量不変・CPU の Fallback なし）。
- Web: `seatDirections`（2〜8 席・どの席が Hero でも真下・単位円上で重ならない）・`Table`（2・8 席で全席を 1 回ずつ描く・Hero 席は 1 つ）。

## 実機確認（Playwright・dev サーバー）

`TABLE_SIZE` を 2・3・4・5・6・7・8 で起動し、PC（1280）・タブレット（768）・スマホ（390 / 360）で、席同士の重なり・画面外・横スクロールを DOM の矩形で測定し、2・6・8 人は画面も目視した。修正前は 8 人卓で 768px の横スクロールと 360px の席の重なりがあり、修正後は全人数・全幅で無し。dev サーバーは確認後に止めた。

## 変更ファイル

- `packages/engine/src/table-config.ts`・`hand-engine.test.ts`・`hand-engine.property.test.ts`
- `apps/server/src/config.ts`・`config.test.ts`・`index.ts`・`hand-orchestrator.test.ts`
- `apps/web/src/components/Table.tsx`・`components.test.tsx`・`lib/view-model.test.ts`・`lib/api.ts`・`hooks/useHandSession.ts`・`styles.css`
- `docs/03_SYSTEM_ARCHITECTURE.md`（Betting 範囲・卓設定）・`README.md`（環境変数表に `TABLE_SIZE`）

## 残課題

- Button・Session の決め方は #34・#35。Hero の席位置は常に先頭固定（人数だけ可変）。
- 7・8 席の最小幅（360px）では、Bet の表示が隣の席に近い。実用上は読めるが、Phase 2 の UI 改良（#5 系）で再点検してよい。
