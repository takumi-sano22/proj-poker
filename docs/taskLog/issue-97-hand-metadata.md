# Issue #97: Hand ごとの Best-effort Metadata（App Version・CPU のモデル）を Event に残す（schema_version 7）

## 概要

親 #2 の DoD の最後の未チェック項目（Best-effort Model / Config / Debug Metadata）を埋める。Hand の開始時に、App Version・Rule Profile Version・Persona の Preset 一式の版・席ごとの CPU の実装（RuleBot / Claude と Model Role・具体モデル / Emergency Bot）を、新しい Event `HAND_METADATA_RECORDED`（system Visibility）として Event Log に残し、Event の `schema_version` を 7 に上げた。AI の Request / Response の生データは保存しない（D100。この Issue の PR で親が記録）。既存のテーブル・列・行は変えていない。

## 初期調査

- 前提（main 77b27f1）
  - Event は版 6（`apps/server/src/sqlite-event-store.ts` の `EVENT_SCHEMA_VERSION`）。版 3〜6 は Event の種類を足しただけで、読み込みは版 3 以上の行をそのまま返す（`toCurrent`）。版を上げても古い版の行を新しい変換に通さない前例（#48・#64・#77）に従えば、版 6 の行は変換なしで読める。
  - opponent_fast の解決値は `apps/server/src/config.ts` の `MODEL_ROLES`（D85）。CPU の実装は起動時の `OPPONENT_PROVIDER` で決まり、`index.ts` が `createOpponent` を選ぶが、その説明（provider・モデル）は Orchestrator へ渡っていなかった。
  - Emergency Bot を選んだ CPU は Session の終わりまで `SessionPointer.emergencyBots`（`EMERGENCY_BOT_ENGAGED` の写し。再起動後は Session Projection から戻す）。
  - Persona は `persona.ts` の 6 Preset（D85・OI-005 の暫定値）で、Preset に版の値は無かった。Persona の割り当ては Event に入れない（Secret Persona。docs/04 §10・`persona.ts` の冒頭）。`testing/leaks.ts` の `personaTerms` が Event Log に "persona" の語が出ないことをテストで確かめている。
  - Rule Profile の版は `HAND_STARTED.ruleProfile`（例: `phase4_provisional_v1`）。App Version はルートと `apps/server` の `package.json` の `version`（どちらも `0.0.0`）。
  - Engine の `startHand` は開始の Event の後に `progress` で自動進行するので、Blind で All-in が決まると開始の結果だけで `HAND_FINISHED` まで進む。→ 開始の結果の後ろに足す形（`SESSION_STARTED` と同じ `recordSessionEvent`）では、Hand の終わりより後ろに置くことになり、Event Store の規則（Hand の終わりの後ろは `SESSION_ENDED` だけ）に反する。
  - Opponent の `KnowledgeState` は seq を持たない（`projection.ts`）。Opponent Eval の Spot・Review Eval の Hand は `startHand` を直接呼んで作る。
- 根拠: docs/04 §3・§9、D37・D38・D76・D95・D100、ガイダンス db / ai-boundary / poker-engine。

## 設計方針

- **Event の位置**: Engine の `startHand` に任意の `metadata` を渡したときだけ、`HAND_STARTED` の直後（seq 1）に `HAND_METADATA_RECORDED` を置く。開始の Event の中に置くので、Hand が開始直後に終わる場合も Hand の終わりより前になる。`metadata` を省けば Event 列は従来と同じ（固定 Scenario・Opponent Eval の Spot・Review Eval の Hand は変わらない）。
- **項目**: `appVersion`・`ruleProfileVersion`（Engine が `config.ruleProfile` から写す。呼び出し側に別の値を渡させない）・`cpuProfileVersion`・`cpuSeats`（席順の CPU だけ。`playerId`・`provider`〔`rule_bot` / `claude` / `emergency_bot`〕・`modelRole`・`model`）。Hero は入れない。
- **Persona Profile Version は Preset 一式の版にした**（`PERSONA_PROFILE_VERSION = "phase3_provisional_v1"`）。席ごとの Preset ID を入れると、Event に Persona の割り当てを入れない既存の方針（Secret Persona）と食い違うため、割り当ては従来どおり Session Projection にだけ置き、Event には「どの版の Preset 一式か」だけを残す。Event の項目名は docs/04 §9 の「CPU Profile Version」に合わせて `cpuProfileVersion` にした（"persona" の語を Event Log に出さない既存のテストをそのまま通す）。
- **provider の決め方**: `index.ts` が `OPPONENT_PROVIDER` から `opponentInfoOf` で説明（`rule_bot`、または `claude`・`opponent_fast`・`MODEL_ROLES.opponent_fast`）を作り、`createOpponent` と組で `buildApp` → Orchestrator に渡す（Claude のモデル名も同じ値を使う）。Orchestrator は Hand の開始時点で Emergency Bot を選んでいる CPU を `emergency_bot`（Model は null）にする。Hand の途中の切り替えはその Hand の Metadata を変えず、`EMERGENCY_BOT_ENGAGED` に残る。省略時（テスト・`buildApp` の既定）は RuleBot。
- **App Version**: `apps/server/src/app-version.ts` が `apps/server/package.json` の `version` を読む（src からも dist からも 1 階層上。`DEFAULT_DB_PATH` と同じ作法）。読めない・空なら起動時に止める。
- **版**: `EVENT_SCHEMA_VERSION` を 7 にし、版 6 の行は変換せずに読む（Metadata を補って作り直さない）。`event-upcast.ts` に `HandEventV6` を足した。DB のテーブル・列・行は変えない（マイグレーションなし）。
- **情報境界**: system Visibility なので `projectHeroView` / `projectKnowledgeState`（Opponent の Prompt の入力）/ Replay の応答には入らない。Leak 検査の語（`hiddenMarkers` / `forbiddenKeys`）に `HAND_METADATA_RECORDED`・`"appVersion"`・`"cpuSeats"` を足し、`tamperHiddenEvents` で中身を差し替えても KnowledgeState・Hero Information Set が変わらないことを Property Test で確かめる。

