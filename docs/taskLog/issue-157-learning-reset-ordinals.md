# Issue #157: buildApp の既定の Learning Reset Store を Event Store と同じ順序の源にする

## 目的

`buildApp` に Event Store だけ独自の論理順序カウンタで渡し `learningResetStore` を省くと、既定の `InMemoryLearningResetStore` がプロセスの既定のカウンタで Reset の番号を振り、Hand の保存の番号と比べられなかった（D117 の契約違反。テスト用の組み立て経路のみ。起動時は SQLite の同じ DB の `ordinals` なので影響なし）。

## 変更内容

- `apps/server/src/event-store.ts`: `InMemoryEventStore.ordinals` を公開（読み取り専用）
- `apps/server/src/app.ts`: 既定の Learning Reset Store を `defaultLearningResetStore(store)` で組み立てる。メモリ内の Event Store ならそのカウンタを共有する。メモリ内以外の Event Store で `learningResetStore` を省いたら、順序の源を共有できないので例外で拒否する
- `apps/server/src/routes/learning.test.ts`: 回帰テスト（Event Store の独自のカウンタが既定より先／遅れの両方向、メモリ内以外の Event Store の拒否）。修正前は先／遅れの 2 件が落ちることを確認した
- `docs/04_DATA_AND_EVENTS.md` §10「論理順序」の書き込みの項: メモリ内の Store の記述を実装に合わせた

## 判断理由

- Opponent Memory Reset（#143）の形（`lastOrdinal()` を読む）に合わせると、Learning Reset の「後の Reset ほど番号が大きい」（SQLite と同じ意味・既存テスト）が崩れる。Reset が番号を消費する既存の意味を保つため、カウンタの共有にした
- 本番（SQLite）の経路・マイグレーション・スキーマは変えていない

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（server 729 件）/ `pnpm format:check` すべて通過

## 残課題

なし
