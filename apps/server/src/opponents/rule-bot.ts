// 暫定 CPU（D71）: seed 付きの決定論ルール Bot。
// 戦略の質は求めない（Phase 1 は 1 Hand を最後まで進められることが目的）。不正な出力が続いたときの Deterministic Fallback（D41）にも使い、将来の Emergency Bot（D42）の土台にもなる。
// 入力は OpponentInput（自分の KnowledgeState と Legal Action）だけで、乱数は seed から作る（Math.random を使わない）。
// Persona（#51）を渡すと、参加 Range と Aggression のしきい値だけを変える。Persona なしの挙動は D71 のときのまま。
// KnowledgeState にその CPU 自身の Memory の要約（D121・#139）があれば、Persona の Skill・Adaptability・Opponent Reading Quality の
// 範囲で 2 つのしきい値だけを少しずらす（memoryAdjustedTuning）。合法性は Legal Action の中から選ぶことで守る（D40）。
import {
  HandCategory,
  createRng,
  evaluateHand,
  type Card,
  type LegalAction,
  type PlayerAction,
  type Rng,
} from "@proj-poker/engine";
import type { MemorySubjectSummary } from "../memory/memory-summary.js";
import type {
  CpuKnowledgeState,
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
export interface RuleBotTuning {
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

/**
 * Memory の反映の係数（phase7_rulebot_memory_v1。D121・#139）。数値はすべて OI-011 の暫定値で、確定ではない。
 * - maxShift: しきい値をずらす幅の上限（Persona の読みの強さが 1 のとき）
 * - aggressionReference: 相手の aggression_frequency の基準。これより攻める相手には medium の手の Call を広げ、攻めない相手には狭める
 * - foldToCbetReference: 相手の fold_to_cbet_flop の基準。これより降りる相手には weak の手の Bluff を増やし、降りない相手には減らす
 * - deviationScale: 基準からのずれをこの幅で割って -1〜1 に丸める
 */
export const RULEBOT_MEMORY_V1 = {
  version: "phase7_rulebot_memory_v1",
  maxShift: 0.15,
  aggressionReference: 0.35,
  foldToCbetReference: 0.45,
  deviationScale: 0.5,
} as const;

/**
 * Persona の「相手を読んで使う力」（Skill・Adaptability・Opponent Reading Quality の平均。0〜1）。
 * Persona なしの RuleBot は 0（Memory を読まない。D71 の挙動のまま）。
 */
export function memoryReadingOf(persona: Persona | undefined): number {
  if (persona === undefined) return 0;
  const t = persona.traits;
  return clamp01((t.skill + t.adaptability + t.opponentReadingQuality) / 3);
}

/** Subject の項目の割合。十分な Sample の項目だけを読む（不十分な推測は使わない）。 */
function sufficientFrequency(
  subject: MemorySubjectSummary | undefined,
  item: string,
): number | null {
  const found = subject?.items.find((i) => i.item === item);
  return found !== undefined && found.sufficient ? found.frequency : null;
}

/** 基準からのずれを -1〜1 にする。 */
function deviation(frequency: number, reference: number): number {
  return Math.min(
    1,
    Math.max(-1, (frequency - reference) / RULEBOT_MEMORY_V1.deviationScale),
  );
}

/**
 * Memory の要約で、medium の手の Call（mediumLooseCall）と weak の手の Bluff（weakBluffFrequency）のしきい値だけをずらす。
 * 決定論で、乱数を引かない（引く回数を変えると seed の再現性が崩れる）。reading が 0 か Memory が無ければ元のまま。
 * - Bet / Raise に直面していて、この Street で最後に額を上げた相手の aggression_frequency が十分なら、Call をずらす
 * - Postflop でまだ降りていない（All-in でない）相手全員の fold_to_cbet_flop が十分なら、その最小（一番降りない相手）で Bluff をずらす
 */
export function memoryAdjustedTuning(
  base: RuleBotTuning,
  knowledge: CpuKnowledgeState,
  reading: number,
): RuleBotTuning {
  const memory = knowledge.memory;
  if (memory === undefined || reading <= 0) return base;
  const subjectOf = (playerId: string) =>
    memory.subjects.find((s) => s.playerId === playerId);
  const shift = reading * RULEBOT_MEMORY_V1.maxShift;
  let { mediumLooseCall, weakBluffFrequency } = base;

  const aggressor = [...knowledge.actionHistory]
    .reverse()
    .find(
      (a) =>
        a.street === knowledge.street &&
        a.playerId !== knowledge.viewerId &&
        (a.action === "bet" || a.action === "raise" || a.action === "all_in") &&
        a.toAmount === knowledge.currentBet &&
        a.toAmount > 0,
    );
  if (aggressor !== undefined) {
    const aggression = sufficientFrequency(
      subjectOf(aggressor.playerId),
      "aggression_frequency",
    );
    if (aggression !== null) {
      mediumLooseCall = clamp01(
        mediumLooseCall +
          shift * deviation(aggression, RULEBOT_MEMORY_V1.aggressionReference),
      );
    }
  }

  const live = knowledge.seats.filter(
    (s) => s.playerId !== knowledge.viewerId && !s.folded && !s.allIn,
  );
  if (knowledge.board.length > 0 && live.length > 0) {
    const folds = live.map((s) =>
      sufficientFrequency(subjectOf(s.playerId), "fold_to_cbet_flop"),
    );
    if (folds.every((f): f is number => f !== null)) {
      weakBluffFrequency = clamp01(
        weakBluffFrequency +
          shift *
            deviation(
              Math.min(...folds),
              RULEBOT_MEMORY_V1.foldToCbetReference,
            ),
      );
    }
  }
  return { ...base, mediumLooseCall, weakBluffFrequency };
}

/** RuleBot を作る OpponentFactory。Persona があればそのしきい値で判断する。 */
export const createRuleBot: OpponentFactory = (seed, _playerId, persona) =>
  new RuleBot(seed, persona);

export class RuleBot implements OpponentAgent {
  private readonly rng: Rng;
  private readonly tuning: RuleBotTuning;
  /** Memory を使う強さ（memoryReadingOf）。Persona なしは 0。 */
  private readonly reading: number;

  /** persona を省くと既定のしきい値（D71 の暫定 Bot のまま。Memory も読まない）。 */
  constructor(seed: number, persona?: Persona) {
    this.rng = createRng(seed);
    this.tuning =
      persona === undefined ? DEFAULT_TUNING : tuningFromPersona(persona);
    this.reading = memoryReadingOf(persona);
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
    const tuning = memoryAdjustedTuning(this.tuning, knowledge, this.reading);
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
