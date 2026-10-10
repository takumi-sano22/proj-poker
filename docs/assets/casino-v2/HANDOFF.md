# Casino V2（UX-08 #223）納品・引継ぎ

## 検収と担当

- 人間が Emerald Nocturne のデザイン、画像プレビュー、代表SFXを2026-10-11に採用。AS-01=B / AS-02=A / AS-03=A / AS-04=A / AS-05=C。
- **画像6点、SFX10種のOGG/MP3計20点、26アセット**を納品対象とする。既存9 PNGと Card / Chip のSVG/CSS描画を維持。
- このPRは素材・台帳・プレビュー・試聴のみ。React・CSS・Engine・Event変更はしない。#224/#225 が演出と音声再生の実装を担当。
- #215 Gate 0 は解除済み。Gate 1 / Gate 2 は未解除。

## 一括納品ZIP

ChatGPT会話から **`ux08-casino-v2-approved-pack.zip`** を入手して本リポジトリのルートに展開する。アーカイブ SHA-256:

`d101a3d57722ebfe3a8074e36462bdf4d7137987ec520c42c047487d7c8c3b2b`

ZIPはリポジトリルートからの相対パスで、`apps/web/public/assets/casino-v2/` と `docs/assets/casino-v2/` を含む。素材の公開URL・用途・SHA-256・サイズ・制作由来・フォールバックは展開後の `manifest.json` を正とする。

## WSL によるバイナリ追加（Draft PR の後続コミット）

```bash
# リポジトリの作業ツリーで。ZIP_FILE は実際のダウンロードパスに置換
export ZIP_FILE=/absolute/path/to/ux08-casino-v2-approved-pack.zip
git fetch origin
git switch --track origin/feature/223-casino-v2-pack
unzip -o "$ZIP_FILE" -d .
# ZIP内にもHANDOFF.mdがあるため、PRの最新の受領手順を維持する
git restore --source=HEAD -- docs/assets/casino-v2/HANDOFF.md
git add apps/web/public/assets/casino-v2 docs/assets/casino-v2
python3 - <<'PY'
import json,hashlib,pathlib
base=pathlib.Path("apps/web/public")
m=json.loads(pathlib.Path("docs/assets/casino-v2/manifest.json").read_text())
assert len(m["assets"]) == 26
for a in m["assets"]:
    p=base/a["path"].lstrip("/")
    assert p.is_file() and p.stat().st_size==a["bytes"], a["path"]
    assert hashlib.sha256(p.read_bytes()).hexdigest()==a["sha256"], a["path"]
print("OK: 26 assets")
PY
# JSON・試聴HTML をプロジェクト規定で整形する
pnpm exec prettier --write docs/assets/casino-v2/manifest.json docs/assets/casino-v2/sfx-audition.html
git add docs/assets/casino-v2
git commit -m "assets(#223): 承認済み画像・SFXを一括納品"
git push origin HEAD
```

バイナリ追加の後、Manifest と実ファイルを照合し、自己レビュー・Codex・CI・人間検収を終えるまで **Draft のままマージ禁止**。制作素材が足りない・不整合の場合は勝手に代替生成しないで #223 に返す。

## ライセンス・制約

- 背景画像は ChatGPT 画像生成、オーバーレイ・フェルト質感・効果音は新規のプロシージャル合成。第三者素材は組み込まない。配布時には既存のアセットを含む権利条件を確認する。
- Card 52枚・Chip額面は構造描画（D60・D92）。未公開カード、偽のPot、数値や操作ラベルを画像に焼き込まない。
- 音源・演出が読めない場合は既存の視認性を損なわないフォールバックを保つ。
