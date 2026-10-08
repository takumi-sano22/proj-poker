// Review（Pass A: Decision Review。docs/05 §6〜§9・docs/03 §7・docs/04 §8）の型。
// Review AI に渡すのは構造化した Evidence（ReviewEvidence）だけで、Event Log・global な State・他者の札・Persona は型の上でも渡さない。
import type {
  ActionType,
  AlternativeAction,
  Card,
  ImportantSpotReason,
  LegalAction,
  PositionName,
  PublicActionRecord,
  PublicRulingRecord,
  RangeAssumption,
  RulingCode,
  Street,
} from "@proj-poker/engine";
import type { KbLabel, KbTopic } from "../kb/types.js";
import type { TableTendencyItemId } from "../memory/table-tendency-policy.js";
import type {
  BetTree,
  SolverActionFrequency,
  SolverErrorCode,
  SpotRangeAssumption,
  UnsupportedReason,
} from "../solver/types.js";

/**
 * Review の Pass（docs/05 §7）。decision は Pass A（判断時点の情報だけの Decision Review。reviews テーブル）、
 * reveal は Pass B（Hand 後に Learning-only Full Reveal で答え合わせする Reveal Review。reveal_reviews テーブル。#83）。
 */
export type ReviewPass = "decision" | "reveal";

/** 「標準」は review_standard、Hero が「詳しく」を選んだ Spot は review_deep（D97）。 */
export type ReviewDepth = "standard" | "deep";

export type ReviewModelRole = "review_standard" | "review_deep";

/** 段階評価（docs/05 §8）。点数ではなく段階で示す。 */
export const ASSESSMENTS = [
  "strong",
  "reasonable",
  "mixed_marginal",
  "improvement_suggested",
  "major_leak",
  "insufficient_evidence",
] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Decision Context: 判断時点に Hero に見えていた卓（KnowledgeState から whitelist で写す）。 */
export interface DecisionContextEvidence {
  readonly id: string;
  readonly street: Street;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly heroId: string;
  readonly heroPosition: PositionName;
  /** 席に座っている人数（Fold した人を含む）。 */
  readonly playerCount: number;
  /** Fold していない人数（Hero を含む）。 */
  readonly activePlayerCount: number;
  readonly heroHoleCards: readonly Card[];
  /** 判断時点までに公開された Board だけ。 */
  readonly board: readonly Card[];
  readonly pot: number;
  readonly currentBet: number;
  readonly seats: readonly {
    readonly playerId: string;
    /** Hero の画面に出ている名前（文ではこの名前で呼ぶ。#96）。#96 より前に保存された Evidence には無い。 */
    readonly displayName?: string;
    readonly position: PositionName;
    readonly isHero: boolean;
    readonly stack: number;
    readonly streetCommitted: number;
    readonly totalCommitted: number;
    readonly folded: boolean;
    readonly allIn: boolean;
  }[];
  /** 判断時点までの Public Action（時系列）。 */
  readonly actionHistory: readonly PublicActionRecord[];
  /** Hero の操作への裁定の履歴（裁定が無い Hand では持たない）。 */
  readonly rulingHistory?: readonly PublicRulingRecord[];
  readonly legalActions: readonly LegalAction[];
  /** Review の対象の判断（Hero 自身の選択）。 */
  readonly decision: {
    readonly action: ActionType;
    readonly amount: number;
    readonly toAmount: number;
    readonly allIn: boolean;
  };
  readonly rulingNotes: readonly RulingCode[];
  /** Important Spot に選ばれた理由（選ばれていなければ空）。 */
  readonly importantSpotReasons: readonly ImportantSpotReason[];
}

/** Math Evidence: Engine の analyzeDecision（#79）が決定論で作った値。LLM に計算させない。 */
export interface MathEvidence {
  readonly id: string;
  readonly pot: number;
  readonly callAmount: number;
  readonly potOdds: number | null;
  readonly effectiveStack: number;
  readonly spr: number | null;
  /** 仮定した Range に対する Equity。出せなければ null。 */
  readonly equity: {
    readonly equity: number;
    readonly win: number;
    readonly tie: number;
    readonly method: "exact" | "monte_carlo";
    readonly trials: number;
  } | null;
  readonly alternatives: readonly AlternativeAction[];
  /** 簡易 EV で、GTO / Solver の値ではない（D20）。 */
  readonly evBasis: "simplified";
  readonly assumptions: readonly string[];
}

/** Range Evidence: 相手ごとの Range の Assumption と、Important Spot では Range の想定ごとの Equity の比較（D08）。 */
export interface RangeEvidence {
  readonly id: string;
  readonly villains: readonly RangeAssumption[];
  /** Important Spot のときだけ。標準・狭い・広いの想定ごとの Equity。 */
  readonly comparisons:
    | readonly {
        readonly id: string;
        readonly profileId: string;
        readonly label: string;
        readonly equity: number | null;
        readonly ranges: readonly RangeAssumption[];
      }[]
    | null;
}

