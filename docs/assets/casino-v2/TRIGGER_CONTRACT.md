# Casino V2 — Event / Presentation Cue 契約（M1=A）

## 目的と共通規則

`manifest.json` の `schemaVersion: casino-v2-asset-manifest-v2` から、旧版の曖昧な `event` を **`trigger`** に置き換えた。これにより「ゲーム正本 Event」と「表示や効果音の発火 Cue」を混同しない。

`trigger` は**素材の使用想定を示す台帳**であり、ランタイムが任意文字列を評価する実行仕様ではない。条件の論理は #222/#224/#225 の決定論的コードで明示実装・テストする。AIや素材画像を Poker の正本にはしない。

| `trigger.kind` | 用途 | Event schema への影響 |
|---|---|---|
| `static` | 画面背景・装飾 | Event 不要 |
| `event` | Event Log に存在する可視 Event `eventType` | 既存 Event を読むだけ |
| `derived` | 実 Event `sourceEvent` の属性から決定論で作る Cue | 新 Event を作らない |
| `presentation` | Client の Presentation Controller の表示フェーズ | Event Logに記録しない |
| `client` | 確定送信前の UI 操作など | Event Logに記録しない |
| `session_result` | 確定した Session 結果を受ける Cue | 個々の Hand Event ではない |

### 主な Cue の具体的な対応

| Cue / Asset | 起点 | 注意 |
|---|---|---|
| `all-in`（aura / SFX） | `ACTION_TAKEN` かつ `allIn === true` | `ALL_IN` / `ACTION_TAKEN_ALL_IN` という正本 Event は無い |
| `winner-flare` | `POT_AWARDED.awards` から勝者を求める | `WINNER` という Event は無い。複数Potや分割を二重演出しない |
| `showdown` / `showdown-spotlight` | `CARDS_TABLED` | 公開された札のみ。複数人の公開で効果音を不要に連打しない |
| `card-deal` | `HOLE_CARD_DEALT` | Heroに見える分だけ。相手のHidden Cardsは復元しない |
| `card-flip` | `presentation` で Card Flip が発生した瞬間 | `CARD_FLIP_VISUAL` は Game Eventではない。Flop3枚の順次描画と連携 |
| `chip-pick` | `client` の未送信 Draft 操作 | `CHIP_PICK_DRAFT` は Game Eventではない。確定済みChip移動と混同しない |
| `chip-place` | `PHYSICAL_CHIP_ACTION`（公開済み操作） | Preview上のChipの移動との二重再生に注意 |
| `pot-collection` | `presentation` の Bet→Pot 集約フェーズ | `POT_COLLECTION_VISUAL` は Game Eventではない。公開Commitの差分で派生 |
| `pot-award` | `POT_AWARDED` | Side / Split Potで実額・配分はEventの値が正本 |
| `session-win` | `session_result`（確定したHero勝利） | `SESSION_RESULT_WIN` というHandEventは無い。Cashの単なる利益を優勝としない |
| `street-reveal` | `BOARD_DEALT` | Flop（3枚）・Turn・Riverの表示段階は Client が管理 |

### セキュリティ・表示時系列

- 入力は Hero の可視 Event / View（D143）と、確定した Session 結果だけ。CPUのHidden Cards、未来札、Persona、Private Memoryを Cue に使わない。
- Clientは `authoritative` と `displayed` を分離し、Skipや再接続で古い演出 Cue を再生しない。公開札・勝者・Pot分配の**情報**は欠かさない。
- Effect・SFXは任意の装飾であり、素材を読み込めない・音声自動再生が禁止された場合もゲームを進められること。
- `trigger.condition` は説明用の文字列で、ランタイムに `eval` 等で渡さない。重要な条件は明示的なコード・テストで確定する。
