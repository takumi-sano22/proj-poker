# 学習とAnalytics設計

## 1. 原則

短期収支をPoker Skillと同一視しません。

主評価:
- その時点で利用可能な情報に基づくDecision Quality

補助評価:
- 実額収支
- BB収支
- 結果Variance

### Phase 6の前提（D102〜D105）

Phase 6（Session Learning。#105）は、次を前提に実装します。

- Event Logが正本で、Stats / Score / Profile / Hypothesisはすべて再計算できる派生Projectionです（D37・D102）。Projectionを保存してもCacheとして扱い、正本にしません（`docs/04` §12）。
- Score・Recent Windowなどの数値は、Version付きのPolicy / Configに置く暫定値です（OI-006）。Playtest後に変えられるようにし、永久仕様にしません。
- 判断の評価の入力は、Review Pass A（判断時点の情報だけ。`docs/05` §7）のVersion付きAssessmentです。Pass B（Learning-only Reveal）の情報をScore・Hypothesisの根拠に使いません。
- Hidden CPU PersonaとLearning-only Revealを、Hero向けのObservation Evidenceに使いません（§8）。

## 2. Ability Dimension

初期候補:

- Preflop
- Postflop
- Bet Sizing
- Pot / Equity Math
- Range Reading
- Opponent Adaptation
- Position
- Live Mechanics

各Abilityに持つもの:

- Score
- Confidence
- Sample Size
- Evidence IDs
- Trend

### Ability DimensionとScoringPolicyの契約（D103。数値はOI-006の暫定値）

Scoreは、Version付きの暫定式 `ScoringPolicy` で計算します。最初のVersionは `phase6_provisional_v1` です。Policyは次を持ち、Versionを変えれば同じEvidenceから計算し直せるようにします（Scoreには計算したPolicyのVersionを必ず残す）。

- Ability Dimensionの一覧（上の初期候補。Policyの中のVersion付きの一覧で、永久仕様にしない）
- Pass A Assessmentの点（暫定値）

  | Assessment | 点 |
  |---|---|
  | `strong` | 100 |
  | `reasonable` | 80 |
  | `mixed_marginal` | 60 |
  | `improvement_suggested` | 35 |
  | `major_leak` | 0 |
  | `insufficient_evidence` | 集計から除外（0点として数えない） |

- Decision → Abilityの割り当てとWeight: 1つのDecisionは複数のAbilityに寄与できます。割り当てとWeightは決定論でVersion付き（LLMに決めさせない）。
- Confidenceの扱い: Confidenceは点数そのものを変えず、集計のWeightに使います（Weightの値は暫定値）。

ScoreはConfidence / Sample Size / Evidence IDs / Trendと必ず一緒に扱い、点数だけを見せません。Live MechanicsはPoker Decisionと別のScoreです（D48）。Drillの結果は通常PlayのAbility / Overall Scoreへ直接混ぜません（§7。D105）。

### 実装（#113。`phase6_provisional_v1` の値はすべてOI-006の暫定値）

`apps/server/src/learning/` にあります。Policyは`scoring-policy.ts`（`SCORING_POLICIES`にVersionごとに置き、値を変えるときは既存のPolicyを書き換えずVersionを足す）、Ability Evidenceは`ability-evidence.ts`、集計は`score.ts`の`computeScoreReport`です。Scoreは都度計算し、保存しません（D111）。

- **入力**: Hand（古い順のEvent Log）とPass Aの`reviews`だけです。Pass B（`reveal_reviews`）のStoreは型の上でも渡せません。Reviewを作る経路は持ちません（D115）。
- **M件中N件**: M＝終わったHand（`HAND_FINISHED`か`HAND_ABORTED`。Reviewを作れるHandと同じ条件）のHeroの判断の数（Engineの`heroDecisions`）。N＝Pass AのReviewがある判断の数。結果は`decisions: { total: M, reviewed: N, scored, insufficientEvidence }`を必ず持ちます。
- **Reviewの選び方**: 同じ判断に複数のVersionがあれば、最大のVersion（最新）を使います。standardとdeepの優先は付けません（暫定）。
- **Ability Evidence**: 判断1つにつき、使うReview 1つから作ります。IDは`<handId>/d<判断の番号>/v<ReviewのVersion>`で、Assessment・Confidence・点・Weight・Abilityへの割り当て・Live Mechanicsの点・ReviewのEvidence IDs（provenance）を持ちます。割り当ては、Reviewが持つ判断時点のEvidence（Street・Action・Call額・判断時点の最高額・裁定の理由）だけから決めます。
- **Decision → Abilityの割り当て（暫定）**:

  | 条件 | Ability | Weight |
  |---|---|---|
  | Preflopの判断 / Flop以降の判断 | Preflop / Postflop | 1 |
  | 額を引き上げた（Bet / Raise / 額を上げるAll-in） | Bet Sizing | 0.5 |
  | Betに直面していた（Call額 > 0） | Pot / Equity Math | 0.5 |
  | Flop以降でBetに直面していた | Range Reading | 0.5 |
  | Preflopで誰もRaiseしていない（最高額がBBのまま） | Position | 0.5 |
  | （割り当てなし。Heroが観察した相手のEvidenceがまだ無い。#115・Phase 7で見直す） | Opponent Adaptation | — |

