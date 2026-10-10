# Casino V2（UX-08 #223）登録後の確認・引き継ぎ

## 現在の状態

- ユーザーが Emerald Nocturne の画像・代表SFXを採用（AS-01=B / AS-02=A / AS-03=A / AS-04=A / AS-05=C）。
- **画像6件＋音源20件を含む31ファイルを Draft PR #239 に登録済み**。すべてのバイナリは制作時のファイルと同一で、ファイルパス・バイト数・SHA-256を維持。
- M1=A により Schema v2 の `trigger` を使い、実 Event / 派生 / client / presentation / session_result を区別。M2=A により第三者再利用ライセンスは未設定。
- **現時点はメタデータ差分の独立レビュー・最終PR検収待ち。マージ前。** #215 Gate 0 は解除済み、Gate 1/2 は未解除。
- プレイ用の React/CSS/Engine/Event/DB は変更しない。#224/#225 の組込は後続。

## 元の承認済み ZIP の識別

`ux08-casino-v2-approved-pack.zip` の SHA-256:

`d101a3d57722ebfe3a8074e36462bdf4d7137987ec520c42c047487d7c8c3b2b`

この ZIP は**登録時の原本**で、含まれる Manifest / 文書は PR #239 における後続の改善前の版。ゲーム素材ファイルのハッシュは同じ。**GitHubの最新の Manifest Schema v2・権利文書・受領手順を優先**し、ZIPの古い文書を再展開して上書きしないこと。

## 受領検査（リポジトリのルート）

```bash
git fetch origin
# #239 の worktree で実施。既存 worktree がある場合、別checkoutを作らない。
python3 - <<'PY'
import json, hashlib, pathlib
m = json.loads(pathlib.Path("docs/assets/casino-v2/manifest.json").read_text())
assert m["schemaVersion"] == "casino-v2-asset-manifest-v2"
assert m["assetCount"] == len(m["assets"]) == 26
assert sum(a["bytes"] for a in m["assets"]) == m["totalBytes"]
root = pathlib.Path("apps/web/public")
for a in m["assets"]:
    file = root / a["path"].lstrip("/")
    assert file.is_file(), a["path"]
    data = file.read_bytes()
    assert len(data) == a["bytes"], a["path"]
    assert hashlib.sha256(data).hexdigest() == a["sha256"], a["path"]
    assert "event" not in a and "trigger" in a, a["path"]
    assert a["license"] is None, a["path"]
print("26 assets: path / bytes / SHA-256 / trigger / license OK")
PY
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## 検収と責務境界

- 画像の実体・SFX音源を変更しない。消す・再圧縮・再生成は新たな人間判断を要する。
- `docs/assets/casino-v2/manifest.json` は用途/条件の台帳、`TRIGGER_CONTRACT.md` は Game Event と Cue の境界、`ASSET_RIGHTS.md` は M2=A の暫定的な配布方針、`ART_DIRECTION.md` は見た目/演出の方針。
- `preview.webp` は見本であって実機 UI のスクリーンショットではない。
- Draft PR #239 は改定された Manifest / 権利文書への独立レビュー・CIと人間の最終承認を経て Ready/マージする。現時点で #223 は Open、#215 Gate1/2は閉じたまま。
