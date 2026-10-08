# Issue #144: Phase 7 の Critical E2E と README（P7-9）

## 概要

Phase 7（Rich Opponent Simulation）の Critical E2E を `e2e/tests/opponent-memory.spec.ts` として足し、`docs/09` §8・§11、`docs/08` §3.2、`docs/03` §1、ルート README を Phase 7 の到達点へ更新した。プロダクトの挙動は変えていない（E2E のために本番の API・画面を足していない）。

E2E で確かめること（親 #106 の P7-9 と、`docs/09` §8 の一覧）:

1. Fixed CPU と複数 Session をプレイする（Session の終わりは Hero の Bust、次の Session は画面の「新しい Session を始める」）
2. 前の Session の observable Evidence を、次の Session の同じ `cpuProfileId` の CPU が Memory として使う
3. Guest は次の Session に Memory を持ち越さない
4. CPU-to-CPU の Private Memory が第三者の CPU に漏れない
5. Tilt が Session の終わりで Reset される
6. Opponent Memory Reset の後は Reset より前の Hand を Memory に使わず、User Note / Tag は残る
7. Hero の画面と API の応答に Memory / Persona / Tilt の値が出ない

## 初期調査

- Memory・Tilt・Table Tendency は Hand の開始時に Event Log から都度作る Projection で、保存されない（`memory/memory-summary.ts` の `buildOpponentMemoriesFromStore`・`opponents/tilt.ts` の `buildTiltsFromStore`。Hand Orchestrator の `opponentMemories` / `opponentTilts`）。Hero の API には出ない（D105・D107）ので、E2E から値を見る経路は「同じ正本から同じ関数で作り直す」しかない。
- `SqliteEventStore` のコンストラクタは文を準備するだけで書き込まない。`node:sqlite` の `readOnly` で開いた DB にも使える（`SqliteOpponentMemoryResetStore` も同じ）。
- Playwright のテストプロセスから `apps/server/src` を import すると、Engine（`@proj-poker/engine`）が `exports` の既定の `dist` に解決されて落ちる。`NODE_OPTIONS=--conditions=@proj-poker/source` を付けると `src` から読める（Playwright の Loader が TS を変換する）。テストファイルの読み込みは Runner のプロセスでも行うので、Config の中で `process.env` を変えるのでは間に合わず、`pnpm e2e` のスクリプトで付けた。
- Session の終わり方: 既定の 6 人卓で Hero が毎 Hand All-in すると、CPU が降りて Hero の Stack が増え、40 Hand でも終わらなかった。Hero が Call / Check だけで打つと数 Hand で Bust する（既存の E2E の宣言 Button の操作と同じ）。
- 編成（Fixed / Guest）は Session の最初の Hand の seed で決まり、Hand の seed は `POKER_SEED` から 1 ずつ進むので、Session 1 の長さ（Hero の操作と RuleBot の決定論）で Session 2 の編成が決まる。本番と同じ Hand Orchestrator・RuleBot・`fixedSeedSequence` を使った手元の模擬（コミットしない）で seed を 75 個調べ、次を満たす `20261042` を選んだ: Session 1 は 4 Hand で Bust、両方の Session に別の Guest、Session 2 で初めて座る Fixed CPU（goro）、Session 1 の終わりに Tilt 1 で Session 2 にも座る Fixed CPU（dan）。実際の E2E の値（Session 1 の参加者 ben・dan・emi・fumi・Guest、Session 2 は ben・dan・emi・Guest・goro）も模擬と一致した。

## 設計方針

