// 暫定 CPU（D71）: seed 付きの決定論ルール Bot。
// 戦略の質は求めない（Phase 1 は 1 Hand を最後まで進められることが目的）。将来の Fallback / Emergency Bot（D41・D42）の土台。
// 入力は OpponentInput（自分に見える Projection と Legal Action）だけで、乱数は seed から作る（Math.random を使わない）。
import {
  HandCategory,
  createRng,
  evaluateHand,
  type Card,
  type LegalAction,
  type PlayerAction,
  type Rng,
} from "@proj-poker/engine";
import type {
  OpponentAgent,
  OpponentFactory,
  OpponentInput,
} from "./opponent-agent.js";

type Strength = "strong" | "medium" | "weak";

// 判断のしきい値。暫定 Bot の性格付けで、ルールではない（Persona は Phase 3 以降）。
const STRONG_AGGRESSION = 0.6;
const MEDIUM_BET_FREQUENCY = 0.25;
const MEDIUM_LOOSE_CALL = 0.3;
const WEAK_BLUFF_FREQUENCY = 0.1;
const WEAK_LIMP_FREQUENCY = 0.3;
/** Bet の目安（Pot に対する割合）。 */
const BET_POT_FRACTION = 0.6;
/** medium の手で Call してよい額の上限（Pot に対する割合）。 */
const MEDIUM_CALL_POT_FRACTION = 0.5;

export const createRuleBot: OpponentFactory = (seed) => new RuleBot(seed);

export class RuleBot implements OpponentAgent {
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  decide({ view, legal }: OpponentInput): PlayerAction {
    const me = view.seats.find((s) => s.playerId === view.viewerId);
    const strength = rateStrength(me?.holeCards ?? null, view.board);
    const r = this.rng();
    const find = <T extends LegalAction["type"]>(type: T) =>
      legal.actions.find(
        (a): a is Extract<LegalAction, { type: T }> => a.type === type,
      );
    const bet = find("bet");
    const raise = find("raise");
    const call = find("call");
    const check = find("check");
    const passive: PlayerAction =
      check !== undefined ? { type: "check" } : { type: "fold" };

    switch (strength) {
      case "strong":
        if (bet !== undefined && r < STRONG_AGGRESSION) {
          return { type: "bet", amount: betSize(view.pot, bet.min, bet.max) };
        }
        if (raise !== undefined && r < STRONG_AGGRESSION) {
          return { type: "raise", amount: raise.min };
        }
        return call !== undefined ? { type: "call" } : passive;
      case "medium":
        if (check !== undefined) {
          return bet !== undefined && r < MEDIUM_BET_FREQUENCY
            ? { type: "bet", amount: bet.min }
            : { type: "check" };
        }
        if (
          call !== undefined &&
          (call.amount <= view.pot * MEDIUM_CALL_POT_FRACTION ||
            r < MEDIUM_LOOSE_CALL)
        ) {
          return { type: "call" };
        }
        return passive;
      case "weak":
        if (check !== undefined) {
          return bet !== undefined && r < WEAK_BLUFF_FREQUENCY
            ? { type: "bet", amount: bet.min }
            : { type: "check" };
        }
        if (
          call !== undefined &&
          call.amount <= view.bigBlind &&
          r < WEAK_LIMP_FREQUENCY
        ) {
          return { type: "call" };
        }
        return passive;
    }
  }
}

/** Pot の一定割合を目安に、Legal な範囲へ丸めた Bet 額（整数。D74）。 */
function betSize(pot: number, min: number, max: number): number {
  const target = Math.round(pot * BET_POT_FRACTION);
  return Math.min(max, Math.max(min, target));
}

/** 自分の札と公開 Board だけから手の強さを 3 段階で見積もる。 */
function rateStrength(
  hole: readonly Card[] | null,
  board: readonly Card[],
): Strength {
  if (hole === null || hole.length !== 2) return "weak";
  if (board.length === 0) return ratePreflop(hole);
  const value = evaluateHand([...hole, ...board]);
  if (value.category >= HandCategory.TwoPair) return "strong";
  if (value.category === HandCategory.Pair) return "medium";
  return "weak";
}

function ratePreflop(hole: readonly Card[]): Strength {
  const [a, b] = hole as readonly [Card, Card];
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  if (a.rank === b.rank) return a.rank >= 9 ? "strong" : "medium";
  if (high === 14 && low >= 12) return "strong";
  if (low >= 10 || (high === 14 && a.suit === b.suit)) return "medium";
  return "weak";
}
