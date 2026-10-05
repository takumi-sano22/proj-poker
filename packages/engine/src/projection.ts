// Player ごとの可視 Projection（Hero 表示用と CPU 用の KnowledgeState）。
// 作り方は whitelist: その Player が読める Event（public と自分宛て private）だけを畳み込み、
// 出力の型にも渡してよい項目だけを積む（D28・INV-INFO-001・docs/04 §5）。
// そのため他者の Hole Cards・Deck の残り・Future Cards は State にすら入らない。Showdown で公開された札だけは含む。
import type { Card } from "./card.js";
import {
  isVisibleTo,
  type ActionType,
  type HandEvent,
  type PlayerChips,
  type Street,
} from "./hand-events.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { getLegalActions, type LegalActionSet } from "./legal-actions.js";

export interface SeatView {
  readonly playerId: string;
  readonly isButton: boolean;
  readonly stack: number;
  readonly streetCommitted: number;
  readonly totalCommitted: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** 自分の札、または Showdown で公開された札。それ以外は null。 */
  readonly holeCards: readonly Card[] | null;
}

/** Hero 表示用と CPU 用（KnowledgeState）に共通する卓の見え方。 */
export interface TableView {
  readonly handId: string;
  readonly viewerId: string;
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly street: Street;
  readonly status: "in_progress" | "complete";
  /** 公開済みの Board だけ（未来の Card は含まない）。 */
  readonly board: readonly Card[];
  readonly pot: number;
  readonly currentBet: number;
  readonly actorId: string | null;
  readonly seats: readonly SeatView[];
  /** viewer が手番のときだけ。それ以外は null。 */
  readonly legalActions: LegalActionSet | null;
  /** 配分した額の Player ごとの合計（Main / Side Pot を合算。Pot ごとの内訳は POT_AWARDED）。 */
  readonly awards: readonly PlayerChips[];
}

/** Hero 表示用。卓の見え方に加え、Hero が読める Event をログとして持つ。 */
export interface HeroView extends TableView {
  readonly log: readonly HandEvent[];
}

/** 公開された Action の記録（CPU の判断材料。docs/02 §2 の Public Action）。 */
export interface PublicActionRecord {
  readonly playerId: string;
  readonly street: Street;
  readonly action: ActionType;
  readonly amount: number;
  readonly toAmount: number;
  readonly allIn: boolean;
}

/** 自分の Position。席順（時計回り）と Button から決まる公開情報。 */
export interface PositionInfo {
  /** Button から時計回りに数えた席の距離（0 = Button）。Heads-Up では Button = SB なので 0 が SB、1 が BB。 */
  readonly buttonOffset: number;
  /** この Hand に座っている人数。 */
  readonly playerCount: number;
}

/**
 * 判断の材料になる決定論の Math（docs/05 §1「必要な決定論的Math」）。
 * 公開情報（Pot・Stack・Commit）だけから計算するので、Projection の State からも全情報の State と同じ値になる。
 * 比率は表示・判断の目安で、Chip の移動には使わない（Chip は整数のまま。D74）。
 */
export interface DecisionMath {
  /** Call に追加で出す額（Stack で頭打ち）。0 なら Check できる。 */
  readonly callAmount: number;
  /** Pot Odds = callAmount / (pot + callAmount)。Call が要らなければ null。 */
  readonly potOdds: number | null;
  /** 有効 Stack = 自分の Stack と、Fold していない他者の最大 Stack の小さい方（どちらも残りの Stack）。 */
  readonly effectiveStack: number;
  /** SPR = effectiveStack / pot。Pot が 0 なら null。 */
  readonly spr: number | null;
}

/**
 * CPU の Opponent Agent へ渡す、その Player 専用の KnowledgeState（D28・D71・docs/05 §1・docs/04 §5）。
 * 卓の見え方（公開 Board・Pot / Stack・Legal Action）に、自分の札・Position・Public Action の履歴・Math を足したもの。
 * 他者の Hidden Cards・Deck（未来の Card）・engine Visibility の Event は、見える Event だけを畳み込むので入らない。
 */
