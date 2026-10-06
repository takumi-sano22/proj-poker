# Issue #80: Local Knowledge Base（Curated KB）を作る

## 概要

Phase 5 の子 Issue。Review の根拠にする Local KB を `apps/server/kb/` に置き、Metadata と全文で検索する関数を `apps/server/src/kb/` に足した（D98。Vector DB は使わない）。Event・スキーマ・DB・依存は変えていない。

## 初期調査

- 前提（main 8d1b5d5）: #79 の Engine に Range・Equity・Pot Odds・Alternative Action の比較がある。KB は数値の根拠を置き換えず、概念・Practical な指針だけを持つ。
- 根拠: `docs/research/06_knowledge_base_design.md`（Directory 案・Metadata 例・Retrieval の開始案〔Metadata Filtering → Topic / Keyword → Full-text〕）、`02_strategy_and_math.md`、`03_review_and_learning.md`、`05_solver_and_analysis.md`、`SOURCES.md`（Source 利用ポリシー: Source Scope を保持し、General Heuristic を無条件の Product Rule にしない）、`README.md` §2（Knowledge Label の 7 種）。
- 参照: docs/03 §9（Research Pack をそのまま LLM に入れない）、docs/05 §6（Knowledge Evidence）、D23・D24・D58・D98。
- `apps/server` に YAML 等のパーサ依存は無い。依存を足さず、front matter は `key: value` / `[a, b]` / `- item` だけの小さなパーサにした。

## 設計方針

- **項目 = 1 ファイル**（`apps/server/kb/<id>.md`）。先頭の front matter に `id`（ファイル名と同じ）・`title`・`topic`・`label`・`formats`・`streets`・`positions`・`players`・`spots`・`actions`・`keywords`・`source`・`date`・`version` を持つ。絞り込みの項目は空なら「条件なし」。research 06 §2 の Metadata 例を、Issue が求める topic・street・position・source・date・version に Spot の種類・Action 列・Player 数を足した形にした。
- **語彙は閉じる**: Topic（22 種）・Label（research README の 7 種）・Street・Position・Player 数（`heads_up` / `multiway`）・Spot の種類（5 種）・Action 列（Engine の `PreflopSpot`）。未知の値・未知の項目名・必須項目の欠けは読み込みで弾く（綴りの揺れで検索から漏れるのを防ぐ）。Position・Action 列は Engine の型（`PositionName` / `PreflopSpot`）を使い、食い違えば typecheck で落ちる。全部の値を並べた条件（書かないのと同じ）も弾く。
- **KB 全体の Version** は `manifest.json` の `version`（x.y.z）。`contentHash`（全項目の内容の sha256。改行コードの違いは無視）を一緒に持ち、内容を変えて更新を忘れるとテストが落ちる。実行時には検証しない（開発中の編集で起動できなくなるのを避け、CI で止める）。項目の `version` は項目ごと。
- **出典**は `docs/research/<file>.md §<節> | <元の出典>`。テストで、研究資料に実在する節（`## N. `）と、`SOURCES.md` の `###` 見出しにある元の出典を確かめる。研究資料の丸写しをしないよう、1 項目の本文は 1600 字未満に制限した（研究資料 1 ファイルは約 4000 字）。
- **検索**（`search.ts`）は純粋関数で、I/O は `loadKb` の起動時の読み込みだけ。①渡した Spot の特徴について、項目の条件（空でないリスト）に当たらなければ除外 ②Spot の種類 4・Action 列 3・Street / Position / Player 数 2 を加点（条件が 1 つの値だけの項目は +1）③Topic を渡したらその Topic だけに絞って +5 ④全文の語を title・keywords（3 点）→ 本文（1 点）で加点。点の高い順・同点は id の昇順。1 点も取らない項目と、何も渡さない検索は空を返す。全文は日本語を分かち書きしないので、語は部分一致で見る。
- **Evidence に残す形**: hit は `kbVersion`・`id`・`version`・`evidenceId`（`kb:<kbVersion>:<id>@<version>`）・`topic`・`label`・`source`・`score`・`matched`・本文を持つ。Review の Evidence ID（#82）はこれから作る。
- KB に置く内容は、research にある事実と、Review で使う指針に絞った。Preflop Chart の % や Hand の列挙は置かない（research 02 §8 が RULE ではないと明記）。HEURISTIC / EXPLOIT の項目は「断定しない」ことを本文に書いた。

## 変更内容

- `apps/server/kb/`（新規）: 22 項目の Curated KB と `manifest.json`（version 1.0.0）。
  - Topic（22）: `pot_odds`・`outs_equity`・`equity`・`expected_value`・`implied_odds`・`spr`・`position`・`preflop_open`・`preflop_3bet`・`blind_defense`・`rake`・`range_thinking`・`range_advantage`・`cbet`・`value_betting`・`bluffing`・`bet_sizing`・`river_decision`・`multiway`・`exploit`・`solver_usage`・`review_principle`（各 1 項目）。
- `apps/server/src/kb/types.ts`: 語彙・型・`kbEvidenceId`。
- `apps/server/src/kb/load.ts`: `parseKbEntry`（検証）・`parseKbManifest`・`hashKbFiles`・`buildKb`・`loadKb`・`readKbFiles`。
- `apps/server/src/kb/search.ts`: `searchKb`・`getKbEntry`・`tokenize`・`KB_SCORE`。
- `apps/server/src/kb/index.ts`: 入口。
- テスト（新規）: `load.test.ts`（Metadata の検証・manifest・ハッシュ・実物の KB の検証）、`search.test.ts`（手計算の加点・決定性・並び順・limit・Evidence の形・実物の KB の代表 Spot）。
- docs: `docs/03` §9（KB の実装）・`docs/05` §6（Knowledge Evidence）・`docs/09` §6（KB のテスト）。

## 判断理由

- Vector DB・Embedding を使わないのは D98 と research 06 §4（KB が大きくなってから検討）による。22 項目なら Metadata の絞り込みと部分一致で足りる。
- Topic を閉じた語彙にしたのは、Review が Topic を直接指定するときの取りこぼし（綴りの揺れ）を、実行時ではなく読み込み・CI で止めるため。
- 加点は暫定値。Review AI（#82）で実際に使い、代表 Spot の出方（`search.test.ts` の実物の KB のテスト）を見て変える。
- Position・Player 数を絞り込みに入れたのは、research 02 §14（player_count を First-class Parameter にする）と §8（Position）による。Multiway の項目は Heads-Up の Spot では出ない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過。
- `pnpm test`: server 239 件（うち KB 44 件）を含めて通過。
- `pnpm build` 後の `dist/kb/load.js` から `loadKb()` が 22 項目を読めること（既定のディレクトリが src からも dist からも同じ相対位置にある）を確かめた。

## 残課題

- 加点の重みと項目の中身は暫定。Review の品質評価（`llm-quality-improvement`・docs/09 §6 の KB / Source Grounding）と運用で見直す。
- 検索結果を Review の Evidence に組み込むのは #82（HeroInformationSet から `KbSpot` への変換もそちら）。
- Tournament / ICM の項目は Phase 5 の範囲外なので置いていない。
- Web Fallback の判定（KB の Coverage 不足）は、この検索の結果が空・低得点であることを材料にできるが、判定そのものは別の Issue。
