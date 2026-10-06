// 暫定 CPU（D71）: seed 付きの決定論ルール Bot。
// 戦略の質は求めない（Phase 1 は 1 Hand を最後まで進められることが目的）。不正な出力が続いたときの Deterministic Fallback（D41）にも使い、将来の Emergency Bot（D42）の土台にもなる。
// 入力は OpponentInput（自分の KnowledgeState と Legal Action）だけで、乱数は seed から作る（Math.random を使わない）。
// Persona（#51）を渡すと、参加 Range と Aggression のしきい値だけを変える。Persona なしの挙動は D71 のときのまま。
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
  OpponentOutput,
} from "./opponent-agent.js";
import type { Persona } from "./persona.js";

type Strength = "strong" | "medium" | "weak";

/** Preflop で参加する手の範囲。standard が Persona なしの既定（D71 の暫定 Bot と同じ）。 */
type PreflopRange = "tight" | "standard" | "loose";

/** 判断のしきい値。Persona なしは DEFAULT_TUNING（D71 の暫定 Bot の値）。 */
interface RuleBotTuning {
  /** strong の手で Bet / Raise する確率。 */
  readonly strongAggression: number;
  /** medium の手で（Check できるとき）Bet する確率。 */
  readonly mediumBetFrequency: number;
  /** medium の手で、Bet / Raise に直面したとき Raise する確率（Persona なしは 0。攻撃的な Persona だけが持つ）。 */
  readonly mediumRaiseFrequency: number;
  /** medium の手で、Pot に対して大きい額でも Call する確率。 */
  readonly mediumLooseCall: number;
  /** weak の手で（Check できるとき）Bet する確率。 */
  readonly weakBluffFrequency: number;
  /** weak の手で、BB 以下の額なら Call（Limp）する確率。 */
  readonly weakLimpFrequency: number;
  readonly preflopRange: PreflopRange;
}

// 暫定 Bot の性格付けで、ルールではない。Persona なしの挙動を変えないよう、既定値は D71 のときの値のまま。
const DEFAULT_TUNING: RuleBotTuning = {
  strongAggression: 0.6,
  mediumBetFrequency: 0.25,
  mediumRaiseFrequency: 0,
  mediumLooseCall: 0.3,
  weakBluffFrequency: 0.1,
  weakLimpFrequency: 0.3,
  preflopRange: "standard",
};
/** Bet の目安（Pot に対する割合）。 */
const BET_POT_FRACTION = 0.6;
/** medium の手で Call してよい額の上限（Pot に対する割合）。 */
const MEDIUM_CALL_POT_FRACTION = 0.5;
/** Preflop Looseness がこれ以下なら参加 Range を狭め、LOOSE 以上なら広げる（OI-005 の暫定値）。 */
const TIGHT_LOOSENESS = 0.35;
const LOOSE_LOOSENESS = 0.65;

/**
 * Persona の軸から RuleBot のしきい値を作る（参加 Range と Aggression だけを変える最小限の反映。#51）。
 * 軸が 0.5（平均的）のとき既定値になるよう、既定値からのずれで表す。係数は OI-005 の暫定値。
 */
