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

Evidenceの組み立て（#82。`apps/server/src/review/evidence.ts`）: 判断時点のHero Information Setだけを入力に、次の形でReview AIへ渡します（Event Log・`KnowledgeState`をそのまま渡さず、whitelistで写す）。各項目は`id`を持ち、Review AIは根拠に挙げた`id`を返します（実在しない`id`は不正）。

- Decision Context（`ctx:`）: Street・Blind・HeroのPositionと札・判断時点のBoard・Pot・各席のPosition / Stack / Commit / Fold / All-in（他者の札は持たない）・Public Actionの履歴・裁定の履歴・Legal Action・Heroが選んだAction・Important Spotの理由。
- Math（`math:`）: `analyzeDecision`の値（Pot・Call額・Pot Odds・有効Stack・SPR・Equity・Alternative Action・前提）。Monte Carloのseedは入れません。
- Range（`range:`）: 相手ごとのRangeのAssumption。Important Spotだけ、Rangeの想定（標準・狭い・広い）ごとのEquityの比較（`compareRangeProfiles`）。
- Opponent Observation: 相手の過去の傾向の記録はまだ無いので`unavailable`（Exploitは根拠なしとして書かせる）。
- Solver（`solver:`）: Capability Gateを通って解けたときだけ`supported`（`docs/03` §7）。それ以外はUnsupported / 当てはまらないNode / 失敗の理由を前提として渡します。
- Knowledge（`kb:<KB Version>:<id>@<version>`）: 判断時点のSpotの特徴（Street・HeroのPosition・Heads-Up / Multiway・Spotの種類・相手のPreflopのAction列）で`searchKb`した上位4項目。
- User Read / Intent: まだ聞いていない（`not_collected`）。

Evidenceに他者のHidden Cards・未来のCard・`system`のEvent・CPUのPersonaが入らないこと、判断より後のEventを切り落としても見えないEventの中身を差し替えてもEvidenceが変わらないことをテストで確かめます（`evidence.test.ts`）。

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

実装（#83。`apps/server/src/review/reveal-evidence.ts`・`reveal-ai.ts`・`generate-reveal.ts`）: Pass BのEvidenceは、Pass Aと同じ判断時点のDecision Contextに、次を決定論で足したものです（LLMに計算させない）。

- 読みと実際の比較（`reveal:`）: 相手ごとの実際の札と、判断時点でFoldしていなかった相手は、判断時点に仮定した標準のRange（Pass AのRange Evidenceと同じ作り方）と、実際の札がそのRangeに入っていたか・判断時点のBoardでの役。
- 実際のEquity（`equity:`）: 判断時点のBoardからの、Potを争っていた相手の実際の札に対するHeroの勝率と、判断時点に仮定したRangeに対する勝率。
- Bluff / Valueの答え合わせ（`aggression:`）: 判断時点までのBet / Raiseと、Heroの判断がBet / Raiseならその判断の、本人の実際の札の、その時点でPotを争っていた残りの相手の実際の札に対するEquity。公平な取り分（1 / 人数）以上ならvalue、未満ならbluff（暫定の基準。Evidenceに基準の文を添える）。

Review AIは評価（Assessment）を出さず、`readComparison`（読みと実際の比較）・`actualEquity`・`bluffValue`・`takeaways`（次に活かす点）だけを書きます。Promptで、判断の評価はPass Aで済んでいて結果を理由に付け直さないこと、1 Handの結果でRangeの想定を断定しないことを指示します。Pass Bは`reveal_reviews`に別のVersionの列として保存し、Pass Aの`reviews`は変えません（`docs/04` §8）。Pass BのEvidenceはCPUの入力・Pass Aの入力に渡しません（INV-TEST-008。`docs/09`）。

### Follow-up Q&A

Heroは、PassとVersionで指定したReviewに続けて質問できます（#83。`apps/server/src/review/followup.ts`）。答えの根拠は、そのReviewのEvidenceと説明だけです。Pass Aへの質問のPromptにはPass AのEvidence（判断時点の情報）しか入らないので、Hand後の情報（相手の実際の札・結果）は混ざりません。範囲の指示はPassごとに文で出し分け（Pass Aは「Hand後の情報は知らない。聞かれたら`out_of_scope`にしてReveal Reviewで確かめられると答える」、Pass Bは「結果で判断の評価を付け直さない」）、Evidenceで答えられない質問は`out_of_scope`にさせます。複数ターンは、同じVersionのこれまでの質問と答えを古い順にPromptへ入れ、1回の単発の問い合わせで呼びます（D87）。答えの検証はSchema（`scope`・本文・件数）→ Grounding（`answered`なら根拠のidが1つ以上で、すべてそのReviewのEvidenceに実在する）の順で、不正なら1回だけ再要求し、2回続けて不正なら答えずに（`unanswered`）失敗を残します。履歴はReviewのVersionに紐づけて`review_followups`に保存します。

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

実装（#82。`apps/server/src/review/review-ai.ts`・`generate.ts`）: Review AIは構造化出力で`assessment`（`strong` / `reasonable` / `mixed_marginal` / `improvement_suggested` / `major_leak` / `insufficient_evidence`）・`confidence`（`low` / `medium` / `high`）・`assumptions`・`conclusionChangers`（何が変わると結論も変わるか）・`evidenceIds`と、§9の順の説明（`practical` → `theory` → `exploit`）を返します。検証はSchema（形・enum・文字数・件数）→ Grounding（`evidenceIds`がEvidenceに実在する・Solverの結果が無いのに`theory.basis: solver`を選ばない・Observationが無いのに`exploit.basis: observation`を選ばない）の順で、不正なら理由を付けて1回だけ再要求し、2回続けて不正ならInsufficient Evidenceにします。根拠が足りない（判断時点の卓が読めない・EquityもSupportedのSolverの結果も無い・KBの項目が無い）ときは、Review AIを呼ばずにInsufficient Evidenceにします（Evidence Sufficiency Gate。§11のWebへは進まない。D94）。

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
