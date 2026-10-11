# Issue #219: UX-04 Hero の操作の下書き（TurnDraft）の寿命の先行技術検証

## 目的

D139（下書きはパネルの開閉や Home / Learn への移動では失わず、同じ Hand で有効な間は保持し、無効になったら破棄して通知する）を実装する前に、
「有効な間」の判定・下書きの所有層・送信前の再検証の契約を、今のコードと Engine の振る舞いから確かめる。
**設計・検証テスト・資料だけ**で、#218 の App Shell・#219 の UI・#222 の Presentation Controller・#226 の Ack・#230 の Session Lifecycle は実装しない。
ここの推奨と UX04-1〜3 は**人間の承認前の案で、採用済みではない**。

## 結論（要約）

1. **下書きの有効性の鍵は今の `operationKey(view)`（`handId:street:Hero への裁定の数`）で足りる**。CPU の Action で可視 seq が進んだだけ・Hero の手番が来ただけでは変わらず、Street・Hand・Hero への裁定（保留の Out-of-Turn とその解決を含む）では必ず変わる。受理された Hero の操作は必ず Hero への `DEALER_RULING` を 1 つ足すので、送った下書きは key の変化で必ず捨てられる（二重送信の原因にならない）。
2. **今の欠陥は「所有層」**: 下書きは `ChipControls` のローカル state で、`key={operationKey(view)}` 以外に、卓の画面から離れる（Replay / Review / Drill）・CPU の障害の Dialog・`DockBody` の早期 return でもアンマウントされて消える。D139 を満たすには、画面の切り替えより上（`useHandSession` と同じ層）へ移す必要がある。
3. **今の key では「Hero の状況の変化」を検知できない**: 手番外に組んだ下書きは、CPU の Raise で Hero の Call の額が変わっても残る。送れば Ruling Engine が裁定するので Event Log の正しさは崩れないが、Hero の意図と違う裁定になりうる。扱いは人間判断（UX04-1）。
4. 送信の安全性は、server の `stale_view`（lastSeq の完全一致）と D143（displayed と authoritative の同期と再検証）・D145（Ack 待ちの操作は 409）で保たれる。下書きの側で追加の API・Event・DB は要らない。
5. ブラウザの再読み込み後の復元はしない（D62・D139）。下書きはメモリだけに置き、`localStorage` / `sessionStorage` に入れない。

## 今のコードの事実（main・993268c）

| # | 事実 | 根拠 |
|---|---|---|
| 1 | `TurnDraft = { hand, ops }`。hand は手に取った Chip（戻せる）、ops は Betting Area に出した Chip と宣言（取り消せない） | `apps/web/src/lib/chip-ops.ts:17-22` |
| 2 | 下書きは `ChipControls` の `useState`。useEffect のリセットは無く、捨てるのはアンマウントだけ | `ChipControls.tsx:63` |
| 3 | `<ChipControls key={operationKey(view)}>`。key の変化で再マウントされて空に戻る | `App.tsx:672-673` |
| 4 | `DockBody` は Hand の完了・Session の終了・CPU の障害（`outage.current`）・Hero の席が無い・Fold・All-in で早期 return し、`ChipControls` ごと消える | `App.tsx:531,582,594,625,633,644` |
| 5 | 画面は `useState<Screen>`（table / replay / review / session_review / drill）。table 以外へ移ると `TableScreen` ごとアンマウントされる。`useHandSession` は App にあるので View・SSE は残り、消えるのは下書きだけ | `App.tsx:73-82,99,194-257` |
| 6 | `operationKey` は `handId:street:Hero への DEALER_RULING の数`。actorId・legalActions・lastSeq は含まない | `view-model.ts:341-346` |
| 7 | 送る lastSeq はクリックの時点の受信済みの最新 View の値（下書きを組み始めた時点の値ではない）。ネットワークの再送だけは最初の lastSeq と操作を送る | `useHandSession.ts:242-256,415-421,495-503` |
| 8 | server の `stale_view` は lastSeq の**完全一致**（古い・新しいのどちらも拒否）。physical-action は手番の判定より先に確かめる | `apps/server/src/hand-orchestrator.ts:893-906,810-830` |
| 9 | 手番外でも操作でき、保留中（`heroRulingStatus = pending`）は全ボタンが無効 | `App.tsx:651,670-677` |
| 10 | 宣言で手番が終わる操作（Fold / Check / Call / All-in）は即送信し、送った後も ops は下書きに残る（応答の裁定で key が変わって消える） | `ChipControls.tsx:88-93,205` |
| 11 | authoritative / displayed の分離（D143）は未実装。View は単一の state | `useHandSession.ts:220` |

## 検証テストで確かめた事実

