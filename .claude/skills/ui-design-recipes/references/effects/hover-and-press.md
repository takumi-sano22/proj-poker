# hover と押下（影の一段上げ・持ち上げ・出現条件）

> **いつ読むか**: ボタン・カード・一覧の行・雲形の候補面など、押せる要素に hover / 押下の反応を付けるとき
> **前提**: `foundations/surface-and-depth.md`（影 3 段・面のレシピ）・`foundations/contrast-and-a11y.md` §6・§8（状態を色だけで示さない・hover 能力の出し分け）・`foundations/motion.md`（duration トークン・transition の書き方）
> 形の値（移動量・duration）はそのまま再現してよい。色は役割名で書く。

## 1. 要点

- hover は色ではなく**影を1段上げて**示す（`rest` → `raise`、既に浮いている面は `raise` → `overlay`、主 CTA は色を変えず `brand` の光を足す）。
- 持ち上げは **-1〜2px** だけ（`hover:-translate-y-px` か `-translate-y-0.5`）。押下は `active:translate-y-0 active:shadow-none` で元に戻す。
- 面と hover 面の色差がほぼ無い場所（実測で 1.0〜1.12:1 程度）では、**影と文字色の2つ**で hover を伝える。半透明の面の**中に置いた、面を持たない操作**では影を足さず、**背景の不透明度と文字色**で伝える。
- hover だけで出す操作は `opacity-0 pointer-events-none` を基点に `group-hover:` と `group-focus-within:` の両方で出す（キーボードでも出す）。ただし、その操作の唯一の入口が hover の中にしか無い場合は常時表示にする。
- `clip-path` で輪郭を切った面は `border` も `box-shadow` も効かない。hover は一段外側の要素の `filter`（`brightness()` や `drop-shadow`）で出す。

## 2. 影を1段上げる

| 静止 | hover | 対象 |
| --- | --- | --- |
| `shadow-rest` | `shadow-raise` | 地に置かれた通常の操作要素 |
| `shadow-raise` | `shadow-overlay` | 既に浮いている操作要素（入力ブロック脇の独立した操作ボタン等） |
| 濃い塗り（CTA）の `shadow-rest` | `shadow-brand`（塗りは変えず光を足す） | 主 CTA・送信ボタン |

```
/* 既に raise の面をさらに持ち上げる */
border border-brand-200/60 bg-surface-raised/85 shadow-raise backdrop-blur-md
hover:shadow-overlay

/* 主 CTA: 塗りは変えず光だけ足す */
bg-cta-gradient inset-shadow-edge-brand shadow-rest
hover:shadow-brand
```

- 主 CTA の hover に色の変化そのものを禁じるわけではない（単色塗りの主操作は塗りを1段濃くしつつ光も足す設計もある。`components/button.md` の `primary` 変種を参照）。ここで固定したいのは「面の差がほぼ無い要素」と「濃い塗りの CTA」で示し方を混同しないこと。
- 独立した操作ボタンの一部には、影の一段上げに加えてごく淡い背景色の変化（例: 白系の面から極薄いブランド色の面へ）を併用する実装もある。地に対する両者の差はどちらも 1.1:1 程度しか無いため、**主な合図は高さで、色は補助**と考えて設計する。

## 3. 持ち上げ幅と transition

| 移動量 | Tailwind | 用途 |
| --- | --- | --- |
| 1px | `hover:-translate-y-px active:translate-y-0` | 面を持たない候補（雲形など）を軽く持ち上げる |
| 2px（0.125rem） | `hover:-translate-y-0.5 active:translate-y-0` | 独立した円形・正方形のボタン（送信ボタン等） |

```
transition-[background-color,box-shadow,transform] duration-[var(--duration-quick)] ease-standard
hover:-translate-y-0.5 active:translate-y-0 active:shadow-none
```

- `transition` は動かすプロパティだけを列挙する（`foundations/motion.md` §5）。`transform` で持ち上げるなら `transition-[...,transform]` に必ず含める。含め忘れると、hover 復帰時だけ transform が瞬間移動して見える。
- 色も影も動かす要素は `transition-[background-color,box-shadow]`、文字色まで動かすなら `transition-[background-color,box-shadow,color]` のように、変える分だけ列挙を増やす。

## 4. 押下（active）

- 基本形は `active:translate-y-0 active:shadow-none`（持ち上げていた分を戻し、影を消して「沈める」）。
- 押下の反応は位置（`translate`）と影だけで表し、拡大縮小（`scale`）は使わない。持ち上げ・影の段と同じ「高さ」の語彙だけで状態を表すため。

