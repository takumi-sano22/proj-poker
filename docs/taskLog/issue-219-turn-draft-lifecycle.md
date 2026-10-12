# Issue #219: UX-04 Hero の操作の下書き（TurnDraft）の寿命・保持・再確認の本実装

## 目的

D146（UX04-1〜3=A）に従い、Hero の未送信の操作の下書き（手元の Chip・Betting Area に出した Chip と宣言・その順番）を、
画面の切り替えより上の層に Session（通常の卓 / Drill）ごとのメモリで持ち、錨（組み始めた時点の displayed の `operationKey` と状況）で
有効性を決め、同じ局面で状況が変わったら送る前に再確認させる。送信の開始を受理と取り違えず、通信の失敗・応答の消失・`stale_view` でも
下書きを安全に扱う。Engine・Event・API・DB と #226 の Ack の契約は変えない。検証は PR #242（`issue-219-draft-lifecycle-design.md`）。

## 変更内容

1. **規則の純関数（`apps/web/src/lib/turn-draft.ts`・新規）**: `DraftState = { slot, discarded }`、`DraftSlot = { anchorKey, anchorContext, draft, change, inFlight }`。
   - `edit`: 下書きが無ければ今の displayed の `operationKey` と `anchorContext`（`currentBet`・Hero の `streetCommitted`）を錨にして組み始める。
     中身を全部戻したら持たない。編集したら出していた再確認は取り下げる。送った操作の結果を待つ間は変えない。
   - `reconcile`（displayed / authoritative が変わるたび）: 送った操作の結果は authoritative で判定し（`operationOutcome`）、受理なら黙って捨てる。
     有効性は displayed で判定し、`operationKey` の変化（Hand / Street / Hero への裁定）・Hand の完了・Fold / All-in で捨て、中身があれば通知を作る。
   - `checkSend` / `confirmChange`: 送る直前に錨を照合。key が違えば捨てる、状況が違えば `change = {from, to, actions}` を出して送らない、
     確定はそのときの状況が `to` と同じときだけ（違えば `to` を更新して示し直す）。
   - `markSending` / `settleSend`: 送った `lastSeq`・操作を記録（`sending`）。応答の受理で捨てる、拒否で元の下書きに戻す（Fold / Check / Call /
     All-in の宣言は元の下書きに無い）、応答が届かなければ `unknown`（同じ操作の再送だけ）。結果不明の後の再送が拒否されても、前の送信の結果が
     最新の View で分かるまで固定を解かない。
   - 受理の判定: server は受理した操作の Event（`PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION`）を送った `lastSeq` の直後に足す。直後の Event が
     Hero のそれなら受理、別の Event なら `lastSeq` の完全一致（stale_view）で受理されていない。最初は「直後が `DEALER_RULING`」で書いたが、
     実際の Engine の追記の順（操作の Event → 裁定 → Action）でテストが落ちて気づき、直した。
2. **所有層（`useHandSession`）**: `turnDraft`（`draft` / `change` / `phase` / `discarded` / `edit` / `submit` / `confirm` / `resend` /
   `dismissDiscarded`）を足し、旧 `operate` を置き換えた。`submit` は応答の結果を `onSettled` で伝える（network / unknown は結果不明、他は拒否）。
   物理的な操作は `lastFailed` の再送から外し、下書きの層の `resend` が送ったときの `lastSeq`・操作で送り直す。`stale_view` は状態を読み直す
   （自動で送り直さない）。Ack 待ち（`pendingRulingSeq`）では送らない。表示が最新でなければ送らずに同期し、最新の View で錨を照合する。
3. **画面**: `ChipControls` は下書きを props で受けるだけにし（`useState` を外した）、再確認の欄（`.draft-change`）と結果不明の再送の欄を出す。
   `DraftNotice.tsx`（新規）が捨てた通知を Hero の欄の案内の下に `role=status` で出す（`DRAFT_DISCARD_NOTICE_MS` = 6,000ms。OI-012 の暫定値。
   RULING / ETIQUETTE の欄の間も `.notice` なので隠れない）。`App.tsx` の `ChipControls` は送信中・結果不明の間も押せない。
4. **検証テスト T2 の置き換え（`draft-lifecycle-verification.test.ts`）**: 「CPU の Raise で key が変わらない（状況の変化を検知しない）」を、
   key は変わらないが `anchorContext` の変化を検知し、下書きを保持したまま送らず、明示の確定で組んだとおりの操作を送る成功条件へ置き換えた。
5. docs: `docs/03`（クライアントの節に下書きの層）・`docs/06`（§5 の下書き・§16 冒頭・§16.3 の実装・§16.4 の送信・§16.8）・`docs/10`（D146 の行）・
   `docs/11`（OI-012 の暫定値）・`ui-design-recipes/references/proj-poker.md`。`docs/04` は「下書きは Event に入れない」が既に実装と一致。

## 状態遷移（送信中・再確認中・裁定確定時）

