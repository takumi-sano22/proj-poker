# Issue #83: Reveal Review（Pass B）と Follow-up Q&A を作る

## 概要

Phase 5 の子 Issue。Hand の後に Learning-only Full Reveal（全員の札）を使って、Hero の判断の答え合わせ（Pass B）をする。中身は、読み（判断時点に仮定した Range）と実際の札の比較・実際の Equity・Bluff / Value の答え合わせ。Pass A の Review は書き換えない。あわせて、Pass と Version で指定した Review に Hero が続けて質問できる Follow-up Q&A を作り、履歴を Review の Version に紐づけて保存する。保存先は人間判断（2026-10-06・AskUserQuestion。推奨の B 案）に従い、マイグレーション v4 で追記だけの `reveal_reviews` と `review_followups` を足した（既存のテーブルと行は変えない）。

## 初期調査

- 前提（main 763d219）は次のとおり。
  - #82 の Review AI（Pass A）・Evidence・Gate・`reviews` テーブル（v3）・`runStructuredQuery`（D87）・Review の API。
  - #78 の `projectLearningReveal`。Hand が終わった後だけ全員の札を返し、`visibility: "learning_only"` の印を付ける。
- `reviews.pass` には CHECK `pass IN ('decision')` が付いていて、`assessment` は NOT NULL で、CHECK により Pass A の 6 段階しか入らない。SQLite は CHECK を ALTER できないので、`reviews` に Pass B を入れるには既存テーブルを作り直す必要があった。そこで一度 NEEDS_HUMAN で止め、新テーブルの案（B）が採られた。
- 根拠: docs/05 §7・§12、docs/03 §7、docs/04 §4・§8、docs/09 INV-TEST-008、D33・D39・D76・D87・D93・D95・D97。ガイダンスは llm / ai-boundary / db、台帳は LC-001・LC-022・LC-030・LC-050。

## 設計方針

- **Pass B の Evidence**（`review/reveal-evidence.ts`）
  - 入力は判断時点の Hero Information Set と `LearningReveal` で、Pass A の Evidence 関数は Reveal を受け取らない。Decision Context は Pass A と同じ関数（`decisionContext`）で作る。
  - 判断時点で Fold していなかった相手は、Pass A と同じ標準の Range（`villainRange`）に実際の Combo が入っていたかを見る。
  - 実際の Equity は、判断時点の Board から、Pot を争っていた相手の実際の札（1 Combo ずつの Range）に対する `equityVsRanges` で出す。
  - Bluff / Value は、判断時点までの Bet / Raise と、Hero の判断が Bet / Raise ならその判断を対象にする。本人の実際の札の、その時点の残りの相手の実際の札に対する Equity が、公平な取り分（1 / 人数）以上なら value とする（暫定の基準。基準の文を Evidence に入れる）。
  - 全部決定論で、LLM に計算させない。
- **Pass B の生成**（`reveal-ai.ts`・`generate-reveal.ts`）
  - 評価（Assessment）は出させない。出力は `readComparison` / `actualEquity` / `bluffValue` / `takeaways` / `evidenceIds` で、`evidenceIds` は Schema の enum で Evidence の id に絞る。
  - 検証 → 1 回だけ再要求 → Fallback の流れは Pass A と同じ。
  - Prompt で次の 2 つを明示する。判断の評価は Pass A で済んでいて、結果で付け直さないこと。1 Hand で Range の想定を断定しないこと。
- **Follow-up**（`followup.ts`）
  - Prompt に入れるのは、対象の Review の Evidence と説明、同じ Version の履歴（古い順）、今回の質問だけ。Pass A への質問に Hand 後の情報が入る経路は無い。
  - 範囲の指示は Pass ごとに文で出し分ける（条件文にしない。llm ガイダンス 4）。
  - 複数ターンは、履歴を Prompt に入れる単発の問い合わせにした（D87。SDK のセッションは残さない）。
  - `scope` は `answered` / `out_of_scope`。`answered` には根拠の id が要る。2 回続けて不正なら `unanswered` で失敗を残す。
  - 質問は 500 字まで、1 Version につき 20 ターンまで（暫定値）。
- **保存**（`reveal-store.ts`・マイグレーション v4）
  - `reveal_reviews`: Version 付き・assessment 列なし・UPDATE は Trigger で拒否。
  - `review_followups`: `(review_id, turn)` が一意・UPDATE は Trigger で拒否。指す Review は pass に応じて別のテーブルなので、外部キーの代わりに挿入の Trigger で、実在と Hand・判断・Version の一致を確かめる。
  - 採番と追記は `BEGIN IMMEDIATE` の 1 トランザクションで行う（LC-022）。
- **非同期**（`review-service.ts`）
  - Pass A・Pass B・Follow-up を同じ待ち行列で 1 つずつ進める（Claude の子プロセスを同時に複数動かさない）。同じ対象の生成中は新しく始めない（LC-030）。
  - Follow-up は、前の質問の答えを作っている間の質問を 409 で返す（質問を黙って捨てない）。
  - 生成の共通部分（上限の時間・終了・失敗の種類）は `schedule` / `execute` にまとめた。
