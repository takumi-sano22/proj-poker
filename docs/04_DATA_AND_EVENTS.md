# データとEvent設計

## 1. 正本

Hand Event Logを、実際に何が起きたかを表す**唯一の正本**とします。

以下は派生データです。

- Current Game State
- Hand Summary
- Session Summary
- Statistics
- Replay Timeline
- Review Input

独立した二つの「正しいHand表現」を持たないでください。

## 2. 主要ID

推奨:

- `session_id`
- `hand_id`
- `event_id`
- `player_id`
- `cpu_profile_id`
- `action_id`
- `review_id`
- `observation_id`
- `hypothesis_id`
- `drill_id`

## 3. Eventカテゴリ

最低限、以下と同等の情報を復元可能にします。

- `SESSION_STARTED`
- `SESSION_ENDED`
- `HAND_STARTED`
- `HAND_FINISHED`
- `BUTTON_ASSIGNED`
- `BLIND_POSTED`
- `ANTE_POSTED`
- `HOLE_CARD_DEALT`
- `PLAYER_DECLARED`
- `PHYSICAL_CHIP_ACTION`
- `DEALER_RULING`
- `ACTION_TAKEN`
- `CHIPS_MOVED`
- `CARD_BURNED`
- `BOARD_DEALT`
- `PLAYER_FOLDED`
- `PLAYER_ALL_IN`
- `SHOWDOWN_STARTED`
- `CARDS_TABLED`
- `POT_AWARDED`
- `AI_ACTION_INVALID`
- `AI_FALLBACK_USED`
- `HINT_OPENED`
- `USER_READ_RECORDED`

内部実装でEventを統合しても構いませんが、必要な情報を後から復元できることが条件です。

### Phase 1 Engine の Event 構成（`packages/engine/src/hand-events.ts`）

Phase 1（D70）の1 Hand進行で発行するEventです。上の一覧のうち、統合したものは「統合元」に書きます。Eventは `seq`（Hand内の通し番号・0始まり）と `visibility` を持ち、Stateは `foldHandEvents`（Eventの畳み込み）だけで作ります（D37）。`event_id`・時刻・`session_id` は永続化する側（`apps/server`）が付けます（EngineはI/Oと時刻を持たない）。

| Event | 主な項目 | Visibility | 統合元・備考 |
|---|---|---|---|
| `HAND_STARTED` | `handId`・`ruleProfile`・`smallBlind`・`bigBlind`・`oddChipRule`（Split Potの端数の配り方。D75）・`seats`（席順の `playerId` / `stack`）・`buttonPlayerId` | public | `BUTTON_ASSIGNED` |
| `DECK_SHUFFLED` | `seed`（積んだDeckならnull）・`deck`（配布順の52枚） | engine | 未来のCardを含むため、どのPlayerのProjectionにも入れない。§9のRNG Seedに相当 |
| `BLIND_POSTED` | `playerId`・`blind`（small / big）・`amount` | public | Ante は Phase 1 で扱わない |
| `HOLE_CARD_DEALT` | `playerId`・`cards`（2枚） | private(playerId) | 1 Player 1 Event |
| `ACTION_TAKEN` | `playerId`・`street`・`action`（fold / check / call / bet / raise / all_in）・`amount`（出した額）・`toAmount`（そのStreetの累計）・`allIn` | public | `PLAYER_FOLDED`・`PLAYER_ALL_IN`・`CHIPS_MOVED`（Bet分） |
| `BOARD_DEALT` | `street`（flop / turn / river）・`cards` | public | Burn は省く（`CARD_BURNED` は発行しない） |
| `CARDS_TABLED` | `playerId`・`cards` | public | `SHOWDOWN_STARTED`。River後か、All-inでBettingが終わった時点で、Foldしていない全員が公開する |
| `UNCALLED_BET_RETURNED` | `playerId`・`amount` | public | `CHIPS_MOVED`（返却分） |
| `POT_AWARDED` | `potTotal`・`awards`（`playerId` / `amount`）・`showdown` | public | 単一Potのみ。同着の端数は `oddChipRule` に従って配分済みの額が入る（D75） |
| `HAND_FINISHED` | `stacks`（`playerId` / `amount`） | public | §10のRecovery境界 |