- **ConfidenceのWeight（暫定）**: high 1・medium 0.7・low 0.4。AbilityのScoreは「点 × ConfidenceのWeight × 割り当てのWeight」の加重平均、Overall（Poker Decisionだけ）は「点 × ConfidenceのWeight」の加重平均です（判断1つを1回数える）。小数第1位で丸めます。
- **Live Mechanics（D48。暫定式）**: その判断のHeroの操作に理由のある裁定（Oversized Chip等。`docs/02`）が入れば0点、入らなければ100点。Assessmentを使わないのでinsufficient_evidenceの判断も数え、裁定は決定論なのでWeightは1です。Overallには入れません。
- **ScoreのConfidence（暫定）**: 集計に入ったEvidenceの数で決めます。0件はinsufficient（Scoreはnull）、1〜9件はlow、10〜29件はmedium、30件以上はhigh。
- **Trend（暫定）**: 直近10件とその前の10件の加重平均を比べ、5点以上上がればimproving、下がればdeclining、それ以外はstable。20件に満たなければinsufficient。
- **Drillの除外**: `excludeHandIds`で除くHandのidを受け取り、M・N・Scoreのどれにも入れません（D116。`drills`テーブルは#117）。
- **Versionを変えた計算し直し**: `computeScoreReport`に別のPolicyを渡せば、同じEvent Logと`reviews`から計算し直せます。結果には計算したPolicyのVersion（`policyVersion`）を必ず残します。
- 表示用のAPI・UIは#116、Learning Resetの区切り（D114）は#118で足します。

## 3. Detailed Statistics

Eventを十分細かく保存し、後から多くのStatを再計算可能にします。

通常UI:

- VPIP
- PFR
- 3-bet
- 一部Aggression / Fold Metrics
- Position別
- Street別

詳細UI:

より多いTracker-style Metrics。

Percentageだけでなく:

- Numerator
- Denominator
- Opportunity Count

を必ず保持します。

`2 / 3 = 66%` と `200 / 300 = 66%` を同じConfidenceで扱わないでください。

Stats Projection（D103）:

- Event Logから再計算する、**全Player対応**の汎用Projectionにします。Phase 6のUIはHeroを主対象にします。
- 同じEvent Logからは同じ結果になる決定論で作ります。
- 指標をSchemaへ固定で埋め込みすぎず、後から指標を足せる境界にします。
- Play中のHUDは足しません（D32）。Heroが他Playerの統計を見るのはReviewで、Heroが観察可能だった範囲に限ります（§8）。

実装（#112）: `packages/engine/src/stats.ts` の `projectPlayerStats(hands, options)` が、HandごとのEvent Logの配列から全PlayerのStatsを計算します（I/O・LLMを持たない純粋関数。結果は保存しない。D111）。

