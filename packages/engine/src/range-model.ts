// Range Model。判断時点の KnowledgeState（Hero に見えた公開情報）から、相手ごとの Range を仮定する（docs/research/02 §9）。
// 使うのは Position（席順と Button）・公開された Action の履歴・判断時点までの Board・Hero 自身の札（Card Removal）だけで、
// 相手の実際の札・判断より後の Event は入力に無い（不変条件 3・Hindsight Leak の防止）。
// 結果には必ず Assumption（どの Range を仮定し、どう絞ったか）を付ける。Range は推定で、実際の札ではない。
import type { Card } from "./card.js";
import type { Street } from "./hand-events.js";
import { cardCode, handScore, type CardCode } from "./hand-strength.js";
import type { KnowledgeState, PublicActionRecord } from "./projection.js";
import {
  STANDARD_RANGE_PROFILE,
  type PositionName,
  type PreflopSpot,
  type RangeProfile,
} from "./range-config.js";
import { parseRange, type Combo } from "./range.js";

/** Postflop の絞り込み 1 回分（その相手の Bet / Raise / Call 1 回ごと）。 */
export interface PostflopNarrowing {
  readonly street: Exclude<Street, "preflop">;
  readonly action: "bet_or_raise" | "call";
  /** 残した割合（RangeProfile.postflop）。 */
  readonly keep: number;
  readonly combosBefore: number;
  readonly combosAfter: number;
}

/** 相手 1 人の Range の Assumption（どの Range を仮定したか）。Review の Range Evidence にそのまま渡せる形。 */
export interface RangeAssumption {
  readonly playerId: string;
  readonly profileId: string;
  readonly position: PositionName;
  readonly preflopSpot: PreflopSpot;
  /** 仮定した Preflop の Range の表記（絞る材料が無い Spot は "random"）。 */
  readonly preflopNotation: string;
  readonly postflop: readonly PostflopNarrowing[];
  /** Hero の札と判断時点の Board を除き、Postflop で絞った後の Combo 数。 */
  readonly comboCount: number;
}

export interface VillainRange {
  readonly assumption: RangeAssumption;
  readonly combos: readonly Combo[];
}

/**
 * Button からの距離（buttonOffset）と人数から、Range を決める席の名前を決める。
 * 0 = BTN・1 = SB・2 = BB、BB より後は Button の手前から CO・HJ、それより前は UTG（7〜8 人の Early Position も UTG にまとめる）。
 * Heads-Up は Button（= SB）を BTN、相手を BB とする。
 */
export function positionName(
  buttonOffset: number,
  playerCount: number,
): PositionName {
  if (playerCount === 2) return buttonOffset === 0 ? "BTN" : "BB";
  if (buttonOffset === 0) return "BTN";
  if (buttonOffset === 1) return "SB";
  if (buttonOffset === 2) return "BB";
  const fromButton = playerCount - buttonOffset; // CO = 1・HJ = 2
  if (fromButton === 1) return "CO";
  if (fromButton === 2) return "HJ";
  return "UTG";
}

/** 公開された Action の履歴から、その相手の Preflop の分類を決める。 */
export function classifyPreflop(
  history: readonly PublicActionRecord[],
  playerId: string,
  bigBlind: number,
): PreflopSpot {
  let raises = 0;
  let currentBet = bigBlind;
  let spot: PreflopSpot = "not_acted";
  for (const a of history) {
    if (a.street !== "preflop") continue;
    const aggressive = isAggressive(a, currentBet);
    if (a.playerId === playerId) {
      if (aggressive) {
        spot =
          raises === 0 ? "open" : raises === 1 ? "three_bet" : "four_bet_plus";
      } else if (a.action === "check") {
        spot = "check_option";
      } else if (a.action === "call" || a.action === "all_in") {
        spot =
          raises === 0 ? "limp" : raises === 1 ? "call_open" : "call_three_bet";
      }
    }
    if (aggressive) {
      raises++;
      currentBet = a.toAmount;
    }
  }
  return spot;
}

/**
 * 判断時点の KnowledgeState から、相手 1 人の Range を仮定する。
 * Preflop の分類で Profile の Range を選び、Hero の札と判断時点の Board を含む Combo を除き（Card Removal）、
 * Postflop のその相手の Bet / Raise / Call ごとに、その Street の Board での役の強さの上位を残す。
 */
export function villainRange(
  knowledge: KnowledgeState,
  villainId: string,
  profile: RangeProfile = STANDARD_RANGE_PROFILE,
): VillainRange {
  if (villainId === knowledge.viewerId) {
    throw new RangeError(`Range を仮定する相手が卓にいない: ${villainId}`);
  }
  // Hero に見えている札（自分の札と判断時点の Board）を含む Combo は相手が持ちえない。
  return assumeRange(knowledge, villainId, profile, [
    ...(knowledge.holeCards ?? []),
    ...knowledge.board,
  ]);
}

