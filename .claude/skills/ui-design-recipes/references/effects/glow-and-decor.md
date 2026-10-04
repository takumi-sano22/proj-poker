# 発光・装飾の演出

> **いつ読むか**: ボタンや主役（アバター・キャラクター等）に光・呼吸・気分の演出を付けるとき／吹き出しを「発話」ではなく「考えて差し出している」候補として形で示すとき
> **前提**: `foundations/motion.md`（所要時間トークン・reduced-motion の止め方）・`foundations/surface-and-depth.md`（clip-path / mask と影の関係）・`foundations/type-space-radius.md`（専用フォントの限定適用）
> 形の値（半径・ぼかし・遅延・opacity・duration）はそのまま再現してよい。色はトークン外のものを含め役割と選び方で書く。

## 1. 要点

- 発光は**ボタン本体の前面に敷いた別要素（オーバーレイ）**に持たせる。背面だと不透明な面の下に光が隠れ、ボタン本体の box-shadow に載せると hover の影差し替えと食い合う。
- 強弱は opacity で付ける。keyframes 側の alpha を calc で変える方式はブラウザ差が出て読みづらい。
- 状態（生成中 / 表示中など）で周期と強さを変え、色は画面のどの面とも色相が離れた色を選ぶ。
- 光の意味は**文言でも補う**。光だけでは「もう一度押すと消える」のような状態の違いは伝わらない。
- 雲形の吹き出しは clip-path を 1 か所に定義して参照し、輪郭は一段外側の要素の drop-shadow で出す（clip-path を掛けた要素には border も box-shadow も効かない）。
- 主役の気分は keyframes の値と「気分 → クラス」の対応を 1 か所の Record で持つ。同じ要素に重ねる演出は `animation` を 1 つの宣言に並べる（クラス 2 つでは後勝ちで片方が消える）。**定義した keyframes の数だけ reduced-motion で止める**（止め忘れやすい）。

## 2. 発光オーバーレイ

### 構造

```html
<div class="relative">
  <button class="relative ...">…</button>
  <span
    aria-hidden="true"
    class="glow pointer-events-none absolute inset-0 rounded-<ボタンと同じ角丸>"
  ></span>
</div>
```

- **前面に敷く**: 背面に敷くと、不透明な面のボタン本体の下に内側の光が隠れて見えない。前面なら外側のハローと内側のリムを 1 つの要素で描け、アイコンや文字はオーバーレイに背景が無いのでそのまま透けて見える。
- **ボタン本体の box-shadow には乗せない**: hover で影を差し替える要素に別の box-shadow（発光）を同居させると食い合う。光は前面の別要素に分ける。
- `pointer-events-none` を必ず付け、クリックを妨げないようにする。

### 値

| 状態 | box-shadow（外側ハロー 2 層 + 内側リム 1 層） | duration | opacity |
| --- | --- | --- | --- |
| 静止（弱） | `0 0 6px 1px rgb(<r> <g> <b> / 0.35)`, `0 0 14px 4px rgb(<r> <g> <b> / 0.2)`, `inset 0 0 6px 1px rgb(<r> <g> <b> / 0.3)` | 2.8s ease-in-out infinite（周期の折り返し地点で下段の値まで強める） | 0.85 |
| 折り返し（強） | `0 0 12px 3px rgb(<r> <g> <b> / 0.7)`, `0 0 26px 9px rgb(<r> <g> <b> / 0.4)`, `inset 0 0 12px 2px rgb(<r> <g> <b> / 0.55)` | 同上の中間点 | — |
| 強調状態（例: 生成中） | 同じ 2 段の keyframes | duration を短縮（例: 2.8s → 2s） | 1 |

- **色の選び方**: 画面の主役級の色相（ブランド色・対象の面の色相）と被らない暖色（例: amber 系）を選ぶ。近い色相だと「光っている」こと自体に気づけない。
- **reduced-motion**: 中間の強さの静止した box-shadow（例: `0 0 10px 2px rgb(<r> <g> <b> / 0.5)`, `0 0 20px 6px rgb(<r> <g> <b> / 0.3)`, `inset 0 0 10px 2px rgb(<r> <g> <b> / 0.45)`）を残す。「光っている」という状態の情報を動きに依存させない（`foundations/motion.md` §3 の静止形の考え方）。

## 3. 雲形の吹き出し

コミックの文法では「丸い雲＝内心・思考」「楕円＝発話」。主役が**喋っている**のではなく**考えて差し出している**候補であることを、形で示す。

- 輪郭は **SVG の clipPath（`clipPathUnits="objectBoundingBox"`）** で 1 か所に定義し、`clip-path: url(#id)` で参照する。`objectBoundingBox` なら座標が 0〜1 の割合になり、適用先の箱の大きさ（1 行でも複数行でも、幅が変わっても）に自動で追従する。

