// Review Evidence の組み立て（docs/05 §6・docs/03 §7）。入力は判断時点の Hero Information Set（#78）だけ。
// Event Log・判断より後の Event・他者の Hidden Cards・Learning-only Reveal・system の記録・CPU の Persona は受け取らないので、
// Evidence に入る経路が無い（不変条件 2・3。Hindsight Leak の防止）。Card は Card の形のまま持ち、Prompt を作るときに表記へ直す。
import {
  analyzeDecision,
  classifyPreflop,
  compareRangeProfiles,
  positionName,
  type DecisionAnalysis,
  type HeroInformationSet,
  type ImportantSpotReason,
  type KnowledgeState,
  type PreflopSpot,
  type RangeAssumption,
} from "@proj-poker/engine";
import { searchKb, type LoadedKb } from "../kb/index.js";
import type { KbSpot, KbSpotKind } from "../kb/types.js";
import type { SolverAdapter } from "../solver/types.js";
import type { PlayerNames } from "./identifiers.js";
import { buildSolverEvidence } from "./solver-evidence.js";
import type {
  DecisionContextEvidence,
  EvidenceIdSet,
  KnowledgeEvidence,
  MathEvidence,
  RangeEvidence,
  ReviewEvidence,
} from "./types.js";

export interface EvidenceDeps {
  /** playerId → 表示名（Hero の画面に出ている名前。#96）。Evidence の席に添える。 */
  readonly playerNames?: PlayerNames;
  readonly kb: LoadedKb;
  readonly solver: SolverAdapter;
  /** Review の生成を止める（アプリ終了）。Solver の子プロセスも止める。 */
  readonly signal?: AbortSignal;
  /** Solver の失敗の本文をログに残す。 */
  readonly onSolverFailure?: (error: unknown) => void;
}

/** Knowledge Evidence に入れる KB の項目数（暫定値）。Prompt の長さと根拠の幅の釣り合いで決める。 */
export const REVIEW_KB_LIMIT = 4;

/** 相手の Observation の記録はまだ無い（CPU Memory・Hero の観察の蓄積は後の Phase）。 */
const NO_OBSERVATION_REASON =
  "相手の過去の傾向（Observation）の記録はまだ無い。この Hand の公開された Action 以外に、相手の読みの根拠は無い。";

/**
 * 判断時点の Information Set から Review Evidence を作る。importantSpotReasons は extractImportantSpots（判断時点の情報だけで選ぶ）の結果。
 * Math・Range は Engine の決定論の関数、Solver は Capability Gate を通ったときだけ、KB は判断時点の Spot の特徴で検索する。
 */
export async function buildReviewEvidence(
  set: HeroInformationSet,
  importantSpotReasons: readonly ImportantSpotReason[],
  deps: EvidenceDeps,
): Promise<ReviewEvidence> {
  const prefix = `${set.handId}/d${set.decision.index}`;
  const context = decisionContext(
    set,
    importantSpotReasons,
    prefix,
    deps.playerNames,
  );
  const analysis = analyzeDecision(set);
  const math = mathEvidence(analysis, prefix);
  // Equity の計算は同期で数百 ms かかりうる。Hand の進行（SSE 等）を止め続けないよう、区切りごとに Event Loop へ戻す。
  await yieldToEventLoop();
  const range = rangeEvidence(
    set,
    analysis.ranges,
    importantSpotReasons.length > 0,
    prefix,
  );
  await yieldToEventLoop();
  const solver = await buildSolverEvidence(set, deps.solver, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.onSolverFailure === undefined
      ? {}
      : { onFailure: deps.onSolverFailure }),
  });
  return {
    pass: "decision",
    handId: set.handId,
    decisionIndex: set.decision.index,
    context,
    math,
    range,
    opponentObservation: {
      status: "unavailable",
      reason: NO_OBSERVATION_REASON,
    },
    solver,
    knowledge: knowledgeEvidence(set.knowledge, deps.kb),
    userRead: { status: "not_collected" },
  };
}

