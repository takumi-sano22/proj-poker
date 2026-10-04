---
name: llm-quality-improvement
description: "proj-poker の AI Opponent Eval と Review Eval（docs/09_TEST_STRATEGY.md §5・§6）など、LLM 出力の品質を測定駆動で改善するための全体プロセス skill。評価ハーネス・LLM-as-a-Judge の設計、ベースライン測定、プロンプト改善ループ、SFT（ファインチューニング・教師データ作成・tuned モデル評価）、効果の分離検証、品質スナップショットまでを一貫して扱う。ユーザーが品質改善、精度改善、評価、eval、評価ハーネス、Judge、KPI、ベースライン、プロンプト改善、A/B 比較、ファインチューニング、SFT、教師データ、tuned モデル、品質測定、quality improvement、fine-tuning に言及したら必ず使用する。「応答の品質を上げたい」「効果を測りたい」「評価の仕組みを作って」「SFT やりたい」「モデルの出力を改善して」といったリクエストでもトリガーする。"
---

# LLM 出力品質の測定駆動改善

LLM 機能の品質を「感覚」ではなく「測定」で改善するためのプロセスと原則。プロンプト改善だけの場面でも同じ骨格で回す。

## proj-poker での適用対象

プロバイダは Claude API（Opponent = Haiku 級 / Review = 上位モデル。具体的な Model 名は role-based config で、未確定は OI-001。モデル ID をコードへ直書きしない）。評価対象は 2 つ（一次情報は `docs/09_TEST_STRATEGY.md` §5・§6、設計は `docs/05_AI_OPPONENTS_AND_REVIEW.md`）。Poker Engine の正しさはこの skill の対象外（決定論テストで担保。`poker-engine-testing`）。

| 評価 | 測定する指標（決定論で測れるものは決定論で） | 判定の軸（Judge を使う場合） |
|---|---|---|
| **AI Opponent Eval** | Structured Output Valid 率・Illegal Action 率（合法候補外の選択）・Retry 率・Latency・Hidden Information Leakage（他者 Hole Cards 等の言及/利用） | Persona Differentiation・Action Diversity・Strategic Incoherence の有無 |
| **Review Eval** | Pass A の Hindsight Leak 件数・Math の正しさ（Pot Odds / Equity 等を再計算で照合）・Solver Capability Gate の動作・Source Grounding（KB 引用の実在）・Hidden CPU Setting を Evidence に使っていないか | Uncertainty の表現・Assumption 変更で Recommendation が適切に変わるか |

代表 Spot / Human-reviewed Hand を固定 Regression Case として持つ。Eval の実装場所・コマンドは未確定。Phase 0 には LLM 呼び出しが無いため決めていない。LLM を呼ぶのは `apps/server`（D67）なので、最初の Eval を作る Issue（AI Opponent を入れる Phase 3 の見込み）で置き場と実行コマンドを決め、ここへ追記する。

## 全体プロセス

```
0. 品質の定義   … 実出力への人間コメントから「原理」を言語化する
1. 評価基盤     … Judge の軸 + 決定論指標 + ハーネスを作る → references/harness-implementation.md
2. ベースライン … 現状を測って固定する（改善前の数値が無いと効果を語れない）
3. 改善ループ   … 1 回 1 変更で測る → references/measurement-ops.md
4. SFT          … 【現時点で採用予定なし・参考】プロンプトで頭打ち・コストを推論から学習へ寄せたい時 → references/sft-workflow.md
5. 検証         … 効果の分離・副作用の監視・現状スナップショット
6. 記録         … 数値・比較可否・未測定項目を文書に固定する
```

どのフェーズにいるかを最初に判断し、該当する reference を読むこと。
今取り組むのが「測り方の設計」なら harness、「測る運用」なら measurement-ops、
「学習」なら sft-workflow（proj-poker は現時点で SFT 採用予定なし。参考資料）。

## 鉄則（全フェーズ共通）

### 1. 比較可能性は「3 点一致」でのみ成立する

**Judge（criteria バージョン + 採点モデル）・母集団・理想参照の 3 点が一致する数値だけを
同じ表に並べる。** 1 点でも違えば別表にし、「並べてはいけない」と明記する。
Judge の軸を統廃合したら旧スコアとは比較不能になる（軸の意味が変わるため）。
これを崩すと「改善した/劣化した」の結論自体が無効になる。