```html
<svg width="0" height="0" aria-hidden="true" class="absolute">
  <defs>
    <clipPath id="<cloud-path>" clipPathUnits="objectBoundingBox">
      <path d="…大小まちまちの丸みを持つ 1 本のパス…" />
    </clipPath>
  </defs>
</svg>
```

```css
.cloud-surface {
  clip-path: url(#<cloud-path>);
}
```

- **clip-path / mask を掛けた要素には border も box-shadow も効かない**（描画そのものが削られる）。輪郭は一段外側の要素の `filter: drop-shadow(...)` で出す。drop-shadow は要素の alpha の形に沿って影が付くので、mask / clip で欠けたこぶの輪郭にもそのまま追従する。
- **drop-shadow を mask / clip と同じ要素に置かない**: `filter` → `mask` の順で描画されるため、同じ要素に置くと影までマスクで一緒に削られる。

```css
.cloud-shadow {
  filter:
    drop-shadow(0 2px 4px rgb(<r> <g> <b> / 0.22))
    drop-shadow(0 8px 16px rgb(<r> <g> <b> / 0.12));
}
```

輪郭の色は発光のように離すのではなく、**面自体の色相に合わせて馴染ませる**（塗り自体が特定の色相のグラデーションなら、その色相の暗めの段を使う）。

**タイル状の radial-gradient mask で作った教訓**: こぶを等間隔の radial-gradient タイルで並べる方式は、**均等な間隔の小さなこぶしか作れず、全体が四角く見える**。クラウドマークのような大小まちまちで広いカーブは、輪郭そのものを 1 本のパスとして持つしかない。

### しっぽの ◦

吹き出しの下に ◦ を 3 つ並べ、下から上へふわっと上がる動きで「ここで考えている」ことを示す。

| 位置（吹き出しに近い順） | 大きさ | 遅延 | ピーク時 opacity | 間隔 |
| --- | --- | --- | --- | --- |
| 1 | 8px | 0ms | 0.85 | 4px |
| 2 | 6px | 200ms | 0.65 | 6px |
| 3 | 4px | 400ms | 0.45 | 3px |

大きさ・遅延・opacity を少しずつ変えて均一さを崩す（機械的に並んだ半円に見えないようにする）。

```css
@keyframes dot-rise {
  0%,
  100% {
    transform: translateY(3px);
    opacity: calc(var(--dot-o) * 0.4);
  }
  50% {
    transform: translateY(-3px);
    opacity: var(--dot-o);
  }
}
.dot {
  animation: dot-rise 2.4s ease-in-out infinite;
  opacity: var(--dot-o);
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
    transform: none;
  }
}
```

ピーク時の濃さ（`--dot-o`）は ◦ ごとにインラインの CSS 変数で渡す。1 つの keyframes 定義を複数の ◦ で共有しながら、濃さだけを個別に変えられる。止めた後も ◦ 自体は残す（「ここに続きがある」という意味は動きに依存していない）。

## 4. 主役の気分の演出

| 気分 | keyframes の概要（周期・移動量・回転・スケール） |
| --- | --- |
| 浮遊（通常） | 3s ease-in-out infinite。`translateY` を 0 → -10px（25%）→ -6px（75%）→ 0、`rotate` を ±1deg で揺らす |
| 弾む（喜び） | 0.7s ease-in-out・単発。`translateY(-18px)`（上へ 18px）まで跳ね、着地で `scaleY` 0.92 / `scaleX` 1.08 に潰れ、2 回目は -10px と弾みを減らす。伸縮を互い違いにして着地の弾力を表す |
| 小刻みに震える（心配） | 0.6s ease-in-out infinite。`translateX` ±5px・`rotate` ±2deg から振幅を減衰させる |
| 考える | 2.2s ease-in-out infinite。`rotate` を -8deg（30%）→ 4deg（60%）→ 0、`translateY` をわずかに伴わせる |
| 登場（ポップイン） | 0.6s・`ease-emphasis`（`cubic-bezier(0.34, 1.56, 0.64, 1)`）・単発・`both`。`scale` を 0.4 → 1.12（60%、行き過ぎ）→ 0.95（80%）→ 1、`opacity` を 0 → 1 |
| グロー（周辺の光） | 4s linear infinite。drop-shadow のぼかし半径を 8px ⇄ 12px、色をブランド系 → アクセント系 → ブランド系の 3 点で回す |

- **気分 → 演出の対応は 1 か所の Record で持つ。** 分岐をコンポーネント側に散らしたり、描画方式ごとに対応表を複製したりすると、気分を 1 つ増やすたびに複数箇所を直す羽目になり、片方だけ漏れる。
- **2 つの演出を同じ要素に重ねるときは、`animation` を 1 つの宣言に並べる。** クラスを 2 つ並べる（`class="mood-float mood-glow"`）と、どちらも `animation` の短縮形を指定しているので、**後に定義した方だけが効き、もう片方は黙って消える**。担当が `transform` と `filter` に分かれていても、ぶつかるのは `animation` という 1 つのプロパティである。