| 状態 | 入り口 | 出口 |
|---|---|---|
| 無し | 初期・捨てた後・受理の後 | Chip を手に取る / 出す / Bet・Raise の宣言（錨を記録）、または空の下書きで Fold / Check / Call / All-in を送り始めた |
| 編集中（idle） | 組み始めた | 送る（照合へ）・`operationKey` の変化 / Hand の完了 / Fold・All-in で破棄（中身があれば通知）・全部戻して無しへ |
| 再確認中（change） | 送る直前の照合で状況が違う | 確定（状況が `to` と同じなら送信へ・違えば `to` を更新して留まる）・編集で取り下げ（idle へ）・key の変化で破棄 |
| 送信中（sending） | 照合を通って送り始めた | 応答 200 または最新の View で受理 → 無し（通知なし）／拒否 → idle（宣言は外れる）／届かない → 結果不明 |
| 結果不明（unknown） | 応答が届かない | 最新の View で受理 → 無し／最新の View で別の Event が先 → idle／再送 → 送信中（前の結果不明を引き継ぐ） |

## 判断理由

- 所有層を `useHandSession` に置いた: 通常の卓と Drill の卓が既に別々の `useHandSession` を App（画面の切り替えより上）で持ち、送信・同期
  （D143）・Ack（D145）の状態もそこにあるため。新しい Context・store を足さない（KISS）。
- 規則を純関数に分けた: web のテストは DOM を持たない（`renderToStaticMarkup`）ので、寿命の規則は実際の Engine で Hand を進めて確かめられる
  形にした（`turn-draft.test.ts`）。
- 受理の判定に server の新しい応答・Event を足さない: 既存の `stale_view`（lastSeq の完全一致）と、受理の追記の順（操作の Event が直後）だけで
  決まるため。API / Event / DB の契約変更が要らない。
- 状況の比較は `currentBet` と Hero の `streetCommitted` に限った（D146 の例示）。Pot や他席の Call は Hero の Call の額を変えないので再確認しない。
- 再確認の後の送信は、確定の時点の状況が示した `to` と同じときだけ（古い確認を使わない）。

## 実行した確認

- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 493・web 301・server 940 passed。web に turn-draft 21 件・T2 の置き換え・component 4 件を含む）
- E2E 全体 `pnpm --filter @proj-poker/e2e e2e`: 37 passed（8.1m）。新規 `e2e/tests/turn-draft.spec.ts` 10 件（HU 卓・固定 seed・CPU の思考待ちを `BOT_THINK_DELAY_MS` で作る。障害は `page.route` だけで起こし server に注入しない）:
  Home / Learn / Replay 往復の保持、CPU の Raise の再確認（確定まで POST なし・確定で 1 回だけ組んだとおり）、空の下書きは通知なし、Street の変化の通知、
  応答の消失（受理済み → 通知なしで消える）、応答が届かない（同じ lastSeq・actions の再送）、stale_view（宣言は残らず自動再送なし）、Out-of-Turn（保留で消費・通知なし）、
  ETIQUETTE の Ack 待ち（操作欄が隠れ Home 往復でも再表示・確認後の下書きの保持）、320×568（hit-test・横スクロールなし・Tab + Enter で確定）
- 1 回目の E2E 全体の実行では etiquette-ack（SSE 再接続）・learning の 2 件が落ちたが、実行中にソースを編集して Vite が再読み込みしたためで、個別の再実行と編集を止めた全体の再実行で pass
- 自己レビュー（reviewer agent）: P0 / P1 なし。P2（結果不明の後の再送が「適用されていないと分かる拒否」でも固定が解けない）を CONFIRMED として修正、
  P2（E2E 未コミット）はレビュー時点の見え方で FALSE_POSITIVE（26e1d5e でコミット済み）。P3 のうち、応答の後の照合し直し・結果不明のまま別 Hand で通知しない・
  再送の Ack 待ちの照合・別 Hand へ移ったときの案内・docs の例外の明記を修正。Drag の Drop が古い View を錨にする稀な競合は、送信の照合で捨てられるので accept

## 残課題・#227 へ引き継ぐ QA

- CPU の障害（Outage）のダイアログの間の保持は、下書きが View だけで照合され障害で消えないことを純関数のテストで確かめた。実ブラウザで障害を
  決定論的に起こす手段が無い（RuleBot は失敗しない）ので、Outage の表示中・Retry / Emergency Bot の後の下書きは #227 の実機 QA で確かめる。
- E2E で決定論的に作れなかった局面（#227 へ）: 手番外の下書きを保ったまま Hand が完了する・Fold / All-in で外れる局面の通知、Hand 途中の Review 往復
  （入口が無い）、「応答だけ消失」で再送ボタンが見える瞬間（SSE と競合する。届かない場合はテスト済み）、Ack 待ちの前に組んでいた下書きの保持（ETIQUETTE を
  起こす操作で下書きは消費される。Ack 待ち中は操作欄が隠れ組めない）。これらは純関数のテスト（`turn-draft.test.ts`）で規則を確かめた。
- 通知の文言・表示時間（OI-012）は Playtest で見直す。