- 入力はpublicのEventだけです（`projection.ts` の `publicEvents`。卓に座った全員が見聞きした事実）。Hole Cards（private）・Deck（engine）・CPUの判断の経緯やSessionの運用・HandのMetadata（system）は読まないので、Hidden Cards・Persona・Learning-only Revealは入力の経路にありません。publicでないEventの中身を差し替えても取り除いても結果が変わらないことをProperty Testで確かめます（INV-TEST-007に相当）。
- 集計に入れるのは `HAND_FINISHED` まで済んだHandです（進行中のHandと、`HAND_ABORTED` で打ち切ったHandは入れない）。`options.excludeHandIds` で除くHandを渡せます（DrillのHandを通常の集計から除く口。D116。`drills` テーブルは#117で作り、呼び出し側が渡す）。Learning Resetの区切り（D114）で範囲を絞る引数は、#118で足します。
- 指標の定義は `STAT_DEFINITIONS` の1か所に集め、定義の版を `STATS_DEFINITION_VERSION`（最初は `phase6_stats_v1`）として結果に付けます。指標を足すときは定義を1つ足し、意味を変えたら版を上げます。指標ごとにNumerator / Denominator / Opportunity Countを返し、Percentageは表示側が計算します。Playerごとに、全体・Position別（UTG / HJ / CO / BTN / SB / BB。`positionName` と同じ分け方）・Street別の3つの表を持ちます。
- Raiseの数え方は、Bet / Raiseと、その時点の最高額を超えるAll-inをAggressiveとします（Range Modelの `isAggressive` と同じ規則）。Preflopの機会は「そのPlayerがPreflopでActionしたHand」で数え、Blindを出しただけでActionが来なかったHand（Walk・BlindでAll-in）は入れません。

  | 指標 | 種類 | 機会（Opportunity） | 分子 | 分母 |
  |---|---|---|---|---|
  | `vpip` | percentage | PreflopでActionしたHand | 自分からChipを出した（Call / Bet / Raise / All-in）Hand | 機会 |
  | `pfr` | percentage | 同上 | RaiseしたHand | 機会 |
  | `three_bet` | percentage | Raise 1回（Open）に直面してActionしたHand（Openした本人は除く） | そこでRaise | 機会 |
  | `fold_to_three_bet` | percentage | Openした後に3-bet（Raise 2回目）に直面してActionしたHand | そこでFold | 機会 |
  | `cbet_flop` | percentage | Preflop Aggressor（Preflopで最後にRaiseしたPlayer）が、Flopで誰もBetしていない時点でActionしたHand | そこでBet | 機会 |
  | `fold_to_cbet_flop` | percentage | Preflop AggressorのFlopのContinuation Betに（Raiseの前に）直面してActionしたHand | そこでFold | 機会 |
  | `aggression_frequency` | percentage | PostflopのCheck以外のAction（Bet / Raise / Call / Fold） | Bet / Raise | 機会 |
  | `aggression_factor` | ratio | PostflopのBet / RaiseとCallの回数 | Bet / Raise | Call |

## 4. Evidence-backed User Profile

正本:
- Structured Evidence

派生:
- Natural Language Player Profile

Profileは以下から高頻度で再生成します。

- Recent Evidence
- Long-term Evidence
- Improvement
- Unresolved Hypothesis

過去の自然言語Summaryを再帰的に「真実」として積み重ねないでください。

Recent / Long-term（D104）:

| 区分 | 範囲 |
|---|---|
| Recent | 直近100の有効Decision（OI-006の暫定値。Configに置く） |
| Long-term | 全有効Evidence |

Structured Profileが正本で、自然言語のPlayer Profileはそこからの派生物です。古い自然言語Summaryを次の生成の正本にしません。

実装（#114。`phase6_profile_v1` の値はOI-006の暫定値）: `apps/server/src/learning/profile.ts` の `computePlayerProfile` が、Scoreと同じAbility Evidence（Pass Aの`reviews`の判断ごとの最新のVersion。Pass Bは入れない）からStructured Profileを都度計算します（保存しない。D111）。

- **有効Decision**: Pass AのReviewがある判断です（D115）。Recentは、判断の順で末尾の`recentDecisions`件（暫定値100。`ProfilePolicy`に置き、変えるときはVersionを足す）、Long-termは全件です。どちらも`scoreEvidence`（Scoreと同じ集計）でOverall / Abilityを出し、件数（`reviewed`・`scored`）を持ちます。Long-termの集計は`computeScoreReport`と同じ値になります。
- **持つもの**: Policyの各Version（Profile・Hypothesis・Scoring）、対象の判断の数とReview済みの数（M件中N件。D115）、Recent・Long-term、Weakness Hypothesis（§5。Snapshotを読まず、同じEvidenceから同じ関数で作る）。Improvementは、各AbilityのTrend（§2）とHypothesisの`improving` / `resolved`で表します。
- **自然言語のProfile**: `renderProfileText`が、Structured Profileだけを受け取る決定論のテンプレートで作ります（LLMを呼ばない。APIの課金経路を増やさない）。表示用の派生で、Structured Profileは文を持たず、過去の文を次の計算の入力にしません。
- **Drillの除外**: `excludeHandIds`（D116。Scoreと同じ口）。Learning Resetの区切り（D114）は#118で足します。表示用のAPI・UIは#116です。

