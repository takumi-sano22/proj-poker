---
name: ui-design-recipes
description: >-
  確立したデザイン体系を、実装の値（Tailwind v4 のクラスと素の CSS 値）で再現する UI のレシピ集。
  色の使い方・面と影・文字/余白/角丸・動き・コントラスト、部品、画面幅ごとの配置、hover や発光などの演出、
  絵文字・アイコンを扱う。画面や部品を作る・直す、配色・影・余白を決める、レスポンシブ対応や
  アニメーションを付けるとき（「モーダルを作って」「スマホでも崩れないようにして」等）に使い、
  SKILL.md の対応表から必要な reference だけを読む。
  体系が確立済みなら frontend-design より優先する。
---

# UI デザインの実装レシピ

> **proj-poker での位置づけ**: 汎用の reference に、卓 UI の固有補強 `references/proj-poker.md` を足したもの。**UI を作る・直すときは、reference より先に `references/proj-poker.md` を読む**（素の CSS・トークン・既存部品・画面幅と卓の配置規則・重なりの測り方）。画面要件は `docs/06_UI_UX.md` が正本で、実額常時表示（D49）を優先する。卓 UI に不要な汎用 reference（チャット画面・管理画面・画面の見本・コードブロック）は #5 で削除した。

画面や部品を**すでにあるデザイン体系に沿って**作るときの、実装の値と作法の集まり。
美学の方向性を決める skill ではなく、決まった方向性を**同じ値で再現する**ための skill である。

本文（この SKILL.md）は導線だけを持つ。知見は `references/` に分けてあるので、
下の対応表で**作るものに対応する reference だけ**を読むこと。全部を読むとコンテキストを浪費する。

## 着手前（毎回）

1. **固有の補強 md を先に読む。** 作業中のリポジトリの `CLAUDE.md` / `AGENTS.md` が
   本 skill の固有補強 md（proj-poker では `references/proj-poker.md`）を指していれば、
   reference より先に読む。固有 md には実際の色の値・既存部品の対応表・プロジェクト固有の禁止事項がある。
   **固有 md と reference が食い違ったら固有 md（とそれが指す実装）を採る。**
   reference は複数プロジェクトに共通する形に一般化してあり、個別の事情を知らないため。
   その差は固有 md に例外として書き、reference を書き換えるのは一般則そのものが誤っている／改善されたときだけにする
   （reference は他のプロジェクトとも共有している）。
2. **既存の部品とトークンを探す。** 同じ役割の部品・トークンが既にあれば新しく作らない。
   同じ意匠が 2 か所に書かれると、片方だけ直されて必ずずれる。
3. **対応表から reference を選んで読む。** 1 つの作業で読むのは 1〜3 本が目安。

## frontend-design との優先順位

`frontend-design`（Anthropic 公式 skill）は「毎回違う美学を選ぶ」「白背景の紫グラデーションや
システムフォントを避ける」と指示する。これは**体系がまだ無い**段階で方向性を決めるための指示であり、
体系を**再現する**本 skill とは向きが逆になる。両方が効いた場合は次の表で決める。

| 状況 | 使う skill |
| --- | --- |
| トークン・部品の体系が既にある／本 skill の体系を採用すると決めている | **本 skill**（frontend-design の「毎回違う美学」「配色・フォントの回避指示」は適用しない） |
| 体系が無く、0→1 で方向性から決める | frontend-design（決まった後の実装値は本 skill の型に落とす） |
| LP・ポスター・Artifact など、体系の外にある単発の制作物 | frontend-design |

## 作るもの → 読む reference

