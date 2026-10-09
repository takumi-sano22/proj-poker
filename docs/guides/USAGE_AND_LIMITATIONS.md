# 使い方と現在の制約

起動したアプリの使い方と、最新の main 時点で分かっている制約・暫定値の一覧です。起動手順は [`SETUP_AND_DEVELOPMENT.md`](./SETUP_AND_DEVELOPMENT.md)、短い要約は [ルート README](../../README.md) にあります。

> このガイドは利用者向けのスナップショットです。仕様の正本は Domain docs（[ドキュメント索引](../00_DOCUMENTATION_INDEX.md)）・[`decision_log.yaml`](../decision_log.yaml)・[`11_OPEN_ITEMS.md`](../11_OPEN_ITEMS.md) で、各項目の括弧内に正本の所在を書いています。矛盾したら正本を優先します。

## 1. 使い方

### Cash の Session

- 最初の画面で Session の種類（Cash / Tournament）を選び、「Hand を始める」を押すと Hero として遊べます。既定は 6-max（Hero + CPU 5 人。人数は `TABLE_SIZE`）です。
- Hand が終わったら「次の Hand へ」で Stack を持ち越して続けます。Hero が Bust するか、CPU が全員 Bust すると Session が終わり、「新しい Session を始める」で均等 Stack から始め直せます。
- サーバーを再起動しても、Hand の合間で止まった Session はそのまま続きます（Stack・Button・Emergency Bot を持ち越す）。

### Bet の操作（`docs/06` §4・§5）

- 画面下の Hero 欄で Stack の Chip（額面 1 / 5 / 25 / 100 / 500）を Click で手に取り（Click の回数が枚数）、Click か Drag で Betting Area に出して「確定して Dealer に渡す」で送ります。
- 宣言 Button だけでも、宣言と Chip の組み合わせでも操作できます。裁定はサーバーの Ruling Engine が行い、Dealer Feedback（Ruling・Etiquette・Coaching）で説明します。
- 卓の用語は Hover / Click / キーボードで開くと、定義・今の Hand の例・関連する概念が出ます。

### 表示の切り替え・Replay・Fast Forward（`docs/06` §2・§8・§10）

- 「BB 補助表示」で BB 換算の表示を ON / OFF できます（実額は常に出ます。設定はこのブラウザに保存）。
- 「Replay を見る」で保存済みの Hand の一覧を開き、選んだ Hand を「前へ / 再生 / 一時停止 / 次へ」で一手ずつ見返せます。「卓に戻る」で卓の画面に戻ります（Replay を見ている間も卓の Hand はそのまま続きます）。
- Hero が Fold した後の観戦中だけ、Hero 欄の Fast Forward で CPU の思考の待ち（演出）を縮められます。Claude の応答時間そのものは縮みません。

### Hand Review（`docs/05` §6〜§8・`docs/06` §10）

