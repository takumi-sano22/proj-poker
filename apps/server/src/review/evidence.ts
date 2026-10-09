// Review Evidence の組み立て（docs/05 §6・docs/03 §7）。入力は判断時点の Hero Information Set（#78）だけ。
// Event Log・判断より後の Event・他者の Hidden Cards・Learning-only Reveal・system の記録・CPU の Persona は受け取らないので、
// Evidence に入る経路が無い（不変条件 2・3。Hindsight Leak の防止）。Card は Card の形のまま持ち、Prompt を作るときに表記へ直す。
// Table Tendency（D122・#153）だけは前の Hand から作る値で、呼び出し側（ReviewService）が判断の Hand より前に保存した Hand に絞って作り、
// 出来上がった値を受け取る（ここでは Event Store を読まない）。
// Tournament の Hand（#189）では、呼び出し側が Session の設定の Snapshot と参加人数を渡し、判断時点の ICM の Evidence を足す
// （tournament-evidence.ts。Cash の Evidence は項目ごと持たない）。
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
  type TournamentSessionInfo,
} from "@proj-poker/engine";
import { searchKb, type LoadedKb } from "../kb/index.js";
import type { KbSpot, KbSpotKind } from "../kb/types.js";
import type { TableTendency } from "../memory/table-tendency.js";
import type { SolverAdapter } from "../solver/types.js";
import type { PlayerNames } from "./identifiers.js";
import { buildSolverEvidence } from "./solver-evidence.js";
import {
  buildTournamentEvidence,
  importantSpotsOf,
  tournamentIdsOf,
} from "./tournament-evidence.js";
import type {
  DecisionContextEvidence,
  EvidenceIdSet,
  KnowledgeEvidence,
  MathEvidence,
  OpponentObservationEvidence,
  RangeEvidence,
  ReviewEvidence,
  UserReadEvidence,
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
  /**
   * Hero から見た Table Tendency（D122・#153）。判断の Hand より前に保存した、今の Session の Hand の public の Event だけから
   * 作った値（buildHeroTableTendencyFromStore に beforeOrd を渡した結果）を渡す。省略（Review Eval・テスト）なら入れない。
   */
  readonly tableTendency?: TableTendency;
  /**
   * Tournament の Hand の Session の情報（設定の Snapshot・参加人数。#189）。渡したときだけ Tournament の Evidence を足し、
   * Solver の Capability Gate へ mode: tournament で渡す。Cash の Hand は省略（Evidence・Prompt は #189 より前と同じ）。
   */
  readonly tournament?: TournamentSessionInfo;
}

/**
 * Review の対象の判断の Important Spot の理由（判断時点の情報だけで選ぶ）。Cash と共通の理由（extractImportantSpots）に、
 * Tournament の Hand では Bubble / Pay Jump / Short Stack（tournamentImportantSpotReasons）を足す。
 * 本番（ReviewService の Pass A・Pass B）と Review Eval のハーネスが同じこの関数を通る（LC-050）。
 */
export function reviewSpotReasons(
  sets: readonly HeroInformationSet[],
  decisionIndex: number,
  tournament?: TournamentSessionInfo,
): ImportantSpotReason[] {
  // Replay・Session Review と同じ関数（importantSpotsOf）で選ぶ（画面ごとに理由が食い違わない。#190）。
  return [
    ...(importantSpotsOf(sets, tournament).find(
      (s) => s.decisionIndex === decisionIndex,
    )?.reasons ?? []),
  ];
}

/** Knowledge Evidence に入れる KB の項目数（暫定値）。Prompt の長さと根拠の幅の釣り合いで決める。 */
export const REVIEW_KB_LIMIT = 4;