`apps/web/src/lib/draft-lifecycle-verification.test.ts`（9 件。実際の Engine の `startHand` / `applyAction` / `applyPhysicalActions` / `resolvePendingOutOfTurn` / `projectHeroView` で Hand を進める）:

| # | 事実 |
|---|---|
| T1 | CPU の Action で可視 seq が進み Hero の手番が来ても、`operationKey` は変わらない |
| T2 | CPU の Raise で Hero の Call の額が増えても `operationKey` は変わらない（今の key は状況の変化を検知しない） |
| T3 | Street が変わると変わる（Hero の操作で閉じる場合も、CPU の Action で閉じる場合も） |
| T4 | Hand が変われば変わる |
| T5 | 受理された物理的な操作は必ず Hero への `DEALER_RULING` を 1 つ足し、key を変える（`settleRuling`） |
| T6 | 手番外の操作は保留の裁定で key が変わり、保留中の CPU の Action では変わらず、手番の到来で保留を解く裁定でもう一度変わる |
| T7 | 保留中の再操作は Engine が `not_actor` で拒否し、Event・key・lastSeq は変わらない |
| T8 | CPU の Action だけを演出している間は displayed と authoritative の key が同じで lastSeq だけが違う。displayed では Hero の手番がまだ見えない |
| T9 | 演出が Street の変わり目より前にあると、displayed と authoritative の key が違う |

二重送信と古い画面からの送信は、既存の server テストが `stale_view` で Log を変えないことを確かめている（`hand-orchestrator.test.ts:1375`「古い lastSeq（二重送信・古い画面）は stale_view で拒否し、Log を変えない」・`:1743`「古い画面からの操作は stale_view で拒否し、何も残さない」・`routes/live-presentation.test.ts:195`）。

## 検証項目ごとの分析

### 1. CPU の Action で可視 seq が進んだだけの場合

保持できる（T1・T8）。条件は「同じ Session の卓（通常の卓と Drill は別）・同じ `operationKey`・Hand が進行中・Hero がまだ Hand に残っている」。lastSeq は送る直前の同期で最新に合わせるので、下書きに lastSeq を持たせない（事実 7 の今の方式のまま）。

### 2. 無効になる条件

`operationKey` が変わったとき（Street・Hand・Hero への裁定。T3〜T6）に破棄する。加えて、key と独立に次でも破棄する（今は `DockBody` の早期 return で暗黙に消えている）:

- Hand の完了（`status: complete`）・Session の終了・新しい Session（#230 の終了 / 一時中断も含む。下書きのスコープが Session なので）
- Hero が Hand から抜けた・操作できなくなった（Fold・All-in。操作による Fold / All-in は Hero への裁定を伴うので key でも変わるが、Blind / Ante の支払いで All-in になる場合は裁定を伴わないので、`folded` / `allIn` の状態でも判定する）

**CPU の障害（Outage）では破棄しない**（今は Dialog の表示で消える。D139 の「同じ Hand で有効な間は保持」に反するので、所有層を移す実装で直す）。障害の間も手番外の操作は送れる（#226 の検証の事実 7）ので、下書きを残してよい。

### 3. Out-of-Turn の下書きと、その後の状況の変化

- 手番外で組んだ下書きは CPU の Action を越えて残る（T1）。送れば Out-of-Turn として保留の裁定になり key が変わる（T6）。保留中は全ボタンが無効なので、保留の裁定と解決の間に新しい下書きは作れない。
- **欠落**: 手番外に組んで送らずにいる間に CPU が Bet / Raise すると、Hero の Call の額が変わっても下書きは残る（T2）。その後に送ると、その時点の最新の lastSeq で送るので受理され、Hero の意図（例: BB 分の Call のつもりの Chip）と違う裁定（額の足りない Chip 等）になりうる。Event Log の正しさは Ruling Engine が守るので壊れないが、UX の扱いは人間判断（UX04-1）。

### 4. authoritative と displayed が異なる間

D143 の契約どおり: 下書きは演出中も組めて保持し、送信の前に残りの演出を高速化して displayed を authoritative に追いつかせ、そこで再検証する。

- **下書きの錨（anchor）は「組んだときに Hero が見ていた displayed の `operationKey`」**にする。Hero は displayed の卓を見て組むので、authoritative の key に錨を置くと、演出が Street の変わり目の前にある間に組んだ下書き（T9）を見逃す。
- 送信の手順: (1) 同期（displayed = authoritative）→ (2) 錨の key と `operationKey(authoritative)` を比べ、違えば破棄して通知・送信しない → (3) 同じなら手番・Ack 待ち（D145）・送信中でないことを確かめる → (4) `lastSeqOf(displayed) === lastSeqOf(authoritative)` の値で送る。
- 同期の前に最新の lastSeq を先取りして送らない（D143）。displayed では Hero の手番がまだ見えない局面がある（T8）ので、操作の可否も同期の後に判定する。
- #222 の実装前は displayed = authoritative なので、錨は今の `operationKey(view)` と同じになる。

