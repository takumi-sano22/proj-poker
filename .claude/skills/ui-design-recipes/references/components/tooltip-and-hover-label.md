# ツールチップとホバーラベル

> **いつ読むか**: hover / focus で補足を出すとき（ツールチップ）／一覧の行やカードにカーソル追従の
> 行動ラベルを出すとき／タッチ環境での代わりを用意するとき
> **前提**: `foundations/contrast-and-a11y.md` §8（hover 能力による出し分け）、`foundations/motion.md`
> （所要時間トークン）
> 形の値・遅延時間はそのまま再現してよい。

## 目次

1. 要点
2. (a) 要素基準の CSS ツールチップ
3. (b) ポインタ追従のホバーラベル
4. (c) タッチでの代わり
5. (d) `title` 属性の位置づけ
6. 落とし穴
7. チェックリスト

## 1. 要点

- **表示条件は「画面幅」ではなく「hover / pointer の能力」で決める**（`foundations/contrast-and-a11y.md`
  §8）。タッチ対応の大画面端末を取りこぼさないため。
- CSS だけで済む場面（要素に固定して出す）と、JS が要る場面（カーソルに追従させる）を分ける。
  追従させないなら CSS の `group-hover` で足りる。
- **`group-focus-visible` は使わない。** group を持つ要素自身が `:focus-visible` である
  ことを見る変種で、group がフォーカスできない `<div>` なら永久に発火しない。子孫のフォーカスを
  拾うには `group-has-[:focus-visible]` を使う。
- タッチには hover の概念が無い。**常時ラベル表示**か**長押しでポップアップ**のどちらかに倒す。
- `title` 属性はネイティブのツールチップとして補助に使えるが、単独の説明手段にはしない。

## 2. (a) 要素基準の CSS ツールチップ

追従させず、トリガーに対して固定位置に出す場合。

```html
<span class="group relative inline-flex">
  <button aria-describedby="tip-1">…</button>
  <span id="tip-1" role="tooltip" class="…">補足の説明</span>
</span>
```

- **`role="tooltip"` を付けるだけでは読み上げられない。** ツールチップに一意な `id` を付け、トリガーから `aria-describedby` で参照して初めて、
  トリガーの説明として支援技術に伝わる（React なら `useId()` で id を作る）。
- **ツールチップの文言がトリガーの名前（見えるラベル・`aria-label`）と同じなら結ばない。** 名前と説明で同じ文が二度読まれる。
  アイコンだけのボタンで「名前＝ツールチップの文言」なら `aria-label` だけで足り、ツールチップは見える人向けの表示になる。

```
pointer-events-none absolute bottom-full right-0 z-10 mb-1
whitespace-nowrap rounded-control bg-ink-800 px-2 py-1
text-xs text-on-brand shadow-raise
opacity-0 transition-opacity duration-[var(--duration-quick)] ease-standard
delay-0 pointer-fine:group-hover:delay-500
pointer-fine:group-hover:opacity-100 group-has-[:focus-visible]:opacity-100
```

| 項目 | 値 | なぜ |
| --- | --- | --- |
| 位置 | `absolute bottom-full right-0 mb-1`（上向き・右揃え） | トリガーの上に出す既定。下向きに出す場所（画面上端付近のヘッダー等）は `top-full mt-1` に読み替える |
| 面 | `bg-ink-800 text-on-brand` | 会話面の brand 系とは無関係な中立の濃色。一時的にしか出ない面なので、常時表示の濃い塗りの上限（画面 4 種類まで）の枠外として扱ってよい |
| 角丸・影 | `rounded-control`・`shadow-raise` | 操作に付随する小さな浮き面 |
| 表示条件 | `pointer-fine:group-hover` ＋ `group-has-[:focus-visible]` | ポインタが正確な環境の hover と、キーボードフォーカスの両方で出す。`pointer-fine` は Tailwind v4.1 以降の**組み込み** variant（`@media (pointer: fine)`）で、v4 の `group-hover` は `@media (hover: hover)` を内包するので、組み合わせると `hover-fine` と同じ条件になる。v4.0 以前や Tailwind を使わない場合は `@media (hover: hover) and (pointer: fine)` を書く |
| 支援技術への伝え方 | 補足なら `id` ＋ トリガーの `aria-describedby`、名前と同じ文言なら `aria-label` だけ | `role="tooltip"` 単独では説明として読まれない |
| 出るときだけ遅延 | `delay-0 pointer-fine:group-hover:delay-500` | 消えるときは即座に、出るときだけ 500ms 待つ。一覧を流し見るときに全部のツールチップが明滅しないようにする一方、フォーカス移動（`group-has-[:focus-visible]`）はこの遅延を継承しないので即時に出る |

