# Issue #63: Ruling Engine を作り、Oversized Chip・String Bet・Out-of-Turn を裁定する

## 概要

Poker Engine に Ruling Engine（`packages/engine/src/ruling.ts`）を作った。Hero の物理的な操作（Chip を出す・足す・宣言・手番でない操作）を、版付きの Rule Profile（`TableConfig.ruling`）に従って Canonical Action に裁定する純粋関数 `rulePhysicalActions` と、保留した Out-of-Turn を Hero の手番で拘束 / 撤回する `resolveOutOfTurn` を持つ。Rule Profile の ID を `phase1_provisional_v0` から `phase4_provisional_v1` に上げた。Event・`schema_version`・永続化スキーマ・server / web の配線は変えていない（Event 化は #64、UI は #65）。

## 初期調査

- 前提（main 229bd53）: Engine は Canonical Action（`PlayerAction`）だけを受け付ける。`TableConfig` に `chipDenominations`（#62・D92）があり、Event には写さない。
- docs/02 §3（Rule Profile の対象）・§4（PhysicalAction / CanonicalAction の型）・§5（必須 Scenario: Oversized Chip・String Bet / Raise・Representative Out-of-Turn）、docs/research/01 §4〜§9（TDA の宣言・Oversized Chip・Multiple Chip / 50% 規則・OOT）、D91（3 種の裁定の暫定値）、D90（Event 化は #64）、OI-008 を読んだ。
- `ruleProfile` は `HAND_STARTED` → `HandState` → Projection の `TableView` → CPU の KnowledgeState（Prompt の引数）まで流れる。ID を変えると AI Opponent Eval の録画（引数の指紋）と合わなくなる（後述）。

## 変更内容

- `packages/engine/src/table-config.ts`: `RulingRules`（`oversizedChip` / `stringBet` / `multipleChip` / `declaration` / `outOfTurn`。各規則の内容を型のコメントに明記）と `TableConfig.ruling` を追加。`PHASE1_CASH_PRESET.ruleProfile` を `phase4_provisional_v1` に上げた。`ruling` は Event に持たせない（buttonRule と同じ扱い。版は ID で分かる）。
- `packages/engine/src/ruling.ts`（新規）: `PhysicalAction`（`chip_push` / `chip_add` / `declare`）・`Declaration`・`RulingCode`・`PendingOutOfTurn`・`RulingResult`（`action` / `out_of_turn` / `no_action`）と、`rulePhysicalActions`・`resolveOutOfTurn`。裁定の結果は必ず Legal Action に寄せる（D40）。入力の誤り（額面に無い Chip・Stack 超過・chip_add から始まる・Fold 済み等）は `invalid_input`。
- `packages/engine/src/legal-actions.ts`: `CanonicalAction`（`PlayerAction` の docs/02 §4 の名前での別名）。
- `packages/engine/src/index.ts`: 上記を公開。
- `packages/engine/src/hand-scenarios.test.ts`: `ScenarioStep` に Hero の物理的な操作（`physical` + 期待する裁定）と `resolveOutOfTurn` の Step を足し、ランナーで裁定 → Engine への適用 → 各 Step の Invariant・畳み込みを確かめる。Scenario 7 本（`SCN-ruling-oversized-001〜003`・`SCN-ruling-string-001〜002`・`SCN-ruling-oot-001〜002`）。期待値は手計算。
- `packages/engine/src/ruling.test.ts`（新規）: 規則ごとの Unit Test（47 件）。裁定した Action が `applyAction` で拒否されないことも毎回確かめる。
- `packages/engine/src/ruling.property.test.ts`（新規）: ランダムな物理的操作（宣言の有無・位置、Chip の動作 0〜3 回）と Out-of-Turn を混ぜて Hand を最後まで進め、裁定した Action が常に合法で、各 Step の Invariant（Chip 保存を含む）と畳み込みが保たれることを確かめる（300 run）。
- `packages/engine/src/hand-engine.test.ts`: `TableConfig` の直書き 2 か所に `ruling` を足した。
- `apps/server/src/testing/opponent-eval/spots.ts`: Eval の Spot を録画時の ID（`phase1_provisional_v0`）で始める（下記）。
- docs: docs/02 §3 に現在の Preset の規則表と TDA との差、§4 に実装の型と結果。docs/03 の Engine の入口に Ruling Engine。docs/09 §5 に Eval の ID 固定。docs/11 OI-008 に #63 で置いた暫定値の注記。

## 判断理由

- **D91 の 3 種以外の規則も TDA に沿って決めた**: 宣言なしの複数枚（Multiple Chip）は、どれかに決めないと Canonical Action に変換できないので、TDA の「全部の Chip が Call に要るなら Call」と 50% 規則にした。宣言は「先にした方が決める・最初の宣言が拘束・合法な最も近い Action に寄せる」。OOT の「状況が変わる」は「同じ Street の最高額が変わる（Bet・Raise・最高額を上げる All-in）、または Street が進む」。いずれも Rule Profile の暫定値（docs/02 §3）。
- **TDA と食い違う点は D91 を優先し、docs/02 §3 に差として書いた**: TDA は OOT の Fold を常に拘束とするが、D91 は「変われば撤回できる」なのでこの版では Fold も撤回できる。Undercall は一律に全額の Call（TDA は Multiway の一部を Floor 判断）。
- **Out-of-Turn は操作の種類にしない**: 手番でないときの操作を Ruling Engine が判定する。保留の比較は「同じ Street の最高額」だけで足りる（Check・Call・Fold は最高額を変えない）。
- **Event の項目は増やしていない**: 裁定の規則は Projection の Legal Action の計算に要らない（Hero の入力の解釈だけ）。版は `ruleProfile` の ID に残る。
- **Eval の Spot の ID 固定**: `ruleProfile` は KnowledgeState に入って Prompt の引数を変えるので、ID を上げると録画の再生（CI）が指紋の不一致で落ちる。録画の取り直しは Claude を呼ぶ手動の Eval なので、この Issue では Spot を録画時の ID で始めるように固定し、取り直すときに戻す（コメントと docs/09 に記載）。版の差は Hero の Ruling だけで CPU の局面・Legal Action は変わらない。

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 220・web 43・server 154 件すべて通過）/ `pnpm format:check` が通る。
- ID の変更の影響: `phase1_provisional_v0` を repo 全体で grep。残るのは Eval の固定（意図）・web の表示用 fixture（保存済みの Hand の例として妥当なので変えない）・過去の作業ログ。

## 残課題

- Ruling の Event 化（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING。D90）と Server の配線は #64、Chip を出す UI は #65。
- AI Opponent Eval の録画を現在の Preset の ID で取り直す（手動の Eval。取り直したら `spots.ts` の固定を外す）。
- TDA との差（OOT の Fold・Undercall・前の Bet の Chip が残るときの細則）を確定するかは OI-008 の人間判断。