Phase 1で扱えない状態（D70）は、Eventを発行せずにEngineが `unsupported_state` エラーを返します（`side_pot`: All-inした額を他のPlayerのCommitが超える）。Split Potの端数はD75で実装したため、エラーにしない。

## 4. Visibility

Card / Observation EventにはVisibilityを明示します。

```ts
type Visibility =
  | { type: "public" }
  | { type: "private"; playerId: string }
  | { type: "learning_only" }
  | { type: "engine" };
```

`engine` はEngine内部専用で、Deckの順序（未来のCard）のようにどのPlayerにも見せない情報に付けます。Phase 1 Engineが発行するのは `public` / `private` / `engine` で、`learning_only` はReviewのRevealを実装するときに使います。

これにより以下を再構築できます。

- Heroが当時何を知っていたか
- 各CPUが当時何を知っていたか
- Reviewで何を学習用に開示できるか

## 5. KnowledgeState Projection

`KnowledgeState` はglobal Event Storeそのものではなく、PlayerごとのProjectionです。

Phase 1 Engineでは、`public` と自分宛ての `private` のEventだけを畳み込んで作ります（`packages/engine/src/projection.ts` の `projectHeroView` / `projectBotView`）。`engine` と他者宛ての `private` は読みません。

含めるもの:
- Public Table State
- 自分のHole Cards
- Public Action History
- 自分が観察したShowdown
- 自分が取得した過去Observation / Hypothesis
- 自分自身のInternal State

Learning-only Revealを読み込んで構築してはいけません。

## 6. Opponent Observation

Observationの事実と、そこからの解釈を分けます。

例:

```yaml
observer_player_id: cpu_ken
subject_player_id: hero
source_hand_id: hand_123
evidence:
  - river_bet_75pct
  - showed_bluff
interpretation: bluff_frequency_may_be_high
confidence: low
```

AIが過去に書いた自然言語だけを正本にしないでください。

## 7. User Learning Hypothesis

例:

```yaml
id: hyp_001
type: river_bluff_catch_overcall
supporting_action_ids: [...]
counter_evidence_action_ids: [...]
sample_size: 6
confidence: medium
status: improving
```

自然言語Player ProfileはこのEvidence Layerから派生させます。

## 8. Review Record

Reviewは「構造化された根拠」と「説明文」の両方を保存します。

最低限:

- Review Version
- Created At
- Target Hand / Action / Session
- Model Role
- Concrete Model
- KB Version
- Solver Adapter / Version
- Assumptions
- Math Evidence IDs
- Solver Evidence IDs
- User Read IDs
- Assessment
- Confidence
- Explanation

過去Reviewを上書きしてはいけません。

## 9. Replay Metadata

Replayそのものは保存済みEventだけで再生します。

Best-effortなDebug / Re-analysis用Metadata:

- RNG Seed
- Deck Order Hash
- Rule Profile Version
- App Version
- Model Role / Version
- AI Request / Response
- CPU Profile Version / Snapshot

これらを保存しても、完全なRe-simulationを保証するものではありません。

## 10. Auto Save境界

**Completed Hand**を安定したRecovery Boundaryとします。

`HAND_FINISHED` 時に:

- Hand Events保存
- Session Projection保存
- Stack保存
- 必要なMemory Update保存

アプリがHand途中で終了した場合、直前のCompleted Hand終了時点から再開できればMVPとして十分です。

Action単位の完全Crash RecoveryはMVPで過剰実装しません。

## 11. Reset Semantics

### Learning Reset

削除:
- User Hypothesis
- Ability Score
- Generated Player Profile

Hand Historyは別指定がない限り保持します。

### Opponent Memory Reset

CPUのPersistent Observation / Hypothesisを削除します。

### Hand History Delete

Hand / Session Historyと派生Projectionを削除します。

### Factory Reset

アプリ本体・Asset以外のLocal User Data / Configを初期化します。
