# フォーム部品（入力・並び・エラー・スイッチ・選択肢チップ・グラデーションリング・自動伸長）

> **いつ読むか**: 1 行／複数行入力、ラベル・説明・エラーの並び、スイッチ、選択肢チップ、入力欄の縁を作るとき
> **前提**: `foundations/surface-and-depth.md`（`inset-shadow-well`）・`foundations/contrast-and-a11y.md`（状態を色だけで示さない・hover 能力・キーボード操作）
> 形の値（寸法・padding）はそのまま再現してよい。色は役割名で書く。

## 1. 要点

- 1 行／複数行入力は同じ語彙（solid＝地に沈めた不透明な面、glass＝半透明の面＋識別用の縁）を共有する。違いは resize の有無だけ。
- ラベル・説明・入力・ヒント/カウンタ・エラーの並びは固定する。画面ごとに順序を変えない。
- 「入力の指摘」と「読み込みの失敗」は別物として扱う。再試行できないなら再試行ボタンを出さない。
- 選択の状態は色の濃淡ではなく縁・文字・影の 3 つで示す（面の差だけでは 1.1:1 程度しか付かない）。
- 入力欄の縁は border ではなく背景 2 層で描き、フォーカス時は 2 層目のグラデーションだけを差し替える。
- textarea の自動伸長は上限 120px。高さを一度 auto に戻してから再計測する。

## 2. 1 行・複数行入力（solid / glass）

| surface | クラス | 備考 |
| --- | --- | --- |
| solid | `border border-border-interactive bg-surface-sunken inset-shadow-well placeholder:text-on-surface-subtle` | 地に沈めた不透明な面 |
| glass | `border border-border-interactive-glass bg-surface-raised/60 placeholder:text-on-surface-muted` | 半透明の面。淡い光の縁ではなく識別用の縁を使う |

共通: `rounded-control px-3 py-2 text-sm`・`transition-[background-color,box-shadow,border-color] duration-[var(--duration-quick)] ease-standard`・`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`・`disabled:cursor-not-allowed disabled:opacity-60`。1 行は `forwardRef<HTMLInputElement>`、複数行は `resize-y` を足して `forwardRef<HTMLTextAreaElement>`。

**glass でも淡い光の縁を使わない理由**: 入力欄では境界線が「コンポーネントの識別」そのものを担う。半透明面どうしの面の差は最大 1.2:1 程度しかなく、背景が明るいほど白へ収束して消える。装飾の縁（淡い光の縁）は識別を担えないので、操作要素の輪郭には使わない（`foundations/contrast-and-a11y.md` §5）。

## 3. Field の並び固定

1. ラベル（任意）
2. 説明（任意。入力する前に読ませたい補足）
3. 入力そのもの（children）
4. ヒント（左）／カウンタ（右） ← 入力直下の 1 行。片方だけでも成立する
5. エラー（最下段・`role="alert"`）

- カウンタを右に置くのは、文字数のような「入力の結果」を入力の終端に揃えるため。
- エラーを最後に置くのは、読み上げ順で「何の入力か → どう入れるか → 何が起きたか」になるようにするため。
- 並びは部品側に固定し、画面ごとに順序を変えさせない（共通部品なのに画面ごとに順序が違う状態を防ぐ）。
- glass（半透明面の上）は文字の段を 1 つ濃くする（`on-surface-muted` が半透明面の上で 4.5:1 を割る実測に基づく）。

## 4. FormError と LoadFailed の使い分け

| | 対象 | 見た目 | 再試行 |
| --- | --- | --- | --- |
| FormError | 入力に対する指摘 | `rounded-control border border-danger-500/40 bg-danger-50 px-3 py-2 text-caption text-danger-700`・`role="alert"` | 無し（やり直す対象はフィールドそのもの） |
| LoadFailed | 読み込みの失敗 | 同系色で `p-3`・`text-sm`・`role="alert"` | 再取得の手段を渡した場合だけボタンを出す |

**再試行できないならボタンを出さない**: 押しても直らない場面でボタンを出すと、利用者に偽の期待を持たせる。再取得の手段（コールバック）が無いときはボタンごと描画しない。再試行中はボタンを `disabled` にし、文言を「読み込み中...」に変える。

## 5. Switch

`role="switch"` ＋ `aria-checked` を持つボタンとして作る。

- キー操作: Space / Enter でトグル（`<button>` のネイティブ動作）。矢印キーは既定では拾わないため `onKeyDown` で明示的に足す（← ↓ で OFF、→ ↑ で ON。WAI-ARIA switch の慣習）。
- ON / OFF は色だけで示さない。つまみの位置＋トラックの色＋「ON」「OFF」の文字を併記する（`foundations/contrast-and-a11y.md` §6「状態を色だけで示さない」）。
- 寸法: トラック `h-5 w-9`（20×36px）・つまみ `h-4 w-4`（16×16px）。OFF 時はつまみが `left-0.5`（2px）、ON 時は `left-[18px]`（左右とも 2px の余白で収まる）。
- サイズ違い（例: `sm` / `md`）は文字サイズと padding だけを変える。トラック・つまみの寸法はサイズに関わらず固定でよい。

