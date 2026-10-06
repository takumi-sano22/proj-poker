# AI CPUとReview設計

## 1. Opponent Agent Contract

Opponent AIは**戦略を決めますが、ルールを決めません**。

入力:

- 自分のHole Cards
- 公開済みBoard
- Pot / Stack
- Position
- Legal Actions
- Legal Amount Range
- 自分が観察可能な履歴
- Persona / State
- 必要な決定論的Math

渡してはいけないもの:

- 他PlayerのHidden Cards
- Future Deck
- Learning-only Reveal
- Hero Weakness Database
- 他CPUのPrivate Observation
- 他CPUのSecret Persona

出力:

- Action
- 必要ならAmount
- 任意のCompactなRationale / Debug Metadata

## 2. Persona Model

推奨Parameter:

- Skill
- Preflop Looseness
- Aggression
- Bluff Tendency
- Risk Tolerance
- Discipline
- Adaptability
- Trap Tendency
- Opponent Reading Quality
- Tilt Susceptibility
- Recovery Speed

すべてを一つの `difficulty` に縮約しないでください。

## 3. 弱いCPU

弱さは「人間にありがちな一貫したLeak」として作ります。

例:

- Call Rangeが広すぎる
- Cold Callしすぎる
- 3-bet不足
- Drawを追いすぎる
- RiverでOverfold
- RiverでOvercall
- Underbluff
- Overbluff
- Position軽視

弱くするために、Illegal / 意味不明なRandom Actionを混ぜないでください。

## 4. Tilt / 非合理行動

Transient Stateを持てます。

Trigger例:

- 大きいPotを失った
- 連続で負けた
- Bluff失敗
- 大勝ち後のOverconfidence

影響はPersona依存とします。

例:

```text
Tilt上昇
 ↓
参加Rangeが少し広がる
Aggression上昇
Discipline低下
```

このような条件成立時のみ、Strategically PoorなActionへ低確率を割り当てられます。

## 5. Opponent Modeling

各CPUは以下を分離して保持します。

1. Observation
2. Hypothesis
3. Confidence

SkillはOpponent Modelの質にも影響します。

強いCPU:
- Sample不足なら保留しやすい

弱いCPU:
- 少数Sampleから早合点する場合がある

CPU内部のSecret HypothesisをHeroへ「事実」として見せてはいけません。

## 6. Review Evidence Model

Review AIへ渡す前に、以下を構造化します。

- Decision Context
- Math Evidence
- Range Evidence
- Opponent Observation Evidence
- Solver Evidence
- Knowledge Evidence
- User Read / Intent

AI文章はこの後に生成します。

Math EvidenceとRange Evidenceは、Engineの`analyzeDecision`（`packages/engine/src/decision-analysis.ts`。#79）が判断時点のHero Information Setだけから決定論で作ります（LLMに計算させない）。

- Math: 判断時点のPot・Call額・Pot Odds（計算は`pot-math.ts`の`potOdds` 1か所。KnowledgeStateの`math`・webのDealer Feedbackも同じ関数）・有効Stack・SPR。
- Range: Fold していない相手ごとに、Position（Buttonからの距離）とPreflopのAction列（open / limp / call_open / three_bet / call_three_bet / four_bet_plus / check_option / not_acted）で標準Rangeを選び、Heroの札と判断時点のBoardを除き（Card Removal）、PostflopのBet / Raise / Callごとに、そのStreetのBoardでの役の強さの上位を残す簡易モデルで絞ります（Drawは数えない）。標準Rangeと絞る割合はConfig（`range-config.ts`の`RangeProfile`）の暫定値で、永久仕様にしません。結果には必ずAssumption（どのRangeを仮定し、どう絞ったか）を付けます。
- Equity: 仮定したRangeに対するShowdownまでの勝率（`equity.ts`）。相手1人のFlop・Turn・Riverは全列挙、PreflopとMultiwayはseed固定のMonte Carloで、同じ入力から同じ結果になります。
- Alternative Action: Legal ActionからFold / Check / Call / Bet（Potの半分・Pot）/ Raise（最小・Pot Size）/ All-inを候補にし、Heroが実際に選んだ額を足して、それぞれの必要Equity・簡易EV（Foldを0とした差。Check / Callはこの後のBetが無い前提、Bet / Raiseは相手全員がCallする前提でFold Equityを含めず、Break-even Fold Frequencyを別に示す）を出します。簡易EVはAssumption付きの目安で、GTO / Solverの値として表示しません（D20）。
- 重要Spotでは`compareRangeProfiles`で標準・狭い（Tight）・広い（Loose）のRange想定ごとにEquityを比べられます（D08）。

