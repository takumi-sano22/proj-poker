# Issue #115 P6-4 User Read（Event）と Note / Tag

## 概要

Hero の User Read（判断の前の読み・意図）を `USER_READ_RECORDED` として Event Log に残し、Review Pass A の Evidence（User Read / Intent）に判断時点の読みだけを provenance 付きで入れる。CPU ごとの Note / Tag を追記型のテーブル（マイグレーション v5）に置く。D112（schema_version 8・v5）・D105（Subject は seat id を永続 Identity とみなさない）・D113（v5 は Note / Tag 専用、v6 は #114）。

## 初期調査

- `heroInformationSets`（`packages/engine/src/hand-summary.ts`）は、判断時点を「ACTION_TAKEN の直前に続く Hero 自身の操作を除いた前の Event」とする。読みを操作と同じに飛ばさないと、`no_action` の裁定の後の選び直しの間に読みを挟んだとき、判断時点が読みになり `rulingNotes` が欠ける。
- Orchestrator の `cpuTurn` は、思考待ちの後に Log の長さが変わっていれば古い手番として捨てる（`isCurrent`）。CPU の手番の間に読みを追記すると、その手番がやり直しになり Claude を二重に呼びうる。
- Review の Prompt は Evidence の JSON と `evidenceGlossary("decision")`（項目の説明をすべて出す）でできている。Review Eval の録画は Prompt・Schema の指紋を持つので、読みの無い判断の Evidence・Prompt・Schema を変えなければ録画を取り直さずに済む。
- Event Store は終わった Hand への追記を拒否する（`HAND_FINISHED` の後ろは `SESSION_ENDED` だけ）。Session の行は最初の Hand が終わるまで作られない。

## 設計方針（判断）

1. **User Read は Hero の手番の間だけ**記録できる（Engine の `recordUserRead` が判定）。CPU の手番を古くしない・読みが「直後の判断の前」に必ず並ぶ。Hand の途中だけの制約は docs/07 §8 に書いた。
2. **判断時点**: `heroDecisions` は読みも Hero 自身の入力として飛ばす（`decisionPointSeq`・KnowledgeState・Replay の飛び先は読みの有無で変わらない）。`HeroInformationSet.userReads` に「その判断の ACTION_TAKEN より前の読み」を入れ、`events` には入れない（読みの経路を 1 本にする）。判断より後の読みは入らない。docs/04 §1 に書いた。
3. **Visibility**: `private(playerId)`。CPU の KnowledgeState・他者の View・`publicEvents`（Stats）・Learning-only Reveal に入らない。
4. **Review**: 読みが無ければ `userRead: { status: "not_collected" }` のまま（Prompt・Schema は従来と同じ文字列）。読みがあれば `collected` と items（`read:<handId>/<seq>`・Street・対象の席と表示名・本文）を入れ、Prompt に扱い方（`USER_READ_GUIDE`）を添える（構造ゲート）。項目名は既存の説明（`playerId`・`displayName`）と小文字 1 語だけにして、項目の説明（glossary）を変えない。
5. **Note / Tag**: `user_notes`（revision と tombstone。削除は次の revision の本文 NULL の行）・`user_tags`（add / remove の行）。どちらも UPDATE / DELETE を Trigger で拒否。今の状態は行の列から作る派生。
6. **Subject**: `{ kind: "session_player", sessionId, playerId }`（その Session の中の参加者）。`subject`（JSON）と `subject_key`（検索の鍵）で持ち、Phase 7 は kind を足す（列は変えない）。Session の行は最初の Hand の終わりまで無いので外部キーにしない。
7. **UI**: Hero の手番の行に「読みを記録」の Button 1 つ（開いたときだけ入力）。進行ログの下に既定で閉じた「CPU の Note / Tag」。一覧・閲覧の専用画面は作らない（#116 は Session Review の画面で、Note / Tag の画面は含まない。最小の今の Note / Tag の表示だけを入力欄に添えた）。

## 変更ファイル

- Engine: `packages/engine/src/hand-events.ts`（Event と Visibility）・`hand-state.ts`（畳み込みは State を変えない）・`hand-engine.ts`（`recordUserRead`・`USER_READ_TEXT_MAX`）・`hand-summary.ts`（`isHeroInput`・`userReads`）・`index.ts`・`user-read.test.ts`（新規）
- Server: `sqlite-event-store.ts`（版 8）・`event-upcast.ts`（`HandEventV7`）・`db/database.ts`（v5）・`hand-orchestrator.ts`（`heroUserRead`・`subjectOf`）・`routes/hands.ts`（`/reads`）・`routes/notes.ts`（新規）・`notes/subject.ts`・`notes/note-store.ts`（新規）・`app.ts`・`index.ts`・`review/types.ts`・`review/evidence.ts`・`review/review-ai.ts`
- Server テスト: `db/database.test.ts`・`sqlite-event-store.test.ts`・`notes/note-store.test.ts`（新規）・`routes/notes.test.ts`（新規）・`routes/replay.test.ts`・`review/evidence.test.ts`
- Web: `lib/api.ts`（`recordUserRead`・`deleteJson`・`not_found`）・`lib/notes-api.ts`（新規）・`lib/view-model.ts`（進行ログの行）・`lib/review-api.ts`・`hooks/useHandSession.ts`（`recordRead`）・`components/UserRead.tsx`・`components/OpponentNotes.tsx`（新規）・`components/ReviewPass.tsx`・`App.tsx`・`styles.css`・テスト（`components.test.tsx`・`review.test.tsx`・`view-model.test.ts`）
- E2E: `e2e/tests/session.spec.ts`（広い画面・375px で読みと Note / Tag を記録して Hand を進める）
- Docs: `docs/03` §1（notes・API 表）・`docs/04` §1・§3・§4・§8・§12・`docs/05` §6・`docs/06` §1・§10・`docs/07` §8

## 実行したコマンドと結果

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過
- `pnpm test`: engine 355・web 126・server 480 件すべて通過（Review Eval の録画の再生〔指紋の照合〕を含む。録画は取り直していない）
- `pnpm e2e`: 4 件通過（既存 2 件 + #115 の 2 件）
- Playwright の実測（一時スクリプト。コミットしない）: 1280×900・375×760・375×667・320×568 で横スクロール 0。手番の行は 44px（従来の案内 24px から +20px）。読みの入力を開いたときの Hero の欄は 1280 で +28px、375 で +80px、320×568 で +104px（320×568 は従来から Hero の欄が画面の大半を占める既知のずれ。入力は Hero の欄の中に見えている）。

## 残課題

- Pass B（Reveal Review）に読みと実際の札の比較を入れる・Review Interview（docs/05 §12）で後から読みを聞く経路は未実装（本 Issue の範囲外）。
- Note / Tag を Review の Evidence に入れるかは未決定（本 Issue では入れない）。
- 320×568 で Hero の欄が画面の大半を占める既知のずれは従来どおり。