/**
 * Table Tendency の項目 1 つ（D122・#153）。数値は決定論のコード（memory/table-tendency.ts）が数えた値が正本で、Review AI は説明だけを行う。
 * provenance は id（Hand と判断と項目）と、項目・Policy の版。
 */
export interface TableTendencyEvidenceItem {
  /** `tendency:<handId>/d<判断の番号>/<項目>`。 */
  readonly id: string;
  readonly item: TableTendencyItemId;
  /** numerator / denominator（小数第 3 位まで。Review AI に割り算させない）。機会が 0 なら null。 */
  readonly rate: number | null;
  readonly numerator: number;
  /** 機会の数。 */
  readonly denominator: number;
  /** その項目の機会があった Hand の数。 */
  readonly hands: number;
  /** Policy の基準（Hand の数と機会の数）以上か。false の項目は保留（根拠にしない）。 */
  readonly sufficient: boolean;
}

/**
 * 判断時点より前に Hero が座って見えた、今の Session の保存済みの Hand の public の Event だけから作った、
 * Hero 以外の卓全体の傾向（D122）。個々の相手の傾向ではなく、CPU の Private Memory / Hypothesis・Persona・Tilt を含まない。
 */
export interface TableTendencyEvidence {
  readonly policyVersion: string;
  /** 数えた Hand の数。 */
  readonly hands: number;
  readonly items: readonly TableTendencyEvidenceItem[];
}

/**
 * Opponent Observation Evidence。Hero が観察できた相手の傾向は、今は Table Tendency（D122・#153）だけ。
 * 十分な項目が 1 つも無ければ unavailable のまま（Prompt を #153 より前と同じ文字列に保つ。Review Eval の録画の指紋を変えない）。
 */
export type OpponentObservationEvidence =
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "available";
      readonly tableTendency: TableTendencyEvidence;
    };

/**
 * Solver Evidence。Capability Gate（supports）を通り、実際に解けたときだけ supported。
 * Unsupported（Multiway・Flop・未導入等）・当てはまらない Node・失敗は Fallback の理由として残す（正常系）。
 */
export type SolverEvidenceItem =
  | {
      readonly status: "supported";
      readonly id: string;
      readonly solver: {
        readonly id: string;
        readonly version: string;
        readonly commit: string;
        readonly pinnedCommit: boolean;
      };
      /** HU の Solver の結果。Multiway の Exact GTO ではない（不変条件 5）。 */
      readonly scope: "heads_up";
      readonly node: { readonly street: Street; readonly actor: "oop" };
      readonly spot: {
        readonly street: Street;
        readonly board: readonly string[];
        readonly pot: number;
        readonly effectiveStack: number;
      };
      readonly betTree: BetTree;
      /** Root の Range 全体の行動頻度。 */
      readonly strategy: readonly SolverActionFrequency[];
      /** Hero の実際の札の Hand Class（"AKs" 等）。 */
      readonly heroHandClass: string;
      /** その Hand Class の行動頻度（Hero 側の Range の外なら null）。 */
      readonly heroHandClassStrategy: Readonly<Record<string, number>> | null;
      readonly ev: { readonly available: false; readonly reason: string };
      readonly convergence: {
        readonly iterations: number;
        readonly note: string;
      };
      readonly rangeAssumptions: {
        readonly oop: SpotRangeAssumption & { readonly comboCount: number };
        readonly ip: SpotRangeAssumption & { readonly comboCount: number };
      };
      readonly assumptions: readonly string[];
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly reason: UnsupportedReason;
      readonly detail: string;
    }
  | {
      readonly status: "not_applicable";
      readonly reason: "preflop" | "not_root_node";
      readonly detail: string;
    }
  | {
      readonly status: "failed";
      readonly code: SolverErrorCode;
      readonly detail: string;
    };

/** Knowledge Evidence: Local KB（#80）の検索結果。evidenceId は KB の Version を含む。 */
export interface KnowledgeEvidence {
  readonly kbVersion: string;
  readonly items: readonly {
    readonly id: string;
    readonly kbId: string;
    readonly title: string;
    readonly topic: KbTopic;
    readonly label: KbLabel;
    readonly matched: readonly string[];
    readonly body: string;
  }[];
}

/** Hero が判断の前に記録した読み 1 つ（USER_READ_RECORDED。D112）。provenance は id（Hand と Event の seq）と Street。 */
export interface UserReadItem {
  /** `read:<handId>/<seq>`（Event Log の USER_READ_RECORDED を指す）。 */
  readonly id: string;
  /** 記録した時点の Street。 */
  readonly street: Street;
  /** 読みの対象の席。相手を特定しない読み・意図には無い。 */
  readonly playerId?: string;
  /** 対象の席の表示名（Hero の画面に出ている名前。#96）。 */
  readonly displayName?: string;
  readonly text: string;
}