/**
 * 判断時点の KnowledgeState から、Hero（viewer）自身の Range を「相手から見た形」で仮定する（#82: Solver に渡す Hero 側の Range）。
 * 相手と同じ作り方（Position と公開された Action の列・Postflop の絞り込み）で、使う札は公開の Board だけにする。
 * Hero の実際の札は Range から除かず、足しもしない（相手は Hero の札を知らない。実際の札が Range の外になることもある）。
 */
export function heroRange(
  knowledge: KnowledgeState,
  profile: RangeProfile = STANDARD_RANGE_PROFILE,
): VillainRange {
  return assumeRange(knowledge, knowledge.viewerId, profile, knowledge.board);
}

/** Player 1 人の Range を仮定する（dead の札を含む Combo は除く）。 */
function assumeRange(
  knowledge: KnowledgeState,
  playerId: string,
  profile: RangeProfile,
  dead: readonly Card[],
): VillainRange {
  const seatIndex = knowledge.seats.findIndex((s) => s.playerId === playerId);
  const buttonIndex = knowledge.seats.findIndex((s) => s.isButton);
  if (seatIndex < 0) {
    throw new RangeError(`Range を仮定する相手が卓にいない: ${playerId}`);
  }
  const playerCount = knowledge.seats.length;
  const position = positionName(
    (seatIndex - buttonIndex + playerCount) % playerCount,
    playerCount,
  );
  const preflopSpot = classifyPreflop(
    knowledge.actionHistory,
    playerId,
    knowledge.bigBlind,
  );
  const preflopNotation = notationFor(profile, preflopSpot, position);

  const deadCodes = new Set<CardCode>(dead.map(cardCode));
  let combos = parseRange(preflopNotation).filter(
    ([a, b]) => !deadCodes.has(cardCode(a)) && !deadCodes.has(cardCode(b)),
  );

  const postflop: PostflopNarrowing[] = [];
  let currentBet = 0;
  let street: Street = "preflop";
  for (const a of knowledge.actionHistory) {
    if (a.street === "preflop") continue;
    if (a.street !== street) {
      street = a.street;
      currentBet = 0;
    }
    const aggressive = isAggressive(a, currentBet);
    if (aggressive) currentBet = a.toAmount;
    if (a.playerId !== playerId) continue;
    const action = aggressive
      ? "bet_or_raise"
      : a.action === "call" || a.action === "all_in"
        ? "call"
        : null;
    if (action === null) continue; // Check・Fold では絞らない
    const keep =
      action === "bet_or_raise"
        ? profile.postflop.betOrRaiseKeep
        : profile.postflop.callKeep;
    const board = knowledge.board.slice(0, boardSize(a.street));
    const before = combos.length;
    combos = keepStrongest(combos, board, keep);
    postflop.push({
      street: a.street,
      action,
      keep,
      combosBefore: before,
      combosAfter: combos.length,
    });
  }

  return {
    assumption: {
      playerId,
      profileId: profile.id,
      position,
      preflopSpot,
      preflopNotation,
      postflop,
      comboCount: combos.length,
    },
    combos,
  };
}

/** Street の Action の時点で見えている Board の枚数。 */
function boardSize(street: Exclude<Street, "preflop">): number {
  return street === "flop" ? 3 : street === "turn" ? 4 : 5;
}

/** Bet / Raise、またはその時点の最高額を超える All-in なら Aggressive。 */
function isAggressive(a: PublicActionRecord, currentBet: number): boolean {
  return (
    a.action === "bet" ||
    a.action === "raise" ||
    (a.action === "all_in" && a.toAmount > currentBet)
  );
}

function notationFor(
  profile: RangeProfile,
  spot: PreflopSpot,
  position: PositionName,
): string {
  switch (spot) {
    case "open":
      return profile.open[position];
    case "limp":
      return profile.limp;
    case "call_open":
      return profile.callOpen;
    case "three_bet":
      return profile.threeBet;
    case "call_three_bet":
      return profile.callThreeBet;
    case "four_bet_plus":
      return profile.fourBetPlus;
    case "check_option":
    case "not_acted":
      return "random";
  }
}

/**
 * Board での役の強さの上位 keep の割合を残す（同じ強さは境目でまとめて残す）。順序は元の Range の順を保つ。
 * Made Hand の強さだけを見て Draw は数えない（簡易モデルの Assumption）。
 */
function keepStrongest(
  combos: readonly Combo[],
  board: readonly Card[],
  keep: number,
): Combo[] {
  if (combos.length === 0) return [];
  const boardCodes = board.map(cardCode);
  const scores = combos.map(([a, b]) =>
    handScore([cardCode(a), cardCode(b), ...boardCodes]),
  );
  const sorted = [...scores].sort((x, y) => y - x);
  const count = Math.max(1, Math.ceil(combos.length * keep));
  const cutoff = sorted[count - 1] as number;
  return combos.filter((_, i) => (scores[i] as number) >= cutoff);
}