- **確かめ方**: `e2e/support/opponent-memory.ts` が一時 DB を `readOnly` で開き、`SqliteEventStore`・`SqliteOpponentMemoryResetStore` と、Hand Orchestrator と同じ入力の組み立て（席・Observer・Persona の Skill・Reset の区切り）で `buildOpponentMemoriesFromStore` / `buildTiltsFromStore` を呼ぶ。「Hand H の開始時」の値は、H より論理順序（`ord`）が小さい保存済みの Hand だけを見せる Store で作る（1 卓を順に進める E2E では、H の途中で別の Hand が保存されないので、server が H の開始時に読んだ入力と同じ）。
- **期待値は独立に数える**: Memory の「見た Hand の数（`handsObserved`）」を、保存済みの Hand の `HAND_STARTED` の席と `session_participants` から数えた「Observer と Subject が同じ卓にいた Hand の数」と比べる（Subject が Hero なら Observer が座っていた Hand の数）。別の CPU の観察が混ざれば数が合わなくなる。Evidence ID の Hand は Observer が座っていた Hand に限る。
- **空振りさせない**: 編成の前提（両方の Session に Guest・両方に座る Fixed CPU が 2 人以上・Session 2 で初めて座る Fixed CPU・Session 1 の終わりの Tilt が 1 以上で Session 2 にも座る Fixed CPU）を先に expect で確かめる。Reset の検査は「区切りを当てない計算では前の Hand から作られる」ことも並べて確かめる。
- **Reset の後の作り直し**: Reset の後の最初の Hand は全員の Memory が空、その次の Hand は Reset より後に保存した Hand（1 Hand）だけから作る。Evidence ID は新しい 3 件だけなので、区切りの検査には使わず「見た Hand の数」で見る。
- **Hero に出ないこと**: Play の間に画面が受け取った応答（Hand の開始・操作・Note / Tag の JSON と、進行中の SSE の各 Event。SSE はページの `EventSource` を包んで data を残す）と、終わった後の Replay の一覧・各 Hand の Replay・終わった Hand の SSE（Session の状態と Hero の View を 1 回ずつ送って閉じる）・各席の Note / Tag の応答と、画面の文字に、Memory・Tilt・Table Tendency の項目名、Pool の `cpuProfileId`・名前・Guest の id、`phase7_` の Policy の版、既存の `forbiddenKeys`（Deck・seed・system の Event・Persona の語）が無いこと。Reset の応答は 4 つの項目（`cpuProfileId` は `all` なので null）だけ。
- **Hand の特定**: 開始の応答（`POST /api/hands`）の handId を使い、「次の Hand へ」「新しい Session を始める」の後は画面が新しい Hand に切り替わるまで待つ（`e2e/support/next-hand.ts` に Button の名前の引数を足した。#133 の待ち方のまま）。
- **画面の高さ**: 既定の 1280×720 では、Session の終わりの卓の中央の「新しい Session を始める」が Hero の席の枠に覆われて押せず、click が 5 分待って時間切れになった（「次の Hand へ」は Button が 1 つなので重ならない）。プロダクトの不具合なので #158 にして #106 に紐付け、この PR では直さず、この E2E だけ 1280×900 で動かす。

## 変更ファイル

