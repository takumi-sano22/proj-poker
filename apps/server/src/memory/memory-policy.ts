// CPU の Opponent Memory の Policy（D106・D119・#138。docs/05 §5・OI-011）。Observer × Subject × Context の Private Hypothesis を
// Observation から作るときの recency decay・十分な Sample の基準・傾向の項目の一覧を、Version 付きで置く。
// ここにある数値はすべて OI-011 の暫定値で、確定ではない。Eval / Playtest の後に変えるときは、既存の Policy を書き換えず、
// Version を上げた Policy を足す（Hypothesis は保存しない Projection なので、同じ Observation から Version ごとに作り直せる）。
// Hero の弱点の Policy（apps/server/src/learning/ の ScoringPolicy・HypothesisPolicy）とは別物で、import も型の共有もしない（不変条件 2）。
import type { StatId } from "@proj-poker/engine";

/**
 * Hypothesis の傾向の項目。Observation（public の Event だけ）から数えられる観察可能な頻度に限り、Engine の Stats の定義
 * （packages/engine の STAT_DEFINITIONS。Hero の Stats と同じ数え方）のうち、割合で読む指標を使う。
 * 比で読む Aggression Factor は、機会の重みと分母が一致しないので入れない。項目は Policy の Version ごとに増やせる。
 */
export type HypothesisItemId = Extract<
  StatId,
  | "vpip"
  | "pfr"
  | "three_bet"
  | "fold_to_three_bet"
  | "cbet_flop"
  | "fold_to_cbet_flop"
  | "aggression_frequency"
>;

export interface MemoryPolicy {
  readonly version: string;
  /** Hypothesis に持たせる傾向の項目（この順に返す）。 */
  readonly items: readonly HypothesisItemId[];
  /**
   * recency の重み。age は「その Observation の Hand より後に、Observer がその Subject を（同じ context で）見た Hand の数」
   * （最新の Hand は 0）。論理順序（ordinals.ord）で数え、壁時計を使わない（D117）。
   */
  recencyWeight(age: number): number;
  /**
   * 十分な Sample とみなす重み付きの機会数。Observer の Persona の Skill（0〜1）で変える
   * （弱い CPU は少ない Sample で早合点し、強い CPU は保留しやすい。docs/05 §5）。
   */
  sufficientOpportunities(observerSkill: number): number;
}

/** 半減期（Hand の数）。OI-011 の暫定値。確定ではない（D119）。 */
const PHASE7_HALF_LIFE_HANDS = 150;
/** 十分な Sample の基準の機会数（Skill が平均 0.5 のとき）。OI-011 の暫定値。確定ではない（D119）。 */
const PHASE7_MIN_OPPORTUNITIES = 15;
/** Skill 0 → 0.5 倍、Skill 1 → 1.5 倍（線形）。OI-011 の暫定値。確定ではない（D119）。 */
const PHASE7_SKILL_SCALE = { min: 0.5, max: 1.5 } as const;

/**
 * phase7_memory_v1（D119。数値はすべて OI-011 の暫定値で、確定ではない）。
 * - recency: Observer がその Subject を見た Hand の数に応じた指数減衰（半減期 150 Hand）
 * - 十分な Sample: 重み付きの機会数が 15 × (0.5〜1.5 倍。Skill で線形) 以上
 */
export const PHASE7_MEMORY_V1: MemoryPolicy = {
  version: "phase7_memory_v1",
  items: [
    "vpip",
    "pfr",
    "three_bet",
    "fold_to_three_bet",
    "cbet_flop",
    "fold_to_cbet_flop",
    "aggression_frequency",
  ],
  recencyWeight(age) {
    if (!Number.isSafeInteger(age) || age < 0) {
      throw new RangeError(`recency の age ${age} が不正`);
    }
    return Math.pow(0.5, age / PHASE7_HALF_LIFE_HANDS);
  },
  sufficientOpportunities(observerSkill) {
    if (!(observerSkill >= 0 && observerSkill <= 1)) {
      throw new RangeError(`Observer の Skill ${observerSkill} が 0〜1 でない`);
    }
    const { min, max } = PHASE7_SKILL_SCALE;
    return PHASE7_MIN_OPPORTUNITIES * (min + (max - min) * observerSkill);
  },
};

/** Version → Policy。Version を変えれば同じ Observation から作り直せる。 */
export const MEMORY_POLICIES: Readonly<Record<string, MemoryPolicy>> = {
  [PHASE7_MEMORY_V1.version]: PHASE7_MEMORY_V1,
};

export const DEFAULT_MEMORY_POLICY = PHASE7_MEMORY_V1;
