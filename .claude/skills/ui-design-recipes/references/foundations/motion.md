# 動き（所要時間・イージング・reduced-motion）

> **いつ読むか**: hover・開閉・入場のアニメーションを付けるとき／keyframes を足すとき／reduced-motion に対応するとき
> **前提**: なし
> 値はそのまま再現してよい。

## 1. 要点

- 所要時間とイージングは**トークン**で持つ（120 / 200 / 320ms・2 種類のイージング）。
- `prefers-reduced-motion: reduce` のときは、**`:root` でトークンをまとめて 0ms にする。**
  部品ごとに `@media` を書かなくても一斉に止まる。
- **keyframes にはこの一括停止が効かない。** 定義した直後に、その keyframes を止めるルールを必ず書く。
  止めた後も状態が分かる**静止形**を残す。
- `transition` は**必要なプロパティだけ**を列挙する。短縮形や `transition-colors` の既定集合は罠がある（§5）。
- 入場の演出は keyframes より `@starting-style` ＋ transition が扱いやすい（トークンの 0ms 化がそのまま効く）。

## 2. トークン

| トークン | 値 | 用途 |
| --- | --- | --- |
| `--duration-quick` | 120ms | hover・押下の即時の反応 |
| `--duration-base` | 200ms | 開閉・フェードなどの状態変化・入場 |
| `--duration-slow` | 320ms | 登場・レイアウトの移動 |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 状態変化の既定 |
| `--ease-emphasis` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 登場など少し弾ませたいとき（行き過ぎて戻る） |

```css
@theme static {
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-emphasis: cubic-bezier(0.34, 1.56, 0.64, 1);
  --duration-quick: 120ms;
  --duration-base: 200ms;
  --duration-slow: 320ms;
}
```

Tailwind v4 では `--ease-*` が `ease-standard` のようなユーティリティになる。所要時間はテーマの名前空間に無いので、
`duration-[var(--duration-quick)]` と任意値で書く。

**部品での書き方**:

```tsx
// hover で背景と影だけを 120ms で変える
"transition-[background-color,box-shadow] duration-[var(--duration-quick)] ease-standard"
```

```css
/* 素の CSS */
.button {
  transition-property: background-color, box-shadow;
  transition-duration: var(--duration-quick);
  transition-timing-function: var(--ease-standard);
}
```

## 3. reduced-motion の止め方（4 通り）

| # | 方法 | 効く範囲 | 書く場所 |
| --- | --- | --- | --- |
| 1 | `:root` でトークンを 0ms に上書き | トークン経由の transition すべて | グローバル CSS に 1 回 |
| 2 | keyframes ごとに `animation: none` | その keyframes だけ | keyframes の定義の直後 |
| 3 | `motion-reduce:animate-none` / `motion-reduce:transition-none` | トークンを使っていない既製のアニメ（`animate-pulse` 等）・固定値の transition | 部品のクラス |
| 4 | JS の `matchMedia("(prefers-reduced-motion: reduce)")` | `scrollTo({ behavior })` など JS が起こす動き | 呼び出し側 |

```css
/* 1. トークンを一括で 0 に */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-quick: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
  }
}

/* 2. keyframes は定義の直後で個別に止める（同じ詳細度なので定義より後ろに置く） */
.thinking { animation: think 2.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .thinking { animation: none; }
}
```

```ts
// 4. JS が起こすスクロール
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "instant" : "smooth" });
```

`"auto"` は「即時」ではなく「その要素の CSS `scroll-behavior` に従う」の意味なので、どこかで `scroll-behavior: smooth` を指定すると
reduced-motion でも動いてしまう。即時にしたいときは `"instant"` を明示する。

**静止形を残す**: 止めた結果、状態の情報まで消えてはいけない。

| 動き | 止めた後に残すもの |
| --- | --- |
| 発光の脈動 | 中間の強さの静止した光（`box-shadow` をそのまま残す） |
| 「続きがある」を示す点の上下運動 | 点そのもの（動きに意味を持たせない） |
| 生成中の揺れ | 文言・カーソルなど、動き以外で「生成中」が分かる表示 |
| 登場（ポップイン） | 最終状態で表示（`opacity: 1`・`transform: none`） |

**止め忘れの見つけ方**: keyframes を足した PR では、定義数と停止ルールを突き合わせる。

```bash
grep -c "@keyframes" app.css                      # keyframes の数
grep -n "prefers-reduced-motion" -A6 app.css      # 止めているクラス
```

アニメーションクラスを使う部品のコメントに「CSS 側で止めている」と書く場合は、**実際に止まっていることを確認してから**書く。
コメントだけが正しく、実装が止まっていない状態はレビューで見落とされやすい。

## 4. 入場の演出（`@starting-style`）

条件レンダーで出す要素（ポップオーバー等）の「入り」だけを演出する。閉じるときは unmount されるので即時に消える。

```css
.popover {
  opacity: 1;
  transform: translateY(0) scale(1);
  transform-origin: bottom right;        /* 出てくる起点（トリガー側）に合わせる */
  transition-property: opacity, transform;
  transition-duration: var(--duration-base);
  transition-timing-function: var(--ease-standard);
}
@starting-style {
  .popover {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
}
```

- transition なので、reduced-motion のトークン 0ms 化がそのまま効く（keyframes だと個別に止める必要がある）。
- `@starting-style` に対応していないブラウザでは即座に表示されるだけで、情報は失われない。
- 移動量は 4px・縮小は 0.98 程度にとどめる。大きく動かすと「飛んでくる」印象になる。

## 5. 落とし穴

- **`transition` の短縮形を CSS に書かない。** Tailwind v4 のユーティリティは `@layer utilities` に入るので、
  レイヤー外に書いた CSS（グローバル CSS の独自クラス）は同じプロパティなら常にユーティリティより強い。
  短縮形 `transition: opacity 200ms` は、書いたつもりのない `transition-delay` などのサブプロパティまで初期値で固定するため、
  後から要素に足した `delay-*` などのユーティリティまで黙って無視される。**必要なサブプロパティだけを長い形**
  （`transition-property` / `-duration` / `-timing-function`）で書き、書いていないものはユーティリティに任せる。
- **`transition-colors` は `outline-color` も遷移させる。** `outline-color` の初期値は `currentColor` 相当なので、
  白文字のボタンではフォーカスリングが白から始まり、120ms の間だけ濃い塗りの上で見えなくなる。
  キーボードで素早く移動すると常に見えない。**グローバルに `outline-color` の既定値をフォーカス色に固定する**:

  ```css
  * { outline-color: var(--color-focus); }
  ```

  フォーカス前後で値が変わらないので遷移そのものが起きない。各要素の `focus-visible:outline-focus` は冗長になるが害は無い。
- **トークンを使わずに `duration-300` のような固定値を書く**と、一括停止から外れる。やむを得ない場合は
  `motion-reduce:transition-none` を併記する。
- **hover の影の transition と、発光などの keyframes を同じ `box-shadow` に載せない。** 食い合う。発光は前面の別要素に分ける。

## 6. チェックリスト

- [ ] 所要時間・イージングはトークン経由（固定値なら `motion-reduce:` を併記）
- [ ] 足した keyframes に reduced-motion の停止ルールがあり、止めた後も状態が分かる
- [ ] transition は必要なプロパティだけを列挙し、CSS の短縮形を使っていない
- [ ] `* { outline-color: var(--color-focus) }` が入っている
- [ ] reduced-motion をエミュレートして（ブラウザの開発者ツール・Playwright の `emulateMedia({ reducedMotion: "reduce" })`）止まることを確認した
