# Issue #108: P6-0 Post-MVP Decision / Docs Sync

## 概要

#104（Post-MVP Parent）で人間が確定した Post-MVP 方針を `docs/decision_log.yaml` に D102〜D109 として記録し、正本 docs を同期した。#104 の「⛔ 実装開始 Gate」（Documentation Gate）の文書側を満たすための PR で、**Phase 6 の機能実装は含めない**。#104〜#107 の本文を人間確定事項として扱い、新しい判断は足していない。

## 確認した現状（2026-10-07）

- main は `9a2c79c`。Open PR なし。
- #96 は PR #100 で Close 済み（COMPLETED。D101）。Phase 6 の開始への影響なし。
- #105〜#107 が #104 の sub-issue に紐付いていなかったので、#104 の Issue 構造（Post-MVP Parent → Phase Parent → 子 Issue）に合わせて紐付けた。P6-0 を #108 として起票し #105 の sub-issue にした。
- `decision_log.yaml` 先頭の範囲表記が `D01〜D100` のまま（実際は D101 まで）だったので、今回の更新でそろえた。

## 変更内容

- `docs/decision_log.yaml`: D102〜D109 を追記（既存の D は変えていない）。
  - D102 Post-MVP の Parent 構造・Phase 6→7→8 の順・Gate・不変条件の継承・Scope 外
  - D103 Phase 6 の全 Player 対応 Stats Projection と `ScoringPolicy phase6_provisional_v1`（Assessment の暫定点・Confidence は集計の Weight）
  - D104 Recent（直近 100 有効 Decision）/ Long-term Profile と決定論の Hypothesis 遷移
  - D105 User Read / Note / Tag（seat id を永続 Identity にしない）と Drill（決定論の変形が基本・Engine Validation 必須・通常 Score と別系列）
  - D106 Fixed CPU の `cpuProfileId`・Guest の寿命・append-only の Observation・recency decay・observer private の CPU-to-CPU Memory・context の分離・Table Tendency
  - D107 Tilt（版付きの決定論 State Machine・transient・Session 終了で Reset）
  - D108 `TournamentSession` 層・6-max STT・時間 / Hand 数 base・Ante の 3 種・Payout 50/30/20（暫定）・Rebuy なし
  - D109 Public Tournament Context・2〜8 人の決定論 ICM・Chip EV と別 Evidence・Push/Fold Solver は Scope 外
- `docs/07`: Phase 6 の前提、Ability Dimension と ScoringPolicy の契約（Policy が持つもの・暫定点の表）、Stats Projection、Recent / Long-term、Hypothesis、Drill、User Read / Note / Tag。
- `docs/05`: Opponent の入力（Phase 7 の Memory・Phase 8 の Tournament Context）、Tilt、Phase 7 の Identity と Memory、Table Tendency（D10 の卓編成とは別と明記）、Review Evidence の Phase 6 以降の扱い、Tournament の Solver と Review。
- `docs/02`: Post-MVP でも変えない情報境界、Observation の Identity、Phase 8 の構造（TournamentSession・Blind / Ante・Payout・Elimination）、Public Tournament Context、ICM。
- `docs/04`: §6 Phase 7 の Observation、§7 Hypothesis の遷移、§11 Post-MVP の Reset、§12（新設）Post-MVP の Projection と永続化の方針（正本を増やさない・Policy Version を残す・マイグレーションは足すだけ）。P6-0 の「Phase 6 の DB / Projection 追加方針」にあたる。具体的なテーブル・Event の形は各子 Issue で決める。
- `docs/08`: §3.1 Post-MVP の実装順と Phase ごとの子 Issue の分解（#105〜#107 の推奨）、§3.2 Phase Gate（Documentation Gate・6→7・7→8）、§4 Post-MVP の Scope Creep 防止、§5 Post-MVP の停止条件。
- `docs/11`: OI-005（D106 で Identity と寿命だけ確定。人数等は未確定のまま）、OI-006（D103・D104 の暫定値）、OI-007（D108 の暫定値）に注記。OI-011（Opponent Memory と Tilt の Parameter）を新設し、recency decay・Tilt の値が未確定であることを明記。いずれも永久確定にはしていない。
- `docs/10`: 判断グループ表に D102〜D109。範囲表記を D01〜D109 に（`docs/00`・`docs/10`・`decision_log.yaml`・README・`.claude/skills/{sync-check,test-and-review}`）。

## 判断理由

- D 番号は #104〜#107 の記載のまとまり（全体 / Phase 6 の Score / Profile / Read と Drill / Phase 7 の Memory / Tilt / Phase 8 の構造 / CPU と Review）で 8 つに分けた。既存の D（D05・D11・D18・D27・D29〜D36・D52〜D54・D63）を変えるものではなく「具体化」と書いた。
- 暫定値（Assessment の点・Recent 100・Payout 50/30/20・decay / Tilt の値）は、すべて OI の暫定値として書き、永久仕様にしていない。
- Tilt の永続化の有無、User Note / Tag をどの Reset で消すか、テーブルの形は #104〜#107 に記載が無いので決めず、子 Issue（P6-4・P6-7・P7-5・P7-8）に残した。

## 実行した確認

- `python3 -c "import yaml; ..."` で `decision_log.yaml` が読め、末尾が D109（109 件）であること。
- `grep -rn "D01〜D" --include=*.md --include=*.yaml .`（taskLog を除く）で範囲表記が D01〜D109 にそろっていること。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan に記載）。

## 残課題

- #104 の Gate のチェックと、Documentation PR のマージは人間の確認で行う（AI は Gate を解除しない）。
- `CLAUDE.md`・`create-issue`・`phase-planning` などの harness は、進捗管理の親を「#2」としている。Codex の [P1] を受けて差分内の `sync-check` は直し、残りは #110 に分離した。

## レビュー

- 自己レビュー: 2 件（docs/04 §12 の正本の範囲・docs/07 の Confidence の限定）を 5643309 で修正。
- Codex 1 回目（`findings`）: [P1] 2 件。どちらも CONFIRMED。
  - Observation の Subject を `cpuProfileId` としていたため Hero を表せない → Observer は `cpuProfileId`、Subject は Hero・Fixed CPU・Guest を表せる参加者の参照にした（docs/04 §6・同じ原因の docs/02 INV-INFO-003）。
  - `sync-check` が Issue の正本を #2 としていた → MVP は #2、Post-MVP は #104・#105〜#107 に直した。差分外の同じ原因（CLAUDE.md・create-issue 等）は #110 に分離。
- Codex 2 回目（`clean`）: 本文に [P2] 1 件（sync-check の sub-issue の取得例が #2 だけ）。CONFIRMED で 1bf5145 で修正。P2 だけの修正で条件付き再レビューの①〜④に当たらないため再実行なし。
- 学習 Capture: round 1 で 3 件（docs P2 / docs P1 / harness P1）。round 2 の P2 は round 1 の harness の候補と同じ root failure class のため新しい候補にしない。
- マージは #104 の Documentation Gate の解除にあたるため人間の確認後。
