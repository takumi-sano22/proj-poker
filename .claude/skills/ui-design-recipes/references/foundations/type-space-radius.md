# 文字・余白・角丸・タップ領域

> **いつ読むか**: 文字サイズ・行間・フォント・余白・角丸・押せる範囲の大きさを決めるとき
> **前提**: `surface-and-depth.md` の層（角丸は層で決まる）
> 値はそのまま再現してよい。

## 1. 要点

- **既定の数値スケール（`text-sm` 等）は上書きしない。役割名の段を「足す」。** 既存画面を作り替えずに済む。
- 日本語は**行間を広め**に取る（本文 1.8）。
- 余白で名前を付けるのは「画面をまたいで揃っていないと気持ち悪い 3 つ」だけ。残りは 4px 刻みの既定。
- **角丸は層を表す**（操作 10 / 脇役 12 / 読む対象・準主役 16 / 別レイヤー 20 / 見本 4）。
- 押せる範囲は **44px 以上**、アイコンだけのボタンは **40px 四方**が下限。
- 親しみやすさは配色の温度ではなく、**余白・角丸・影のやわらかさとコピー**で出す。

## 2. 文字

| トークン | サイズ | 行間 | 太さ | 用途 |
| --- | --- | --- | --- | --- |
| `--text-caption` | 0.75rem（12px） | 1.6 | — | 補足・タイムスタンプ・キーヒント |
| `--text-body` | 0.9375rem（15px） | 1.8 | — | 本文・吹き出し |
| `--text-section` | 1.125rem（18px） | 1.5 | 600 | セクション見出し |
| `--text-title` | 1.375rem（22px） | 1.4 | 700 | 画面タイトル・モーダル名 |
| `--text-display` | 1.875rem（30px） | 1.3 | 700 | 入口・空状態の大見出し |

- 吹き出しなど読み物は `text-sm leading-relaxed`（14px / 1.625）でも運用している。長文を読む面で本文を
  15px / 1.8 にするか 14px / 1.625 にするかは、**1 画面の中で揃える**ことを優先する。
- 見出しを本文と区別するときは、文字色だけでなく**太さ・大きさ・左の縦線（2〜4px）**のいずれかを併用する。

**フォント**:

- 本文は OS の日本語フォントに任せる: `"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif`。
  Web フォントで全体を差し替えると既存画面の見た目が全部動き、日本語フォントは転送量も大きい。
- **個性を出すフォントは適用範囲を 1 か所に限定する**（例: 提案の吹き出しだけ丸ゴシック）。
  Next.js なら `next/font/google` で `variable: "--font-rounded"` を持たせ、使う側は
  `font-family: var(--font-rounded), <本文と同じスタック>` にする（未読込でも本文スタックへ落ちる）。
- 日本語の Web フォントは `preload: false` ＋ `display: "swap"`。unicode-range で 100 以上のスライスに
  分かれており、preload すると使わないスライスまで先読みする。

```ts
// 限定用途の丸ゴシック（Next.js）。<RoundedFont> は next/font/google の丸ゴシック系フォント
export const roundedFont = <RoundedFont>({
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-rounded",
  fallback: ["Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", "sans-serif"],
});
```

## 3. 余白

| トークン | 値 | 用途 |
| --- | --- | --- |
| `--spacing-stack` | 0.75rem（12px） | 同じブロック内の要素の間 |
| `--spacing-gutter` | 1rem（16px） | 画面の端・カードの内側（モバイル基準） |
| `--spacing-section` | 2rem（32px） | セクションの間 |

よく使う組み合わせ（実装での値）:

| 対象 | 値 |
| --- | --- |
| 吹き出しの内側 | `px-4 py-3`（16 / 12px） |
| モーダルのヘッダー / 本文 / フッター | `px-6 pb-3 pt-5` / `p-4` / `px-4 py-3` |
| ボタン sm / md / lg | `px-3 py-1.5` / `px-4 py-2.5` / `px-5 py-3` |
| 入力欄 | `px-3 py-2`（1 行）・`px-4 py-3`（メッセージ入力） |
| フォームの縦の並び | `gap-1.5`（ラベル〜エラーの間） |

## 4. 角丸