/** Evidence が持つ ID の一覧（Review Record の Evidence IDs。docs/04 §8）。cited は Review AI が根拠に挙げた ID。 */
export function evidenceIdsOf(
  evidence: ReviewEvidence,
  cited: readonly string[] = [],
): EvidenceIdSet {
  return {
    context: [evidence.context.id],
    math: [evidence.math.id],
    range: [
      evidence.range.id,
      ...(evidence.range.comparisons ?? []).map((c) => c.id),
    ],
    solver: evidence.solver.status === "supported" ? [evidence.solver.id] : [],
    knowledge: evidence.knowledge.items.map((i) => i.id),
    userRead: [],
    cited,
  };
}

/** Evidence が持つ全 ID（Review AI が挙げてよい ID）。 */
export function allEvidenceIds(evidence: ReviewEvidence): Set<string> {
  const ids = evidenceIdsOf(evidence);
  return new Set([
    ...ids.context,
    ...ids.math,
    ...ids.range,
    ...ids.solver,
    ...ids.knowledge,
  ]);
}

/** 判断時点の卓（Decision Context）。Pass B（reveal-evidence.ts）も同じ形で使う。 */
export function decisionContext(
  set: HeroInformationSet,
  importantSpotReasons: readonly ImportantSpotReason[],
  prefix: string,
  playerNames: PlayerNames = {},
): DecisionContextEvidence {
  const { knowledge, decision } = set;
  const positionOf = (playerId: string) => {
    const seatIndex = knowledge.seats.findIndex((s) => s.playerId === playerId);
    const buttonIndex = knowledge.seats.findIndex((s) => s.isButton);
    const n = knowledge.seats.length;
    return positionName((seatIndex - buttonIndex + n) % n, n);
  };
  // whitelist で写す（KnowledgeState をそのまま渡さない。席の holeCards は Hero の札だけで、heroHoleCards に 1 回だけ入れる）。
  return {
    id: `ctx:${prefix}`,
    street: knowledge.street,
    smallBlind: knowledge.smallBlind,
    bigBlind: knowledge.bigBlind,
    heroId: knowledge.viewerId,
    heroPosition: positionOf(knowledge.viewerId),
    playerCount: knowledge.seats.length,
    activePlayerCount: knowledge.seats.filter((s) => !s.folded).length,
    heroHoleCards: knowledge.holeCards ?? [],
    board: knowledge.board,
    pot: knowledge.pot,
    currentBet: knowledge.currentBet,
    seats: knowledge.seats.map((s) => ({
      playerId: s.playerId,
      // 表示名は Hero の画面に出ている名前だけ（Persona など画面に出ない設定は入れない。不変条件 2）。
      ...(playerNames[s.playerId] === undefined
        ? {}
        : { displayName: playerNames[s.playerId] }),
      position: positionOf(s.playerId),
      isHero: s.playerId === knowledge.viewerId,
      stack: s.stack,
      streetCommitted: s.streetCommitted,
      totalCommitted: s.totalCommitted,
      folded: s.folded,
      allIn: s.allIn,
    })),
    actionHistory: knowledge.actionHistory,
    ...(knowledge.rulingHistory === undefined
      ? {}
      : { rulingHistory: knowledge.rulingHistory }),
    legalActions: knowledge.legalActions?.actions ?? [],
    decision: {
      action: decision.action,
      amount: decision.amount,
      toAmount: decision.toAmount,
      allIn: decision.allIn,
    },
    rulingNotes: decision.rulingNotes,
    importantSpotReasons,
  };
}

