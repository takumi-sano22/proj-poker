# カードとパネル（variant・elevation・padding・面のレシピとの対応）

> **いつ読むか**: カード・脇役の面・淡いグラデーションの面を作るとき
> **前提**: `foundations/surface-and-depth.md`（影 3 段・面のレシピ L1〜L4）
> 形の値（角丸・padding）はそのまま再現してよい。色は役割名で書く。

## 1. 要点

- `elevation`（高さ）と `variant`（質感）は独立した軸。混同しない。
- elevation は `rest` / `raise` / `overlay` の 3 段に固定する。カード自体が「持ち上げる」動きを持つわけではなく、渡す値を選ぶだけ。
- `variant="panel"` は L3（脇役の面）専用で、呼び出し側が elevation を渡していても影を強制的に消す。
- カードはどの variant も hover に反応しない。読む対象は静止のままにし、押せるように見せたいときは呼び出し側で hover を足す。
- padding も 3 段（`gutter` / `compact` / `none`）を prop で持つ。className での上書きは効かないことがある。

## 2. elevation（高さ）3 段

| elevation | クラス | 使う場面 |
| --- | --- | --- |
| `rest` | `shadow-rest` | 地に置かれた面（一覧の行・通常のカード） |
| `raise` | `shadow-raise` | 浮かせた面（hover 中・ドロップダウン・フロート要素） |
| `overlay` | `shadow-overlay` | 地から切り離した面（モーダル・シート・別ウィンドウに切り出した面） |

値は `foundations/surface-and-depth.md` の影 3 段そのもの。カードはこの 3 つのどれかを渡すだけで、独自の影は作らない。

## 3. variant（質感）5 種

| variant | 背景 | 縁 | 角丸 | 影の扱い |
| --- | --- | --- | --- | --- |
| `default` | `bg-surface-raised`（単色不透明） | `border-border` | `rounded-card`（16px） | elevation の指定どおり |
| `raised` | `bg-surface-gradient` ＋ `inset-shadow-edge` | `border-border` | `rounded-card` | elevation の指定どおり |
| `glass` | `bg-surface-raised/60` ＋ `backdrop-blur-md` | `border-brand-200/60`（淡い光の縁） | `rounded-card` | elevation の指定どおり |
| `panel` | `bg-surface-sunken`（単色・地より沈む） | `border-border` | `rounded-panel`（12px） | **常に `shadow-none`（強制）** |
| `raised-soft` | `bg-surface-gradient-soft`（`raised` より弱いグラデ）＋ `inset-shadow-edge` | `border-border` | `rounded-card` | elevation の指定どおり |

- `glass` だけ縁の色が違う（淡い光の縁）。カードは操作要素ではないので、この縁は WCAG 1.4.11 の 3:1 を課さない装飾の縁でよい（`foundations/contrast-and-a11y.md` §5）。
- `panel` だけ角丸が違う（12px の `rounded-panel`）。脇役であることを角の締まりで示す。

## 4. padding 3 段

| padding | クラス | 用途 |
| --- | --- | --- |
| `gutter` | `p-gutter` | 既定（画面端・カード内の余白） |
| `compact` | `p-3` | 狭い面に区画を重ねるとき |
| `none` | （なし） | 中身が自前の余白を持つとき（iframe・リスト等） |

呼び出し側が `className="p-3"` と書いても効かないことがある。Tailwind の勝敗は「クラス文字列の並び順」ではなく「生成される CSS の順序」で決まり、部品側で先に定義した padding のほうが後から生成されて勝つ場合がある。上書きしたい軸は prop で受ける（`button.md` §6 と同じ規律）。

## 5. panel は elevation を強制的に shadow-none にする

呼び出し側が `elevation="raise"` を渡していても、`variant="panel"` のときは `shadow-none` を優先する。段の一貫性（脇役の面は影を持たない）を、呼び出し側の指定ミスに関わらず保つため。

```ts
const shadowClass =
  variant === "panel" ? "shadow-none" : ELEVATION_CLASS[elevation];
```

## 6. hover を持たない理由

カードのどの variant も `hover:` クラスを持たない。面を区別する 3 つの軸（`foundations/surface-and-depth.md` §4）のとおり、hover の持ち上げは「押せる要素」だけの標識であり、読む面は hover に反応しない。カード自体は基本的に「読む対象」であって操作要素ではないため、部品側で反応させない。カードをクリッカブルにしたい場合は、呼び出し側が独自に `hover:` クラスを足す（カードは意匠を強制しない）。

## 7. 面のレシピ（L1〜L4）との対応

| カードの variant | 対応する層 | 一致の程度 |
| --- | --- | --- |
| `panel` | L3 脇役の面 | 一致（背景・角丸・影なしまで同じ） |
| `default` / `raised` / `raised-soft` | 明確な L 番号を持たない「読む対象の汎用カード」 | 角丸（16px）は L1/L2 と共通だが、専用のグラデーション・縁の色までは踏み込まない |
| `glass` | ボタンや入力欄の `surface` と同じ「不透明⇄半透明」の軸 | 特定の L 層固定ではなく、背景を透かす面の上に置くときの差し替え |
| L4（別レイヤー） | カードの対象外 | モーダル・シート専用の部品が担う（角丸 20px・`border-strong`・`shadow-overlay`） |

カードは「地に置く／浮かせた／切り離した」の 3 高さと「不透明／グラデ／半透明／脇役／弱グラデ」の 5 質感を組み合わせるだけの部品で、面のレシピの層番号そのものは持たない。層を厳密に再現したいとき（吹き出し・入力欄など）は、`surface-and-depth.md` のレシピ表を直接組む（カードでは組めない）。

## 8. 落とし穴

- elevation と variant を混同する（例:「地から切り離したいから `variant="overlay"` を探す」）。elevation は高さ、variant は質感で軸が別。
- `panel` に elevation を渡して効くと思い込む。常に `shadow-none` が勝つ。
- `className="p-3"` で余白を詰めようとする（§4）。
- カードに `hover:` を期待する。カード自体は反応しない。要る場合は呼び出し側で足す。

## 9. チェックリスト

- [ ] elevation は 3 段のどれかを選んだ（独自の影を作っていない）
- [ ] variant は 5 種から選び、質感の混同（グラデ／半透明／脇役の取り違え）が無い
- [ ] `panel` を使うときは elevation の指定を当てにしていない
- [ ] padding を詰めたいときは className でなく padding prop を使った
- [ ] カードを押せる要素にする場合は hover を呼び出し側で明示的に足した
