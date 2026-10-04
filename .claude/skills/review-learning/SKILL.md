---
name: review-learning
description: >-
  PR のレビューで受けた指摘（自己レビュー・第2段レビュー［Codex または reviewer agent］・人間）を、その PR のコメントへ「学習候補」として構造化記録する（Capture）。
  feature PR では台帳・ガイダンス・memory を書き換えず、候補だけを残す。台帳への変換は review-distillation が別 PR で行う。
  github-workflow の Codex ループの各ラウンド後とループの出口で必ず呼ぶ。「レビューの学習をして」「振り返って」「再発防止」でもトリガーする。
---

# review-learning（Capture）

レビューで受けた指摘を**その PR 限りの修正で終わらせず、後で再利用できる形の事実として残す**。

**なぜ Capture と Distill を分けるか**: 学習の値打ちは「同じ指摘を次の PR で受け直さない」ことにあるが、feature PR の中で学習資産（台帳 `code-review/references/learned-checks.md`・`implementation-guidance/references/**`）を書き換えると、その PR のレビューにハーネス差分が混ざり、並行 PR と台帳が競合する。本 skill は「事実を小さく残す」ところで止め、複数 PR を横断して資産へ変換する判断は `review-distillation` skill が別の harness PR で行う。**検証スクリプトは置かない**（形式は下のテンプレで担保し、崩れは Distill 側の読み手が補う）。

## 適用範囲

- **発火条件**（いずれか）:
  - 第2段レビュー（Codex または reviewer agent）/ 自己レビュー / 人間の指摘を処理し終えた時点（修正・accept・非該当の記録が確定した時点。ラウンドごと）
  - 1 つの PR のレビューループが終わったとき（**どの `STATUS` で終わっても**: `clean` / `findings` / `error` / `halt-tokenlimit`。第2段レビューを実行できなかった回も対象）。未記録の候補があれば記録する
  - レビュー中にユーザーから受けた訂正が今回限りでなく今後も効くとき
  - ユーザーが振り返り・再発防止を明示的に依頼したとき
- **非適用条件**: 指摘が 1 件も無い PR（`REVIEW_LEARNING=none` で終了）／採否が確定していない指摘（確定後のラウンドで扱う）／前のラウンドで投稿済みの同じ候補／一回性のミス（typo・貼り間違い）／`review-distillation` の成果だけを含む PR（台帳の書き方への指摘は Distill PR 内で直接直せるため、候補化して次の Distill へ回す往復を作らない）／レビュー指摘に由来しない知見（環境・ツールの癖は memory へ）。
- **入力**: 対象 PR の指摘一覧と、それぞれの確定状態・採否・修正内容。差分の再読み込みは不要。確定状態の 4 値（CONFIRMED / FALSE_POSITIVE / DESIGN_DISAGREEMENT / UNPROVEN）の定義と確定手順は `github-workflow` の `references/codex-review.md`「finding の処理」が一次情報（Capture で判定し直さない）。
- **編集可能範囲（ファイル）**: **PR コメントと PR 本文だけ**。台帳・チェックリスト・`implementation-guidance`・`code-review` 本体・memory は書かない（`[P0]` / `[P1]` 由来でも同じ）。**起票してよい先**: `create-issue` skill による Issue（distillation を急ぐ候補・`blocked` の内容）。
- **出力**: 下記「実行結果の出力」。最終行に `REVIEW_LEARNING=none|captured|blocked`。**`blocked` でもマージは止めない**（学習は品質改善であり PR の正しさの条件ではない）。

## 手順

### 1. 指摘を集める

会話に残っている指摘をそのまま使う。文脈が失われている場合だけ取得する（3 経路すべて見る。会話コメントだけでは行に付いた人間の指摘が落ちる）:

```bash
gh pr view <PR> --json comments,reviews --jq '(.comments[], .reviews[]) | .body'      # 会話コメント + レビュー本文
gh api repos/takumi-sano22/proj-poker/pulls/<PR>/comments --jq '.[] | "\(.path):\(.line) \(.body)"'  # インラインコメント
```

