# Issue #49: Claude Code の OAuth 認証（サブスク枠）の設定手順を文書にし D87 を記録する

## 目的

CPU の Claude 呼び出しを、API キーではなく Claude Code の OAuth 認証（サブスク枠）で行うための設定・確認手順を docs と README に書き、D84 を変更する人間判断 D87 を記録する。コードは変えない（Model Adapter は #50）。

## 初期調査

- 2026-10-06 のユーザー指示で方針が変わった（旧: `ANTHROPIC_API_KEY` を `.env` に置く = D84）。D87 は Issue 本文の文言のまま追記する。
- origin/main の最大 D 番号は D86（push 前に再確認する）。
- 「API キー」「ANTHROPIC_API_KEY」「.env に置く」の残存を `grep -rnE` で洗った。D84 由来の記述は `decision_log.yaml` の D82・D84・D86（採用済みの文言なので変えない）、`docs/10` の判断グループ表、`docs/03`・README のブラウザへ「API Key を渡さない」の 2 箇所、`AGENTS.md`（Codex 観点）。`apps/web/package.json` の description は範囲外（コード領域）のため触らない。
- 公式（Agent SDK quickstart）: `claude` の `/login` 済み資格情報を使う。環境に `ANTHROPIC_API_KEY` があるとそちらが優先され API 課金になる。第三者が自製品で claude.ai ログインを提供することは認められていない。

## 変更内容

- `docs/decision_log.yaml`: D87 を末尾に追記。D84 の `status` を `"D87 で変更"` に（他の行は変えない）。先頭の範囲表記を D01〜D87 に。
- `docs/00_DOCUMENTATION_INDEX.md`・`docs/10_DECISION_TRACEABILITY.md`・`README.md`: 範囲表記を D01〜D87 に。docs/10 の判断グループ表に D87 の行を足し、D82〜D86 の行の D84 に「D87 で変更」を添えた。
- `docs/03_SYSTEM_ARCHITECTURE.md` §3: 「Claudeの認証（D87。D84を変更）」を追記（呼ぶ場所・資格情報の置き場所・`ANTHROPIC_API_KEY` を子プロセスから外す〔実装は #50〕・前提と範囲・利用枠の共有・障害の扱い・テスト）。ディレクトリ構成の「API Key を渡さない」を「Claude の資格情報を渡さない」に。
- `README.md`: 技術構成の同上の言い回しと、「セットアップ」に「Claudeの認証」の手順（ログイン → 動作確認 → `ANTHROPIC_API_KEY` が無いことの確認 → 切り替え設定は #50 で追記）、守ること、ログイン切れ・枠上限の症状と対処を追加。
- `AGENTS.md`: Codex 観点の P0 を、Claude Code の OAuth 資格情報（`~/.claude/`）も対象に広げ、`ANTHROPIC_API_KEY` が子プロセスに残る実装を `[P1]` に足した。

## 判断理由

- D82（#49 を「APIキーの置き場所と手順」とした分解）と D86（「キー無し」）は採用済みの文言なので書き換えない。D84 は D87 の指示どおり `status` だけ変える。
- 切り替え設定名は #50 で確定するので、手順では「#50 で追記する」と書いた。
- `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` は本プロダクトでは使わない前提で、言及だけ（資格情報をリポジトリ・`.env` に置かない方針の裏返し）。
- 利用枠の上限・ログイン切れは、Claude 呼び出しの失敗として D86 の「障害」に載せる。ダイアログは #52 の範囲。

## 実行した確認

- `pnpm format:check`（ルート）: 成功（`.md` は Prettier の対象外。YAML・JSON は対象）
- 範囲表記・D84 由来の記述の再 grep の結果は PR 本文に記載