### 5. ETIQUETTE の Ack 待ち（D145）

- Ack は Event を足さないので、Ack の前後で key も lastSeq も変わらない。Ack 待ちになるのは Hero の操作への裁定の直後なので、その時点で送った下書きは key の変化ですでに捨てられている。
- Ack 待ちの間に組んだ下書きは保持してよいが、送れない（server が 409 `etiquette_ack_required`）。client は Ack 待ちの間、確定・宣言を押せない状態にする（押せる状態にして 409 を見せない）。
- Ack の後に CPU が進み Street が変わったら、上の 2 のとおり key の変化で破棄する。Ack 自体は下書きを無効にしない。

### 6. 画面遷移・アンマウントで失わない所有層

- 下書きを `ChipControls` から出し、**`useHandSession` と同じ App の層（#218 の App Shell が画面を切り替える場所より上）に、Session ごと（通常の卓 / Drill）のメモリの store として置く**。中身は `{ anchorKey, draft }` だけ。`ChipControls` はそれを読み書きするだけにして、`key={operationKey(view)}` による再マウントの破棄はやめ、store の側で「錨の key と今の key（displayed）が違えば破棄」を判定する。
- パネルの開閉・狭い画面の切り替え・Home / Learn / Replay / Review への移動と復帰では、store が残るので失わない。復帰したとき key が変わっていれば、その時点で破棄して通知する。
- `localStorage` / `sessionStorage` / IndexedDB に入れない（再読み込みで消えてよい。D62）。Event にも入れない（D90・docs/04「表示の状態は Event Log に入れない」）。

### 7. 無効化の通知と二重送信・`stale_view`

- 通知: 破棄した下書きに hand か ops が 1 つでもあったときだけ、Hero の操作パネルの近くに非モーダルの短い通知を出す（例:「局面が進んだため、組んでいた操作を戻しました」）。空の下書きの破棄では出さない（UX04-3）。
- 二重送信: 受理された操作は必ず key を変える（T5）ので、送った ops が残って再送されることはない。応答の前の再クリックは今どおり送信中で無効、ネットワークの再送は最初の lastSeq なので、先の送信が受理済みなら `stale_view` で何も起きない（server テスト）。
- `stale_view` を受けたとき: 下書きは残す（Event が足されていないので key も同じことが多い）。自動で送り直さず、同期と再検証（4）の後に Hero がもう一度確定する（今の `retryable: false` と同じ）。

### 8. 再読み込みと D62

再読み込み・プロセスの再起動の後に下書きを復元しない（D62・D139・#219 WHAT）。store はメモリだけなので自然に満たす。Hand の途中の完全な復帰も求めない。

## 推奨の下書きの寿命の契約（承認待ち）

```ts
// apps/web の表示状態（Event Log・API・DB には入れない）。Session（通常の卓 / Drill）ごとに 1 つ。
interface DraftSlot {
  /** 組み始めたときに Hero が見ていた displayed View の operationKey（handId:street:Hero への裁定の数）。 */
  readonly anchorKey: string;
  readonly draft: TurnDraft; // { hand, ops }
  // UX04-1 で A を採るとき: 組み始めたときの Hero の状況（currentBet と Hero の streetCommitted）
  readonly anchorContext?: { readonly currentBet: number; readonly heroCommitted: number };
}
```

| 局面 | 下書き | 送信 |
|---|---|---|
| CPU の Action で seq だけ進む・Hero の手番が来る | 保持 | 同期の後に送れる |
| Street / Hand が変わる・Hero への裁定が増える | 破棄して通知（空なら通知しない） | — |
| Hand の完了・Session の終了 / 新しい Session | 破棄 | — |
| CPU の障害（Outage）の Dialog | **保持**（今は消えている） | 手番外の操作は今どおり送れる |
| ETIQUETTE の Ack 待ち（D145） | 保持 | 押せない（server も 409） |
| 演出中（displayed ≠ authoritative） | 保持 | 同期 → 錨の key と照合 → 一致なら displayed = authoritative の lastSeq で送る |
| パネルの開閉・Home / Learn / Replay / Review への移動と復帰 | 保持（復帰時に key を照合） | — |
| `stale_view` | 保持 | 自動で送り直さない |
| 再読み込み・再起動 | 復元しない（D62） | — |

## 関係する Issue との境界