export interface KnowledgeState extends TableView {
  /** 自分の Hole Cards（seats の自分の席と同じ値）。配られる前は null。 */
  readonly holeCards: readonly Card[] | null;
  readonly position: PositionInfo;
  /** 自分が観察できた Public Action の履歴（時系列）。 */
  readonly actionHistory: readonly PublicActionRecord[];
  readonly math: DecisionMath;
}

/** viewer が読める Event だけを返す（public と viewer 宛ての private）。 */
export function visibleEvents(
  events: readonly HandEvent[],
  viewerId: string,
): HandEvent[] {
  return events.filter((e) => isVisibleTo(e, viewerId));
}

export function projectHeroView(
  events: readonly HandEvent[],
  heroId: string,
): HeroView {
  const visible = visibleEvents(events, heroId);
  return { ...buildTableView(visible, heroId), log: visible };
}

export function projectKnowledgeState(
  events: readonly HandEvent[],
  playerId: string,
): KnowledgeState {
  const visible = visibleEvents(events, playerId);
  const actionHistory: PublicActionRecord[] = [];
  for (const e of visible) {
    if (e.type === "ACTION_TAKEN") {
      actionHistory.push({
        playerId: e.playerId,
        street: e.street,
        action: e.action,
        amount: e.amount,
        toAmount: e.toAmount,
        allIn: e.allIn,
      });
    }
  }
  const table = buildTableView(visible, playerId);
  const seatIndex = table.seats.findIndex((s) => s.playerId === playerId);
  const me = table.seats[seatIndex] as SeatView;
  const buttonIndex = table.seats.findIndex((s) => s.isButton);
  const playerCount = table.seats.length;
  return {
    ...table,
    holeCards: me.holeCards,
    position: {
      buttonOffset: (seatIndex - buttonIndex + playerCount) % playerCount,
      playerCount,
    },
    actionHistory,
    math: decisionMath(table, me),
  };
}

/** 公開情報だけから Call 額・Pot Odds・有効 Stack・SPR を計算する。 */
function decisionMath(table: TableView, me: SeatView): DecisionMath {
  const callAmount = Math.min(
    Math.max(0, table.currentBet - me.streetCommitted),
    me.stack,
  );
  const otherStacks = table.seats
    .filter((s) => s.playerId !== me.playerId && !s.folded)
    .map((s) => s.stack);
  const effectiveStack = Math.min(me.stack, Math.max(0, ...otherStacks));
  return {
    callAmount,
    potOdds: callAmount === 0 ? null : callAmount / (table.pot + callAmount),
    effectiveStack,
    spr: table.pot === 0 ? null : effectiveStack / table.pot,
  };
}

function buildTableView(
  visible: readonly HandEvent[],
  viewerId: string,
): TableView {
  const state: HandState = foldHandEvents(visible);
  if (!state.players.some((p) => p.playerId === viewerId)) {
    throw new RangeError(
      `卓にいない Player の Projection は作らない: ${viewerId}`,
    );
  }
  const actor =
    state.actorIndex === null ? null : state.players[state.actorIndex];
  const legal = getLegalActions(state);
  return {
    handId: state.handId,
    viewerId,
    ruleProfile: state.ruleProfile,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    street: state.street,
    status: state.status,
    board: state.board,
    pot: state.pot,
    currentBet: state.currentBet,
    actorId: actor?.playerId ?? null,
    seats: state.players.map((p, i) => ({
      playerId: p.playerId,
      isButton: i === state.buttonIndex,
      stack: p.stack,
      streetCommitted: p.streetCommitted,
      totalCommitted: p.totalCommitted,
      folded: p.folded,
      allIn: p.allIn,
      // 畳み込んだ時点で他者の札は入っていないが、出力側でも自分か公開済みに限る（二重の whitelist）。
      holeCards: p.playerId === viewerId || p.shown ? p.holeCards : null,
    })),
    legalActions: legal !== null && legal.playerId === viewerId ? legal : null,
    awards: state.awards,
  };
}