function mathEvidence(
  analysis: DecisionAnalysis,
  prefix: string,
): MathEvidence {
  return {
    id: `math:${prefix}`,
    pot: analysis.pot,
    callAmount: analysis.callAmount,
    potOdds: analysis.potOdds,
    effectiveStack: analysis.effectiveStack,
    spr: analysis.spr,
    // Monte Carlo の seed は Review の根拠ではないので入れない（Deck の seed と取り違えさせない）。
    equity:
      analysis.equity === null
        ? null
        : {
            equity: analysis.equity.equity,
            win: analysis.equity.win,
            tie: analysis.equity.tie,
            method: analysis.equity.method,
            trials: analysis.equity.trials,
          },
    alternatives: analysis.alternatives,
    evBasis: analysis.evBasis,
    assumptions: analysis.assumptions,
  };
}

function rangeEvidence(
  set: HeroInformationSet,
  villains: readonly RangeAssumption[],
  important: boolean,
  prefix: string,
): RangeEvidence {
  // 相手ごとの Range の Assumption は analyzeDecision と同じ標準の想定。比較（D08）は Important Spot だけ（計算が重いため）。
  const comparisons = important
    ? compareRangeProfiles(set).map((c) => ({
        id: `range:${prefix}/${c.profileId}`,
        profileId: c.profileId,
        label: c.label,
        equity: c.equity?.equity ?? null,
        ranges: c.ranges,
      }))
    : null;
  return { id: `range:${prefix}`, villains, comparisons };
}

function knowledgeEvidence(
  knowledge: KnowledgeState,
  kb: LoadedKb,
): KnowledgeEvidence {
  const result = searchKb(kb, {
    spot: kbSpotOf(knowledge),
    limit: REVIEW_KB_LIMIT,
  });
  return {
    kbVersion: result.kbVersion,
    items: result.hits.map((hit) => ({
      id: hit.evidenceId,
      kbId: hit.id,
      title: hit.title,
      topic: hit.topic,
      label: hit.label,
      matched: hit.matched,
      body: hit.body,
    })),
  };
}

/**
 * KB の検索に使う Spot の特徴（判断時点の情報だけ。docs/03 §9）。
 * Spot の種類は、Preflop は Raise に直面しているか、Postflop は Bet に直面しているか・Hero が Preflop の最後の Raiser か で決める。
 */
export function kbSpotOf(knowledge: KnowledgeState): KbSpot {
  const heroIndex = knowledge.seats.findIndex(
    (s) => s.playerId === knowledge.viewerId,
  );
  const buttonIndex = knowledge.seats.findIndex((s) => s.isButton);
  const n = knowledge.seats.length;
  const opponents = knowledge.seats.filter(
    (s) => s.playerId !== knowledge.viewerId && !s.folded,
  );
  const actions: PreflopSpot[] = opponents.map((s) =>
    classifyPreflop(knowledge.actionHistory, s.playerId, knowledge.bigBlind),
  );
  return {
    street: knowledge.street,
    position: positionName((heroIndex - buttonIndex + n) % n, n),
    players: opponents.length > 1 ? "multiway" : "heads_up",
    spotKind: spotKindOf(knowledge),
    actions: [...new Set(actions)],
  };
}

function spotKindOf(knowledge: KnowledgeState): KbSpotKind {
  const facing = knowledge.math.callAmount > 0;
  // Preflop の Raise（その時点の最高額を超える Bet / Raise / All-in）を数え、最後の Raiser を覚える（classifyPreflop と同じ数え方）。
  let currentBet = knowledge.bigBlind;
  let lastRaiser: string | null = null;
  for (const a of knowledge.actionHistory) {
    if (a.street !== "preflop") continue;
    const aggressive =
      a.action === "bet" ||
      a.action === "raise" ||
      (a.action === "all_in" && a.toAmount > currentBet);
    if (!aggressive) continue;
    currentBet = a.toAmount;
    lastRaiser = a.playerId;
  }
  if (knowledge.street === "preflop") {
    return facing && lastRaiser !== null
      ? "preflop_facing_raise"
      : "preflop_open";
  }
  if (facing) return "postflop_facing_bet";
  return lastRaiser === knowledge.viewerId
    ? "postflop_aggressor"
    : "postflop_checked_to";
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
