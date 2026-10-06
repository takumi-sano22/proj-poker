// Hero の操作の欄（docs/06 §4・§5）: Stack の Chip を Click で手に取り（Click の回数が枚数）、Betting Area へ Click か Drag で
// 出し、宣言 Button で口頭の宣言をする（D44・D46）。毎回の宣言は強制しない（宣言しないと裁定が変わることも練習の対象）。
// 組んだ操作は PhysicalAction の列としてサーバーへ送り、裁定は Ruling Engine が行う（D47・D91）。
// ここでは合法性を判定せず、誤操作になる操作（手番でない操作・Oversized Chip・2 回に分けた Chip・局面に合わない宣言）の
// 事前の警告も出さない。数値の Bet Box（Slider・Preset）は作らない（docs/06 §4）。
import type { HeroView, PhysicalAction, SeatView } from "@proj-poker/engine";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { useChipDrag } from "../hooks/useChipDrag.js";
import {
  EMPTY_DRAFT,
  completesTurn,
  declarationOf,
  declare,
  handTotal,
  pickChip,
  pushChip,
  pushHand,
  pushedMotions,
  pushedTotal,
  remainingStack,
  returnHand,
  type DeclarationKind,
  type TurnDraft,
} from "../lib/chip-ops.js";
import { CHIP_DENOMINATIONS } from "../lib/config.js";
import {
  ACTION_TERMS,
  formatBB,
  formatChips,
  termLabel,
} from "../lib/format.js";
import { ChipPile } from "./ChipStack.js";

interface ChipControlsProps {
  readonly view: HeroView;
  readonly hero: SeatView;
  /** 送信中など、操作を受け付けないとき。 */
  readonly disabled: boolean;
  readonly onSubmit: (actions: readonly PhysicalAction[]) => void;
}

/** Drag の元: Stack の Chip 1 枚か、手に取った Chip 全部。 */
type DragSource =
  { readonly kind: "chip"; readonly value: number } | { readonly kind: "hand" };

/** 宣言 Button の並び（Issue #65: Fold / Check / Call / Bet / Raise / All-in）。局面によらず全部出す。 */
const DECLARATIONS: readonly DeclarationKind[] = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
];

