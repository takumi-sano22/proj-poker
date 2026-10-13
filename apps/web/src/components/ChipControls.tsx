// Hero の操作の欄（docs/06 §4・§5）: Stack の Chip を Click で手に取り（Click の回数が枚数）、Betting Area へ Click か Drag で
// 出し、宣言 Button で口頭の宣言をする（D44・D46）。毎回の宣言は強制しない（宣言しないと裁定が変わることも練習の対象）。
// 組んだ操作は PhysicalAction の列としてサーバーへ送り、裁定は Ruling Engine が行う（D47・D91）。
// ここでは合法性を判定せず、誤操作になる操作（手番でない操作・Oversized Chip・2 回に分けた Chip・局面に合わない宣言）の
// 事前の警告も出さない。数値の Bet Box（Slider・Preset）は作らない（docs/06 §4）。
// 下書き（TurnDraft）はここに持たない（#219・D146）。画面の切り替えより上の useHandSession が Session ごとに持ち、この部品が外れても
// （Home / Learn へ移る・障害のダイアログ・RULING / ETIQUETTE の欄）消えない。ここは下書きを出して、変更・送信を伝えるだけ。
import type { Declaration, HeroView, SeatView } from "@proj-poker/engine";
import {
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { useChipDrag } from "../hooks/useChipDrag.js";
import { flyChip } from "../lib/chip-flight.js";
import {
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
import type { AnchorContext, ContextChange } from "../lib/turn-draft.js";
import {
  ACTION_TERMS,
  formatBB,
  formatChips,
  termLabel,
} from "../lib/format.js";
import { useShowBB } from "./BbDisplay.js";
import { ChipPile } from "./ChipStack.js";

interface ChipControlsProps {
  /** 操作の欄の id（狭い画面の開閉 Button の aria-controls が指す）。 */
  readonly id?: string;
  readonly view: HeroView;
  readonly hero: SeatView;
  /** 送信中など、操作を受け付けないとき。 */
  readonly disabled: boolean;
  /** 出す下書き（useHandSession の turnDraft.draft）。 */
  readonly draft: TurnDraft;
  /** 組み始めた後に状況が変わり、もう一度の確定を待っている操作（無ければ null）。 */
  readonly change?: ContextChange | null;
  /** 送った操作の応答が届かず、結果が分からないか（同じ操作の再送だけを出す）。 */
  readonly unknown?: boolean;
  /** 下書きを変える（Chip を手に取る・出す・戻す・Bet / Raise の宣言）。 */
  readonly onEdit: (change: (draft: TurnDraft) => TurnDraft) => void;
  /**
   * 下書きを Dealer に渡す。completing は宣言だけで決まる宣言（Fold / Check / Call / All-in）で、送れたときだけ操作に入る
   * （表示が古い・状況が変わった・確認待ちで送らなかったら、下書きに残さない）。
   */
  readonly onSubmit: (completing: Declaration | null) => void;
  /** 示した状況の変化を確認して、もう一度確定する。 */
  readonly onConfirm?: () => void;
  /** 応答が届かなかった操作を、同じ時点・同じ操作で送り直す。 */
  readonly onResend?: () => void;
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

/** 額面の色（ChipColor）。CHIP_DENOMINATIONS に無い額面は来ない（Stack の Chip の Button はこの一覧から作る）。 */
function colorOf(value: number): string {
  return CHIP_DENOMINATIONS.find((d) => d.value === value)?.color ?? "white";
}

export function ChipControls({
  id,
  view,
  hero,
  disabled,
  draft,
  change = null,
  unknown = false,
  onEdit,
  onSubmit,
  onConfirm,
  onResend,
}: ChipControlsProps) {
  const bettingArea = useRef<HTMLDivElement | null>(null);
  // 移動の演出（Stack → 手元 → Betting Area）の行き先。演出は表示だけで、下書きは先に変える（lib/chip-flight.ts）。
  const handPile = useRef<HTMLSpanElement | null>(null);
  const felt = useRef<HTMLSpanElement | null>(null);
  const remaining = remainingStack(hero.stack, draft);
  const held = handTotal(draft);
  const motions = pushedMotions(draft);
  const declarations = draft.ops.flatMap((op) =>
    op.type === "declare" ? [op.declaration] : [],
  );

  const onDrop = useCallback(
    (source: DragSource) =>
      onEdit((d) =>
        source.kind === "hand"
          ? pushHand(d)
          : pushChip(d, hero.stack, source.value),
      ),
    [hero.stack, onEdit],
  );
  const { drag, bind } = useChipDrag<DragSource>(bettingArea, onDrop, disabled);

  // Stack の Chip を手に取る（Click・Enter / Space）。手に取れたときだけ、その Chip を手元へ飛ばす。
  const onPick = (value: number, e: MouseEvent<HTMLButtonElement>) => {
    const picked = pickChip(draft, hero.stack, value) !== draft;
    onEdit((current) => pickChip(current, hero.stack, value));
    if (picked) {
      flyChip(e.currentTarget.querySelector(".chip-token"), handPile.current, {
        color: colorOf(value),
        label: formatChips(value),
      });
    }
  };

  // 手に取った Chip を Betting Area に出す（手元・Betting Area の Click）。出せたときだけ、手元から Betting Area へ飛ばす。
  // Drag で出したときは、指・カーソルに付いてきた Chip が移動を示すので飛ばさない。
  const onPushHand = () => {
    const pushed = pushHand(draft) !== draft;
    onEdit(pushHand);
    const top = draft.hand.at(-1);
    if (pushed && top !== undefined) {
      flyChip(handPile.current, felt.current, {
        color: colorOf(top),
        label: formatChips(held),
      });
    }
  };

  const onDeclare = (kind: DeclarationKind) => {
    if (completesTurn(kind)) {
      // Fold / Check / Call / All-in は宣言だけで Action が決まるので、その時点で Dealer に渡す。
      // 手に取ったまま出していない Chip は卓に出ていないので送らない。送らなかったら、宣言は下書きに足さない（useHandSession）。
      onSubmit({ kind });
      return;
    }
    // Bet / Raise は続けて Chip を出すので、宣言を下書きに足す（手に取った Chip の額を to 額として宣言する）。
    onEdit((d) => declare(d, declarationOf(kind, hero.streetCommitted, d)));
  };

  const declaredText = declarations
    .map((d) =>
      (d.kind === "bet" || d.kind === "raise") && d.amount !== undefined
        ? `${termLabel(ACTION_TERMS[d.kind])} ${formatChips(d.amount)}${d.kind === "raise" ? " まで" : ""}`
        : termLabel(ACTION_TERMS[d.kind]),
    )
    .join(" → ");

  return (
    <div id={id} className="chip-controls">
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
              onClick={(e) => onPick(d.value, e)}
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
          onClick={onPushHand}
          {...bind({ kind: "hand" })}
        >
          <span className="chip-hand__label">手元</span>
          <span ref={handPile} className="chip-hand__chips">
            <ChipPile chips={draft.hand} />
          </span>
          <span className="chip-hand__amount">{formatChips(held)}</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm chip-hand__return"
          disabled={disabled || held === 0}
          onClick={() => onEdit(returnHand)}
        >
          戻す
        </button>
      </div>
      {/* Betting Area の判定領域（Drop の矩形・Click の Button）は grid の欄いっぱいに取り、見た目のフェルトだけを小さくする
          （D138。判定領域は隣の手元・確定・宣言の欄と grid の gap で分け、重ねない） */}
      <div
        ref={bettingArea}
        className={`betting-area${drag !== null ? " betting-area--dragging" : ""}${drag?.overTarget ? " betting-area--over" : ""}`}
      >
        <button
          type="button"
          className="betting-area__target"
          disabled={disabled || held === 0}
          aria-label={`ベッティングエリア（Betting Area）。出した Chip ${formatChips(pushedTotal(draft))}${declaredText === "" ? "" : `、宣言 ${declaredText}`}。押すと手に取った Chip を出す`}
          onClick={onPushHand}
        >
          <span ref={felt} className="betting-area__felt">
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
          </span>
        </button>
      </div>

      {/* 卓に出した操作を Dealer に渡す（宣言なしの投入もここで送る）。Betting Area の隣に置き、DOM の順と見た目の順をそろえる */}
      <button
        type="button"
        className="btn btn--primary btn--md chip-controls__submit"
        disabled={disabled || draft.ops.length === 0}
        onClick={() => onSubmit(null)}
      >
        確定して Dealer に渡す
      </button>

      {change !== null && (
        <ContextChangeNotice
          change={change}
          disabled={disabled}
          onConfirm={onConfirm}
        />
      )}
      {unknown && (
        <div className="draft-unknown" role="status">
          <p>
            送った操作の結果を確かめています。届いていなければ、同じ時点の同じ操作として送り直せます。
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onResend}
          >
            同じ操作をもう一度送る
          </button>
        </div>
      )}

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
          {/* Stack の Chip は、押した Chip と同じ大きさ・額面の札で付いてくる（手元の Chip は出す枚数のまま積む） */}
          {drag.source.kind === "chip" ? (
            <span className={`chip-token chip--${colorOf(drag.source.value)}`}>
              {formatChips(drag.source.value)}
            </span>
          ) : (
            <ChipPile chips={draft.hand} />
          )}
        </span>
      )}
    </div>
  );
}