- `e2e/tests/opponent-memory.spec.ts`（新規）: Phase 7 の Critical E2E
- `e2e/support/opponent-memory.ts`（新規）: 一時 DB を読み取り専用で開き、Memory・Tilt を server の関数で作り直す
- `e2e/support/next-hand.ts`: 押す Button の名前を引数にした（既定は「次の Hand へ」で既存の呼び出しは変わらない）
- `e2e/package.json`: `e2e` スクリプトに `NODE_OPTIONS=--conditions=@proj-poker/source`、説明
- `e2e/tsconfig.json`: `customConditions`（`apps/server`・Engine を `src` から型検査する）
- `docs/09_TEST_STRATEGY.md`: §8 に Phase 7 の Critical E2E、§11 に Phase 7 → 8 の Gate の項目とテストの対応
- `docs/08_MVP_AND_ROADMAP.md`: §3.2 の Phase 7 → 8 に、テストの対応の参照（進捗の記号は書かない）
- `docs/03_SYSTEM_ARCHITECTURE.md`: §1 のディレクトリ構成の `e2e/` の説明と、E2E が `apps/server` の関数を読むこと
- `README.md`: 現在のフェーズを Phase 7 の到達点へ（`release-readme-sync`）。E2E の実行・制約（OI-005・OI-011・#150・#153・#155・#157・#158）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（engine 32 files / 363 tests、web 9 / 141、server 57 / 726。e2e の `tsc --noEmit` も通過）
- `pnpm e2e`（全 6 件）: 通過（41.7 秒）
- 安定性 `pnpm e2e --repeat-each=10`（全 6 件 × 10 = 60 件）を 3 回: 1 回目 60 passed / 0 failed（6.8 分）、2 回目 60 passed / 0 failed（6.8 分）、3 回目 60 passed / 0 failed（6.9 分）。一度だけ落ちる失敗は出なかった。Codex の指摘の対応（進行中の応答の検査、df43104）の後にも 3 回流し、1 回目 60 passed / 0 failed（7.0 分）、2 回目 60 / 0（6.8 分）、3 回目 60 / 0（6.8 分）
- 変異の確認（手元で入れて戻した）: 支援モジュールで Reset の区切りを当てないようにすると、(6) の「Reset の後の最初の Hand の Memory は空」が `Expected: 0 / Received: 6` で落ちる
- 値の確認（手元で一時的に出力して戻した）: Session 2 の最初の Hand の開始時、ben・dan・emi は Hero と互いを 4 Hand 見ていて、goro（初めて座る）と Guest からは全員 0、Session 2 の Guest の Memory は空。Session 1 の終わりの Tilt は dan・fumi が 1、Session 2 の最初の Hand の開始時は全員 0。Reset の後の最初の Hand は区切りを当てなければ Hero を 6 Hand（Fixed）・2 Hand（goro・Guest）見ている

## レビュー対応

- Codex 1 巡目 [P1]「進行中の API 応答も Hidden 情報漏洩検査に含める」: CONFIRMED。終わった後の View だけでは、進行中の応答にだけ混ざる漏れを見逃す。Play の間に画面が受け取った JSON の応答と、進行中の SSE の各 Event（ページの `EventSource` を包んで data を残す）を検査に足した。変異の確認（検査の語に `"legalActions"` を一時的に足す）で `POST /api/hands` の応答で落ちることを確かめ、戻した
- Codex 1 巡目 [P1]「実行中の Memory 注入を E2E で検証する」: DESIGN_DISAGREEMENT。親の指示（確認用の API・本番の仕組みを足さず、一時 DB を読み取り専用で開いて Projection の関数で確かめる）どおりの方式で、CPU に実際に渡った値を E2E から捕まえるには server に観測用の仕組み（Test Double の CPU 等）を足す必要がある。CPU に渡った層の値と Projection の値の一致は、本番の Hand Orchestrator を使う `memory-eval.test.ts`（「層の値は本番の Orchestrator が CPU に渡した値と同じ」「(2) Fixed Pool の継続性」）と `memory-reset.test.ts`（「Reset の後の Hand は、その時点の区切りより後に保存された Hand だけで Memory を作る」）が CI で確かめている。docs/09 §8 にこの分担を書いた

## 残課題

- **#158**: 1280×720 で Session の終わりの「新しい Session を始める」が Hero の席に覆われる（この PR では直さない。直したら、この E2E の画面の高さの指定を外す）
- 既存の残課題（この PR の範囲外。README の制約に記載）: #150（Memory の都度計算の Cache）・#153（Table Tendency を Hero の Review に入れるか）・#155（Memory 付き Prompt の Claude の CPU の Eval の録画）・#157（テスト用の組み立てでの Learning Reset Store の順序の源）
- Fixed CPU の名前・`cpuProfileId` を Hero に見せないので、1 つの Fixed CPU を対象にする Opponent Memory Reset は E2E では確かめていない（全 CPU だけ。1 つの Fixed CPU は `memory-reset.test.ts`・`routes/opponents.test.ts` で確かめている）
