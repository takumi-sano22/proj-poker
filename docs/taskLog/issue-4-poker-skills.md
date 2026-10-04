# Issue #4: proj-poker 固有の skill を新規作成する

## 概要

#3 で移設した汎用資産に加えて、proj-poker 固有の skill を 4 つ作成した（セッション冒頭でユーザーが承認済み）。

## 設計方針

- **docs を正本とし、skill には写さない**: 各 skill は「点検の観点・確認動作・手順・記録様式」だけを持ち、規範は docs の節番号で参照する。docs と食い違った場合は docs が正。
- **docs に無い仕様を発明しない**: Chip の数値表現（未確定）、Scenario の形式（Phase 0 で確定）、PoC の置き場などは「未確定。確定したら decision-log で記録」と明記した。
- **人間判断の境界**: Solver の選定や Phase 分解の承認は、セッション冒頭の AskUserQuestion と decision-log（D 番号）に集約し、AI は確定させない。

## 変更ファイル

- `.claude/skills/poker-invariant-review/SKILL.md`（新規）: A 情報境界 / B 決定論と LLM の役割 / C Review / D Event Log / E Chip・表示 / F Solver のチェックリストと確認動作。
- `.claude/skills/poker-engine-testing/SKILL.md`（新規）: 変更種別ごとに足すテスト、seed の注入、INV-TEST-001〜008 の assert 方針、Scenario Regression の YAML 形式、Property / Fuzz の反例を Scenario へ昇格させる手順。
- `.claude/skills/phase-planning/SKILL.md`（新規）: 実装開始ゲートの確認、DoD との突き合わせ、Scope Creep の除外、子 Issue への分解、親 #2 への紐付け、Phase の完了判定。
- `.claude/skills/solver-poc/SKILL.md`（新規）: OI-002 の候補（research/05 §3）、比較表、実測手順、SolverAdapter への写像、Unsupported の扱い。結論は推奨にとどめる。
- 既存資産の「#4 で追加 / 作成予定 / 未作成の間は H 節で代替」という注記を除去した（CLAUDE.md、.claude/README.md、code-review、github-workflow、implementation-guidance、agents ほか）。
- `AGENTS.md`: Review guidelines から、poker-invariant-review と poker-engine-testing へ参照を追加した。

## 実行した確認

- 4 skill すべてで、frontmatter の `name` がディレクトリ名と一致していることを確認した。
- 「#4 で」「予定」「未作成の間」の注記が 0 件になったことを grep で確認した。
- 参照先の実在を確認した: `docs/research/05` §8（PoC Acceptance Criteria）、`create-issue` 手順 7（sub-issue 紐付け）。

## 残課題

- Phase 0 でテストランナーとディレクトリ構成が確定したら、poker-engine-testing の想定パスと Scenario の形式を確定値に更新する。
