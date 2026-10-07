// HypothesisPolicy（docs/07 §5・D104・D113）。Weakness Hypothesis の type の一覧・判断の分類・状態遷移のしきい値を、Version 付きで置く。
// ここにある一覧・数値はすべて OI-006 の暫定値で、永久仕様にしない。Playtest 後に変えるときは、既存の Policy を書き換えず、
// Version を上げた Policy を足す（Snapshot には計算した Policy の Version を残し、正本の reviews から計算し直す）。
// 分類と遷移は決定論で、LLM に決めさせない（D104）。
import type { Assessment } from "../review/types.js";
import {
  PHASE6_PROVISIONAL_V1,
  type DecisionFeatures,
  type ScoringPolicy,
} from "./scoring-policy.js";

/**
 * Hypothesis の type（判断の種類）。一覧は Policy の中の Version 付きの一覧で、永久仕様にしない。
 * 1 つの判断は複数の type に入れる（例: Flop 以降の Bet に Raise した判断は postflop_facing_bet と bet_raise）。
 */
export type HypothesisType =
  | "preflop_unraised"
  | "preflop_facing_raise"
  | "postflop_facing_bet"
  | "postflop_unbet"
  | "bet_raise";

/** 状態（D104）。強さの順は strong > supported > suspected で、improving・resolved は Counter Evidence で弱くなった状態。 */
export const HYPOTHESIS_STATUSES = [
  "suspected",
  "supported",
  "strong",
  "improving",
  "resolved",
  "insufficient_data",
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export interface HypothesisPolicy {
  readonly version: string;
  /** Ability Evidence を作る ScoringPolicy（Review の選び方・Assessment の点）。Version はこの Policy の Version で決まる。 */
  readonly scoringPolicy: ScoringPolicy;
  /** Hypothesis の type の一覧（この順に返す）。 */
  readonly types: readonly HypothesisType[];
  /** 判断を type に分ける。Review が持つ判断時点の特徴だけから決める（結果・Pass B を見ない。不変条件 3）。 */
  classify(features: DecisionFeatures): readonly HypothesisType[];
  /** 弱点を支持する（Supporting Evidence にする）Assessment。 */
  readonly supportingAssessments: readonly Assessment[];
  /** 弱点に反する（Counter Evidence にする）Assessment。ここにもどちらにも無い Assessment は数えない。 */
  readonly counterAssessments: readonly Assessment[];
  readonly thresholds: {
    /** Supporting + Counter がこの数に満たなければ insufficient_data。 */
    readonly minSample: number;
    /** supported: Supporting がこの数以上、かつ Supporting の割合がこの値以上。 */
    readonly supported: {
      readonly minSupporting: number;
      readonly minRate: number;
    };
    /** strong: 同上。 */
    readonly strong: {
      readonly minSupporting: number;
      readonly minRate: number;
    };
    /** 直近の窓（Supporting + Counter の直近この件数）。窓より古い Evidence があるときだけ improving / resolved を見る。 */
    readonly recentWindow: number;
    /** strong / supported で、直近の窓の Supporting がこの数以下なら improving（0 件なら resolved）。 */
    readonly improvingMaxRecentSupporting: number;
  };
}

/**
 * phase6_hypothesis_v1（D104・D113。一覧と数値はすべて OI-006 の暫定値）。
 */
export const PHASE6_HYPOTHESIS_V1: HypothesisPolicy = {
  version: "phase6_hypothesis_v1",
  scoringPolicy: PHASE6_PROVISIONAL_V1,
  types: [
    "preflop_unraised",
    "preflop_facing_raise",
    "postflop_facing_bet",
    "postflop_unbet",
    "bet_raise",
  ],
  classify(f) {
    // OI-006 の暫定の分類。Street と「Bet / Raise に直面していたか」で主の type を 1 つ決め、額を引き上げた判断は bet_raise にも入れる。
    const types: HypothesisType[] = [];
    if (f.street === "preflop") {
      types.push(
        f.preflopUnraised ? "preflop_unraised" : "preflop_facing_raise",
      );
    } else {
      types.push(f.callAmount > 0 ? "postflop_facing_bet" : "postflop_unbet");
    }
    if (f.aggressive) types.push("bet_raise");
    return types;
  },
  // OI-006 の暫定値。改善を勧められた判断を弱点の支持、良い判断を反証とし、mixed_marginal はどちらにも数えない。
  // insufficient_evidence は Ability Evidence の点が無い（集計から除く）ので、ここでも数えない。Review の Confidence は件数に影響させない（v1）。
  supportingAssessments: ["improvement_suggested", "major_leak"],
  counterAssessments: ["strong", "reasonable"],
  // OI-006 の暫定値。件数が少ないうちは状態を決めず、Counter Evidence が増えると strong → supported → improving → resolved と弱くなる。
  thresholds: {
    minSample: 3,
    supported: { minSupporting: 2, minRate: 0.4 },
    strong: { minSupporting: 4, minRate: 0.6 },
    recentWindow: 5,
    improvingMaxRecentSupporting: 1,
  },
};

/** Version → Policy。Version を変えれば同じ reviews から作り直せる。 */
export const HYPOTHESIS_POLICIES: Readonly<Record<string, HypothesisPolicy>> = {
  [PHASE6_HYPOTHESIS_V1.version]: PHASE6_HYPOTHESIS_V1,
};

export const DEFAULT_HYPOTHESIS_POLICY = PHASE6_HYPOTHESIS_V1;
