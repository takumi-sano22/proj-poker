---
id: decision_quality_vs_result
title: 判断の質は結果では測れない（Review の原則）
topic: review_principle
label: FACT
formats: [cash, tournament]
keywords: [review, レビュー, 結果論, variance, 分散, decision quality, 判断の質, assessment, confidence, insufficient evidence]
source:
  - docs/research/03_review_and_learning.md §1
  - docs/research/03_review_and_learning.md §2
  - docs/research/03_review_and_learning.md §5
date: 2026-10-06
version: 1
---

# 判断の質と結果

Review の目的は結果を当てることではなく、**限られた情報から再現可能な判断プロセスを身につける**こと。短期の収支は Variance が大きいので、勝った Hand かどうかだけでは Decision Quality を測れない。

## Review の書き方

- Pass A（Decision Review）は、判断時点で使えた情報だけを使う。Fold 済みの CPU の Hole Cards・これから出る Board・CPU の Secret Persona・他の CPU だけが知る情報は使わない。
- Actual Hand の答え合わせは Pass B（Reveal Review）で別に行い、Pass A の評価を実際の札で自動的に変えない。
- 評価は段階（Strong / Reasonable / Mixed・Marginal / Improvement Suggested / Major Leak / Insufficient Evidence）で示し、Confidence・Assumption・「何が変わると結論も変わるか」を併記する。1 つの Action に細かい点数を付けない。
- Evidence が足りないときは、Insufficient Evidence とする。