### 2. criteria は測定前に固定する

合格ライン・比較対象・測定手順をファイルに書いてコミットしてから測る。
測った後に基準を動かすと、無意識に「通る基準」を選んでしまう。
改善ラインは run 間のばらつきを先に測り、その**約 3 倍**に置く（ばらつき ±0.1〜0.15 なら +0.4）。
ばらつき以下の差を「改善」と呼ばない。

### 3. 1 回に 1 つだけ変える

複数の変更を混ぜた測定は、効いた要因を特定できず、悪化した時に戻せない。
「A を変えたら B が落ちた」も因果と決めつけず、旧版を展開して文字列 diff で確認する
（意図の記憶ではなくコードとプロンプトの実体で比較する）。測定中はプロンプトに触らない
（Judge は起動時に読むため、途中で変えると採点基準が run 内で割れる）。

### 4. 効果の確定は独立証拠 2〜3 本で

Judge スコアだけで「効いた/効かない」を確定しない。LLM Judge・決定論指標（Illegal Action 件数・
Hindsight Leak 件数・Math 照合）・目視サンプルの独立した証拠が一致してから結論する。
（SFT を行う場合）学習の loss は代理指標であり、**下流の品質評価が直接指標**（loss 最適の checkpoint より
下流評価が良い checkpoint を採ってよい）。

### 5. 平均で潰れる致命傷は「件数」で拾う

軸の平均が全部上がっていても、Illegal Action 1 件・Hindsight Leak 1 件・他者 Hole Cards の漏洩 1 件のような「たまに起きる致命傷」は
平均に埋もれる。失敗フラグ（Illegal Action・Hindsight Leak・Hidden Information Leakage・Source Grounding 欠落・Math 誤りなど）を件数でカウントし、
軸スコアと並記する。これらは 1 件でも出たらゲート不合格として扱う。

### 6. 副作用は「狙っていない軸」の決定論監視で見つける

改善はトレードオフを生む。狙った軸の上昇だけ見ていると、Persona 間の行動差の消滅（全 CPU が同じ Action 分布になる）・
Retry 率や Latency の悪化・Structured Output の欠落のような副作用を見逃す。機械で数えられる
指標（Action 分布・Persona 別の Raised/Fold 率・Retry 率・Latency・字数）を毎回機械集計し、
ベースラインの水準と比べる。

### 7. 条件付きの指示はプロンプトでなく構造で守らせる

「〜のときに限り」という条件付き指示はモデルに守られない。**合法性や情報境界はプロンプトでなく構造で守る**:
合法候補は決定論的コードが列挙して LLM には選択だけをさせ（D40）、CPU ごとの `KnowledgeState` に無い情報は
そもそも入力へ入れない（D28）。モードや Solver 可否による出し分けもサーバー側の boolean でプロンプトの文ごと切り替える（構造ゲート）。

### 8. 数値は機械生成か機械照合のみ（記憶で表を書かない）

文書の数表は集計スクリプトで生成するか、書いた後に一次データ（summary.json 等）と
突合スクリプトで照合する。subagent の報告値も実ファイルで裏取りする。
二次記録（手書きの履歴表）と raw が食い違ったら **raw を正**とし、食い違い自体を記録する。

### 9. 評価ハーネスは本番の呼び出し経路を複製する

モデル解決（role-based config）・生成設定・Structured Output 検証・後処理のどれか 1 つでも本番と違うと、
測っているものが本番品質ではなくなる。詳細は references/harness-implementation.md。

### 10. 不利な結果を隠さない

ゲート不合格・フラグ増加・統計として成立しない n の小ささは、そのまま ✅/❌ や
「暫定」の注記つきで記録する。判断はデータを見た人間がする（skill の役割は
判断材料を正確に揃えることまで）。

## reference の使い分け

| reference | いつ読むか |
| --- | --- |
| `references/harness-implementation.md` | 評価ハーネス・Judge 採点バッチを新規実装/改修するとき |
| `references/measurement-ops.md` | Judge の軸を設計・改訂するとき／測定を計画・実行するとき／スナップショット文書を書くとき |
| `references/sft-workflow.md` | （現時点で採用予定なし・参考）SFT を検討・実行・評価するとき（教師データ作成を含む） |
