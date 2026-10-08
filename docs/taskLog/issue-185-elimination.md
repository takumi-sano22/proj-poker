# Issue #185: Elimination / Position / Tournament の進行と順位を作る（P8-3）

## 概要

Tournament の Bust = Elimination、残人数、Button / SB / BB の移動、Heads-Up への移行、Tournament の終了と順位の確定を作った。Bust の除外・Button の移動・Heads-Up は既存の `nextHandSeating` と Hand Engine をそのまま使い（複製しない）、Hero の Bust（`hero_busted`）か Hero が最後の 1 人（`hero_last_standing`）で Tournament を終える既存の経路を Tournament でも使う。順位は Event Log から都度計算する Engine の純関数 `tournamentStandings` を足した。新しい Event・テーブル・マイグレーションは足しておらず、Event の版は 10 のまま。Cash の経路・Event・テストの期待値は変えていない。

## 初期調査

- 前提（main f1858ff）: 判断の正本は D80・D108・D129、docs/02 §7、docs/04 §3 / §12。P8-1（#183）の `SESSION_STARTED.tournament`（版 9）と P8-2（#184）の `HAND_STARTED.ante / tournament`（版 10）の上に作る。
- Orchestrator の `sessionAfterEvents` は mode に依らず、`HAND_FINISHED` の `stacks` から `nextHandSeating` で次の Hand の席・Button を決め、Hero の Stack 0 で `hero_busted`、残りが Hero だけで `hero_last_standing` の `SESSION_ENDED` を Hand の終わりと同じ追記で置いている。Tournament の Session もこの経路で既に終わる（CPU だけで続けない。D129）。
- Event Store が Hand の終わりの後ろに受け付けるのは `SESSION_ENDED` 1 つだけ。

## 設計方針

- **Event を足さない**: Elimination（Bust = Elimination。D108）は Tournament の Session の Hand の `HAND_FINISHED.stacks` の 0、終了は `SESSION_ENDED`（`hero_busted` / `hero_last_standing`）として既に Event Log にある。Elimination の Event を別に足すと、同じ事実の二つ目の表現になり（食い違いうる）、版 9・10 で保存した Tournament（Elimination の Event が無い）を読む別の経路も要る。D129 の「Elimination・終了は Event Log に残し」はこれで満たし、版は上げない（Event Store・`session_projections` の CHECK も変えない）。PR の Review Required に記載。
- **順位の計算（`packages/engine/src/tournament-standings.ts`）**: Session の Hand の Event Log（論理順序）を畳み込む。Hand ごとに、座っていて `HAND_FINISHED` の Stack が 0 になった Player をその Hand の Bust とし、順位は「その Hand の後に残った人数 + 1 + 同じ Hand で開始時の Stack が自分より多かった人数」（同じなら同順位。OI-007 の暫定 Policy。docs/02 §7 の既存の記述）。残りが 1 人ならその 1 人が 1 位。Hero を知らない（Hero の順位は呼び出し側が引く）。cash の Session・`SESSION_STARTED` の無い旧版の Session は null。矛盾する Log（Bust した Player がまた座る・Session の終わりの後の Hand・全員の Bust 等）は RangeError。
- **状態**: `SESSION_ENDED` が無ければ `in_progress`、`hero_busted` / `hero_last_standing` は `finished`、`ai_outage` は `abandoned`。
- **人間判断を経ていない規則（OI-007 の暫定 Policy として docs/02 §7・docs/11 に明記）**: `ai_outage` で打ち切った Tournament は、それまでに Bust した Player の順位だけを決め、残っていた Player（Hero を含む）の順位は決めない。
- **解釈（Review Required）**: Hero が Heads-Up で Bust したときの残った CPU は、残りが 1 人なので 1 位とした（D129 の「残った CPU の順位は未決」は 2 人以上が残る場合と読んだ）。
- **Server**: Orchestrator に `tournamentStandingsOf(handId)`（その Hand の Session の終わった Hand〔`sessionHandIds`〕から計算）を足した。API・UI への表示は #190、Payout は #186。

## 変更内容

- Engine（`packages/engine`）
  - `src/tournament-standings.ts`（新規）: `tournamentStandings`・`TournamentStandings`・`TournamentPlacement`・`TournamentStatus`。
  - `src/tournament-standings.test.ts`（新規）: 積んだ Deck と All-in で Engine を実際に進めるテスト 6 件（同時 Bust の開始時 Stack 順と同順位・Hero 優勝 / `nextHandSeating` での Heads-Up 移行〔Button = SB〕と Hero の Heads-Up の Bust / CPU が 2 人以上残る Hero の Bust / `ai_outage` の打ち切り / 矛盾する Log / cash・旧版は null）。
  - `src/index.ts`: export。`src/tournament.ts`: 冒頭コメントの参照先。
- Server（`apps/server`）
  - `src/hand-orchestrator.ts`: `tournamentStandingsOf`。
  - `src/tournament-session.test.ts`: Hero が All-in を続ける Tournament を終わりまで進め、終了理由・Hero の順位・未決の CPU の数・Bust した席が次の Hand に座らないこと・決定論を確かめる（seed 固定で 6 Hand・Hero 3 位・同じ Hand で Bust した 2 人が同順位の 5 位・CPU 2 人が未決）。cash の Session は null。
- Docs: docs/02 §7（Elimination・終了と順位・打ち切りの暫定 Policy）、docs/03 §1（Tournament の Elimination と順位）、docs/04 §3（`SESSION_ENDED` の行・「Tournament の Elimination・終了と順位」・版 10 のままの理由）・§12、docs/11 OI-007。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（worktree のルート）: すべて成功（engine 422 件・web 147 件・server 801 件）。
- Cash の既存のテストの期待値は変更していない（Cash の Session の `tournamentStandingsOf` は null を追加で確認）。

## 残課題

- Payout（同順位の賞金の合算と等分・端数）は #186。順位の `place` と同順位の人数から計算する。
- 卓 UI での残人数・順位の表示は #190。
- `ai_outage` の打ち切りの扱いは人間判断を経ていない暫定 Policy（OI-007）。
