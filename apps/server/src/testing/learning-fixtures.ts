// Learning（Hypothesis / Player Profile。#114）のテスト補助。Scripted Hand を handId を変えて繰り返し、
// その判断の Pass A の Review（判断時点の Evidence は本物の buildReviewEvidence で作る）を Assessment だけ変えて作る。
// Claude と Solver は呼ばない（Solver は未導入の Adapter）。
import { heroInformationSets, type HandEvent } from "@proj-poker/engine";
import { loadKb } from "../kb/index.js";
import { buildReviewEvidence, evidenceIdsOf } from "../review/evidence.js";
import type {
  Assessment,
  Confidence,
  ReviewDraft,
  ReviewEvidence,
} from "../review/types.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
  type ScriptedHand,
} from "./review-eval/hands.js";

export const LEARNING_HERO = "hero";

/**
 * 使う Scripted Hand と、その中の Hero の判断（番号）。
 * - BTN_VS_UTG: d0 Preflop で Open に Call / d1 Flop で Bet に Call
 * - SB_VS_BTN: d2 Turn で最初に Bet
 * - MULTIWAY_FLOP: d3 River で Check
 */
export const LEARNING_HANDS = {
  btn: BTN_VS_UTG,
  sb: SB_VS_BTN,
  multi: MULTIWAY_FLOP,
} as const;

export interface PlayedHand {
  readonly handId: string;
  readonly events: HandEvent[];
  readonly evidence: readonly ReviewEvidence[];
}

export interface LearningFixtures {
  /** Scripted Hand を、handId を変えて（round 回目として）最後まで進める。 */
  play(hand: ScriptedHand, round?: number): PlayedHand;
  /** その判断の Pass A の Review（Assessment と Confidence だけ変える）。 */
  review(
    hand: PlayedHand,
    decisionIndex: number,
    assessment: Assessment,
    confidence?: Confidence,
  ): ReviewDraft;
}

/** 判断時点の Evidence を Scripted Hand ごとに 1 回だけ作り、同じ Hand を別の handId で繰り返すときは使い回す。 */
export async function loadLearningFixtures(): Promise<LearningFixtures> {
  const deps = {
    kb: loadKb(),
    solver: createAmaster97Adapter({
      install: { installed: false, detail: "テスト" },
      timeoutMs: 1,
      maxConcurrency: 1,
      iterations: 1,
    }),
  };
  const evidenceByHand = new Map<string, ReviewEvidence[]>();
  for (const hand of Object.values(LEARNING_HANDS)) {
    const sets = heroInformationSets(playScriptedHand(hand), LEARNING_HERO);
    evidenceByHand.set(
      hand.id,
      await Promise.all(sets.map((s) => buildReviewEvidence(s, [], deps))),
    );
  }

  return {
    play(hand, round = 0) {
      const events = playScriptedHand({ ...hand, id: `${hand.id}_${round}` });
      const started = events[0];
      if (started?.type !== "HAND_STARTED") {
        throw new Error("HAND_STARTED が無い");
      }
      return {
        handId: started.handId,
        events,
        evidence: evidenceByHand.get(hand.id) ?? [],
      };
    },
    review(hand, decisionIndex, assessment, confidence = "high") {
      const base = hand.evidence[decisionIndex];
      if (base === undefined) throw new Error(`判断 ${decisionIndex} が無い`);
      const evidence: ReviewEvidence = { ...base, handId: hand.handId };
      return {
        handId: hand.handId,
        decisionIndex,
        actionSeq: 0,
        pass: "decision",
        depth: "standard",
        modelRole: "review_standard",
        concreteModel: "test-model",
        kbVersion: evidence.knowledge.kbVersion,
        solverVersion: null,
        generatedBy: "review_ai",
        assessment,
        confidence,
        assumptions: [],
        evidenceIds: evidenceIdsOf(evidence, [evidence.math.id]),
        explanation: {
          practical: "",
          theory: { basis: "none", text: "" },
          exploit: { basis: "none", text: "" },
          conclusionChangers: [],
        },
        evidence,
        failure: null,
      };
    },
  };
}