## 6. 選択肢チップ: 見た目だけ返す関数

選択肢を並べて 1 つ選ばせる UI は、コンポーネントではなく**クラス文字列を返す関数**で共通化する。

```ts
function choiceChipClass(args: {
  selected: boolean;
  surface: Surface;
}): string;
```

- 呼び出し側でマークアップが違う（`button[aria-pressed]` の場合と、`label` ＋ `sr-only` の `input[type=radio]` の場合がある）。振る舞いまで 1 つの部品に畳むと、いずれかのアクセシビリティ実装を壊す。共通化するのは見た目だけにする。
- 同じ理由でフォーカスリングもここには入れない。呼び出し側が自分のマークアップに合う当て方（`button` なら `focus-visible:<utility>`、`label`＋隠した radio なら `has-[:focus-visible]:<utility>`）を付ける。
- padding も呼び出し側が持つ（チップの種類によって情報量が違うため）。関数が持つのは面・縁・文字色・影だけ。

**選択状態の示し方**: 面の差では伝わらない（選択面と非選択面の実測差は 1.1:1 程度）。**縁・文字色・影の 3 つ**で示す。

| | 非選択 | 選択 |
| --- | --- | --- |
| 縁 | 識別用の縁（solid: `border-interactive` / glass: `border-interactive-glass`） | `brand-600` |
| 面 | solid: `surface-raised` / glass: `surface-raised/50` | solid: `surface-brand` / glass: `brand-100/70`（1 段濃くするが濃い塗りにはしない） |
| 文字 | solid: `on-surface-muted` / glass: `on-surface`（半透明面では 1 段濃く） | `brand-900` ＋ `font-medium` |
| 影 | なし（hover で solid は `raise`・glass は `rest`） | `shadow-rest`（持ち上げる） |

- 縁の色相は solid / glass で分けない（分けるのは段だけ。半透明面では識別用の縁を 1 段濃くする）。モードの差は面の作り方（不透明／半透明）で出す。
- 補助文（説明・注記）をチップ内に置くときは `on-surface-muted` 以上を使う。選択中の面は非選択面より暗く、より薄い文字色だと AA を割る場合がある。

## 7. 入力欄のグラデーションリング

`border` ではなく**背景の 2 層**で境界を描く。1 層目＝面の色、2 層目＝リングのグラデーション。`background-clip` で境界の 2px 幅だけにグラデを見せる。

```css
border: 2px solid transparent;
background-image:
  linear-gradient(var(--color-surface-sunken), var(--color-surface-sunken)), /* 1 層目: 面 */
  var(--background-image-input-ring);                                          /* 2 層目: リング */
background-origin: border-box;
background-clip: padding-box, border-box;
```

- **フォーカス時は 2 層目（リングのグラデ）だけを差し替える。** 1 層目（面の色）は変えない。
- `border-color` を持たないため、フォーカス時の `outline` と色が重ならず二重線にならない。
- リング色はグラデーション（`brand-500 → accent-500`、フォーカス時は `brand-600 → accent-600`）。操作要素の輪郭なので WCAG 1.4.11（3:1）を満たす段を選ぶ。
- **透かす面用の版**: 背景を透かす面の上に置く入力欄は地が透明なため、1 層目（padding-box 側）を不透明色ではなく `surface-raised` の 60% 相当の半透明にする。2 層目のグラデーション自体は共通のまま。

## 8. メッセージ入力の textarea 自動伸長（上限 120px）

```ts
const el = textareaRef.current;
if (el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}
```

- 一度 `height: auto` に戻してから `scrollHeight` を読む。戻さずに測ると、文字を削除したときに縮まなくなる（`scrollHeight` が現在の高さを含んだ値になるため）。
- 上限は 120px。それ以上は内部スクロールに任せる（`resize-none` と組み合わせ、自動伸長と手動リサイズのハンドルを競合させない）。
- 静的な CSS の `max-height` だけでは成立しない。伸ばす量は内容依存（`scrollHeight`）のため、JS での再計測が要る。

## 9. 落とし穴

- Field の並びを画面ごとに変える。
- 再試行できないのに読み込み失敗の表示にボタンを出す。
- 選択肢チップの状態を面の濃淡だけで示す（1.1:1 では伝わらない）。
- 入力欄のリングを border で描こうとして、outline と二重線になる。
- textarea の高さを auto に戻さずに `scrollHeight` を読み、縮まなくなる。

## 10. チェックリスト

- [ ] solid / glass の入力欄の縁は、淡い光の縁ではなく識別用の色を使った
- [ ] Field の並びを固定順（ラベル→説明→入力→ヒント/カウンタ→エラー）にした
- [ ] 再試行できない失敗表示にはボタンを出していない
- [ ] Switch はつまみの位置＋文字の両方で ON/OFF を示した
- [ ] 選択肢チップの状態を縁・文字・影の 3 つで示した
- [ ] 入力欄のリングは背景 2 層＋ 2 層目だけの差し替えで作った
- [ ] textarea の自動伸長は `height: auto` へ戻してから再計測している
