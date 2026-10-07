// Targeted Drill の Service（docs/07 §7・D35・D36・D105・D110・D116・#117）。
// - 開始: 元の Hand の Hero の判断 1 つ（Pass A の Review があるもの）から、一要素だけ変えた Drill を決定論で選び（drill-plan.ts）、
//   drills テーブルに provenance・変形・seed を残してから、Drill の Hand を専用の Session の通常の Hand として始める（hand-orchestrator.ts）
// - 結果: Drill の Hand の判断の Review は既存の Pass A の経路（/api/reviews）でそのまま作る。集計は通常の Score と別の系列で、
//   Drill の Hand（Script が再現した元の判断を除く、練習した判断から）だけを数える（D105）。通常の集計は Drill の Hand を除く（D116）
// Drill の題材の選択に使うのは Hero 自身の判断と Review（Hero 側の処理）だけで、ユーザーの弱点（Profile・Hypothesis・Score）を
// CPU の入力（RuleBot の Persona・KnowledgeState）へ渡さない（不変条件 2）。Drill の Spot は判断時点の Hero Information Set だけから作る。
import { randomUUID } from "node:crypto";
import {
  heroInformationSets,
  type HeroView,
  type TableConfig,
} from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import { isHandEnd } from "../event-store.js";
import type {
  DrillHandStart,
  OrchestratorError,
  OrchestratorResult,
} from "../hand-orchestrator.js";
import type { ScoreSource } from "../learning/ability-evidence.js";
import { computeScoreReport, type ScoreReport } from "../learning/score.js";
import { PERSONA_PRESETS } from "../opponents/persona.js";
import type { Assessment } from "../review/types.js";
import {
  buildDrillPlan,
  DEFAULT_DRILL_POLICY,
  DRILL_POLICIES,
  planDrill,
  type DrillPolicy,
  type DrillVariant,
} from "./drill-plan.js";
import type { DrillRecord, DrillStore } from "./drill-store.js";

export type DrillServiceError =
  | OrchestratorError
  /** 元の Hand が終わっていない（Review を作れる Hand と同じ条件）。 */
  | { readonly kind: "hand_not_finished"; readonly message: string }
  | { readonly kind: "decision_not_found"; readonly message: string }
  /** 元の判断に Pass A の Review が無い（provenance の Evidence が無い）。 */
  | { readonly kind: "review_required"; readonly message: string }
  /** Drill の Hand からは Drill を作らない、または Engine の Validation を通る変形が無い。 */
  | { readonly kind: "drill_unavailable"; readonly message: string };

export type DrillResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DrillServiceError };

/** Hero に見せる Drill の説明。値は元の Hand の公開の事実と Drill の設定だけ（他者の札・Hidden Persona を含めない）。 */
export interface DrillView {
  readonly drillId: string;
  readonly createdAt: string;
  readonly policyVersion: string;
  readonly source: {
    readonly handId: string;
    readonly decisionIndex: number;
    readonly reviewId: string;
  };
  readonly variant: DrillVariant;
  /**
   * 変形で変わった値（Stack の元 → Drill・Bet の額の元 → Drill）。opponent_tendency は Preset の表示名。
   * Spot を作り直せない（卓の設定が変わった等）ときは null。
   */
  readonly change:
    | {
        readonly kind: "effective_stack";
        readonly factor: number;
        readonly heroStackFrom: number;
        readonly heroStackTo: number;
      }
    | {
        readonly kind: "bet_size";
        readonly potFraction: number;
        readonly bettorId: string;
        readonly betFrom: number;
        readonly betTo: number;
      }
    | {
        readonly kind: "opponent_tendency";
        readonly presetLabel: string;
      }
    | null;
  /** Drill の Hand と、練習する判断の番号（Review の decisionIndex）。 */
  readonly drillHandId: string;
  readonly decisionIndex: number;
}

/** Drill の一覧の 1 行。 */
export interface DrillSummary extends DrillView {
  /** Drill の Hand が終わって保存されたか（途中で止まった Drill の Hand は保存されない）。 */
  readonly finished: boolean;
  /** 練習した判断の Pass A の最新の段階評価（まだ Review していなければ null）。 */
  readonly assessment: Assessment | null;
}

