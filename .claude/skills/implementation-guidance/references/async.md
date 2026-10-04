# async — CPU 思考待ち・Solver Subprocess・Review 非同期生成を書く前の判定基準

**本書が一次情報である範囲**: 実装時の確認動作。**一次情報が別にある範囲**: Hand Orchestration・Review Orchestration・Solver Adapter は `docs/03_SYSTEM_ARCHITECTURE.md` §4 / §7 / §8、Solver の Timeout / Cancellation のテスト要件は `docs/09_TEST_STRATEGY.md` §7、評価ハーネスは `llm-quality-improvement` skill。実行は Local Runtime 内で完結する（クラウドのキュー・スケジューラは使わない）。

## 書く前に決めること

> **レビュー時にも当たる欠陥クラスは台帳が一次情報**（LC-001 失敗経路の握りつぶし・空出力の上書き / LC-030 重複実行と冪等性 / LC-031 集約の上書き・削除の二重ガード / LC-032 完了判定は一次情報で）。書く前に一読し、ここには繰り返さない。

1. **CPU 思考待ちには Timeout を置き、Timeout 後も Game State を壊さない**: 遅れて届いた LLM 応答が、すでに進んだ Hand に適用されないよう requestId / Hand・Action の識別子で捨てる。Timeout・不正出力の扱いは docs/03 §5・§6（Retry → Deterministic Fallback。Emergency Bot へ自動切替しない）に従う。
2. **Solver Subprocess は Timeout と Cancellation を実装し、孤児プロセスを残さない**: Hand 終了・Session 終了・アプリ終了で kill できること。異常終了・Parse Failure・Invalid Input は Unsupported とは別に扱う（docs/09 §7）。
3. **Review の非同期生成は Hand 進行を止めない**: 生成の入力は判断時点の Information Set（Hindsight Leak 防止）。生成の失敗・再実行で Event Log を書き換えず、Review Record は再生成できる形にする。
4. **非同期処理は小さな単位に分けて再送を効かせる**: 1 単位 = 1 Review / 1 Solve にして、失敗した単位だけ再実行する。
5. **長時間ポーリングは Monitor ツールで**（bash のバックグラウンドループは OOM で落ちる実績あり）。

## 確認動作（実装後・自己レビュー前）

- 同じ Review / Solve を 2 回連続で起動して副作用が 1 回分であることを手元で確認
- Solver を意図的に Timeout・Cancel させ、プロセスが残らず Fallback に入ることを確認
- 遅延応答（Timeout 後に届く LLM 応答）を再現して、State に反映されないことを確認
