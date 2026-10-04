# ボタン（変種・サイズ・状態・solid/glass の差し替え）

> **いつ読むか**: ボタン・押せる操作要素の見た目を作るとき／solid（不透明な面）と glass（透かす面）を切り替えるとき
> **前提**: `foundations/surface-and-depth.md`（影 3 段・面を区別する 3 軸）・`foundations/motion.md`（duration/ease トークン）・`foundations/contrast-and-a11y.md`（フォーカスリング・状態の示し方）
> 形の値（サイズ・余白・高さ）はそのまま再現してよい。色は役割名で書く。

## 1. 要点

- 変種は 4 つに固定する: 主（`primary`）・副（`secondary`）・控えめ（`ghost`）・CTA グラデ（`primaryGradient`）。
- サイズは `sm` / `md` / `lg` の 3 段。文字サイズと太さはサイズ側が持ち、呼び出し側の `className` では上書きできない構造にする。
- 状態は色ではなく**高さ**で表す。hover は持ち上げる、active は影を消して押し込む。
- solid（不透明な面）と glass（透かす面）は、共通クラスに足すのではなく**変種の定義ごと丸ごと差し替える**。
- 押せるかどうかで無効化の作り方が変わる。有効時に `<a>` へ切り替わる要素は `disabled:` 疑似クラスに頼れないので、クラスセットそのものを分ける。
- 同じ意匠が複数ファイルに散る場面（solid / glass のトーン違いなど）は、値を直接コピーせず**トーン関数 1 か所から引く**。

## 2. 変種（4 種）

| 変種 | 静止 | hover | active | 用途 |
| --- | --- | --- | --- | --- |
| `primary` | `bg-brand-600 text-on-brand shadow-rest inset-shadow-edge-brand` | `bg-brand-700 shadow-brand` | `shadow-none` | 通常の主操作 |
| `secondary` | `bg-surface-raised text-brand-700 border border-border-interactive shadow-rest` | `bg-surface-brand shadow-raise` | `shadow-none` | 副操作 |
| `ghost` | `bg-transparent text-on-surface-muted`（影なし） | `bg-surface-sunken text-on-surface` | ― | 最も軽い操作（一覧内の操作等） |
| `primaryGradient` | `bg-cta-gradient text-on-brand shadow-rest inset-shadow-edge-brand` | `shadow-brand` | `shadow-none` | 強調したい主 CTA。塗りは変えず「持ち上げ」だけで hover を出す |

- 濃い塗りの変種（`primary` / `primaryGradient`）には `inset-shadow-edge-brand`（上端の光）も足す。濃い塗り＋内側ハイライト＋hover の持ち上げの組が「押せる」の標識になる（`foundations/surface-and-depth.md` §4）。
- `ghost` だけ影の段を持たない。静止状態がそもそも面ではない（`bg-transparent`）ため、hover で初めて `surface-sunken` の面を与える。
- 影の掛け方は `foundations/surface-and-depth.md` の面のレシピ「L2 操作する対象」（静止 → hover で 1 段上げる）にそのまま従う。

## 3. サイズ（sm / md / lg）と算出高さ

| サイズ | クラス | 文字 / 行間 | 縦 padding | 算出高さ（無枠） | 枠あり（+1px×2） |
| --- | --- | --- | --- | --- | --- |
| `sm` | `text-caption font-medium gap-1.5 px-3 py-1.5` | 12px / 1.6 | 6px×2 | 19.2 + 12 = 31.2px | 33.2px |
| `md` | `text-body font-medium gap-2 px-4 py-2.5` | 15px / 1.8 | 10px×2 | 27 + 20 = 47px | 49px |
| `lg` | `text-base font-bold gap-2 px-5 py-3` | 16px / 1.5（Tailwind 既定） | 12px×2 | 24 + 24 = 48px | 50px |

- 「算出高さ」は行ボックス（フォントサイズ×行間）＋縦 padding の合計。枠を持つ変種（`secondary` 等）はさらに border（片側 1px）が乗る。実測ではブラウザの丸めで ±1px 程度ずれうる。
- `lg` は全幅で 1 つだけ置いて強く押させたいボタン（同意モーダルの主操作など）向け。

## 4. 状態クラス

```
hover:...（影を1段上げる。primary系は背景の濃色化も併用）
active:shadow-none
focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus
disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none
```

- フォーカスは `outline` で示す（色の変化ではない）。
- `disabled` は透明度 60% ＋ `shadow-none`（持ち上げていた影を戻す）。文字コントラストは無効状態として免除対象。

## 5. solid / glass の差し替え

背景を透かす面（glass）の上に置く変種だけ、**専用の class 文字列に丸ごと差し替える**（同じ変種のクラスに glass 用のクラスを追加しない）。

```ts
const VARIANT_CLASS: Record<Variant, string> = {
  /* solid 用（既定） */
};
const GLASS_VARIANT_CLASS: Partial<Record<Variant, string>> = {
  /* 地の上に置く変種だけ差し替える */
};

const variantClass =
  (surface === "glass" ? GLASS_VARIANT_CLASS[variant] : undefined) ??
  VARIANT_CLASS[variant];
```

- 差し替えが要るのは「地の上に置く」変種（`secondary` / `ghost`）だけ。塗りそのものを持つ変種（`primary` / `primaryGradient`）は solid / glass 共通でよい。
- **足すのではなく差し替える理由**: 同じ CSS プロパティ（`background-color` など）を両方書くと、どちらが効くかは Tailwind が生成する CSS の順序に依存し、呼び出し側では制御できない。2 つの完結した class 文字列を用意し、条件分岐で選ぶほうが確実。