## 5. Hypothesis Lifecycle

例:

- Suspected
- Supported
- Strong
- Improving
- Resolved
- Insufficient Data

Counter Evidenceによって弱くなる仕組みを持ちます。

Weakness Hypothesis（D104）は、Supporting / Counter EvidenceをEvidence IDsで構造化して保存し、状態遷移を決定論で行います。LLMを状態遷移の正本にしません（説明文を書かせるのは可）。形は`docs/04` §7です。保存はreviewsから作り直せるSnapshotのテーブルで、typeの一覧と遷移のしきい値はVersion付きの暫定Policy（OI-006）に置きます（D113）。

実装（#114。`phase6_hypothesis_v1` の一覧と数値はすべてOI-006の暫定値）: `apps/server/src/learning/` の `hypothesis-policy.ts`（`HYPOTHESIS_POLICIES`にVersionごとに置く）・`hypothesis.ts`（`buildHypotheses`）・`hypothesis-snapshot.ts`（Snapshotの作り直しと読み出し）です。

- **Evidence**: Ability Evidence（§2の実装。Pass Aの判断ごとの最新のReview）を使います。`improvement_suggested` / `major_leak`をSupporting、`strong` / `reasonable`をCounterとし、`mixed_marginal`と`insufficient_evidence`は数えません。EvidenceのIDはAbility EvidenceのID（`<handId>/d<判断の番号>/v<ReviewのVersion>`）です。
- **type（判断の分類）**: Reviewが持つ判断時点の特徴（§2の割り当てと同じ）だけから決めます。1つの判断は複数のtypeに入れます。

  | type | 判断 |
  |---|---|
  | `preflop_unraised` | Preflopで誰もRaiseしていない（最高額がBBのまま） |
  | `preflop_facing_raise` | PreflopでRaiseに直面した |
  | `postflop_facing_bet` | Flop以降でBetに直面した（Call額 > 0） |
  | `postflop_unbet` | Flop以降でBetに直面していない |
  | `bet_raise` | 額を引き上げた（Bet / Raise / 額を上げるAll-in。上のどれかと重なる） |

- **Hypothesisを作る条件**: Supportingが1件以上あるtypeだけです（弱点の疑いが無いtypeは作らない）。IDは`<PolicyのVersion>/<type>`です。
- **状態遷移（暫定のしきい値）**: typeごとのSupporting / Counterを判断の順に並べ、n＝件数・s＝Supportingの数とします。

  | 状態 | 条件（上から順に判定） |
  |---|---|
  | `insufficient_data` | n < 3 |
  | `resolved` | n > 5（直近の窓5件より古いEvidenceがある）で、直近5件にSupportingが無い |
  | `improving` | 下の`strong` / `supported`に当たり、n > 5で直近5件のSupportingが1件以下 |
  | `strong` | s ≥ 4 かつ s / n ≥ 0.6 |
  | `supported` | s ≥ 2 かつ s / n ≥ 0.4 |
  | `suspected` | それ以外 |

  Counter Evidenceが増えると、strong → supported → improving → resolvedと弱くなります。
- **Snapshot（D113）**: `rebuildHypothesisSnapshot`が、reviewsから作り直した結果でマイグレーションv6の`hypothesis_snapshots`の全行を1トランザクションで入れ替えます（列は`docs/04` §7）。消して作り直しても同じ行になる派生データで、正本にしません。Player Profile（§4）はSnapshotを読まず、同じ関数で作ります。
- **Drillの除外**: `excludeHandIds`（D116）。Learning Resetの区切り（D114）は#118で足します。

## 6. Session Review

表示:

- Hands
- Duration
- 実額結果
- BB結果
- Decision Quality Summary
- Strength
- Leak
- Important Hands
- Confidence / Sample Caveat
- Recommended Drill

「負けたから下手」「勝ったから上手」としません。

Decision Quality SummaryとScoreは、Pass AのReviewがある判断だけで計算し、「M件中N件をReview済み」を必ず表示します。Reviewを自動・一括で作る経路は持ちません（D115）。

## 7. Targeted Drill

```text
実際の問題Hand
 ↓
Underlying Concept抽出
 ↓
Analogous Spot生成
 ↓
一要素だけ変える
 ↓
新しい判断
 ↓
Review
```

