// Reveal Review（Pass B。docs/05 §7）の Evidence の組み立て。Hand 後の Learning-only Full Reveal（projectLearningReveal）を使い、
// 読み（判断時点に仮定した Range）と実際の札の比較・実際の Equity・Bluff / Value の答え合わせを決定論で作る（LLM に計算させない）。
// 入力は判断時点の Hero Information Set と、別の Projection の LearningReveal。Pass A の Evidence（evidence.ts）はこれを受け取らない。
// ここで作る値は学習用の開示で、CPU の KnowledgeState・CPU の判断の入力には渡さない（INV-INFO-002・INV-TEST-008）。
import {
  EquityUnavailableError,
  HandCategory,
  analyzeDecision,
  comboKey,
  equityVsRanges,
  evaluateHand,
  positionName,
  villainRange,
  type Card,
  type HandEvent,
  type HeroInformationSet,
  type ImportantSpotReason,
  type LearningReveal,
  type Street,
} from "@proj-poker/engine";
import { decisionContext, yieldToEventLoop } from "./evidence.js";
import type { PlayerNames } from "./identifiers.js";
import type {
  AggressionCheck,
  MadeHand,
  RevealEvidence,
  RevealEvidenceIdSet,
  RevealVillainEvidence,
} from "./reveal-types.js";

/** value / bluff の決め方（暫定の基準。Review の運用を見て変える。永久仕様にしない）。 */
export const AGGRESSION_RULE =
  "Bet / Raise した時点の Board で、本人の実際の札の、その時点で Pot を争っていた残りの相手の実際の札に対する Equity（Showdown までの勝率）が、公平な取り分（1 / 人数）以上なら value、未満なら bluff とする。Draw の Semi-Bluff も Equity が取り分に届かなければ bluff に入る。";

const MADE_HAND_NAMES: Readonly<Record<HandCategory, MadeHand>> = {
  [HandCategory.HighCard]: "high_card",
  [HandCategory.Pair]: "pair",
  [HandCategory.TwoPair]: "two_pair",
  [HandCategory.ThreeOfAKind]: "three_of_a_kind",
  [HandCategory.Straight]: "straight",
  [HandCategory.Flush]: "flush",
  [HandCategory.FullHouse]: "full_house",
  [HandCategory.FourOfAKind]: "four_of_a_kind",
  [HandCategory.StraightFlush]: "straight_flush",
};

/**
 * 判断時点の Information Set と Hand 後の Learning-only Reveal から Pass B の Evidence を作る。
 * events は Board の最後の形（finalBoard）を取るためだけに読む（公開された BOARD_DEALT だけ）。
 */
export async function buildRevealEvidence(
  set: HeroInformationSet,
  reveal: LearningReveal,
  events: readonly HandEvent[],
  importantSpotReasons: readonly ImportantSpotReason[],
  playerNames: PlayerNames = {},
): Promise<RevealEvidence> {
  if (reveal.handId !== set.handId) {
    throw new RangeError(
      `Reveal と判断の Hand が違う: ${reveal.handId} ≠ ${set.handId}`,
    );
  }
  const prefix = `${set.handId}/d${set.decision.index}`;
  const { knowledge } = set;
  const heroCards = knowledge.holeCards ?? [];
  const cardsOf = new Map(reveal.holeCards.map((h) => [h.playerId, h.cards]));
  const seatIndex = (playerId: string) =>
    knowledge.seats.findIndex((s) => s.playerId === playerId);
  const buttonIndex = knowledge.seats.findIndex((s) => s.isButton);
  const n = knowledge.seats.length;

  // 読みと実際の比較: 判断時点で Fold していなかった相手は、Pass A と同じ標準の想定の Range に実際の札が入っていたかを見る。
  const villains: RevealVillainEvidence[] = [];
  for (const seat of knowledge.seats) {
    if (seat.playerId === knowledge.viewerId) continue;
    const cards = cardsOf.get(seat.playerId);
    if (cards === undefined) continue;
    const active = !seat.folded;
    const assumed = active ? villainRange(knowledge, seat.playerId) : null;
    const keys = new Set(assumed?.combos.map(comboKey));
    villains.push({
      playerId: seat.playerId,
      ...(playerNames[seat.playerId] === undefined
        ? {}
        : { displayName: playerNames[seat.playerId] }),
      position: positionName(
        (seatIndex(seat.playerId) - buttonIndex + n) % n,
        n,
      ),
      holeCards: cards,
      activeAtDecision: active,
      assumedRange: assumed?.assumption ?? null,
      inAssumedRange:
        assumed === null ? null : keys.has(comboKey(cards as [Card, Card])),
      madeHandAtDecision: madeHand(cards, knowledge.board),
    });
  }
  await yieldToEventLoop();

  // 実際の Equity と、判断時点に仮定した Range に対する Equity（Pass A の Math と同じ計算）。
  const activeVillainCards = villains
    .filter((v) => v.activeAtDecision)
    .map((v) => v.holeCards);
  const actual = equityAgainst(heroCards, knowledge.board, activeVillainCards);
  await yieldToEventLoop();
  const assumed = analyzeDecision(set).equity?.equity ?? null;
  await yieldToEventLoop();

  const finalBoard = events.flatMap((e) =>
    e.type === "BOARD_DEALT" ? e.cards : [],
  );
  const items = aggressionChecks(set, cardsOf, finalBoard);

  return {
    pass: "reveal",
    handId: set.handId,
    decisionIndex: set.decision.index,
    context: decisionContext(set, importantSpotReasons, prefix, playerNames),
    reveal: {
      id: `reveal:${prefix}`,
      visibility: reveal.visibility,
      villains,
      finalBoard,
    },
    equity: {
      id: `equity:${prefix}`,
      assumed,
      actual:
        actual === null
          ? null
          : {
              equity: actual.equity,
              win: actual.win,
              tie: actual.tie,
              method: actual.method,
              trials: actual.trials,
            },
      heroMadeHandAtDecision: madeHand(heroCards, knowledge.board),
    },
    aggression: {
      id: `aggression:${prefix}`,
      items,
      rule: AGGRESSION_RULE,
    },
  };
}

