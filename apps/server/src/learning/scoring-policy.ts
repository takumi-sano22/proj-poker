// ScoringPolicy（docs/07 §2・D103・D48・D115）。Pass A の Review から Ability / Overall Score を計算する式を、Version 付きで置く。
// ここにある数値・割り当ての規則はすべて OI-006 の暫定値で、永久仕様にしない。Playtest 後に変えるときは、既存の Policy を
// 書き換えず、Version を上げた Policy を足す（同じ Evidence から Version ごとに計算し直せるようにする。Score には Version を残す）。
// 割り当て・点・Weight は決定論で、LLM に決めさせない（D103）。
import type { ActionType, RulingCode, Street } from "@proj-poker/engine";
import type { Assessment, Confidence, ReviewRecord } from "../review/types.js";

/** Ability Dimension（docs/07 §2 の初期候補）。一覧は Policy の中の Version 付きの一覧で、永久仕様にしない。 */
export type AbilityDimension =
  | "preflop"
  | "postflop"
  | "bet_sizing"
  | "pot_equity_math"
  | "range_reading"
  | "opponent_adaptation"
  | "position"
  | "live_mechanics";

/** Poker Decision の Ability（Overall Score に入る）。Live Mechanics は別の Score（D48）なので入れない。 */
export type PokerDecisionAbility = Exclude<AbilityDimension, "live_mechanics">;

/** Ability への割り当て（1 つの判断は複数の Ability に寄与できる）。 */
export interface AbilityAssignment {
  readonly ability: PokerDecisionAbility;
  /** 集計の Weight（0 より大きい）。 */
  readonly weight: number;
}

/**
 * 割り当ての規則が見てよい判断の特徴。Pass A の Review が持つ判断時点の Evidence（Hero Information Set）だけから作る。
 * 結果・後の Street・Pass B の情報は入れない（不変条件 3）。
 */
export interface DecisionFeatures {
  readonly street: Street;
  readonly action: ActionType;
  /** 判断時点に Call に要った額（0 なら Bet に直面していない）。 */
  readonly callAmount: number;
  /** Hero がこの判断で額を引き上げた（Bet / Raise / 額を上げる All-in）。 */
  readonly aggressive: boolean;
  /** Preflop で、判断時点の最高額が BB のまま（誰も Raise していない）。 */
  readonly preflopUnraised: boolean;
  /** この判断の Hero の操作への Dealer の裁定の理由（Live Mechanics の Evidence）。 */
  readonly rulingNotes: readonly RulingCode[];
}

/** Score の Confidence。Evidence が無ければ insufficient（Score は null）。 */
export type ScoreConfidence = "insufficient" | "low" | "medium" | "high";

export type TrendDirection =
  "improving" | "stable" | "declining" | "insufficient";

export interface ScoringPolicy {
  readonly version: string;
  /** Score を返す Ability の一覧（この順に返す）。 */
  readonly abilities: readonly AbilityDimension[];
  /** Pass A の Assessment の点。null は集計から除く（0 点として数えない）。 */
  readonly assessmentPoints: Readonly<Record<Assessment, number | null>>;
  /** Review の Confidence を集計の Weight に変える（点数そのものは変えない）。 */
  readonly confidenceWeights: Readonly<Record<Confidence, number>>;
  /** 判断 → Poker Decision の Ability と Weight。 */
  assignAbilities(features: DecisionFeatures): readonly AbilityAssignment[];
  /** Live Mechanics の点（D48: Poker Decision と別の Score）。裁定の理由から決定論で決める。 */
  liveMechanicsPoints(rulingNotes: readonly RulingCode[]): number;
  /** 同じ判断に複数の Version の Review があるとき、どれを使うか（D115: 最新）。 */
  selectReview(versions: readonly ReviewRecord[]): ReviewRecord | null;
  /** Score の Confidence を、集計に入った Evidence の数から決める。 */
  scoreConfidence(sampleSize: number): ScoreConfidence;
  /** Trend: 直近 window 件と、その前の window 件の Score の差で見る。 */
  readonly trend: {
    readonly window: number;
    /** 差がこの点以上なら improving / declining、未満なら stable。 */
    readonly minDelta: number;
  };
}

/**
 * phase6_provisional_v1（D103。数値と規則はすべて OI-006 の暫定値）。
 */
export const PHASE6_PROVISIONAL_V1: ScoringPolicy = {
  version: "phase6_provisional_v1",
  abilities: [
    "preflop",
    "postflop",
    "bet_sizing",
    "pot_equity_math",
    "range_reading",
    "opponent_adaptation",
    "position",
    "live_mechanics",
  ],
  // D103 の暫定値（OI-006）。insufficient_evidence は 0 点ではなく集計から除く。
  assessmentPoints: {
    strong: 100,
    reasonable: 80,
    mixed_marginal: 60,
    improvement_suggested: 35,
    major_leak: 0,
    insufficient_evidence: null,
  },
  // OI-006 の暫定値（未確定の「Weight」「Confidence Aggregation」）。low の Review も 0 にはせず、重みを下げて数える。
  confidenceWeights: { high: 1, medium: 0.7, low: 0.4 },
  assignAbilities(f) {
    // OI-006 の暫定の割り当て。Street の Ability（Preflop / Postflop）を主（1）にし、判断の種類に応じた Ability を従（0.5）で足す。
    // Opponent Adaptation は、Hero が観察した相手の Evidence（Opponent Observation）がまだ無いので割り当てない（#115・Phase 7 で見直す）。
    const assigned: AbilityAssignment[] = [
      { ability: f.street === "preflop" ? "preflop" : "postflop", weight: 1 },
    ];
    if (f.aggressive) assigned.push({ ability: "bet_sizing", weight: 0.5 });
    if (f.callAmount > 0) {
      assigned.push({ ability: "pot_equity_math", weight: 0.5 });
      if (f.street !== "preflop") {
        assigned.push({ ability: "range_reading", weight: 0.5 });
      }
    }
    if (f.preflopUnraised) assigned.push({ ability: "position", weight: 0.5 });
    return assigned;
  },
  liveMechanicsPoints(rulingNotes) {
    // OI-006 の暫定値（docs に式が無い。D48）。理由のある裁定が入った判断は 0、入らなかった判断は 100。
    return rulingNotes.length > 0 ? 0 : 100;
  },
  selectReview(versions) {
    // D115: 同じ判断の最新の Version を使う。standard と deep のどちらを優先するかは OI-006 の暫定値で、
    // v1 は Depth で優先を付けず、Version の最も大きいもの（後から作ったもの）を使う。
    let latest: ReviewRecord | null = null;
    for (const r of versions) {
      if (r.pass !== "decision") continue;
      if (latest === null || r.version > latest.version) latest = r;
    }
    return latest;
  },
  scoreConfidence(sampleSize) {
    // OI-006 の暫定値（「Confidence Aggregation」は未確定）。件数だけで段階を決める。
    if (sampleSize === 0) return "insufficient";
    if (sampleSize < 10) return "low";
    if (sampleSize < 30) return "medium";
    return "high";
  },
  // OI-006 の暫定値。直近 10 件とその前の 10 件を比べ、5 点以上の差を傾向とみなす。
  trend: { window: 10, minDelta: 5 },
};

/** Version → Policy。Version を変えれば同じ Evidence から計算し直せる。 */
export const SCORING_POLICIES: Readonly<Record<string, ScoringPolicy>> = {
  [PHASE6_PROVISIONAL_V1.version]: PHASE6_PROVISIONAL_V1,
};

export const DEFAULT_SCORING_POLICY = PHASE6_PROVISIONAL_V1;