**落とし穴（重要）**: `group-focus-visible:opacity-100` は**wrapper 自身がフォーカス可能な要素で
ない限り発火しない**。トリガーが wrapper の子（`<button>` 等）で、wrapper 自身は `relative` の
ためだけの `<div>` である構成では、子がフォーカスされても wrapper は `:focus-visible` にならない。
子孫のフォーカスを拾うには `group-has-[:focus-visible]` を使う。実装済みの箇所とそうでない箇所が
混在すると「キーボードでは出ないツールチップ」が静かに残るので、この 2 つを混同していないか
横断的に確認する。

**祖先が `overflow: hidden` / `overflow: auto` を持ち、ツールチップが切れる場合**:
`position: absolute` を諦めて `position: fixed` に変える。fixed は overflow を持つ祖先の
影響を受けず、containing block が viewport になるため `right` 起点の幅計算も安定する。
**ただし祖先に `transform` / `filter` / `backdrop-filter` があると、fixed の基準がその祖先に移る**（viewport 基準にならない）。
半透明の面で `backdrop-blur` を使う画面は特に踏みやすいので、そういう祖先が無いことを確かめてから fixed にする。
表示の出し分け（`group-hover` 等）は DOM の親子関係で決まるので `fixed` に変えても効き続けるが、
**位置（`top` / `left` / `right` / `bottom`）は viewport 座標になるので JS で測り直す**必要がある。
表示中だけ `scroll`（capture）と `resize` を購読し、隠れたら購読を解除する。

## 3. (b) ポインタ追従のホバーラベル

一覧の行やカードで、カーソルの少し先に「次に何が起きるか」を出す場合。CSS の `:hover` だけだと
「カーソル座標が反映される前の 1 フレームだけ、別の位置に見えてから飛ぶ」ちらつきが起きるため、
表示の主導権を JS 側（visible state）に持たせる。

| 値 | 目安 | なぜ |
| --- | --- | --- |
| 出現までの遅延 | 200ms | 一覧を流し見る速度（1 行 100ms 未満で通過）では出ず、意図して止まったときだけ出る |
| カーソルからのオフセット | 右下へ +12px | 近すぎるとカーソル自身に隠れ、離れすぎると「今どこを指しているか」が読めない |
| クランプ | 対象矩形の内側に収める | ラベルが対象の外へはみ出さないよう、`矩形幅 − ラベル幅` を上限にして座標を丸める |

- **`pointerType === "mouse"` で判定する。** `matchMedia("(pointer: coarse)")` は端末の
  **主**ポインタの特性であって、いま使っているデバイスではない。マウスとタッチを併用できる
  環境では、マウス操作中でも coarse 側にマッチしうる。`PointerEvent.pointerType` は
  **そのイベントを起こしたデバイス**を表すので、マウスだけを正確に拾える。タッチ
  （`pointerType === "touch"`）は無視する（ホバーの概念が無く、タップすればそのまま遷移するため）。
- **座標を先に入れてからタイマーを張る。** 表示が 200ms 後なら、その時点では必ず座標が
  反映済みになり、「座標が入る前のフォールバック位置」が見える瞬間が構造的に発生しない。
- **離れた後もフェードが終わるまで座標を保持する。** 離れた瞬間に座標を消すと、opacity が
  0 へ落ちきる前の数フレームで、ラベルが className 側のフォールバック位置へ一瞬飛んで見える
  （フェード時間と同じだけ座標の破棄を遅らせて防ぐ）。
- **キーボードフォーカス経路は CSS のまま**（`group-focus` / `group-focus-within` で即時に
  className 側のフォールバック位置に出す）。`group-focus` が効くのは **group を持つ要素自身がフォーカスを受ける**
  場合だけ（カード全体が 1 つのリンク等）。group が非フォーカス要素なら `group-focus-within` / `group-has-[:focus-visible]` を使う（§2 と同じ理由）。フォーカスにはカーソル座標が存在せず追従できない
  上、意図的な操作なので遅延も不要。
- **data 属性の祖先に `addEventListener` する。** 一覧行がサーバーコンポーネントで
  `onMouseMove` を直接渡せない場合、ラベル自身をクライアントコンポーネントにし、マウント後に
  自分の祖先（`data-*` 属性を目印にする）へ addEventListener する形にすると、呼び出し側は
  data 属性を 1 つ付けるだけでサーバーコンポーネントのまま保てる。