| トークン | 値 | 層・用途 |
| --- | --- | --- |
| `--radius-control` | 0.625rem（10px） | 操作要素（ボタン・入力・チップ）・操作を求める面（選択待ち） |
| `--radius-control-inner` | 0.5rem（8px） | 外枠 10px の内側に 1px の余白を取ったセグメントの内側（10 − 1 × 2 = 8） |
| `--radius-panel` | 0.75rem（12px） | 脇役の面（L3）・トリガーに付いて出るポップオーバーやドロップダウン |
| `--radius-card` | 1rem（16px） | 読む対象・準主役（L1 / L2）・カード |
| `--radius-modal` | 1.25rem（20px） | 別レイヤー（L4: モーダル・シート・ドロワー） |
| `--radius-frame` | 0.25rem（4px） | どの層にも属さない見本（説明用の画面の模式図） |
| `--radius-pill` | 9999px | タグ・バッジ・スクロールバーのつまみ |

- **入れ子の角丸は「外側 − 余白」**で決める。外枠と内側を同じ値にすると、内側の角が外枠からはみ出して見える。
- **段階を上げるほど丸くするのではない。** 脇役（12px）は読む対象（16px）より角を締め、「主役ではない」ことを示す。

## 5. タップ領域

| 対象 | 下限 | 書き方 |
| --- | --- | --- |
| ラベル付きのボタン・一覧の行 | 高さ 44px | `min-h-[44px]` |
| アイコンだけのボタン | 40 × 40px | `h-10 w-10 p-2`（アイコンは 20px） |
| 送信ボタン | 44 × 44px | `h-11 w-11` |

## 6. 実装の雛形

```css
@theme static {
  --font-sans: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;

  --text-caption: 0.75rem;   --text-caption--line-height: 1.6;
  --text-body: 0.9375rem;    --text-body--line-height: 1.8;
  --text-section: 1.125rem;  --text-section--line-height: 1.5;  --text-section--font-weight: 600;
  --text-title: 1.375rem;    --text-title--line-height: 1.4;    --text-title--font-weight: 700;
  --text-display: 1.875rem;  --text-display--line-height: 1.3;  --text-display--font-weight: 700;

  --spacing-stack: 0.75rem;
  --spacing-gutter: 1rem;
  --spacing-section: 2rem;

  --radius-control: 0.625rem;
  --radius-control-inner: 0.5rem;
  --radius-panel: 0.75rem;
  --radius-card: 1rem;
  --radius-modal: 1.25rem;
  --radius-frame: 0.25rem;
  --radius-pill: 9999px;
}

body {
  font-family: var(--font-sans);
}
```

Tailwind v4 では `--text-body--line-height` のように `--` でつないだ副値が、`text-body` を当てたときの
行間・太さとして一緒に効く。`--spacing-gutter` は `p-gutter` / `gap-gutter`、`--radius-card` は `rounded-card` になる。
**Tailwind を使わない場合**は `font-size: var(--text-body); line-height: 1.8;` のように副値を自分で並べる。

## 7. 落とし穴

- **`min-h-[44px]` と `h-10` を同じ要素に併記しない。** どちらが勝つかが Tailwind の生成順で決まるため、
  **アイコンだけの版は別のクラス文字列に分けて**、どちらか一方だけを当てる。
- **閉じるボタン（×）を `p-1.5` ＋ 20px アイコンで作ると 32px になり**、アイコンだけのボタンの下限 40px に届かない。
  `p-2.5` にするか、押せる範囲を疑似要素で広げる。
- **呼び出し側の `className` で文字サイズや余白を上書きしようとしても効かない**ことがある（Tailwind は並び順ではなく
  生成された CSS の順で勝敗が決まる）。上書きさせたい軸（余白・サイズ）は部品の prop で受ける。
- **Web フォントを全体に当てる**と、日本語では転送量が大きく、既存画面の見た目が一斉に動く。

## 8. チェックリスト

- [ ] 既定の数値スケールを上書きしていない（役割名の段を足しただけ）
- [ ] 角丸はその面の層で決めた（入れ子は外側 − 余白）
- [ ] 押せる範囲は 44px 以上（アイコンだけは 40px 四方）
- [ ] 個性的なフォントを全体に当てていない（当てるなら 1 か所に限定し、フォールバックを本文スタックに）
