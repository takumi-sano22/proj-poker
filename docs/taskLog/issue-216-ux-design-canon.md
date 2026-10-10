# Issue #216: UX-01 横断 UI/UX 設計・Q1〜Q29 の判断の正本化

## 目的

#203 の実機プレイを受けて人間が ChatGPT との壁打ちで確定した Q1〜Q29（#216 の本文）を、採用済みの人間判断として `docs/decision_log.yaml` に記録し、関連 docs・トレーサビリティ・Open Items・`ui-design-recipes` を同期する。UX-02 以降の機能実装と、親 #215 の Gate の解除はしない。

## 変更内容

- `docs/decision_log.yaml`: D135〜D142 を追加した（Q をテーマ別に 8 つに束ね、`choice` に Q 番号と選択肢を残す）。既存の D は変えていない（status も不変）。先頭の範囲表記を D01〜D142 に
  - D135 世界観・演出の強さ・装飾素材（Q1・Q5・Q10）／D136 Home / Play / Learn・起動時の Home・読み取り専用の照会・戻り先（Q2・Q6・Q23・Q25）／D137 PC / スマホのレイアウト（Q3・Q4・Q7・Q27）／D138 Chip の操作（Q11・Q13・Q17・Q18）／D139 下書きの保持（Q12・Q24）／D140 表示順序・演出の速度・Showdown・Replay・再接続（Q8・Q14・Q15・Q19・Q20・Q21・Q26）／D141 効果音（Q9・Q16・Q22）／D142 RULING → ETIQUETTE の確認（Q28・Q29）
- `docs/06_UI_UX.md`: §1 の方針を D135 に置き換え、§5・§6・§8・§13 に今後の変更点への注記、§16「横断 UI/UX」を新設（不変条件・画面遷移図・レイアウトと下書きの寿命・Presentation Controller の責務・Dealer の通知の優先順位・効果音と設定の保存先・トークン・技術検証で決める事項）
- `docs/01_PRODUCT_REQUIREMENTS.md`: FR-LIVE-005 の速度の 3 段を D140 の 4 段階に置き換え、FR-UX-001 を追加、非目標に BGM なし
- `docs/03_SYSTEM_ARCHITECTURE.md` §2: UI の Logical Component に App Shell・Presentation Controller（設計のみ）を足し、未確定の API / Event の検証先を明記
- `docs/04_DATA_AND_EVENTS.md` §4: 表示の状態（演出のキュー・速度・下書き・音量）を Event Log に入れないこと、演出が使う Visibility を明記。Ack を Event にするかは未確定
- `docs/10_DECISION_TRACEABILITY.md`: D135〜D142 の行、Q → D → 実装 Issue の対応表、既存 D との関係（すべて具体化）
- `docs/11_OPEN_ITEMS.md`: OI-012（可逆なパラメータと技術検証で決める事項）を追加
- `.claude/skills/ui-design-recipes/references/proj-poker.md`: 演出の規律を D135 に合わせ、横断 UI/UX の新しいレイヤーの導線を追加、「既知のずれ」のスマホの画面高の制約に D137 と UX-05 を明記（未解決のまま）
- 範囲表記 D01〜D142: `docs/00`・README（採用済み判断の行のみ）・`sync-check`・`test-and-review` の skill

## 判断理由

- 既存の D との衝突を検査した（Issue が挙げた D15・D44・D60・D62・D80・D91・D93 と、関係する D32・D43・D46・D47・D49・D86・D90）。どれも変更ではなく具体化で吸収でき、採用済みの判断の変更は無いので停止しなかった
  - D15（速度変更 / Skip）→ D140 の 4 段階。Fast Forward（D93）は別の契約のまま
  - D43（実卓寄り 2D）・D60（構造描画・装飾のみ画像）→ D135 でも維持
  - D62（Hand の間の Auto Save）→ 下書きは client の表示状態で、再起動を跨いだ復元を求めない（D139）
  - D91・D90 → 裁定の規則と Event は変えず、表示と確認の流れだけ（D142）
  - D80・D93 → 変えない
- 衝突したのは D ではない docs の記述だけ: `docs/06` §1「Casino ゲーム的な演出より読みやすさを優先」（Issue が更新を指示）と `docs/01` FR-LIVE-005 の速度 3 段（Real Table / Normal / Fast）。D は docs より優先する（`docs/00` §3）ので docs を書き換えた
- 「数秒」・演出の ms・Chip の拡大率・パネルの高さの正確な比率・画面幅の閾値・音量の既定値は Issue の注記どおり可逆な値として OI-012 に置き、永久値にしていない
- Home の照会の API・下書きの判定・演出の順序の復元・効果音の保存先・ETIQUETTE の確認待ちの責務と Ack は、UX-02 / 04 / 06 / 10 / 11 の技術検証の対象として「未確定」と明記し、採用済みの事実として書いていない。UX-11 の CPU を止める責務は人間の承認（#215 Gate 1）が要ると書いた
- 解釈を 1 つ明記した: Q20 の「Showdown の公開 / 結果は飛ばさない」と Q8 の Skip・Q19 の「演出なし」を両立させるため、「Skip・演出なしでも表示の内容は省かず、省くのは動きだけ」とした（可読性・正確性を守るという Q5 の条件と同じ向きで、新しい仕様を足していない）
- D をテーマ別に束ねたのは、Q ごとに 29 個を足すより、実装 Issue（UX-02〜UX-11）と 1 対多で辿りやすいため。Q との対応は `choice` と `docs/10` の表で失わない

## 実行した確認

- `python3 -c "import yaml; …"` で `decision_log.yaml` を読み込み、142 件・最後が D142 であることを確認
- `git show origin/main:docs/decision_log.yaml | grep -o "id: D[0-9]*" | tail -1` → `D134`（D135 は未使用の次番号）
- `grep -rn "D01〜D1[0-9][0-9]"`（taskLog を除く）で D01〜D142 以外の範囲表記が残っていないことを確認
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan に記録）

## 残課題

- 親 #215 の Gate 0 の充足確認と解除は人間が行う（AI は解除しない）
- UX-02・UX-04・UX-06・UX-10・UX-11 の技術検証（OI-012・`docs/06` §16.8）。UX-11 の確認待ちで CPU を止める責務・Ack の契約は人間の承認が要る
- #215 本文の「未完了の GitHub 管理操作」（sub-issue の紐付け）は、`gh issue view 215` で #216〜#227 がすでに sub-issue として表示されている。チェックボックスの更新は親の管理者に任せ、本 PR では触っていない
