// Player ごとの可視 Projection（Hero 表示用と CPU Bot 用）。
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

/** Hero 表示用と Bot 用に共通する卓の見え方。 */
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

/** 公開された Action の記録（Bot の判断材料。docs/02 §2 の Public Action）。 */
export interface PublicActionRecord {
  readonly playerId: string;
  readonly street: Street;
  readonly action: ActionType;
  readonly amount: number;
  readonly toAmount: number;
  readonly allIn: boolean;
}

/** CPU Bot 用（D71: そのPlayerに見える情報だけ）。卓の見え方と Public Action の履歴を持つ。 */
export interface BotView extends TableView {
  readonly actionHistory: readonly PublicActionRecord[];
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

export function projectBotView(
  events: readonly HandEvent[],
  botId: string,
): BotView {
  const visible = visibleEvents(events, botId);
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
  return { ...buildTableView(visible, botId), actionHistory };
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
