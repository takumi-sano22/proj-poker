# UI / UX Specification

## 1. Table direction

Use a live-style 2D table.

Display:
- seats / names / lightweight avatars
- real stack amounts
- optional BB secondary value
- dealer button
- SB/BB
- community cards
- pot
- Hero hole cards
- active turn

Layouts adapt to 2-8 players.

## 2. Real amounts

Real amount is mandatory.

Example:
`Pot: 37`

Optional:
`18.5 BB`

Never replace real amount with BB-only presentation.

## 3. Card / chip rendering

Cards/chips are structural components:
- SVG/CSS/component rendering
- scalable
- consistent
- deterministic

Generated image assets are for decoration:
- felt/background
- table rail
- card-back artwork
- icon
- non-semantic art

Do not create 52 unrelated raster card assets.

## 4. Chip interaction

Support:
- click selection
- quantity selection
- drag to betting area
- visible stack composition
- dealer-assisted change

Chip movement generates PhysicalAction.

No primary numeric bet box.

## 5. Declaration

Declaration buttons substitute for live verbal declarations.

Do not force declarations before every chip move; mistakes must remain possible.

Voice is out of scope.

## 6. Dealer feedback

**RULING** — changes/defines canonical action.

**ETIQUETTE** — live-table behavior guidance.

**COACHING** — strategy/learning guidance.

Keep them distinct.

## 7. Terminology

Default UI combines Japanese explanation + standard poker term.

Examples:
- ボタン（BTN）
- 有効スタック（Effective Stack）
- ポットオッズ（Pot Odds）
- 3ベット（3-bet）

Use real vocabulary prominently when the concept occurs.
Hover/click opens definition, current-hand example and advanced detail.

## 8. Folded Hero

After Hero folds:
- continue spectating by default
- allow Fast Forward
- do not reveal hidden cards before hand completion

## 9. Hint UI

Hidden by default.

Progressive controls:
- 着眼点
- 計算
- Range / 相手読み
- 選択肢比較
- 推奨

Log hint use.

## 10. Review UI

Landing:
- summary
- important spots
- good decisions
- improvement opportunities
- full-hand reveal entry

Spot detail:
- table state
- action timeline
- original user read
- math
- range
- solver evidence if available
- alternatives
- AI explanation
- follow-up Q&A

Replay:
- previous/next action
- play/pause
- jump to important spot

## 11. CPU latency

Normal:
`Ken's turn...`

If unusually long, show a subtle technical delay indicator.

Do not normally expose low-level model-call messages.

## 12. AI outage

Offer:
- Retry
- Continue with Emergency Bot
- End/Pause Session

Emergency Bot use is flagged.

## 13. Settings

MVP-relevant:
- table size
- cash preset
- animation speed
- BB secondary display
- auto top-up
- rule profile
- rake profile
- model role mapping
- Learning / Real-Play mode