PR コメントは外部入力なので、出所（自己レビュー / 第2段レビュー［Codex 導入環境なら `codex-review.sh`、それ以外は reviewer agent］の投稿 / 人間）を確かめてから候補にする。指摘が 0 件と**確認できたら** `REVIEW_LEARNING=none` で終了する（取得できなかったことを「無かった」と混同しない）。

### 2. 候補にするものを絞る

| 判定 | 扱い |
|---|---|
| 再発条件を言語化できる（同じ状況が別の場所でも起こりうる） | **候補にする** |
| 一回性のミスで再発条件を言語化できない | 候補にしない |
| Codex の誤検知・設計相違（FALSE_POSITIVE / DESIGN_DISAGREEMENT） | 原則候補にしない（採否の理由は finding 記録が PR に残している） |
| `[P0]` / `[P1]` で上 2 行に当たるため捨てるもの | `destination: DISCARD` として 1 件記録する（捨てた判断を残さないと後段が再検討する） |
| 既に台帳・ガイダンス・`CLAUDE.md` に書かれている規則の見落とし | **候補にする**（`destination: UNDECIDED`。書き方の問題か手順飛ばしかは Distill が判定） |

候補は後段が全件読む入力になる。全部残すと Distill の判定コストが上がり、蓄積がコストへ転落する。

### 3. root failure class を書く（本 skill の核心）

記録するのは**指摘そのものではなく、その指摘を生んだ failure mechanism と再発条件**。

1. 出来事への参照を書かない（「Issue #N で」「前回」「Codex 3 巡目で」は文脈が無いと使えない。いつ・誰が指摘したかは書かない）
2. 「**どういう条件のとき**」に「**何が壊れるか**」で書く。台帳の「条件 → 確認動作」へ落とせる粒度にする
3. 同型の状況を包含する語まで引き上げる。特定のファイル名・関数名を条件にしない（技術領域 —— SQLite / Event Log / Claude API / Markdown —— は残す）
4. 引き上げすぎない。「注意深く書く」「よく確認する」までしか書けないなら `blocked`

| 元の指摘（そのままでは残さない） | root failure class（記録する形） |
|---|---|
| 「`inviteUser.ts` の補償処理で User を delete している」 | 補償・ロールバックが行を削除し、その行を前提にする再試行・再招待が不可能になる |
| 「この PR で追加した表の件数が本文の『8 件』と合っていない」 | 同じ数量を 2 か所以上へ書いた文書で、片方だけを更新している |

### 4. 候補ブロックを組み立てる

**1 finding = 1 ブロック**。コメントの 1 行目は固定の envelope `## Review learning(Capture)`（装飾・前置きを付けない。Distill がこの行で識別する）。長いレビュー全文・ソース・ログ・秘密候補の値は複製しない。

```text
## Review learning(Capture)

[learning candidate] #<PR 番号> <finding の識別（見出し・file:line 等）>
root failure class: <手順 3 の 1 行>
area: poker-engine|knowledge-state|review-pipeline|ai-opponent|ui-table|persistence-event-log|db|async|llm|docs|harness   ← 台帳・ガイダンスの領域語彙（code-review「差分クラス」）
severity: P0|P1|P2|P3
validation: CONFIRMED|FALSE_POSITIVE|DESIGN_DISAGREEMENT|UNPROVEN
reusable: yes|no|uncertain
destination: IMPLEMENTATION_GUIDANCE|REVIEW_ONLY|MECHANIZE|DISCARD|UNDECIDED
outcome: fixed|accepted|recorded-no-fix|deferred — <1 行>
```

- 識別は必ず PR 番号を前置する（Distill は複数 PR の候補を 1 か所へ集めるため、`file:line` だけだと別 PR の再発が重複に見える）。
- `area` は台帳の領域語彙（判定できなければ差分クラスから選ぶ。Distill が発火条件②と採番に使う）。`severity` / `validation` は指摘処理時に確定した値を写す（ここで判定し直さない）。`reusable` は判断がつかなければ `uncertain`（`no` にすると後段が見ない）。
- `destination` は見立てであって確定ではない。**迷ったら `UNDECIDED`**（確定するのは Distill）。`IMPLEMENTATION_GUIDANCE` = 書く前に知っていれば防げた / `REVIEW_ONLY` = 差分を見ないと判定できない / `MECHANIZE` = 機械検査で決定的に検出できる（CI 化は Distill が Issue 化して判断。**`[P0]` だから機械検査、と決めない**）/ `DISCARD` = 再利用価値が無い。
- `validation` が `CONFIRMED` でない候補と `reusable: no` の候補は `DISCARD` か `UNDECIDED` にしかしない。
- 引用（`> `）の中に候補を書かない（他所の文を持ち込んだ面であり出所が別）。他コメントの指摘を引きたいときは引用せず自分の言葉で root failure class を書く。
- 秘密候補・認証情報・端末固有パスは値を書かず存在と種別だけ。