## 5. 面の色差が小さい場所（影＋文字色 / 半透明面は不透明度＋文字色）

地の上に直接置かれた操作行など、面どうしの実測差が **1.04〜1.12:1** しか無い場所では、色の変化だけでは hover が伝わらない。

| 面の性質 | hover の示し方 | 実測の目安 |
| --- | --- | --- |
| 不透明な地の上（面自体はほぼ白） | 影（`shadow-rest` を追加）＋文字色を1段濃くする | 地との面差 1.04〜1.12:1（色だけでは不可）／文字色変化後のコントラストは 7 台:1 |
| 半透明の面の中（吹き出しの中の操作行など） | 影は足さず、**背景の不透明度を上げる**（例: ブランド色の淡い段を 60% で敷く `hover:bg-brand-100/60`）＋文字色を1段濃くする | 面差自体は 1.05〜1.33:1 と小さいが、文字色変化で 6〜8 台:1 を確保 |
| 半透明の面の上に置いた、面を持たないボタン列（透明パネルの項目行） | 影は足さず、背景の不透明度だけを段階的に上げる（静止 0% → hover 薄く → 押下でさらに濃く）＋文字色を1段濃くする | パネル自体のアルファが低いほど、文字色の底上げ幅を大きくする |

- 半透明の面の**中に置いた操作**には影を追加しない。外側の面が既に浮いている（影や `backdrop-blur` を持つ）ため、中の操作に影を重ねても効果が読み取りにくく、背景の不透明度の変化のほうが視認性に効く。半透明の面**そのものが独立した操作要素**（浮いている操作ボタン・半透明の選択肢チップ等）なら、§2 のとおり影を1段上げてよい。
- どちらの場合も、文字色の変化を「主 CTA と同じ濃さ」まで上げすぎない。地の上の操作行と主 CTA は面のレシピ上の役割が違う（`foundations/surface-and-depth.md` §4）。

## 6. hover で出す操作の表示・非表示

一覧の行の操作（改名・削除等）のように、常時見せると行の情報が読みにくくなる操作は、hover と同時にキーボードフォーカスでも出す。

```
opacity-0 pointer-events-none
group-hover:opacity-100 group-hover:pointer-events-auto
group-focus-within:opacity-100 group-focus-within:pointer-events-auto
transition-opacity
```

- **`opacity-0` には必ず `pointer-events-none` を組にする**（表示するときに `pointer-events-auto` へ戻す）。`opacity-0` だけで隠すと、タッチ環境で「見えていないのに押せる」領域が残り、意図しないタップで誤発火する。
- `group-focus-within` を使う（`group-focus-visible` ではない）。トリガーとなる子要素がフォーカスされたことを親 group が拾うのは `focus-within` 系であり、`focus-visible` は group 要素自身が対象を要求する（`components/tooltip-and-hover-label.md` の落とし穴と同じ混同に注意）。

## 7. 常時表示にする判断基準

hover 表示にするか常時表示にするかは、「その操作へ到達する手段が他に無いか」で決める。

- **その操作の唯一の入口が、対象そのものの中にしか無い**（例: 一つ一つの発言に対するコピー・作り直しの操作）場合は常時表示にする。タッチ環境には hover の概念が無いため、hover 表示にすると存在に気づけないか、意図しないタップで一瞬だけ表示されて押しそこねる。常時表示にしつつ文字を小さく・淡くすることで、内容の読みを邪魔しない見た目に寄せる。
- **対象を選ぶ主操作が別にあり**、行の操作がその補助（改名・非表示等）にとどまる場合は hover 表示のままでよい。ただし、hover でしか出さない設計を選ぶときは、タッチでその操作へ到達する経路（別のメニュー等）が本当に別にあるかを確認する。無いなら常時表示に倒す。

## 8. clip-path で切った面の hover

雲形など `clip-path` で輪郭を作った面は、`border` も `box-shadow` も一緒に削れて出せない（`clip-path` は要素の描画そのものを欠き取るため）。