- ラベル要素は `aria-hidden="true"`（装飾的な予告であって、遷移先の情報は別途アクセシブルな
  名前で持っているため）。

## 4. (c) タッチでの代わり

hover そのものが無いため、常時表示か長押しのどちらかに倒す。

**常時ラベル**（ラベルが常設できるだけの余白がある場合）:

```
hidden [@media(hover:none)]:inline
```

**長押しポップアップ**（余白が無く、hover 用のラベルを隠している場合の代替）:

| 項目 | 値 |
| --- | --- |
| 判定 | `pointerType === "touch"` のときだけ（マウスの長押しでは出さない） |
| 遅延 | 500ms（`pointerdown` から） |
| 中断条件 | `pointerup` / `pointercancel` / `pointerleave` / スクロール |
| 成立後 | 直後の `click` を握りつぶす（実際の機能を発火させない） |
| 右クリックメニュー | `contextmenu` の既定動作を常に抑止する |

- **`pointerdown` のたびにフラグを戻す。** 長押しが成立した後（フラグが立った状態）で
  `pointerleave` 等により `click` に届かず、フラグが立ったまま残ると、次に来る**別デバイス**
  （マウス）の `click` まで誤って握りつぶしてしまう。判定対象外で早期に処理を終える前に、
  必ずフラグをリセットする。
- **無効化されたボタンは pointer イベントを発火しない。** ハンドラは「常に pointer-events を
  持つラッパー」側に付け、内側の `<button disabled>` には付けない。
- 押している間だけ `scroll` を capture で監視し、発生したら長押しをキャンセルする
  （タイマー中の中断・表示済みポップアップを閉じる、の両方を兼ねる終了処理にする）。
- 位置・見た目は hover 用ツールチップと共有し、**表示条件だけ** JS 制御に切り替える。

## 5. (d) `title` 属性の位置づけ

ネイティブの `title` はマウスユーザー向けの補助として併記してよいが、単独の説明手段にはしない
（表示までの遅延・見た目がブラウザ依存、タッチ・キーボード操作では実質出ない）。
可視ラベルが短い（アイコンのみ・単語 1 つ）操作要素では、`aria-label` に完全な説明を持たせた上で、
`title` にも同じ内容を書いておくとマウスユーザーへの即時の手がかりになる。

## 6. 落とし穴

- **`group-focus-visible` と `group-has-[:focus-visible]` を混同する。** 前者は group 要素
  自身のフォーカス、後者は子孫のフォーカス。wrapper が非フォーカス要素なら前者は永久に発火しない。
- **`(pointer: coarse)` で「いま使っているデバイス」を判定する。** マウスとタッチを併用できる
  環境で誤判定する。イベントの `pointerType` を見る。
- **離脱と同時に座標を消す。** フェードアウトの途中でフォールバック位置へ飛んで見える。
- **`absolute` のまま overflow を持つ祖先の中に置く。** 片方の軸だけ `overflow: hidden` でも
  仕様上もう片方も非 `visible` に強制され、ツールチップがクリップされる。`fixed` に変える。
- **タッチの長押し判定にマウスの `pointerdown` も含める。** 長押しの意図が無い操作でポップアップが
  出てしまう。`pointerType === "touch"` で絞る。
- **画面幅で hover 前提の表示を出し分ける。** 640px 以上のタッチ端末（タブレット）は hover も無く、
  幅条件の代替表示も出ない。

## 7. チェックリスト

- [ ] 表示条件は hover / pointer の能力で出し分け、画面幅で代用していない
- [ ] キーボードフォーカスでも同じ情報が出る（`group-has-[:focus-visible]` を使っている）
- [ ] 補足のツールチップは `id` ＋ `aria-describedby` でトリガーに結んだ（名前と同じ文言なら `aria-label` だけにした）
- [ ] 追従させる場合は `pointerType === "mouse"` で判定し、座標を先に入れてからタイマーを張る
- [ ] 離脱後もフェードが終わるまで座標を保持している
- [ ] 祖先の overflow で切れる場合は `fixed` に変え、表示中だけ scroll/resize を購読している
- [ ] タッチでは常時ラベルか長押しポップアップのどちらかを用意している
- [ ] 長押しの判定は `pointerType === "touch"` に限定し、成立後の `click` を握りつぶしている
- [ ] `title` は補助として併記するに留め、単独の説明手段にしていない