/** 状況の 1 行（組み始めた時点 → 今）。 */
function contextRows(
  from: AnchorContext,
  to: AnchorContext,
): { readonly label: string; readonly from: number; readonly to: number }[] {
  return [
    {
      label: "この Street の Bet の額",
      from: from.currentBet,
      to: to.currentBet,
    },
    {
      label: "Hero の出し済み",
      from: from.heroCommitted,
      to: to.heroCommitted,
    },
    {
      label: "Call に要る額",
      from: Math.max(0, from.currentBet - from.heroCommitted),
      to: Math.max(0, to.currentBet - to.heroCommitted),
    },
  ];
}

/** 送る操作の要約（出した Chip の額と宣言）。Chip・宣言は補正せず、組んだとおりに示す。 */
function actionsSummary(change: ContextChange): string {
  const chips = change.actions.reduce(
    (total, op) =>
      op.type === "declare"
        ? total
        : total + op.chips.reduce((a, c) => a + c, 0),
    0,
  );
  const declared = change.actions.flatMap((op) =>
    op.type === "declare" ? [termLabel(ACTION_TERMS[op.declaration.kind])] : [],
  );
  const parts = [
    ...(chips > 0 ? [`出した Chip ${formatChips(chips)}`] : []),
    ...(declared.length > 0 ? [`宣言 ${declared.join(" → ")}`] : []),
  ];
  return parts.join("・");
}