```css
/* 面本体（輪郭を切る側）: border は使えない */
.cloud-surface {
  clip-path: url(#cloud-path);
}

/* 一段外側の要素（影と hover の反応を持つ側） */
.cloud-shadow {
  /* 面の色相の濃い段。hover でも同じ値を使うので変数にしておく */
  --cloud-outline: drop-shadow(0 2px 4px rgb(<r> <g> <b> / 0.22)) drop-shadow(0 8px 16px rgb(<r> <g> <b> / 0.12));
  filter: var(--cloud-outline);
  transition-property: filter; /* 短縮形にしない（foundations/motion.md §5） */
  transition-duration: var(--duration-quick);
  transition-timing-function: var(--ease-standard);
}
/* hover 能力のある環境だけ（foundations/contrast-and-a11y.md §8） */
@media (hover: hover) {
  .cloud-shadow:hover,
  .group:hover .cloud-shadow {
    /* filter は値ごと置き換わる。brightness() だけを書くと輪郭の影が消える */
    filter: var(--cloud-outline) brightness(1.02);
  }
}
```

- `drop-shadow` は同じ要素に `clip-path` / `mask` を掛けると一緒に削れる（フィルタより後にマスクが適用されるため）。輪郭の影は**必ず一段外側の要素**に持たせる。
- hover の合図もこの外側の要素の `filter` で足す。**影の値に続けて `brightness()` を書く**（`filter` は値ごと置き換わる）。また、独自の CSS クラスで `filter` を持たせた要素に Tailwind の `brightness-*` などのユーティリティを足しても効かない。ユーティリティは `@layer utilities` に入り、レイヤー外の独自クラスが常に勝つ（`foundations/motion.md` §5 と同じ理屈）。hover の反応も同じ独自 CSS の中に書く。`drop-shadow` はアルファの形に沿って影が付くため、四角い box-shadow と違って輪郭どおりの影になる。
- ボタン自体に `clip-path` / `mask` を直接掛けない。フォーカスリング（`outline`）まで一緒に削れてキーボード操作の目印が消える。面は button の中に絶対配置の子として敷き、button 自体は素のまま `hover:-translate-y-px` 等で持ち上げる（§3）。

## 9. hover 能力の出し分け・長押し（参照のみ）

- hover 前提の表示を画面幅で代用しない・`hover-fine` / `[@media(hover:none)]` での出し分けは `foundations/contrast-and-a11y.md` §8。
- タッチでの長押し代替・ポインタ追従ラベルは `components/tooltip-and-hover-label.md`。

## 10. 別体系（業務画面）の例

管理・業務向けの画面は色の役割体系が異なる別体系だが、hover の基本形（影を1段上げる＋わずかに持ち上げる）は共通して使われている。

```
hover:shadow-md hover:-translate-y-0.5 transition-all
```

確立した体系と異なるのは、Tailwind の既定の影（`shadow-md` 等）を使う点と、`transition-all` と既定の所要時間を使う点。後者は `foundations/motion.md` §5 の「動かすプロパティだけを列挙する」にも、reduced-motion の一括停止にも外れるので、新しく作るなら `transition-[box-shadow,transform] duration-[var(--duration-quick)]` にする。

## 11. 落とし穴

- **面の色差だけで hover を判断する。** 白に近い面どうしの差は 1.0〜1.12:1 程度しか無く、色だけでは伝わらない（§5）。
- **`transition` に持ち上げの `transform` を含め忘れる。** hover 解除の瞬間にジャンプして見える（§3）。
- **hover で出す操作を `opacity-0` だけで隠し、`pointer-events-none` を付け忘れる。** 見えないのにタッチ領域だけ残り、誤発火する（§6）。
- **`clip-path` / `mask` を掛けた要素自身に影や hover の `filter` を足す。** 同じ要素では削れて効かない（§8）。
- **輪郭の影を独自クラスの `filter` で持つ要素の hover を、ユーティリティや `brightness()` 単独で書く。** 前者はレイヤー外の独自クラスに負けて効かず、後者は影が消える（§8）。
- **唯一の入口が hover の中にしかない操作を hover 専用にする。** タッチ環境で存在に気づけない（§7）。

## 12. チェックリスト

- [ ] hover は色ではなく影の一段上げ（`rest → raise` / `raise → overlay` / 主 CTA は `brand` の光）で表した
- [ ] 持ち上げは 1〜2px、押下で `translate-y-0` と `shadow-none` に戻した
- [ ] 面の色差が小さい場所では影＋文字色、半透明の面では不透明度＋文字色で示した
- [ ] `transition` は動かすプロパティ（`transform` を含む場合はそれも）だけを列挙した
- [ ] hover 専用の操作は `pointer-events-none` を基点にし、`group-focus-within` でキーボードからも出した
- [ ] 唯一の入口がその中にしか無い操作は常時表示にした
- [ ] `clip-path` / `mask` を掛けた面の影・hover の反応は一段外側の要素に持たせた
- [ ] その要素の hover は、影の値に続けて `brightness()` を書き、`@media (hover: hover)` の中に置いた