## 変更内容

- Engine（`packages/engine`）
  - `src/hand-events.ts`: `HAND_METADATA_RECORDED`・`CpuProviderKind`・`CpuSeatMetadata` を足し、Visibility を system に固定した。
  - `src/hand-engine.ts`: `StartHandInput.metadata`（`HandMetadataInput`）。HAND_STARTED の直後に置き、CPU が卓にいない・重複していれば `invalid_input` で拒否する。
  - `src/hand-state.ts`: 畳み込みでは State を変えない（seq だけ進む）。
  - `src/index.ts`: 型の export。
  - `src/testing/view-leaks.ts`: Leak 検査の語・`tamperHiddenEvents` の差し替え・テスト用の `testMetadata`。
  - テスト: `src/hand-metadata.test.ts`（新規 5 件）。`hand-engine.property.test.ts`・`hand-summary.property.test.ts` の Hand に Metadata を混ぜた。
- Server（`apps/server`）
  - `src/app-version.ts`（新規）・`src/opponents/persona.ts`（`PERSONA_PROFILE_VERSION`）・`src/config.ts`（`OpponentInfo`・`RULE_BOT_INFO`・`opponentInfoOf`）。
  - `src/hand-orchestrator.ts`: `opponentInfo`・`appVersion` の option と、Hand の開始時の Metadata の組み立て（`handMetadata`）。Emergency Bot の Map を `startHand` の前に決めるよう並べ替えた（中身は同じ）。
  - `src/app.ts`・`src/index.ts`: `opponentInfo` を渡す。
  - `src/event-upcast.ts`・`src/sqlite-event-store.ts`: 版 7。
  - `src/testing/leaks.ts`: `forbiddenKeys` の語。
  - テスト: `hand-orchestrator.test.ts`（Metadata 2 件の新規・Emergency Bot の検証の追加・Claude の Fake の Prompt 記録を関数に切り出し）・`sqlite-event-store.test.ts`（版 7 で保存・版 6 の行を変換せずに読む）・`config.test.ts`（`opponentInfoOf`）・`app-version.test.ts`（新規）。
- Web: `apps/web/src/lib/view-model.ts` の進行ログで表示しない Event に足した。
- Docs: `docs/04_DATA_AND_EVENTS.md` §3（Event 一覧・構成表・追記の説明・版 7）と §9（何をどこに記録しているかの表）。`README.md` の Phase 5 の一覧に 1 行。

## 実行した確認

- `pnpm lint`: 成功
- `pnpm typecheck`: 成功（e2e / engine / web / server）
- `pnpm test`: 成功（engine 28 files / 333 tests、web 8 files / 117 tests、server 28 files / 412 tests。Opponent Eval・Review Eval の録画の再生を含む）
- `pnpm format:check`: 成功
- `pnpm e2e`: 成功（1 passed。6-max の Play → Review → Replay → 次の Hand → 再起動して Resume）
- `pnpm --filter @proj-poker/server build` の後に `node` で `dist/app-version.js` を読み、`APP_VERSION 0.0.0` を確認した（dist からも package.json を読める）。

## 残課題

- Hero は `cpuSeats` に入れていない（Hero の実装は人間なので記録しない）。必要になったら項目を足す。
- `package.json` の `version` は `0.0.0` のまま。リリースの版付けを始めたら Metadata にそのまま反映される。
- docs/10 の D 番号の対応表への D100 の追加は、D100 を記録する親の作業。