| 作るもの・やること | 読む reference |
| --- | --- |
| **proj-poker の卓 UI（席・Bet・Pot・Card・Chip・宣言 Button・Dealer Feedback・Hero 欄・Replay・Review）・狭い画面の配置・重なりの測り方** | `references/proj-poker.md`（最初に読む） |
| 新しいプロジェクトにこの体系を導入する | `references/README.md` → `foundations/` を順に全部 |
| 色を決める・グラデーションをかける・アクセントを置く・ベースライン色を差し替える | `references/foundations/color-usage.md` |
| 面（カード・吹き出し・パネル・モーダル）の重なり・影・縁を決める | `references/foundations/surface-and-depth.md` |
| 文字サイズ・行間・余白・角丸・タップ領域・フォント | `references/foundations/type-space-radius.md` |
| アニメーション・遷移・入場の演出・reduced-motion | `references/foundations/motion.md` |
| コントラストを確かめる・フォーカスリング・状態の示し方・キーボード操作の割り当て | `references/foundations/contrast-and-a11y.md` |
| ボタン・押せる操作要素（変種・サイズ・solid / glass・アクションボタン） | `references/components/button.md` |
| カード・パネル | `references/components/card-and-panel.md` |
| 入力欄・フォームの並び・エラー表示・スイッチ・選択肢チップ・入力欄のリング | `references/components/form-controls.md` |
| モーダル・ダイアログ・確認画面・入れ子の確認 | `references/components/modal.md` |
| ボタンに付いて出るメニュー（ポップオーバー・ドロップダウン） | `references/components/popover-menu.md` |
| ツールチップ・hover で出るラベル・タッチでの代わり（長押し） | `references/components/tooltip-and-hover-label.md` |
| ドロワー・画面端から出るシート・画面端スワイプ | `references/components/drawer-and-sheet.md` |
| トースト・お知らせや提案のバナー | `references/components/banner-and-toast.md` |
| スクロールバーの見た目 | `references/components/scrollbar.md` |
| アプリの骨組み・画面幅ごとの列の出し分け・中央寄せ・z-index | `references/layout/app-shell-responsive.md` |
| hover・押下の反応（影の段上げ・持ち上げ・hover で出す操作・常時表示にする判断） | `references/effects/hover-and-press.md` |
| 発光・装飾の演出（光るボタン・雲形の吹き出し・主役の気分のアニメーション） | `references/effects/glow-and-decor.md` |
| 背景を透かす半透明の面（ガラスの面・アルファの決め方・クリック透過・端のフェード） | `references/effects/glass-surface.md` |
| 絵文字・アイコン（使う場所・1 概念 1 絵文字・aria・インライン SVG） | `references/content/emoji-and-icons.md` |

部品を作るときは、部品の reference に加えて、その部品が載る面の層を `surface-and-depth.md` で確かめる。
迷ったら `surface-and-depth.md` から読む。どの部品も「どの層の面か」が決まれば、角丸・影・縁が決まる。

## 鉄則（全 reference に共通）

全 reference と `references/proj-poker.md` に適用する。

1. **色は役割名で呼ぶ**（`brand` / `accent` / `surface` / `on-surface`。`indigo` / `gray-900` と呼ばない）。
   色相名で呼ぶと、ブランド色を差し替えた瞬間に名前が嘘になり、参照側を全部書き換えることになる。
2. **値はトークン経由で書く**（色・影・角丸・所要時間を直書きしない）。
   トークンで担保したコントラストと reduced-motion の保証から、直書きした箇所だけ外れる。
3. **状態は色の差ではなく影の段で示す**（hover で 1 段上げる・active で影を消す）。
   面と hover 面・選択と非選択の面の色差は実測で 1.0〜1.12:1 程度しか無く、色だけでは伝わらない。色覚の差にも強い。
4. **コントラストは計算で決める。目視で決めない。** グラデーションは文字に最も不利な端で、
   半透明の面は実際に重なる背景のうち前景に最も不利なピクセル（暗い文字なら最暗・白文字なら最明）で測る。
5. **hover 前提の情報は、画面幅ではなく hover / pointer の能力で出し分ける。**
   幅で分けると、hover が無く幅だけあるタブレットが取りこぼされる。
6. **動きはトークン経由で指定し、keyframes は定義ごとに止める。**
   トークンの一括 0ms 化は keyframes には効かない。
7. **共通部品の既定値を変えない。** 新しい意匠は prop で opt-in にする。
   上書きさせたい軸は `className` ではなく prop で受ける（Tailwind は生成順で勝敗が決まり、黙って効かない）。
8. **強さは役割ごとに配る。** 全部の面を同じレシピで塗ると区別が消えて安っぽく見える。
   揃えるのは値ではなく「どの役割にどの強さを配るか」の規則。

## この skill を更新するとき

- **色は HEX 値を書かない**（白 `#fff` と透明を除く）。役割・段・相対関係（「白文字を載せる塗りは、白文字が 4.5:1 以上になる段」等）で書く。
  実際の値はプロジェクトごとに違うので、固有補強 md に「当てはめ例」として置く。
- **形（角丸・影・余白・幅・高さ・所要時間）は値そのまま書く。**
- **汎用の reference にプロジェクト固有のパス・Issue 番号を書かない。** WHY は一般化して書き、
  出典の対応は固有補強 md に置く。
- reference の書式・更新手順は `references/README.md` の「reference の型」「更新ルール」に従う。