/**
 * User Read / Intent（docs/05 §6・§12・D112）。その判断の前に Hero が記録した読みだけを入れる（判断より後の読みは入れない）。
 * Hero の主張で、相手の観察の記録（Observation）ではない。読みが 1 つも無い判断は not_collected のまま
 * （読みの無い Hand の Prompt を変えない。Review Eval の録画の指紋を保つ）。
 */
export type UserReadEvidence =
  | { readonly status: "not_collected" }
  | { readonly status: "collected"; readonly items: readonly UserReadItem[] };

/** Review AI へ渡す Evidence の全体（docs/05 §6）。これ以外は渡さない。 */
export interface ReviewEvidence {
  readonly pass: "decision";
  readonly handId: string;
  readonly decisionIndex: number;
  readonly context: DecisionContextEvidence;
  readonly math: MathEvidence;
  readonly range: RangeEvidence;
  readonly opponentObservation: OpponentObservationEvidence;
  readonly solver: SolverEvidenceItem;
  readonly knowledge: KnowledgeEvidence;
  readonly userRead: UserReadEvidence;
}

/** Evidence の ID（docs/04 §8 の Math / Solver / User Read Evidence IDs）。provided は渡した ID、cited は Review AI が根拠に挙げた ID。 */
export interface EvidenceIdSet {
  readonly context: readonly string[];
  readonly math: readonly string[];
  readonly range: readonly string[];
  readonly solver: readonly string[];
  readonly knowledge: readonly string[];
  readonly userRead: readonly string[];
  /** Table Tendency の項目の id（D122・#153）。卓の傾向が Evidence に無い Review（#153 より前の Review を含む）には無い。 */
  readonly tableTendency?: readonly string[];
  readonly cited: readonly string[];
}

/** 説明（docs/05 §9: Practical → GTO / Theory → Exploit の順）。 */
export interface ReviewExplanation {
  readonly practical: string;
  readonly theory: {
    readonly basis: "solver" | "general_theory" | "none";
    readonly text: string;
  };
  readonly exploit: {
    readonly basis: "observation" | "none";
    readonly text: string;
  };
  /** 何が変わると結論も変わるか（docs/05 §8）。 */
  readonly conclusionChangers: readonly string[];
}

/** Review AI の出力（検証済み）。 */
export interface ReviewOutput {
  readonly assessment: Assessment;
  readonly confidence: Confidence;
  readonly practical: string;
  readonly theory: ReviewExplanation["theory"];
  readonly exploit: ReviewExplanation["exploit"];
  readonly assumptions: readonly string[];
  readonly conclusionChangers: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** どの経路で作った Review か。 */
export type ReviewGeneratedBy =
  /** Review AI の出力（検証済み）。 */
  | "review_ai"
  /** Evidence Sufficiency Gate で根拠が足りず、Review AI を呼ばずに Insufficient Evidence にした。 */
  | "sufficiency_gate"
  /** Review AI の出力が 2 回続けて不正で、Insufficient Evidence にした（失敗は failure に残す）。 */
  | "invalid_output_fallback";

/** 保存する前の Review（Version・ID・時刻は Store が付ける）。 */
export interface ReviewDraft {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly actionSeq: number;
  readonly pass: "decision";
  readonly depth: ReviewDepth;
  readonly modelRole: ReviewModelRole;
  /** Review AI を呼んだときの具体モデル名。Gate で止めた（呼んでいない）なら null。 */
  readonly concreteModel: string | null;
  readonly kbVersion: string;
  /** 使った Solver の版（`<id>@<version>+<commit>`）。Solver Evidence が supported でなければ null。 */
  readonly solverVersion: string | null;
  readonly generatedBy: ReviewGeneratedBy;
  readonly assessment: Assessment;
  readonly confidence: Confidence;
  readonly assumptions: readonly string[];
  readonly evidenceIds: EvidenceIdSet;
  readonly explanation: ReviewExplanation;
  readonly evidence: ReviewEvidence;
  readonly failure: {
    readonly kind: "invalid_output";
    readonly attempts: readonly {
      readonly stage: string;
      readonly reason: string;
    }[];
  } | null;
}

/** 保存した Review（docs/04 §8 の Review Record）。上書きしない（D39）。 */
export interface ReviewRecord extends ReviewDraft {
  readonly reviewId: string;
  /** 同じ Hand・判断・Pass の中の版（1 から）。 */
  readonly version: number;
  /** ISO 8601（UTC）。 */
  readonly createdAt: string;
}