```css
.mood-float { animation: float 3s ease-in-out infinite; }
.mood-glow { animation: glow 4s linear infinite; }
/* 重ねる組み合わせは、専用のクラスで 1 つの宣言にする */
.mood-float-glow {
  animation:
    float 3s ease-in-out infinite,
    glow 4s linear infinite;
}
.mood-bounce-glow {
  animation:
    bounce 0.7s ease-in-out,
    glow 4s linear infinite;
}
```

```ts
const MOOD_ANIMATION: Record<Mood, string> = {
  normal: "mood-float-glow",
  happy: "mood-bounce-glow",
  worried: "mood-shake",
  thinking: "mood-think",
};
```

入れ子の 2 要素に 1 つずつ持たせる形（外側に浮遊、内側にグロー）でもよい。こちらは reduced-motion で片方だけ止める・残すといった調整がしやすい。重ねたかどうかは見た目では気づきにくいので、ブラウザの計算値（`getComputedStyle(el).animationName`）に両方の名前が載っていることを確かめる。

- **移動量は表示サイズに対して決める。** 大きな表示（100px 前後）向けに作った浮遊（-10px）や弾み（-18px）を、ヘッダーに収まる 30px 前後のアバターにそのまま当てると、丸枠や置き場所の上端を越えて飛び出す。小さな表示に使うなら振幅を縮めたクラスを別に作るか、動きを付けずグローだけにする。頂点の位置は、`animation-delay` を負の値にして `animation-play-state: paused` で止めれば測れる。
- **グローの色は brand / accent の範囲に収める。** 虹色（ブランドと無関係な色相を混ぜる）にすると、装飾がブランドから浮く。
- **足した keyframes は全部 reduced-motion で止める。** 1 つでも止め忘れると、そこだけ動き続ける。`foundations/motion.md` §3 の確認手順（`@keyframes` の定義数と `prefers-reduced-motion` の停止ルールの数を突き合わせる）を必ず行う。
- 止めた後も気分そのものは、背景のグラデーションや状態文言など**動き以外の手段**で伝わるようにする（動きだけに気分の情報を持たせない）。

## 5. 装飾専用フォント

雲形の吹き出しなど「候補である」ことを示す面だけに丸ゴシック等の専用フォントを当てる場合の適用範囲・フォールバックの作法は `foundations/type-space-radius.md` を参照する（本書では扱わない）。

## 6. 落とし穴

- 発光オーバーレイをボタンの**背面**に敷く。不透明な面の下に隠れて見えない。
- 発光をボタン本体の box-shadow に同居させる。hover の影差し替えと食い合う。
- タイル状の radial-gradient mask で曲線的な形を作ろうとする。均等な小さいこぶしかできず四角く見える。
- clip-path / mask を掛けた要素に直接 border や box-shadow を付ける。描画ごと削られる。
- drop-shadow を mask / clip と同じ要素に置く。影までマスクで削られる。
- 大きな表示向けの移動量を、小さなアバターにそのまま当てる。丸枠や置き場所の上端を越えて飛び出す（§4）。
- 2 つの演出をクラス 2 つで同じ要素に重ねる。`animation` の短縮形どうしがぶつかり、後に定義した方だけが効く（§4）。
- 主役の気分の演出で、足した keyframes を 1 つでも止め忘れる。動きは増えやすいが、止めるルールはトークンの一括停止が効かず個別に書く必要がある。
- 光の色を画面の主要な色相に近い色にする。「光っている」こと自体に気づかれない。

## 7. チェックリスト

- [ ] 発光オーバーレイはボタン前面の別要素で、`pointer-events-none` を付けた
- [ ] 発光の強弱は opacity で付け、状態ごとに duration / opacity を変えた
- [ ] 発光の色はどの面とも色相が離れており、かつ状態の違いを文言でも補っている
- [ ] reduced-motion では発光を中間の強さの静止形で残した
- [ ] 雲形は clipPath を 1 か所に定義し、輪郭は一段外側の drop-shadow で出した
- [ ] しっぽの ◦ は大きさ・遅延・opacity を不揃いにし、止めた後も ◦ 自体は残した
- [ ] 主役の気分は keyframes の値と「気分 → クラス」の Record を 1 か所にまとめた
- [ ] 同じ要素に重ねる演出は `animation` の 1 宣言に並べた（か入れ子の要素に分けた）。計算値の `animationName` に両方が載っている
- [ ] 足した主役の演出の keyframes 全部に reduced-motion の停止ルールがある（定義数と停止数を突き合わせた）