## 6. 上書きしたい軸は className でなく prop で受ける

Tailwind のユーティリティは、**クラス文字列の並び順ではなく生成される CSS の順序**で勝敗が決まる。部品側で決めた `font-weight` / `font-size` を呼び出し側の `className` で上書きしようとしても、部品側の定義が後から生成されて勝つことがある。

- サイズ・変種・surface のように「呼び出し側が変えたい軸」は、className の上書きに期待せず**prop として設計**する。
- 同じ理由で、padding のような軸も prop 化する（`card-and-panel.md` の `padding` prop も同じ規律）。

## 7. forwardRef（初期フォーカスに渡す）

モーダルの「開いたら特定のボタンへ初期フォーカスを当てる」実装は、基底モーダルの `initialFocusRef` のような prop へ ref を素通しできる必要がある。ref を受けられないと、呼び出し側が DOM を `querySelector` で引き当てる回避策を書くことになり、属性名やフォーカス確定タイミングへの依存が呼び出し側に漏れる。

```tsx
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    return <button ref={ref} {...props} />;
  }
);
```

## 8. 入力ブロック等に置くアクションボタン

送信ボタンの隣に並ぶような「独立した操作ボタン」は、共通ボタン部品ではなく専用のクラス文字列で組む（タップ領域とラベルの出し分けが通常のボタンより複雑なため）。

| 要素 | クラス | 備考 |
| --- | --- | --- |
| ラベル付きの行 | `inline-flex min-h-[44px] items-center gap-1.5 rounded-control px-3 py-2 text-sm` | 44px は押せる範囲の下限（`foundations/type-space-radius.md` §5） |
| アイコンだけ | `inline-flex h-10 w-10 items-center justify-center rounded-control p-2 text-sm`（**完全に別の class 文字列**） | 40px 四方。`min-h-[44px]` と `h-10` を同じ要素に併記しない（生成順序に依存した上書きになる） |
| 有効時の面 | `border border-border-interactive bg-surface-raised shadow-raise hover:shadow-overlay`（glass 版は半透明＋blur） | hover は影の 1 段上げ |
| 無効時の面 | `border border-border bg-surface-raised text-on-surface-disabled shadow-rest`（**有効時とは別の完全な class セット**） | 下記参照 |

**無効時に `disabled:` 修飾を使わない理由を確かめる**: このボタンは有効時に `<a href>`（遷移先がある実リンク）、無効時に `<button disabled>` へ**要素そのものを切り替える**。`<a>` には `disabled` 属性が無いため、`disabled:` 疑似クラスで 1 つの class 文字列に畳み込めない。呼び出し側が有効/無効の真偽で「どちらの要素・どちらの class セットを描くか」を丸ごと分岐する。

**タッチ用の常時ラベル**: hover の無い環境ではラベルを常に見せ、hover できる環境ではオーバーレイのツールチップに任せる（`foundations/contrast-and-a11y.md` §8「hover 能力による出し分け」）。

```
hidden text-caption [@media(hover:none)]:inline
```

## 9. 同じ意匠が複数ファイルに散るとき: トーン関数 1 か所から引く

solid / glass のように「同じ役割のボタンが複数ファイル（画面の step 群など）に分かれて存在する」場面では、クラス文字列を各ファイルにコピーしない。値を 1 つのトーンオブジェクトにまとめ、呼び出し側は関数越しに引く。

```ts
type Tone = { primaryButton: string; secondaryButton: string /* ... */ };
const TONE_A: Tone = { primaryButton: "...", secondaryButton: "..." };
const TONE_B: Tone = { primaryButton: "...", secondaryButton: "..." };

export function getTone(useB: boolean): Tone {
  return useB ? TONE_B : TONE_A;
}
```

- コピーすると、片方だけ直したときに静かにズレる。1 か所に集約すれば、直すべき箇所が常に 1 つになる。
- 「solid / glass で意匠を揃えたい」値は、`TONE_A` / `TONE_B` の両方で同じ文字列を書けばよい（分ける必要があるものだけを個別に持つ）。

## 10. 落とし穴

- 同じ CSS プロパティを持つ 2 つのクラスセットを両方当てる（solid 用に glass 用を足す等）。生成順序で意図しない方が勝つ。
- 呼び出し側の `className` で font-weight / padding を上書きしようとする。効いたり効かなかったりする（§6）。
- `min-h-[44px]` と `h-10` を同じ要素に併記する。
- 無効化を `disabled:` 修飾だけで済ませようとする。要素そのものが変わる設計では成立しない。

## 11. チェックリスト

- [ ] 変種は 4 つ、サイズは 3 段の中から選んだ（増やしていない）
- [ ] 状態は色ではなく影の上げ下げで表した（濃い塗りには `inset-shadow-edge-brand` も付けた）
- [ ] glass 版が要る変種は class 文字列を丸ごと差し替えた（足していない）
- [ ] 呼び出し側が上書きしたい軸を prop にした（className 頼みにしていない）
- [ ] 初期フォーカスを当てる可能性がある場合は forwardRef にした
- [ ] 無効時に要素そのものを切り替える設計なら、無効用の class セットを別に用意した
- [ ] 同じ意匠が複数ファイルに散るなら、トーン関数 1 か所から引く形にした