- **#218（App Shell）**: 下書きの store は App Shell が画面を切り替える層より上に置く。#219 の実装は #218 の後（#219 の Blocked by のとおり）。今の `Screen` の切り替えでも同じ層（App）に置けば足りる。
- **#222（Presentation Controller）**: 錨に使う displayed View を提供する。#222 の前は displayed = authoritative。送信前の同期（残りの演出の高速化）は #222 の責務で、#219 はその後の再検証だけを持つ。
- **#226（Ack）**: Ack 待ちの間は送信を無効にする表示の条件だけを #219 が使う。Ack の API・CPU の停止は #226。
- **#230（Session Lifecycle）**: Session の終了 / 一時中断は Hand の間で確定するので、下書きは Hand の完了で先に破棄されている。Session のスコープが変われば store を空にするだけで、#230 の永続化に下書きを入れない。

## 人間判断が必要な論点（#215 Gate 1 で承認を求める。いずれも未採用）

| ID | 論点 | 推奨 | 他の選択肢 |
|---|---|---|---|
| UX04-1 | 手番外に組んだ下書きの後で CPU の Bet / Raise により Hero の状況（Call の額）が変わったとき | **A**: 下書きは保持し、送る前に「組んだ後に卓が変わった」と示して確定をもう一度求める（`anchorContext` と比べる） | B: ops を破棄して通知し、hand（手に取った Chip）だけ残す / C: 今どおり key だけで判定し、そのまま送れる（裁定は Ruling Engine に任せる） |
| UX04-2 | 下書きの所有層と保存先 | **A**: App の層（`useHandSession` と同じ。#218 の画面の切り替えより上）に Session ごとのメモリの store。再読み込みで消える | B: `sessionStorage` に置き再読み込みでも残す（D62 では不要・古い局面の復元と照合の手間が増える） |
| UX04-3 | 無効化の通知 | **A**: 中身があった下書きを破棄したときだけ、Hero の操作パネルの近くに非モーダルの短い通知（文言は OI-012 の暫定値） | B: 通知しない（D139 の「通知」を満たさない） / C: モーダルで確認を求める（進行を妨げる） |

いずれも Event・API・DB・Engine の意味を変えない。承認の後、実装の前に `docs/decision_log.yaml` へ新しい D 番号で記録し、`docs/06`・`11` を同期する（`decision-log` skill）。

## 実装時のテストへの引き継ぎ

- store の単体テスト: 錨の key と今の key の照合・Session ごとの分離・Outage で保持・Hand の完了で破棄・通知の要否（空の下書きでは出さない）
- 画面の遷移（React Testing Library 等）: パネルの開閉・Replay / Review / Drill への移動と復帰で hand / ops が残る・復帰時に Street が進んでいれば破棄と通知
- 送信: displayed ≠ authoritative のとき同期の後に照合し、key が違えば送らない / 同じなら displayed = authoritative の lastSeq で送る / Ack 待ちは送れない / `stale_view` で自動再送しない
- この PR の検証テスト（`draft-lifecycle-verification.test.ts`）は鍵の性質を固定するもので、T2 は UX04-1 で A / B を採ったときに `anchorContext` の比較のテストへ置き換える
- E2E（UX-12 #227）: 手番外で組んだ Chip が Home / Learn との往復で残る・Street が進むと通知が出る

## 変更ファイル

- `apps/web/src/lib/draft-lifecycle-verification.test.ts`（新規。検証テスト 9 件）
- `docs/taskLog/issue-219-draft-lifecycle-design.md`（本資料）
- `docs/06_UI_UX.md` §16.8 の UX-04 の行・`docs/11_OPEN_ITEMS.md` の UX-04 の行（本資料への参照だけ）

## 判断理由

- 新しい鍵を作らず `operationKey` を使う: T1〜T7 で、必要な無効化（Street・Hand・Hero の裁定）はすべて key の変化に現れ、保持したい変化（CPU の Action・手番の到来・Ack）では変わらないことを確かめた。足りないのは「状況の変化」（T2）だけで、それは鍵の問題ではなく UX の判断なので UX04-1 に分けた。
- 錨を displayed の key にする: authoritative の key だと、演出が古い Street を見せている間に組んだ下書きを Street の変化で捨てられない（T9）。
- 永続化しない: D62・D139 が再読み込みの後の復元を求めておらず、保存すると古い局面の下書きを照合する手間と誤送信のリスクが増える。

## 実行した確認

- `pnpm --filter web exec vitest run src/lib/draft-lifecycle-verification.test.ts`（9 passed）
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan）

## 残課題

- UX04-1〜3 の人間判断（#215 Gate 1）と D 番号への正本化
- #219 の本実装（#218 の後・Gate 1 の解除の後）
- 通知の文言・表示時間は OI-012 の暫定値
