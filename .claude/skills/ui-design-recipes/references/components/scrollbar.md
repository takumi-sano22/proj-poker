# 半透明スクロールバー

> **いつ読むか**: スクロール可能な領域の見た目を整えるとき／暗い面のスクロールバーを作るとき
> **前提**: `foundations/contrast-and-a11y.md` §8（hover 能力による出し分け）
> 形の値（太さ・border）はそのまま再現してよい。色は役割名（`ink` の濃淡の段）で書く。

## 1. 要点

- Chromium は `::-webkit-scrollbar` 系疑似要素、Firefox は標準の `scrollbar-width` / `scrollbar-color` で作る。両者は別経路なので、両方を無条件に書くと衝突する。
- Chrome 121+ は `scrollbar-width` / `scrollbar-color` が初期値以外だと webkit 疑似要素を無視するため、標準プロパティは `@supports not selector(::-webkit-scrollbar)` で包み、webkit 疑似要素を持たないブラウザにだけ渡す。
- 太さは 12px で確保し、2px の透明 border を `background-clip: content-box` と組み合わせて見かけ 8px に絞る。
- ポインタのある環境だけ静止時を薄くし、hover / active で 4.5:1 超へ戻す。タッチなど hover の無い環境は常に 3:1 相当の濃さを維持する。
- hover と active は 1 つのセレクタにまとめる（ドラッグ中につまみの外へポインタが出ると、hover だけでは薄い色に戻ってしまう）。

## 2. Chromium 側（webkit 疑似要素）

```css
*::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
  border-radius: var(--radius-pill);
  border: 2px solid transparent; /* 見かけの太さを8pxに絞る */
  background-clip: content-box;
}
*::-webkit-scrollbar-thumb:hover,
*::-webkit-scrollbar-thumb:active {
  background-color: var(--scrollbar-thumb-hover);
}
```

- 太さを px 指定するには `::-webkit-scrollbar` が必須（標準プロパティは `thin` / `auto` の 2 値しか取れない）。
- つまみの見かけ幅を絞る定番パターン: 実際の太さより太く取り、透明 border を `background-clip: content-box` で芯だけに塗りを残す。

## 3. Firefox 側（標準プロパティ）

```css
@supports not selector(::-webkit-scrollbar) {
  * {
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }
}
```

- **前提を取り違えやすい箇所**: 「`::-webkit-scrollbar` を書くと標準プロパティが無効になる」わけではない。逆に、Chrome 121+ は CSSWG の決議により、`scrollbar-width` / `scrollbar-color` が初期値以外だと `::-webkit-scrollbar` 系の疑似要素を無視する（標準側が優先される）。両方を無条件に書くと「Chromium は webkit 側・Firefox は標準側」という想定どおりには動かない。
- そのため標準プロパティは、**webkit 疑似要素を持たないブラウザにだけ** `@supports not selector(::-webkit-scrollbar)` で渡す。
- Firefox は太さを px 指定できないため `thin` のまま、色と不透明度だけが反映される。
- トレードオフ: Chromium は常時表示の古典型スクロールバーに戻る（`::-webkit-scrollbar` に width/height を指定した副作用）。太さを px で固定する以上、この副作用は受け入れる。

## 4. 色: ポインタの有無で静止時の濃さを変える

| 環境 | 静止時 | hover / active |
| --- | --- | --- |
| 既定（タッチ含む全環境） | `ink-900` 50% | `ink-700` 75% |
| ポインタがある環境（`@media (hover: hover) and (pointer: fine)`） | `ink-400` 35% | `ink-700` 75%（変わらない） |

```css
:root {
  --scrollbar-thumb: color-mix(in srgb, var(--color-ink-900) 50%, transparent);       /* 既定＝タッチも含む。3:1 相当 */
  --scrollbar-thumb-hover: color-mix(in srgb, var(--color-ink-700) 75%, transparent); /* hover / active。4.5:1 超 */
}
@media (hover: hover) and (pointer: fine) {
  :root {
    --scrollbar-thumb: color-mix(in srgb, var(--color-ink-400) 35%, transparent); /* ポインタがある環境だけ静止時を薄く */
  }
}
```

- つまみは掴める操作対象だが、常時 3:1（WCAG 1.4.11）を保つと「太く濃い」印象が強くなりすぎる場合がある。**hover で濃さを回復できる環境だけ**、静止時を薄くしてよい。
- **ポインタが無い環境（タッチ）は hover で戻せないため、常に 3:1 相当の濃さ（`ink-900` 50%）を維持する。** 担保の置き場所をポインタの有無で分ける。
- 静止時に薄くする値は、hover / active での回復（4.5:1 超）とセットで初めて成立する。薄くするだけで回復させない実装をしない。

## 5. 暗い面用の utility

コードブロックなど暗い面に載せるスクロールバーは、明るい面と反転した段を使う。子孫のスクロール要素まで継承させる utility にする。

```css
@utility scrollbar-on-dark {
  --scrollbar-thumb: color-mix(in srgb, var(--color-ink-100) 40%, transparent);
  --scrollbar-thumb-hover: color-mix(in srgb, var(--color-ink-100) 55%, transparent);
}
@media (hover: hover) and (pointer: fine) {
  .scrollbar-on-dark {
    --scrollbar-thumb: color-mix(in srgb, var(--color-ink-100) 25%, transparent);
  }
}
```

考え方は §4 と同じ（既定＝タッチも含めて 3:1 相当、ポインタがある環境だけ静止時を薄く）。

## 6. hover と active を 1 ルールにまとめる理由

```css
*::-webkit-scrollbar-thumb:hover,
*::-webkit-scrollbar-thumb:active {
  background-color: var(--scrollbar-thumb-hover);
}
```

ドラッグ中（active）につまみの外へポインタが出ると `:hover` が外れ、薄い静止色に戻ってしまう。hover と active を別ルールに分けると、修正のたびに片方だけ変更される事故が起きやすい。1 つのセレクタにまとめておけば、どちらの状態でも同じ濃さになることが構造上保証される。**この対策は webkit 疑似要素の経路にのみ効く**（Firefox の標準プロパティには hover/active 専用の指定が無く、ドラッグ中でも静止色のまま変わらない）。

## 7. 落とし穴

- `::-webkit-scrollbar` と標準プロパティ（`scrollbar-width` / `scrollbar-color`）を無条件に両方書く。Chrome 121+ では標準側が勝ち、太さの px 指定が効かなくなる。
- ポインタの無い環境でも静止時を薄くする。hover で戻せないため常に 3:1 を割ったままになる。
- hover と active を別ルールに分ける。ドラッグ中に薄い色へ戻る不具合を生む。
- つまみの見かけ幅を絞る目的で padding を使う（`background-clip: content-box` ＋ 透明 border が定番）。

## 8. チェックリスト

- [ ] 標準プロパティは `@supports not selector(::-webkit-scrollbar)` で包んだ
- [ ] 太さは 12px 確保＋透明 border 2px で見かけ 8px に絞った
- [ ] ポインタの無い環境は常に 3:1 相当の濃さを維持している
- [ ] ポインタがある環境だけ静止時を薄くし、hover / active で 4.5:1 超へ戻した
- [ ] hover と active を 1 つのセレクタにまとめた
- [ ] 暗い面には反転させた utility（`scrollbar-on-dark` 等）を使った