/** Drill の系列の集計（通常の Score と別。D105）。 */
export interface DrillResults {
  readonly policyVersion: string;
  readonly drills: readonly DrillSummary[];
  readonly score: {
    readonly policyVersion: string;
    readonly decisions: ScoreReport["decisions"];
    readonly overall: ScoreReport["overall"];
    readonly abilities: ScoreReport["abilities"];
  };
}

export interface DrillServiceOptions {
  readonly events: EventStore;
  /** Pass A の Review（reviews）。Pass B の Store は渡せない。 */
  readonly reviews: ScoreSource["reviews"];
  readonly drills: DrillStore;
  readonly orchestrator: {
    startDrill(
      input: DrillHandStart,
    ): Promise<OrchestratorResult<{ handId: string; view: HeroView }>>;
    /** このプロセスで進めている Hand の Hero の View（未知の Hand なら null）。 */
    heroView(handId: string): HeroView | null;
  };
  readonly heroId: string;
  readonly table: TableConfig;
  /** Drill の seed（Deck の残りの配り直し・変形の選び方・RuleBot の乱数の元）。 */
  readonly nextSeed: () => number;
  readonly nextHandId: () => string;
  readonly nextSessionId?: () => string;
  readonly policy?: DrillPolicy;
}

export class DrillService {
  private readonly policy: DrillPolicy;

  constructor(private readonly options: DrillServiceOptions) {
    this.policy = options.policy ?? DEFAULT_DRILL_POLICY;
  }

  /**
   * 元の Hand の判断から Drill を選んで始める。Drill の Hand の Hero の手番（練習する判断）の View を返す。
   * 同じ元の判断の Drill の Hand がこのプロセスでまだ終わっていなければ、新しく作らずその Drill を返す（created: false）。
   * 応答だけが失われた開始の再送で別の Drill を作らない（終わっていない Drill の Hand を放置して増やさない）。
   */
  async start(
    handId: string,
    decisionIndex: number,
  ): Promise<
    DrillResult<{
      drill: DrillView;
      handId: string;
      view: HeroView;
      created: boolean;
    }>
  > {
    const { events, drills, heroId } = this.options;
    if (drills.byDrillHandId(handId) !== null) {
      return fail("drill_unavailable", "Drill の Hand から Drill は作らない");
    }
    const log = events.read(handId).map((s) => s.event);
    if (log.length === 0) {
      return fail("hand_not_found", `Hand が無い: ${handId}`);
    }
    if (!log.some(isHandEnd)) {
      return fail("hand_not_finished", `Hand が終わっていない: ${handId}`);
    }
    const set = heroInformationSets(log, heroId)[decisionIndex];
    if (set === undefined) {
      return fail(
        "decision_not_found",
        `Hero の判断が無い: ${handId} の ${decisionIndex}`,
      );
    }
    const review = latestReview(
      this.options.reviews.list(handId, decisionIndex, "decision"),
    );
    if (review === null) {
      return fail(
        "review_required",
        "Drill は Pass A の Review がある判断から作る（先にその判断を Review する）",
      );
    }
    const ongoing = this.ongoingDrill(handId, decisionIndex);
    if (ongoing !== null) return { ok: true, value: ongoing };
    const seed = this.options.nextSeed();
    const plan = planDrill(set, seed, this.options.table, this.policy);
    if (plan === null) {
      return fail(
        "drill_unavailable",
        "この判断からは、Engine の検証を通る Drill を作れない",
      );
    }
    const drillHandId = this.options.nextHandId();
    // 行は Drill の Hand を始める前に足す（Hand が保存されるより先に、通常の集計・Resume から除く対象に入れる。D116）。
    const record = drills.add({
      sourceHandId: handId,
      sourceDecisionIndex: decisionIndex,
      sourceReviewId: review.reviewId,
      variant: plan.variant,
      policyVersion: plan.policyVersion,
      seed,
      drillHandId,
    });
    const started = await this.options.orchestrator.startDrill({
      handId: drillHandId,
      sessionId: (this.options.nextSessionId ?? randomUUID)(),
      spot: plan.spot,
      seed,
      persona: plan.persona,
    });
    if (!started.ok) return started;
    return {
      ok: true,
      value: {
        drill: this.viewOf(record),
        handId: started.value.handId,
        view: started.value.view,
        created: true,
      },
    };
  }