同じカードを再提示して答えを暗記させるだけにしません。

Phase 6のDrill（D105）:

- 元のHand / Decision / Evidenceのprovenanceを持ちます。
- 基本の経路は、過去Handからの決定論的な変形（一要素だけ変える）です。
- Phase 6で実装するのは決定論の変形だけです（D110）。LLMでSpotを生成する経路はPhase 6の範囲外で、将来入れる場合もPoker EngineのValidation（合法なState・Action・Chipの保存）を必ず通します。
- Drillの判断もReviewしますが、結果は通常PlayのAbility / Overall Scoreと別の系列に持ち、直接混ぜません。
- Drillは専用のSessionの通常のHandとしてEngineで終局まで進め、追記型の`drills`テーブルで通常Playと区別します。Stats・Score・Profile・Hypothesis・Resume・Replayの通常の集計はDrillのHandを除きます（D116。形は`docs/04` §12）。

例:
- River Bluff Catch
- Blind Defense
- Effective Stack変更
- Opponent Tendency変更
- Bet Size変更

## 8. Opponent Reading Training

Play中:

- HUDなし
- User Note
- Tag
- Optional Read Capture

Review時:

1. User Read
2. Heroが観察可能だったEvidence
3. 観察可能範囲のStats
4. AI Range / Opponent Assessment
5. Actual Revealは別枠

Hidden CPU PersonaをHero-facing Evidenceとして使わないでください。

User Read / Note / Tag（D105）はPhase 6で実装します。

- 対象（Subject）の参照は、seat id（`cpu1`等）を永続Identityとみなさない形にし、Phase 7の永続`cpuProfileId`（D106）が入っても破綻しないようにします。
- User ReadはprovenanceつきでReviewのEvidence（User Read / Intent。`docs/05` §6）に入れます。
- Hidden Personaと照合して、読みの当たり外れをPlay中に見せません。Actual Revealとの比較はReview（Pass B）の別枠だけです。

実装（#115・D112）:

- **User Read**: Play中、Heroの手番の間だけ、画面下のHeroの欄の「読みを記録」から、対象（Foldしていない相手の席、または「相手なし（意図）」）と本文（1〜200字）を記録できます。記録は`USER_READ_RECORDED`（Heroだけのprivate。`docs/04` §3）としてEvent Logに残り、進行ログにHero自身の行として出ます。**User ReadはHandの途中でしか記録できません**: Event Storeは終わったHandへの追記を拒否し（`docs/04` §10）、手番でない間（CPUが判断している間・Fold後）も受け付けません（CPUの手番の判断を古い手番として捨てさせないため）。終わったHandについての振り返りの読みは、Review Interview（`docs/05` §12。未実装）の範囲です。
- **判断時点**: 判断の`ACTION_TAKEN`より前に記録した読みだけが、その判断（とその後の判断）のReview Pass AのEvidence（User Read / Intent。`docs/05` §6）に、provenance（`read:<handId>/<seq>`・Street・対象の席）付きで入ります。判断より後に記録した読みは入りません。読みは判断時点の卓（`decisionPointSeq`・`KnowledgeState`）を変えません（`docs/04` §1）。
- **Note / Tag**: 卓の画面の「CPU の Note / Tag」（既定は閉じた欄）で、CPUの席ごとにNote（1〜500字）とTag（1〜20字）を足し・消せます。保存はマイグレーションv5の追記型のテーブルで、対象は「そのSessionの中の参加者」です（`docs/04` §12。席の番号を永続の相手とみなさない）。HUD（統計）ではなくHero自身のメモなので、Play中も見られます（D32）。
- **見せないもの**: 読みの当たり外れ（Hidden Persona・相手の札との照合）はPlay中にも記録の応答にも出しません。User Read / Note / TagはCPUの`KnowledgeState`・Prompt・CPU Memoryへ渡しません（テストで確かめる。`apps/server/src/routes/notes.test.ts`）。Learning-only Revealは読みの根拠に使いません（記録できるのはHandの途中だけで、RevealはHandの後だけ）。Note / TagはReviewのEvidenceに入れません。

## 9. HintとScore

Hint利用量を保存します。

将来、必要なら:

- Independent Decision
- Hint-assisted Decision
- Review-only Understanding

を区別できます。

ただしExact WeightはPlaytest前に固定しません。