- **API**（`routes/reviews.ts`）
  - `/decisions/:i/reveal`（GET / POST）。
  - `/decisions/:i/passes/:pass/versions/:v/followups`（GET / POST。body は `{ question, depth? }`）。
  - `review_deep` は `depth: "deep"` のときだけ（D97）。

## 変更内容

- `apps/server/src/review/`（新規）:
  - `reveal-types.ts`・`reveal-evidence.ts`・`reveal-ai.ts`・`generate-reveal.ts`・`followup.ts`・`reveal-store.ts`
  - テスト `reveal.test.ts`・`reveal-store.test.ts`・`learning-reveal-isolation.test.ts`（INV-TEST-008 の Runtime 側）
- `review/review-service.ts`: Pass B・Follow-up の入口と、共通の `schedule` / `execute`。
- `review/types.ts`（`ReviewPass` を `decision | reveal` に広げた）、`evidence.ts`（`decisionContext`・`yieldToEventLoop` を公開）、`review-ai.ts`（補助関数を公開）、`review-store.ts`（Pass の型を Pass A に絞る）。
- `routes/reviews.ts` とテスト、`app.ts`・`index.ts`（SQLite の新しい Store を配線）。
- `db/database.ts`: マイグレーション v4。`database.test.ts` に v3 → v4 で `reviews` の行と定義が変わらないことと、追記だけ・Trigger のテストを足した。
- `testing/reveal-smoke.ts`（新規）と `package.json` の `smoke:reveal`（手動スモーク。CI では動かさない）。
- docs: `docs/03` §7、`docs/04` §8、`docs/05` §7（Pass B の実装・Follow-up Q&A）、`docs/09` INV-TEST-008。

## 判断理由

- Pass B に評価を付けないのは、結果（実際の札・勝ち負け）で判断の評価を付け直すと Hindsight が混ざるため（docs/05 §7・不変条件 3）。人間判断（2026-10-06・AskUserQuestion。D99 として記録する文言は親が保持）の決定どおり。
- Follow-up の多ターンを SDK のセッションで続けない理由は、D87 の単発の呼び出し（`persistSession: false`・ツールなし・設定を読まない）を崩したくないから。履歴は DB に正本として残るので、Prompt に入れる形で足りる。
- Bluff / Value の基準を「公平な取り分」にした理由は、Multiway でも同じ式で決められ、決定論で再現できるから。Semi-Bluff を分けないことは基準の文に書いた。暫定値で、運用を見て変える。
- `review_followups` に外部キーを張らず Trigger で確かめるのは、1 列が 2 つのテーブルのどちらかを指すため。外部キーは 1 つのテーブルしか指せない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 328・web 109・server 399 件が通った）/ `pnpm format:check`。すべてルートで実行して通った。
- 手動スモーク `pnpm --filter @proj-poker/server smoke:reveal`（2026-10-06・Agent SDK・OAuth・`claude-sonnet-5-5`・BTN_VS_UTG の River の Call）: 5 回呼び、全部 1 回目で検証を通った（Retry・Fallback なし）。Latency は子プロセスの起動を含む。
  - Pass A: 15.2 秒
  - Pass B: 13.2 秒。読みの比較で、KQs は Open Range には入るが、Flop・River の Bet 後に絞った 34 Combo の外（`inAssumedRange: false`）と説明した。実際の Equity 0 と仮定した Range の約 38.2% の違いを書き、「この 0 は Call の判断が悪かったことを示さない」と結果と判断を分けた。Flop の Bet は bluff、River は value。
  - Follow-up（Pass A）「相手の実際の札は？結果的に正しかった？」: 5.6 秒。`out_of_scope` で、実際の札は知らない・Reveal Review で確かめられると答えた（Hand 後の情報は出なかった）。
  - Follow-up（Pass B）1「River の Bet は Value？」: 5.0 秒。`answered`。value と基準を説明した。
  - Follow-up（Pass B）2「次は Fold すべき？」: 6.1 秒。`answered`。1 回目の答えを踏まえ、1 Hand の結果で Fold とは言えないと答えた（履歴の文脈が効いている）。
- 新しいテーブル: `reveal_reviews`・`review_followups`（追記だけ）。`reviews` の行と列が v4 で変わらないことをテストで確かめた。
- Codex の再実行で [P1]（追記専用の Trigger が UPDATE だけで、DELETE で履歴を消せる）が出た。親の判定は CONFIRMED で、same-root として events（v1）・reviews（v3）も同じだった。v4 に 4 テーブル（events・reviews・reveal_reviews・review_followups）の DELETE を拒否する Trigger を足し、4 テーブルとも DELETE が拒否されることのテストを足した。server のコードとテストに DELETE は無い。

## 残課題

- UI（Pass B の表示・Follow-up の入力）は #84。
- Pass B と Follow-up の Review Eval（録画の再生）は作っていない。CI は Fake で検証している。品質を測るときは Pass A の Review Eval と同じ形で足す。
- `docs/decision_log.yaml` への D99 の追記と、範囲表記（D01〜D99）の更新は、このセッションの権限で拒否された（自動判定）。そのため親（人間）側で行う必要がある。