/** 相手の Observation の記録が無い（十分な Table Tendency が無い）ときの理由。#153 より前と同じ文で、Prompt を変えない。 */
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
    // Tournament の Spot は Capability Gate に mode: tournament で渡す（Cash だけを解く Solver は Unsupported の正常な Fallback。#189）。
    mode: deps.tournament === undefined ? "cash" : "tournament",
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
    opponentObservation: opponentObservationEvidence(
      deps.tableTendency,
      prefix,
    ),
    solver,
    knowledge: knowledgeEvidence(set.knowledge, deps.kb),
    userRead: userReadEvidence(set, deps.playerNames),
    // Tournament の Hand だけ（Cash の Evidence は項目ごと持たない。Prompt と録画の指紋を変えない）。
    ...(deps.tournament === undefined
      ? {}
      : {
          tournament: buildTournamentEvidence(
            set,
            deps.tournament,
            prefix,
            deps.playerNames,
          ),
        }),
  };
}

/**
 * Opponent Observation（D122）。Table Tendency の十分な項目が 1 つ以上あるときだけ available にし、項目ごとに id と割合を付ける
 * （割合は決定論で計算し、Review AI に計算させない）。不十分な項目も sufficient: false のまま残す（保留として読ませる）。
 * 十分な項目が無ければ unavailable のまま（#153 より前と同じ Evidence・Prompt）。
 */
function opponentObservationEvidence(
  tendency: TableTendency | undefined,
  prefix: string,
): OpponentObservationEvidence {
  if (tendency === undefined || !tendency.items.some((i) => i.sufficient)) {
    return { status: "unavailable", reason: NO_OBSERVATION_REASON };
  }
  return {
    status: "available",
    tableTendency: {
      policyVersion: tendency.policyVersion,
      hands: tendency.hands,
      items: tendency.items.map((i) => ({
        id: `tendency:${prefix}/${i.item}`,
        item: i.item,
        rate:
          i.denominator === 0
            ? null
            : Math.round((i.numerator / i.denominator) * 1000) / 1000,
        numerator: i.numerator,
        denominator: i.denominator,
        hands: i.hands,
        sufficient: i.sufficient,
      })),
    },
  };
}

/** Table Tendency の項目の id（無ければ空）。 */
export function tableTendencyIdsOf(evidence: ReviewEvidence): string[] {
  return evidence.opponentObservation.status === "available"
    ? evidence.opponentObservation.tableTendency.items.map((i) => i.id)
    : [];
}

/**
 * User Read / Intent（D112）。判断の前に Hero が記録した読み（Information Set の userReads。判断より後の読みは入っていない）を写す。
 * 読みが無ければ not_collected（読みの無い判断の Evidence・Prompt は従来と同じ）。
 */
function userReadEvidence(
  set: HeroInformationSet,
  playerNames: PlayerNames = {},
): UserReadEvidence {
  if (set.userReads.length === 0) return { status: "not_collected" };
  return {
    status: "collected",
    items: set.userReads.map((read) => {
      const target = read.targetPlayerId;
      const name = target === null ? undefined : playerNames[target];
      return {
        id: `read:${set.handId}/${read.seq}`,
        street: read.street,
        ...(target === null ? {} : { playerId: target }),
        ...(name === undefined ? {} : { displayName: name }),
        text: read.text,
      };
    }),
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
    userRead:
      evidence.userRead.status === "collected"
        ? evidence.userRead.items.map((i) => i.id)
        : [],
    // 卓の傾向（D122）があるときだけ持つ（無い Review の記録は #153 より前と同じ形）。
    ...(evidence.opponentObservation.status === "available"
      ? { tableTendency: tableTendencyIdsOf(evidence) }
      : {}),
    // Tournament の Evidence（#189）があるときだけ持つ（Cash の Review の記録は #189 より前と同じ形）。
    ...(evidence.tournament === undefined
      ? {}
      : { tournament: tournamentIdsOf(evidence.tournament) }),
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
    ...ids.userRead,
    ...(ids.tableTendency ?? []),
    ...(ids.tournament ?? []),
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
