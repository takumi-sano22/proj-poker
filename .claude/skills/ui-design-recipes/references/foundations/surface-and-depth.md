# 面の重なりと奥行き（影 3 段・内側ハイライト・面のレシピ 4 層）

> **いつ読むか**: カード・吹き出し・パネル・モーダル・入力欄など「面」を作るとき／影や縁を決めるとき
> **前提**: `color-usage.md` の役割名（`surface-*` / `border-*` / `ink-*` / `brand-*`）
> 形の値（影・角丸）はそのまま再現してよい。色は役割名で書いてある。

## 目次

1. 要点
2. 影の 3 段（＋上向き・CTA 専用）
3. 内側ハイライト
4. 面を区別する 3 つの軸
5. 面のレシピ 4 層（L1〜L4）と例外
6. 地と面の段差
7. 実装の雛形
8. 落とし穴
9. チェックリスト

## 1. 要点

- **影は `rest` / `raise` / `overlay` の 3 段に固定する。** 画面ごとに独自の影を作らない。
  立体感が破綻するのは、だいたい影の乱立から。
- 各段は **3 層構成**（輪郭を締める 1px の contact ＋ 方向を出す key ＋ 広く薄い ambient）。
  1 層の弱い影では「立体感が無い」と言われる。
- **影の段はレイヤーの距離を表す**: 脇役＝影なし／読む対象＝`rest`／浮かせた操作・選択待ち＝`raise`／別レイヤー＝`overlay`。
- 面を区別する軸は **3 つだけ**（濃い塗りの有無・角丸・内側ハイライトと hover の持ち上げ）。
- **影は分離したい相手の方向へ落とす。** 画面下端に固定する面は上向きの影にする。

## 2. 影の 3 段（＋上向き・CTA 専用）

影の色は `ink-900` を透かす（純黒を使わない）。下表の `ink` は `color-mix(in srgb, var(--color-ink-900) N%, transparent)` の略。

| トークン | 値（contact, key, ambient） | 使う面 |
| --- | --- | --- |
| `--shadow-rest` | `0 1px 1px ink 5%`, `0 2px 6px ink 8%`, `0 8px 16px ink 6%` | 地に置かれた面（吹き出し・カード・一覧の行）・ボタンの静止時 |
| `--shadow-raise` | `0 1px 2px ink 6%`, `0 4px 10px ink 10%`, `0 16px 32px ink 10%` | 浮かせた面（hover・フロート要素・選択待ちの面・**トリガーに付いて出る小さな浮き面**＝ドロップダウンやポップオーバーのメニュー） |
| `--shadow-overlay` | `0 2px 4px ink 8%`, `0 12px 24px ink 14%`, `0 32px 64px ink 20%` | 地から切り離した面（モーダル・シート・ドロワー・別ウィンドウ） |
| `--shadow-raise-up` | `0 -1px 2px ink 6%`, `0 -4px 10px ink 10%`, `0 -16px 32px ink 8%` | **画面下端に固定する面**（入力ブロックなど）。強さは `raise` と同じ段 |
| `--shadow-brand` | `0 6px 18px` を `brand-600` の 28% で | **主 CTA の hover だけ**の色付きの光。多用すると階層が壊れる |

**上向きの影を別に持つ理由**: 画面下端の面に下向きの影を付けても画面外へ逃げて何も担わない。
分離すべき相手は上にある内容なので、影も上へ向ける。祖先に `overflow: hidden` があっても、
上向きなら容器の内側へ伸びるのでクリップされにくい。上向きの影があれば、上の罫線は外してよい（境界を影が担う）。

## 3. 内側ハイライト

光源を意識させる装飾。**境界ではない**（操作要素の輪郭は `border-interactive` が担う）。

| トークン | 値 | 置く面 |
| --- | --- | --- |
| `--inset-shadow-edge` | `inset 0 1px 0` 白 55% | 明るい面（白・淡いグラデ）の上端 |
| `--inset-shadow-edge-brand` | `inset 0 1px 0` 白 28% | 濃い塗りの面（brand / accent のグラデ）の上端。**押せる面の標識**を兼ねる |
| `--inset-shadow-well` | `inset 0 1px 3px` `ink-900` 10% | 入力欄など窪んだ面 |

Tailwind v4 では `--inset-shadow-*` が `inset-shadow-<name>` ユーティリティになり、`shadow-*` と同時に指定できる
（`shadow-rest inset-shadow-edge` のように外側の影と内側ハイライトを重ねられる）。

## 4. 面を区別する 3 つの軸

軸を増やすと「全部違うが違いが読めない」状態に戻る。**3 つに固定する。**