/**
 * 下書きを組んだ後に卓の状況が変わったことを示し、もう一度の確定を求める（UX04-1=A・D146）。非モーダルで、確定しなければ送らない。
 * 下書きは捨てず、Chip の枚数・宣言は補正しない（組み直すなら Chip を足す・宣言を足すこともできる）。
 */
function ContextChangeNotice({
  change,
  disabled,
  onConfirm,
}: {
  readonly change: ContextChange;
  readonly disabled: boolean;
  readonly onConfirm: (() => void) | undefined;
}) {
  return (
    <div
      className="draft-change"
      role="group"
      aria-label="組んだ後に卓の状況が変わりました"
    >
      <p className="draft-change__title">
        組んだ後に卓の状況が変わりました。まだ送っていません。
      </p>
      <dl className="draft-change__rows">
        {contextRows(change.from, change.to).map((row) => (
          <div key={row.label} className="draft-change__row">
            <dt>{row.label}</dt>
            <dd>
              {formatChips(row.from)} → {formatChips(row.to)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="draft-change__actions">
        送る操作: {actionsSummary(change)}
      </p>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={disabled}
        onClick={onConfirm}
      >
        この内容で確定して Dealer に渡す
      </button>
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
  const showBB = useShowBB();
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
          {showBB && (
            <span className="declaration__bb">
              {formatBB(amount, view.bigBlind)}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
