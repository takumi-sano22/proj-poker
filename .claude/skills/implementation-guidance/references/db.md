# db — SQLite・Event Store・Projection・マイグレーションを書く前の判定基準

**本書が一次情報である範囲**: 実装時の確認動作と、コードコメント以外に一次情報が無い実装事実（育てながら追記する）。**一次情報が別にある範囲**: Event Log が正本・Projection は派生は `docs/04_DATA_AND_EVENTS.md` §1 と D37、Auto Save 境界は同 §10、Reset の意味は同 §11、技術方針（SQLite）は `docs/03_SYSTEM_ARCHITECTURE.md` §1。ドライバと方式は D72（Node 24 内蔵の `node:sqlite`・ORM なし・生 SQL・自前の小さなマイグレーション）、Event の版は D76、テーブル構成と保存の境界は `docs/04` §10「Phase 1 の保存」。

> **停止条件**: スキーマ変更・マイグレーションを伴う実装は、自走せず親へ返して人間確認を取る。

## 書く前に決めること

> **レビュー時にも当たる欠陥クラスは台帳が一次情報**（LC-020 三値論理 / LC-021 補償の行削除 / LC-022 競合制御の機構）。書く前に一読し、ここには繰り返さない。

1. **Event Log は追記専用の正本、Summary / Stats は Projection**（D37）。Projection のテーブルを正本として更新・参照元にしない。消しても Event から再構築できる設計にする。
2. **Completed Hand を保存境界にする**（docs/04 §10）。`HAND_FINISHED` 時の Hand Events・Session Projection・Stack・Memory 更新は同一トランザクションで保存する。
3. **Reset の意味（Learning / Opponent Memory / Hand History Delete / Factory Reset）ごとに何を消し何を残すかは docs/04 §11 に従う**。Event Log を消す操作は破壊的操作として停止条件に入れる。
4. **TTL・保持期間の cutoff は日数固定で計算する**（`setMonth` は月末で溢れる）。
5. **タイムゾーン付きの日付キーは実時刻ではない**: 比較・範囲は日付キー専用のヘルパで組み、境界の基準を 1 か所に寄せる。
6. **コードを読んだだけでは分からない実装事実（legacy テーブル・延長される期限列等）はここへ追記する**。
7. **永続化の置き場所（#20 で確定）**: 接続とマイグレーションは `apps/server/src/db/database.ts`（`MIGRATIONS` の配列を `PRAGMA user_version` で管理。適用済みの要素は書き換えず、変更は末尾に足す）、Event Store は `apps/server/src/sqlite-event-store.ts`。DB ファイルは環境変数 `POKER_DB_PATH`（`:memory:` 可）、既定は `apps/server/data/poker.sqlite`（gitignore 済み・worktree ごとに別）。Engine（`packages/engine`）は `node:sqlite` を import しない（lint で禁止）。
8. **Event の形を互換の無い形で変えるときは `EVENT_SCHEMA_VERSION` を上げ、旧版の行を読み込み時に新しい形へそろえる upcast を同じ PR で足す**（D76）。保存済みの行を UPDATE で書き換えない（`events` は Trigger で UPDATE を拒否する）。

## 確認動作（実装後・自己レビュー前）

- マイグレーションは使い捨ての SQLite ファイルへ最初から適用して通ることを確認（開発データを汚さない。`apps/server/src/db/database.test.ts` が一時ディレクトリへ適用する。`pnpm --filter @proj-poker/server test`。実機では `POKER_DB_PATH` に一時ファイルを指定して起動する）
- Projection を作り直して、Event Log からの再構築結果が既存の Projection と一致することを確認
- 競合が絡む処理は、同じ入力を 2 並列で投げる手元テストを 1 回行う