| 軸 | 表すもの | 規律 |
| --- | --- | --- |
| **濃い塗り（グラデ）の有無** | 画面で主張してよい面か | 持てるのは主操作と「自分の発言」だけ（`color-usage.md` §6 の上限 A） |
| **角丸** | どの層に属するか | 操作 10px ／ 脇役 12px ／ 読む対象・準主役 16px ／ 別レイヤー 20px |
| **濃い塗りの内側ハイライト＋hover の持ち上げ** | 押せるかどうか | `inset-shadow-edge-brand` と hover の影の段上げを持つのは操作要素だけ。読む対象は `rest` 固定で hover に反応しない（明るい面の白いハイライト `inset-shadow-edge` は光の装飾なので、読む面にも付けてよい） |

- **「濃い塗り＝押せる」ではない。** 自分の吹き出しは押せないが濃い塗りを持つ（会話の中で主張してよい面だから）。
  押せることの標識は「角丸 10px ＋ 内側ハイライト ＋ hover の持ち上げ」の組で示す。
- **逆も成り立たない。** 押せるものが必ず濃い塗りを持つわけではない（上限 4 種類があるため）。
  濃くない操作要素は、角丸 10px と hover の持ち上げで押せることを示す。

## 5. 面のレシピ 4 層（L1〜L4）と例外

| 層 | 対象の例 | 背景 | 縁 | 角丸 | 影 |
| --- | --- | --- | --- | --- | --- |
| **L1 読む対象（相手）** | 相手（アシスタント・キャラクター等）の吹き出し | `brand-50` → `brand-100`（180deg） | 1px `brand-200` | 16px（話者側の下の角＝左下だけ 4px にして吹き出し形） | `rest` ＋ `inset-shadow-edge`・hover 反応なし |
| **L1 読む対象（自分）** | 自分の吹き出し | `brand-600` → `accent-700`（135deg） | なし | 16px（右下だけ 4px） | `rest`・hover なし・内側ハイライトなし |
| **L2 操作する対象** | 送信・セグメントの選択側・「＋新規」・主 CTA | CTA / 塗りのグラデ | なし | 10px（セグメントの内側は 8px） | `rest` → hover `brand` ＋ `inset-shadow-edge-brand` |
| **L2 準主役（受け皿）** | メッセージ入力欄 | `surface-sunken` ＋ 2px のグラデリング | リングが兼ねる | 16px | `inset-shadow-well` |
| **L2 準主役（器）** | 入力欄を載せるブロック全体 | `surface-raised` の 80% ＋ `backdrop-blur` | 上の罫線は外す | 16px | `raise-up` |
| **L2 準主役（主役の居場所）** | 主役（アバター・キャラクター等）の名前やセリフを置く帯 | 淡い強調のグラデ（1 画面 1 か所） | 1px `brand-200` の 70% | 16px | `rest` |
| **L3 脇役の面** | メモ・周辺カード | **単色** `surface-sunken`（地より沈む） | 1px `border` | **12px** | **なし**（部品側で強制） |
| **L4 別レイヤー** | モーダル・シート・ドロワー | **単色** `surface-raised`（最前面が最も明るい） | 1px `border-strong` | **20px** | `overlay` |
| **例外: 選択待ち** | 提案バナー・選択肢の待機面 | 単色 `accent-100`（色相を振る） | 1px `accent-300` | 10px（操作を求めている面） | `raise` |
| **層の外: 見本** | 使い方の説明に置く画面の模式図 | `surface-raised` | 1px `border-strong` | **4px**（どの層でもないことを示す。0px は紙の切り抜きのように硬すぎる） | なし |

- **L1 の輪郭は縁が担う。** 地に対する面の差は 1.1:1 程度しかないので、縁（`brand-200`）で切り離す。
- **L3 は角を締める。** 段階を上げるほど丸くするのではなく、「主役ではない」ことを 12px で示す。
- **L4 は最前面が最も明るい。** 白単色＋`overlay` 影で、背後の面から切り離す。
- **トリガーに付いて出るポップオーバー・ドロップダウンは L4 にしない。** 画面から切り離すほどの距離ではないので、
  白単色＋淡い縁＋`raise`＋角丸 12px にとどめる（`overlay` の大きな影は、小さな面には重すぎる）。
- 各層は背景・縁・角丸・影の **4 要素すべてで**他の層と異なるようにする（1 要素だけの違いでは区別できない）。

## 6. 地と面の段差

- 画面の地は単色にせず、**極浅いグラデーション**（`color-usage.md` §5 の「地」）にする。
  純白の面（`surface-raised`）との段差が生まれ、影に頼らなくても「面が乗っている」ことが伝わる。
- 地は `body` の 1 か所だけに当て、画面側で背景を当て直さない（出所が 2 か所に割れる）。
- 脇役の面に `brand-50` を使うと、地の下端（`brand-50`）と同色になって溶ける。脇役は `surface-sunken` に沈める。

## 7. 実装の雛形