Knowledge Evidenceは、Local KB（`apps/server/kb/`。#80・D98・`docs/03` §9）の`searchKb`が、判断時点のSpotの特徴（Street・Position・Player数・Spotの種類・相手のPreflopのAction列）と全文の語から決定論で返します。各項目のID・Version・KB全体のVersionを`evidenceId`としてEvidenceに残します。KBは概念とPracticalな指針で、Math / Range Evidenceの数値を置き換えません（数値の根拠はEngine）。`label`がHEURISTIC / EXPLOITの項目は経験則として書き、断定しません。

## 7. Two-pass Review

### Pass A — Decision Review

判断時点で利用可能だった情報だけを使います。

入力の元は、Engineの`heroInformationSets`（#78）が作る判断時点のHero Information Setです（判断時点までにHeroに見えたEventとHeroのKnowledgeState。作り方は`docs/04` §1）。Reviewの対象にするImportant Spotも、判断時点の情報だけから決定論で選びます（`extractImportantSpots`）。

### Pass B — Reveal Review

Hand終了後にActual Hole Cardsを見せます。

用途:
- 読みと実際の比較
- Actual Hand Equity
- Bluff / Valueの答え合わせ

Pass Bの情報を理由にPass Aを勝手に変更しないでください。

全員の札は、Pass Aの入力とは別のProjection `projectLearningReveal`（#78。`docs/04` §4）から取ります。

## 8. Assessment Style

一つのActionにFake Precisionな点数をつけるより、段階評価を基本にします。

例:

- Strong
- Reasonable
- Mixed / Marginal
- Improvement Suggested
- Major Leak
- Insufficient Evidence

併記:

- Confidence
- Assumptions
- 何が変わると結論も変わるか

## 9. Practical / GTO / Exploitの順序

標準説明:

1. 実戦的なBaseline
2. 必要に応じてGTO / Theory
3. EvidenceがあればExploit Adjustment

「GTOでXだから常にXが正しい」と教えないでください。

## 10. Solver利用

MVPから実Solverを組み込みます。

原則:

- Capability Matchしてから使用
- Unsupportedは正常系
- Range Assumptionを明示
- MultiwayをHUのExact Truthとして扱わない
- SolverはEvidenceの一つ

Session Deep Analysisでは通常Reviewより重いSolveを使っても構いません。

## 11. Web Fallback

毎HandでWeb検索しません。

順序:

```text
Local KB
 ↓
Math / Solver
 ↓
Evidence Sufficiency
 ├─ Enough → Review
 └─ Insufficient → Web
```

Web EvidenceでRecommendationが大きく変わる場合、Source / Provenanceを保持します。

## 12. Review Interview

ログだけでは評価が揺れる場合、Heroへ質問できます。

例:

- 当時VillainをValue-heavyと見ていたか
- Bluffがどの程度含まれると考えたか
- BetのTarget Handは何だったか
- Pot OddsでCallしたのか、Player Readだったのか

すべてのHandで質問しないでください。

## 13. Model Routing

初期Role:

- `opponent_fast`: Haiku級
- `review_standard`: Sonnet級以上
- `review_deep`: コスト許容範囲の高性能Model

Concrete ModelはConfigで変更可能とします。