  /** 同じ元の判断の Drill のうち、Hand がこのプロセスで進行中のもの（最後に足したもの）。無ければ null。 */
  private ongoingDrill(
    handId: string,
    decisionIndex: number,
  ): {
    drill: DrillView;
    handId: string;
    view: HeroView;
    created: false;
  } | null {
    const records = this.options.drills
      .list()
      .filter(
        (r) =>
          r.sourceHandId === handId && r.sourceDecisionIndex === decisionIndex,
      );
    for (const record of [...records].reverse()) {
      const view = this.options.orchestrator.heroView(record.drillHandId);
      if (view !== null && view.status !== "complete") {
        return {
          drill: this.viewOf(record),
          handId: record.drillHandId,
          view,
          created: false,
        };
      }
    }
    return null;
  }

  /** Drill の一覧（足した順）と、Drill の系列の集計（通常の Score と別。D105）。 */
  results(): DrillResults {
    const { events, reviews, drills, heroId } = this.options;
    const records = drills.list();
    const summaries = records.map((record): DrillSummary => {
      const log = events.read(record.drillHandId).map((s) => s.event);
      const review = latestReview(
        reviews.list(
          record.drillHandId,
          record.sourceDecisionIndex,
          "decision",
        ),
      );
      return {
        ...this.viewOf(record),
        finished: log.some(isHandEnd),
        assessment: review?.assessment ?? null,
      };
    });
    // 終わった Drill の Hand だけを、練習した判断から数える（Script が再現した元の判断は数えない）。
    const finished = records.filter((_, i) => summaries[i]?.finished === true);
    const report = computeScoreReport(
      {
        hands: finished.map((r) =>
          events.read(r.drillHandId).map((s) => s.event),
        ),
        reviews,
        heroId,
      },
      {
        firstDecisionIndex: new Map(
          finished.map((r) => [r.drillHandId, r.sourceDecisionIndex]),
        ),
      },
    );
    return {
      policyVersion: this.policy.version,
      drills: summaries,
      score: {
        policyVersion: report.policyVersion,
        decisions: report.decisions,
        overall: report.overall,
        abilities: report.abilities,
      },
    };
  }

  /** Hero に見せる Drill の説明。変わった値は、同じ元の判断・変形・seed から Spot を作り直して出す（決定論）。 */
  private viewOf(record: DrillRecord): DrillView {
    const log = this.options.events
      .read(record.sourceHandId)
      .map((s) => s.event);
    const set = heroInformationSets(log, this.options.heroId)[
      record.sourceDecisionIndex
    ];
    const policyVersion = record.policyVersion;
    const known = policyVersion in DRILL_POLICIES;
    const plan =
      set === undefined || !known
        ? null
        : buildDrillPlan(
            set,
            record.variant,
            record.seed,
            this.options.table,
            policyVersion,
          );
    return {
      drillId: record.drillId,
      createdAt: record.createdAt,
      policyVersion,
      source: {
        handId: record.sourceHandId,
        decisionIndex: record.sourceDecisionIndex,
        reviewId: record.sourceReviewId,
      },
      variant: record.variant,
      change: changeOf(record.variant, plan?.spot.delta ?? null),
      drillHandId: record.drillHandId,
      decisionIndex: record.sourceDecisionIndex,
    };
  }
}

function changeOf(
  variant: DrillVariant,
  delta: NonNullable<ReturnType<typeof buildDrillPlan>>["spot"]["delta"] | null,
): DrillView["change"] {
  if (variant.kind === "opponent_tendency") {
    return {
      kind: "opponent_tendency",
      presetLabel: PERSONA_PRESETS[variant.presetId].label,
    };
  }
  if (delta === null || delta.kind === "unchanged") return null;
  return delta;
}

/** 同じ判断の Pass A の Review のうち、最新の Version。無ければ null。 */
function latestReview<T extends { readonly version: number }>(
  versions: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const r of versions) {
    if (latest === null || r.version > latest.version) latest = r;
  }
  return latest;
}

function fail(
  kind:
    | Exclude<DrillServiceError["kind"], OrchestratorError["kind"]>
    | "hand_not_found",
  message: string,
): { ok: false; error: DrillServiceError } {
  return { ok: false, error: { kind, message } };
}