```css
@theme static {
  --shadow-rest:
    0 1px 1px color-mix(in srgb, var(--color-ink-900) 5%, transparent),
    0 2px 6px color-mix(in srgb, var(--color-ink-900) 8%, transparent),
    0 8px 16px color-mix(in srgb, var(--color-ink-900) 6%, transparent);
  --shadow-raise:
    0 1px 2px color-mix(in srgb, var(--color-ink-900) 6%, transparent),
    0 4px 10px color-mix(in srgb, var(--color-ink-900) 10%, transparent),
    0 16px 32px color-mix(in srgb, var(--color-ink-900) 10%, transparent);
  --shadow-raise-up:
    0 -1px 2px color-mix(in srgb, var(--color-ink-900) 6%, transparent),
    0 -4px 10px color-mix(in srgb, var(--color-ink-900) 10%, transparent),
    0 -16px 32px color-mix(in srgb, var(--color-ink-900) 8%, transparent);
  --shadow-overlay:
    0 2px 4px color-mix(in srgb, var(--color-ink-900) 8%, transparent),
    0 12px 24px color-mix(in srgb, var(--color-ink-900) 14%, transparent),
    0 32px 64px color-mix(in srgb, var(--color-ink-900) 20%, transparent);
  --shadow-brand: 0 6px 18px color-mix(in srgb, var(--color-brand-600) 28%, transparent);

  --inset-shadow-edge: inset 0 1px 0 rgb(255 255 255 / 0.55);
  --inset-shadow-edge-brand: inset 0 1px 0 rgb(255 255 255 / 0.28);
  --inset-shadow-well: inset 0 1px 3px color-mix(in srgb, var(--color-ink-900) 10%, transparent);

  --background-image-message-gradient: linear-gradient(180deg, var(--color-brand-50) 0%, var(--color-brand-100) 100%);
  --background-image-message-own-gradient: linear-gradient(135deg, var(--color-brand-600) 0%, var(--color-accent-700) 100%);
}
```

各層を Tailwind のクラスで書くと次のとおり（角丸トークンは `type-space-radius.md`）。

| 層 | クラス |
| --- | --- |
| L1 相手 | `rounded-card rounded-bl-sm border border-brand-200 bg-message-gradient text-on-surface shadow-rest inset-shadow-edge px-4 py-3 text-sm leading-relaxed break-words` |
| L1 自分 | `rounded-card rounded-br-sm bg-message-own-gradient text-on-brand shadow-rest px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words` |
| L2 操作 | `rounded-control bg-cta-gradient text-on-brand shadow-rest inset-shadow-edge-brand hover:shadow-brand active:shadow-none` |
| L2 器 | `rounded-card bg-surface-raised/80 backdrop-blur-md shadow-raise-up` |
| L3 | `rounded-panel border border-border bg-surface-sunken shadow-none` |
| L4 | `rounded-modal border border-border-strong bg-surface-raised shadow-overlay` |
| 選択待ち | `rounded-control border border-accent-300 bg-accent-100 shadow-raise` |

- 吹き出しの `rounded-bl-sm` / `rounded-br-sm` は Tailwind v4 で 0.25rem（4px）。**v3 では `rounded-sm` が 2px**なので、
  版が違うプロジェクトでは `rounded-bl-[4px]` と明示する。素の CSS なら相手は `border-radius: 16px 16px 16px 4px`、
  自分は `16px 16px 4px 16px`（左上・右上・右下・左下の順）。
- 入力欄のリング（L2 受け皿）は border ではなく背景 2 層で描く専用ユーティリティを使う（書き方は部品側の reference で扱う）。

**Tailwind を使わない場合**: `box-shadow: var(--shadow-rest), var(--inset-shadow-edge);` のように
外側の影と内側ハイライトを 1 つの `box-shadow` にカンマで並べる（Tailwind はこれを 2 つのユーティリティに分けている）。

## 8. 落とし穴

- **1 つのレシピで 4 つの役割を塗る**（吹き出し・メモ・2 種類のモーダルを全部同じ白→淡色グラデにする等）と、
  区別が消えて安っぽく見える。層ごとにレシピを分ける。
- **hover の影を `box-shadow` で差し替える要素に、別の用途の `box-shadow`（発光など）を同居させる**と食い合う。
  別の光は前面のオーバーレイ要素に分ける。
- **影を暗くして立体感を出そうとする**と、「硬い管理ツール」の印象に寄る。強さは 3 層構成と距離の割り振りで出す。
- **`clip-path` / `mask` を掛けた要素に影や border を付ける**と、影も縁も一緒に削れる。
  影は一段外側の要素に `filter: drop-shadow(...)` で付ける（drop-shadow はアルファの形に沿う）。

## 9. チェックリスト

- [ ] 新しい影を作らず、`rest` / `raise` / `overlay`（＋`raise-up` / `brand`）のどれかに当てはめた
- [ ] 面がどの層（L1〜L4・選択待ち・見本）かを決め、背景・縁・角丸・影の 4 要素をその層のレシピにした
- [ ] 押せる要素だけが内側ハイライトと hover の持ち上げを持ち、読む面は hover に反応しない
- [ ] 画面下端に固定した面の影は上向き
- [ ] 脇役の面が地に溶けていない（地と同じ段を使っていない）