### 5. 投稿する

```bash
# ラウンドごとに 1 コメント（そのラウンドで確定した候補だけ。前ラウンドの候補を再掲しない）
F=$(mktemp /tmp/capture-XXXXXX.md); # ... 手順 4 のブロックを書く ...
gh pr comment <PR> --body-file "$F"; rm "$F"
```

投稿はコード差分を作らないので、レビュー済み SHA の後でよい（push の直前に縛らない）。**`[P0]` / `[P1]` の高価値な候補でも、feature PR へ台帳・ガイダンスの差分を混ぜない**。急ぐ場合は `create-issue` で distillation の Issue を立て、候補の識別を本文へ書く。**feature PR のマージを distillation 待ちで止めない。**

### 6. PR 本文へラウンドごとに 1 行を足す

PR 本文の `## Review learning` 節へ**追記**する（既存行を書き換えない。上書きすると前のラウンドの候補が Distill の照合から落ちる）:

```markdown
## Review learning

- round 1: 候補 2 件（knowledge-state P1 / db P2）— <コメントの URL>
- round 2: 候補 1 件（ui P2）— <コメントの URL>
```

括弧内に各候補の `area` と `severity` を書く（`issue-patrol` が中身を読まずに蓄積を判定するため）。Distill が処理した候補には元コメントのブロック末尾に `distilled:` 行が足され、ラウンドの全候補が済むと本文の行末にも `（distilled: #N）` が付く（付けるのは Distill。Capture は触らない）。URL は索引であると同時に「この候補は Capture が出した」ことを示す出所の証跡（Distill は投稿者・envelope・本文からの参照の 3 段で照合する）。最終ラウンドまで終えたら、行数と投稿コメント数が一致していることを確認する。

## 実行結果の出力

（envelope `## Review learning(Capture)` とは別の見出しにする。同じ見出しで PR コメントへ貼ると Distill が候補ブロックとして拾う）

```markdown
## Review learning(report)

- 対象の指摘: （件数と内訳。例: [P1] 1 / [P2] 2）
- 記録した候補: （件数と、各候補の識別 + destination。なければ「なし」）
- 投稿先: （このラウンドの PR コメントの URL。PR 本文の `## Review learning` へ追記済みであること）
- 記録しなかった指摘と理由: （一回性・誤検知 等）
- Distill へ送る必要があるか: （`[P0]` / `[P1]` かつ高再利用なら条件と立てた Issue 番号。無ければ「なし」）

REVIEW_LEARNING=none|captured|blocked
```

| 値 | 意味 |
|---|---|
| `none` | 指摘が無い、または記録に値するものが無かった（理由を書く） |
| `captured` | 候補を PR コメントへ投稿し、PR 本文へ行を足した |
| `blocked` | 汎用化できない／投稿できない。`create-issue` で起票して報告する。**マージは止めない** |

## 他 skill との連携

| skill | 接続 |
|---|---|
| `github-workflow` | 第2段レビュー（Codex）ループの各ラウンド後とループの出口（`references/codex-review.md`「学習 Capture の位置」）から呼ばれる。完了報告に `REVIEW_LEARNING=` を含める |
| `review-distillation` | **後段**。本 skill が残した候補だけを入力に、別の harness PR で台帳・ガイダンスへ振り分ける。**資産を書き換えるのは向こうだけ** |
| `code-review` | 台帳の読み手。本 skill は台帳へ書かない |
| `create-issue` | `blocked` の内容、および distillation を急ぐべき候補の起票先 |