export function tuningFromPersona(persona: Persona): RuleBotTuning {
  const t = persona.traits;
  const shift = (base: number, axis: number, scale: number) =>
    clamp01(base + (axis - 0.5) * scale);
  return {
    strongAggression: shift(DEFAULT_TUNING.strongAggression, t.aggression, 0.7),
    mediumBetFrequency: shift(
      DEFAULT_TUNING.mediumBetFrequency,
      t.aggression,
      0.5,
    ),
    mediumRaiseFrequency: shift(
      DEFAULT_TUNING.mediumRaiseFrequency,
      t.aggression,
      0.6,
    ),
    mediumLooseCall: shift(
      DEFAULT_TUNING.mediumLooseCall,
      t.riskTolerance,
      0.6,
    ),
    weakBluffFrequency: shift(
      DEFAULT_TUNING.weakBluffFrequency,
      t.bluffTendency,
      0.4,
    ),
    weakLimpFrequency: shift(
      DEFAULT_TUNING.weakLimpFrequency,
      t.preflopLooseness,
      0.8,
    ),
    preflopRange:
      t.preflopLooseness <= TIGHT_LOOSENESS
        ? "tight"
        : t.preflopLooseness >= LOOSE_LOOSENESS
          ? "loose"
          : "standard",
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** RuleBot を作る OpponentFactory。Persona があればそのしきい値で判断する。 */
export const createRuleBot: OpponentFactory = (seed, _playerId, persona) =>
  new RuleBot(seed, persona);

export class RuleBot implements OpponentAgent {
  private readonly rng: Rng;
  private readonly tuning: RuleBotTuning;

  /** persona を省くと既定のしきい値（D71 の暫定 Bot のまま）。 */
  constructor(seed: number, persona?: Persona) {
    this.rng = createRng(seed);
    this.tuning =
      persona === undefined ? DEFAULT_TUNING : tuningFromPersona(persona);
  }

  /** OpponentAgent としての出力。中身は choose と同じ判断を OpponentOutput の形にしたもの。 */
  decide(input: OpponentInput): Promise<OpponentOutput> {
    const action = this.choose(input);
    return Promise.resolve(
      "amount" in action
        ? { action: action.type, amount: action.amount }
        : { action: action.type },
    );
  }

  /**
   * 合法 Action から同期で 1 つ選ぶ。Deterministic Fallback（D41）はこちらを直接使う
   * （待ち時間も障害も無く、seed だけで結果が決まる）。
   */
  choose({ knowledge, legal }: OpponentInput): PlayerAction {
    const tuning = this.tuning;
    const strength = rateStrength(
      knowledge.holeCards,
      knowledge.board,
      tuning.preflopRange,
    );
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
        if (bet !== undefined && r < tuning.strongAggression) {
          return {
            type: "bet",
            amount: betSize(knowledge.pot, bet.min, bet.max),
          };
        }
        if (raise !== undefined && r < tuning.strongAggression) {
          return { type: "raise", amount: raise.min };
        }
        return call !== undefined ? { type: "call" } : passive;
      case "medium":
        if (check !== undefined) {
          return bet !== undefined && r < tuning.mediumBetFrequency
            ? { type: "bet", amount: bet.min }
            : { type: "check" };
        }
        if (raise !== undefined && r < tuning.mediumRaiseFrequency) {
          return { type: "raise", amount: raise.min };
        }
        if (
          call !== undefined &&
          (call.amount <= knowledge.pot * MEDIUM_CALL_POT_FRACTION ||
            r < tuning.mediumLooseCall)
        ) {
          return { type: "call" };
        }
        return passive;
      case "weak":
        if (check !== undefined) {
          return bet !== undefined && r < tuning.weakBluffFrequency
            ? { type: "bet", amount: bet.min }
            : { type: "check" };
        }
        if (
          call !== undefined &&
          call.amount <= knowledge.bigBlind &&
          r < tuning.weakLimpFrequency
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
  range: PreflopRange,
): Strength {
  if (hole === null || hole.length !== 2) return "weak";
  if (board.length === 0) return ratePreflop(hole, range);
  const value = evaluateHand([...hole, ...board]);
  if (value.category >= HandCategory.TwoPair) return "strong";
  if (value.category === HandCategory.Pair) return "medium";
  return "weak";
}

/**
 * Preflop の手の強さ。standard は既定（D71 の暫定 Bot のまま）。
 * tight は medium の下側（小さい Pair・Ace 以外の Broadway 未満）を weak に落とし、
 * loose は weak の上側（Ace / King を含む手・Suited Connector）を medium に上げる。
 */
function ratePreflop(hole: readonly Card[], range: PreflopRange): Strength {
  const [a, b] = hole as readonly [Card, Card];
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  const suited = a.suit === b.suit;
  const base: Strength =
    a.rank === b.rank
      ? a.rank >= 9
        ? "strong"
        : "medium"
      : high === 14 && low >= 12
        ? "strong"
        : low >= 10 || (high === 14 && suited)
          ? "medium"
          : "weak";
  if (range === "tight" && base === "medium") {
    const keeps = a.rank === b.rank ? a.rank >= 6 : low >= 11;
    return keeps ? "medium" : "weak";
  }
  if (range === "loose" && base === "weak") {
    const plays = high >= 13 || (suited && high - low <= 2 && low >= 5);
    return plays ? "medium" : "weak";
  }
  return base;
}