- Hand が終わると Hero 欄に「この Hand の Review」が出ます（Replay の画面からも開けます）。Important Spot（判断時点の情報だけで選んだ見直す価値の高い判断）が先に並びます。
- 判断を選んで「Review を作る」を押すと、判断時点の Review（段階評価・実戦的な Baseline・理論・前提・結論が変わる条件と根拠の Evidence）が出ます。「Hand 後の答え合わせ」のタブでは全員の札を見せて、読みと実際の比較・実際の Equity・Bluff / Value を答え合わせします（評価は付け直しません）。
- どちらにも質問（Follow-up）を続けられます。作り直すと新しい Version として残り、「詳しく作る」は上位のモデルを使います。
- 「Replay でこの場面を見る」と Replay の「Important Spot へ」で、判断の場面へ移れます。
- Review は Claude を使うので、[Claude の認証](./SETUP_AND_DEVELOPMENT.md#4-claude-の認証) が前提です。

### Session Review・Player Profile・Drill・Learning Reset（`docs/06` §14・`docs/07`）

- Session が終わった後（Hero の Bust・Hero だけが残った・AI 障害で終えた）の「この Session を振り返る」から Session Review を開きます。判断の質・Ability ごとの Score・Hero の Stats・Leak・おすすめの Drill が出ます。
- Player Profile（直近 / 全期間・弱点の仮説）・Drill の結果・Learning Reset はその画面の下にあります。
- Targeted Drill は、Leak の判断から一要素だけ変えた類題を 1 Hand 遊び、練習した判断を Review します。

### Tournament（`docs/06` §15・`docs/02` §7）

- 最初の画面か Session の終わりの案内で Tournament を選んで開始します。標準 Preset は 6-max STT（hand-count）と time-base です。
- 見出しに Level・Blind・Ante、卓の右（狭い画面は卓の下）の欄に次の Level までの残り・残人数・Payout・脱落が出ます。終わったら Hero の順位と Payout の Result が Hero の欄に出ます。
- Review の根拠に「Tournament（ICM / Prize Equity と Chip EV）」の欄が出ます。

### Opponent Memory Reset（`docs/04` §11）

画面の入口はありません。server に `POST /api/opponents/memory-resets` で `{ "scope": "all" }`（全 CPU）か `{ "scope": "cpu_profile", "cpuProfileId": "…" }`（1 つの Fixed CPU）を送ると、その時点より後に保存された Hand だけから CPU の Memory を作り直します。Hand の記録・Review・Note / Tag・Learning Reset の区切りは変えず、取り消しはできません。

## 2. 現在の制約と暫定値

### 暫定値（永久仕様ではない）

- Ruling の規則（Oversized Chip・String Bet・Multiple Chip・宣言・Out of Turn）は OI-008、Chip の額面は OI-004 の暫定値です。物理的な誤操作をするのは Hero だけです（D91。`docs/02` §3・§4）
- Persona の数値（OI-005）・モデル名（`claude-haiku-4-5` / `claude-sonnet-5-5` / `claude-opus-5-5`）と判断待ち・Review・Solver の上限（OI-001）・Primary Solver（OI-002）・Eval の合格ライン（`docs/09` §5・§6）は暫定値です
- Fixed Pool の人数・名前・Persona の内訳と Guest の出やすさ（`phase7_pool_v1`）は OI-005、Memory の recency decay・Sample の基準・注入の上限・Tilt・Table Tendency・層の合成と Memory の Eval の合格ライン（`phase7_*`）は OI-011 の暫定値です
- Score・Hypothesis・Drill の式と値（`phase6_provisional_v1`・`phase6_hypothesis_v1`・`phase6_drill_v1`・Recent の 100 件）は OI-006 の暫定値です
- Tournament の値（Preset の Stack・Blind 表・Payout・端数・同順位・ICM の方式・CPU の調整の係数）は OI-007 の暫定値です

一覧と確定の条件は [`11_OPEN_ITEMS.md`](../11_OPEN_ITEMS.md) にあります。

### 保存と Resume（`docs/04` §10）

- 保存されるのは終わった Hand だけです。Hand の途中でサーバーを止めると、その Hand は消え、最後に終わった Hand から続きます
- Replay の一覧に出る「未完了」の Hand（進行中・内部エラーで止まった Hand）はサーバーのメモリにだけあり、再起動すると消えます。AI 障害の後に Session 終了で打ち切った Hand は「打ち切り」として保存され、再起動後も残ります
- Learning Reset は取り消せません（Hand の記録・Review は残るので、Replay と Review はそのまま開けます）。Session Review と Stats は Reset の対象ではありません（D114）

### 卓と Session

- 人数は起動時の `TABLE_SIZE` で決まり、途中参加・Rebuy / Top-up はありません（`docs/03` §1）
- Cash の Session が続いている間は Tournament を始められません（違う種類を選ぶと、前の Session の続きを開くよう案内します。`docs/06` §15）
- Tournament の標準 Preset は 6 人卓（`TABLE_SIZE=6`。既定）でだけ始められます
- **Tournament は 1 卓（Single Table）の STT だけ**です。MTT・Re-entry・Rebuy / Add-on・Satellite・Bounty はありません。Push/Fold Nash Solver などの Tournament の Solver は置かず、Shove の ICM の必要 Equity は「特定の 1 人に Call され、ほかは Fold した場合」の条件付きの値です（D130。`docs/02` §7）
- Hero の Bust で Tournament を終えたときに残った CPU の順位は、残りが 1 人でも未決です（D129）
- Session Review の画面には Tournament の Result を出していません（卓の欄と Hero の欄に出します）

### CPU と Claude

- Claude の CPU は 1 手に数秒〜十数秒かかります。利用枠は開発で使う Claude Code と共有です（`docs/03` §3）
- CPU の Memory・Tilt・Table Tendency は Hand の開始時に毎回 Event Log から計算します。Hand ごとの Observation は、消しても作り直せる派生の表（マイグレーション v12）に Cache します（D124。`docs/04` §12。5,000 Hand での測定は [`issue-165-observation-cache.md`](../taskLog/issue-165-observation-cache.md)）。Hypothesis の集計は Cache しません
- Memory の節が入った Prompt の Claude の CPU の Eval は、戦略への反映の向きについて結論が出ていません（D123・D126。`docs/09` §5）
- Tournament の Claude の CPU は、実モデルの録画（#202・D132）で、判断が Stage・ICM より Persona に強く引っぱられる傾向が見えています。改善は人間判断待ちの [#207](https://github.com/takumi-sano22/proj-poker/issues/207) です（`docs/09` §5）
- Opponent Memory Reset は API だけで、画面の入口はありません。1 つの Fixed CPU を対象にする Reset は、`cpuProfileId` を知っている場合だけ使えます（Hero に Fixed CPU の名前・`cpuProfileId` を見せないため）

### Review と Solver

- Review は Claude（サブスク枠）を使い、1 回に十数秒〜数十秒かかります（OI-001）
- CPU の Observation・Memory・Tilt は Hero の Review に入れないので、個々の相手の傾向に基づく Exploit の観点は出ません。Hero が見た Hand の公開された Action から数えた卓全体の傾向だけが、十分な項目があるときに根拠として入ります（D105・D107・D122。`docs/05` §5・§6）
- 卓の傾向が入った Hero の Review の実モデルでの品質は、まだ録画で測っていません（`docs/09` §6）
- Review の文の中の数値は、Evidence から作った数値表の参照で書かせて照合します（Pass A と Pass A への Follow-up。Pass B は対象外。D131。`docs/05` §8）
- **Solver は Heads-Up の Turn / River だけ**です。Preflop・Flop・Multiway（3 人以上）・Side Pot あり・Rake あり・Tournament の Spot は Unsupported で、Math・Range・KB で Review します（Multiway の Deep Solver は OI-009）。Solver の結果は Street の最初の判断（OOP）の頻度だけで、Action EV は出しません（`docs/03` §8）
- **Web Fallback（根拠が足りないときの Web 検索）はありません**（D94・OI-010）。根拠が足りない判断は Review AI を呼ばずに「根拠が足りない」として評価しません（`docs/03` §7）
- Score は Review 済みの判断だけで数え、未 Review の判断をまとめて Review する機能はありません（D115）
- Targeted Drill は決定論の変形だけで、LLM で Spot を作る経路はありません。Drill の相手は Drill の設定の RuleBot で、元の Hand の CPU の性格ではありません（`docs/07` §7）

### 画面

- 320×568 の狭い画面では Hero の欄が画面の大きな割合を占め、卓は欄の上でスクロールして見ます（#179 で詰めた後の残る制約。`docs/06` §1）

### 受け入れテスト

- Post-MVP / Phase 8 の人間による実機の受け入れテストは [#203](https://github.com/takumi-sano22/proj-poker/issues/203) で行います（自動テストの範囲は `docs/09`）