/** Pass B の Evidence が持つ ID の一覧。cited は Review AI が根拠に挙げた ID。 */
export function revealEvidenceIdsOf(
  evidence: RevealEvidence,
  cited: readonly string[] = [],
): RevealEvidenceIdSet {
  return {
    context: [evidence.context.id],
    reveal: [evidence.reveal.id],
    equity: [evidence.equity.id],
    aggression: [evidence.aggression.id],
    cited,
  };
}

/** Pass B の Evidence が持つ全 ID（Review AI が挙げてよい ID）。 */
export function allRevealEvidenceIds(evidence: RevealEvidence): Set<string> {
  const ids = revealEvidenceIdsOf(evidence);
  return new Set([
    ...ids.context,
    ...ids.reveal,
    ...ids.equity,
    ...ids.aggression,
  ]);
}

/**
 * 判断時点までの Bet / Raise（その時点の最高額を超える Bet / Raise / All-in）と、Hero の判断が Bet / Raise ならその判断の、
 * 本人の実際の札の Equity と value / bluff。Pot を争っていた人は、配られた人から、その Action より前に Fold した人を除いたもの。
 */
function aggressionChecks(
  set: HeroInformationSet,
  cardsOf: ReadonlyMap<string, readonly Card[]>,
  finalBoard: readonly Card[],
): AggressionCheck[] {
  const { knowledge, decision } = set;
  const folded = new Set<string>();
  const items: AggressionCheck[] = [];
  let street: Street = "preflop";
  let currentBet = knowledge.bigBlind;
  const check = (
    playerId: string,
    action: AggressionCheck["action"],
    actionStreet: Street,
    toAmount: number,
    isDecision: boolean,
  ) => {
    const inPot = [...cardsOf.keys()].filter((id) => !folded.has(id));
    const own = cardsOf.get(playerId);
    const others = inPot
      .filter((id) => id !== playerId)
      .map((id) => cardsOf.get(id))
      .filter((c): c is readonly Card[] => c !== undefined);
    const board = finalBoard.slice(0, boardSize(actionStreet));
    const result = own === undefined ? null : equityAgainst(own, board, others);
    items.push({
      playerId,
      isHero: playerId === knowledge.viewerId,
      isDecision,
      street: actionStreet,
      action,
      toAmount,
      playersInPot: inPot.length,
      actorEquity: result?.equity ?? null,
      label:
        result === null
          ? null
          : result.equity >= 1 / inPot.length
            ? "value"
            : "bluff",
    });
  };
  for (const a of knowledge.actionHistory) {
    if (a.street !== street) {
      street = a.street;
      currentBet = 0;
    }
    const aggressive =
      a.action === "bet" ||
      a.action === "raise" ||
      (a.action === "all_in" && a.toAmount > currentBet);
    if (aggressive) {
      check(a.playerId, a.action, a.street, a.toAmount, false);
      currentBet = a.toAmount;
    }
    if (a.action === "fold") folded.add(a.playerId);
  }
  const heroAggressive =
    decision.action === "bet" ||
    decision.action === "raise" ||
    (decision.action === "all_in" && decision.toAmount > knowledge.currentBet);
  if (heroAggressive) {
    check(
      knowledge.viewerId,
      decision.action,
      decision.street,
      decision.toAmount,
      true,
    );
  }
  return items;
}

/** own の札の、相手ごとの実際の札（1 Combo ずつ）に対する Equity。相手がいない・札が足りない・出せないなら null。 */
function equityAgainst(
  own: readonly Card[],
  board: readonly Card[],
  opponents: readonly (readonly Card[])[],
) {
  if (own.length !== 2 || opponents.length === 0) return null;
  if (opponents.some((c) => c.length !== 2)) return null;
  try {
    return equityVsRanges(
      own,
      board,
      opponents.map((c) => [c as readonly [Card, Card]]),
    );
  } catch (error) {
    // Card の重なり等で出せないときだけ null（不正な入力は握りつぶさずに投げ直す）。
    if (error instanceof EquityUnavailableError) return null;
    throw error;
  }
}

function madeHand(
  cards: readonly Card[],
  board: readonly Card[],
): MadeHand | null {
  if (cards.length !== 2 || board.length < 3) return null;
  return MADE_HAND_NAMES[evaluateHand([...cards, ...board]).category];
}

function boardSize(street: Street): number {
  switch (street) {
    case "preflop":
      return 0;
    case "flop":
      return 3;
    case "turn":
      return 4;
    case "river":
      return 5;
  }
}