export function ChipControls({
  view,
  hero,
  disabled,
  onSubmit,
}: ChipControlsProps) {
  const [draft, setDraft] = useState<TurnDraft>(EMPTY_DRAFT);
  const bettingArea = useRef<HTMLDivElement | null>(null);
  const remaining = remainingStack(hero.stack, draft);
  const held = handTotal(draft);
  const motions = pushedMotions(draft);
  const declarations = draft.ops.flatMap((op) =>
    op.type === "declare" ? [op.declaration] : [],
  );

  const onDrop = useCallback(
    (source: DragSource) =>
      setDraft((d) =>
        source.kind === "hand"
          ? pushHand(d)
          : pushChip(d, hero.stack, source.value),
      ),
    [hero.stack],
  );
  const { drag, bind } = useChipDrag<DragSource>(bettingArea, onDrop, disabled);

  const onDeclare = (kind: DeclarationKind) => {
    const next = declare(
      draft,
      declarationOf(kind, hero.streetCommitted, draft),
    );
    if (completesTurn(kind)) {
      // Fold / Check / Call / All-in は宣言だけで Action が決まるので、その時点で Dealer に渡す。
      // 手に取ったまま出していない Chip は卓に出ていないので送らない。
      onSubmit(next.ops);
    }
    setDraft(next);
  };

  const declaredText = declarations
    .map((d) =>
      (d.kind === "bet" || d.kind === "raise") && d.amount !== undefined
        ? `${termLabel(ACTION_TERMS[d.kind])} ${formatChips(d.amount)}${d.kind === "raise" ? " まで" : ""}`
        : termLabel(ACTION_TERMS[d.kind]),
    )
    .join(" → ");

  return (
    <div className="chip-controls">
      <div
        className="chip-tray"
        role="group"
        aria-label="Stack の Chip（Click で手に取る・Drag で Betting Area へ出す）"
      >
        {CHIP_DENOMINATIONS.map((d) => {
          // 持っている額を超える Chip は物理的に出せない（誤操作ではないので、裁定に送らずここで止める）。
          const unavailable = disabled || d.value > remaining;
          return (
            <button
              key={d.value}
              type="button"
              className="chip-button"
              data-denomination={d.value}
              disabled={unavailable}
              aria-label={`${formatChips(d.value)} の Chip を手に取る`}
              onClick={() =>
                setDraft((current) => pickChip(current, hero.stack, d.value))
              }
              {...bind({ kind: "chip", value: d.value })}
            >
              <span className={`chip-token chip--${d.color}`}>
                {formatChips(d.value)}
              </span>
            </button>
          );
        })}
      </div>
      {/* 手に取った Chip。Drag の元の要素は手が空でも消さない（タッチの操作の途中で要素が消えると、次のタップが Click にならない） */}
      <div className="chip-hand">
        <button
          type="button"
          className="chip-hand__pile"
          disabled={disabled || held === 0}
          aria-label={
            held > 0
              ? `手に取った Chip ${formatChips(held)} を Betting Area に出す`
              : "手に取った Chip はありません"
          }
          onClick={() => setDraft(pushHand)}
          {...bind({ kind: "hand" })}
        >
          <span className="chip-hand__label">手元</span>
          <ChipPile chips={draft.hand} />
          <span className="chip-hand__amount">{formatChips(held)}</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm chip-hand__return"
          disabled={disabled || held === 0}
          onClick={() => setDraft(returnHand)}
        >
          戻す
        </button>
      </div>
      <div
        ref={bettingArea}
        className={`betting-area${drag?.overTarget ? " betting-area--over" : ""}`}
      >
        <button
          type="button"
          className="betting-area__target"
          disabled={disabled || held === 0}
          aria-label={`ベッティングエリア（Betting Area）。出した Chip ${formatChips(pushedTotal(draft))}${declaredText === "" ? "" : `、宣言 ${declaredText}`}。押すと手に取った Chip を出す`}
          onClick={() => setDraft(pushHand)}
        >
          <span className="betting-area__label">
            ベッティングエリア（Betting Area）
            {declaredText !== "" && (
              <span className="betting-area__declared">
                宣言: {declaredText}
              </span>
            )}
          </span>
          {motions.length === 0 ? (
            <span className="betting-area__hint">
              Chip をここへ（Drag / 手に取って Click）
            </span>
          ) : (
            <span className="betting-area__motions">
              {motions.map((chips, i) => (
                // 1 回の動作ごとに分けて置く（2 回目以降の動作が String Bet の判定に関わる）
                <span key={i} className="betting-area__motion">
                  <ChipPile chips={chips} />
                </span>
              ))}
              <span className="betting-area__amount">
                {formatChips(pushedTotal(draft))}
              </span>
            </span>
          )}
        </button>
      </div>

      {/* 卓に出した操作を Dealer に渡す（宣言なしの投入もここで送る）。Betting Area の隣に置き、DOM の順と見た目の順をそろえる */}
      <button
        type="button"
        className="btn btn--primary btn--md chip-controls__submit"
        disabled={disabled || draft.ops.length === 0}
        onClick={() => onSubmit(draft.ops)}
      >
        確定して Dealer に渡す
      </button>

      <div
        className="declarations"
        role="group"
        aria-label="宣言（Declaration）"
      >
        {DECLARATIONS.map((kind) => (
          <DeclarationButton
            key={kind}
            kind={kind}
            view={view}
            committed={hero.streetCommitted}
            held={held}
            disabled={disabled}
            onClick={() => onDeclare(kind)}
          />
        ))}
      </div>

      {drag !== null && (
        <span
          className="chip-drag-ghost"
          style={
            { "--x": `${drag.x}px`, "--y": `${drag.y}px` } as CSSProperties
          }
          aria-hidden="true"
        >
          <ChipPile
            chips={
              drag.source.kind === "hand" ? draft.hand : [drag.source.value]
            }
          />
        </span>
      )}
    </div>
  );
}

interface DeclarationButtonProps {
  readonly kind: DeclarationKind;
  readonly view: HeroView;
  readonly committed: number;
  readonly held: number;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

/**
 * 宣言 Button 1 つ。額の表示は補助で、Call / All-in は Hero の手番にサーバーが返した Legal Action の額
 * （手番でなければ出さない）、Bet / Raise は手に取った Chip の額（その額を to 額として宣言する）。
 */
function DeclarationButton({
  kind,
  view,
  committed,
  held,
  disabled,
  onClick,
}: DeclarationButtonProps) {
  const legal = view.legalActions?.actions.find((a) => a.type === kind);
  let amount: number | null = null;
  let suffix = "";
  if ((kind === "bet" || kind === "raise") && held > 0) {
    amount = committed + held;
    suffix = kind === "raise" ? " まで" : "";
  } else if (legal?.type === "call") {
    amount = legal.amount;
  } else if (legal?.type === "all_in") {
    amount = legal.amount;
    suffix = " まで";
  }
  const variant = kind === "all_in" ? "danger" : "secondary";
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--md declaration`}
      disabled={disabled}
      onClick={onClick}
    >
      {/* 標準 Term は途中で折り返さない（狭い画面で「All-」「in」に割れないように） */}
      <span className="declaration__label">
        {ACTION_TERMS[kind].ja}
        <span className="declaration__term">（{ACTION_TERMS[kind].term}）</span>
      </span>
      {amount !== null && (
        <span className="declaration__amount">
          {formatChips(amount)}
          {suffix}
          <span className="declaration__bb">
            {formatBB(amount, view.bigBlind)}
          </span>
        </span>
      )}
    </button>
  );
}
