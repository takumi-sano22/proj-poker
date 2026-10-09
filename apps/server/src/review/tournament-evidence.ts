// Tournament の Review Evidence（D109・D130・docs/05 §10・docs/02 §7・#189）。Tournament の Hand の判断の Pass A にだけ足す。
// - 入力は判断時点の Hero Information Set（判断時点までに Hero に見えた Event と KnowledgeState）と、Session の設定の Snapshot・
//   参加人数（TournamentSessionInfo）だけ。他者の札・判断より後の Event・Learning-only Reveal は入力の経路に無い（不変条件 2・3）
// - ICM の数値の正本は Engine の ICM Calculator（icm.ts）。ここは判断時点の値を組み、表示の丸めをして Evidence にするだけで、
//   Review AI には計算させない（D109）。Chip EV の必要 Equity と ICM の必要 Equity は別の項目・別の id にする（D130）
// - Push/Fold の Range（Push/Fold Solver）は入れない（D109・D130）
// 人間判断を経ていない決め方（Stack を取る時点・Fold の比較点で Pot を取る Player・範囲外の扱い）は REVIEW_TOURNAMENT_POLICY の版の
// 暫定 Policy（OI-007。docs/02 §7・docs/05 §10）。
import {
  PAYOUT_POLICY_VERSION,
  icmCallAllIn,
  icmEquities,
  icmShove,
  payoutsByPlace,
  prizePoolOf,
  tournamentImportantSpotReasons,
  tournamentStageOf,
  type AllInIcmAnalysis,
  type AllInOutcomes,
  type HeroInformationSet,
  type IcmSpot,
  type ImportantSpotReason,
  type KnowledgeState,
  type TournamentSessionInfo,
  type TournamentStage,
} from "@proj-poker/engine";
import type { PlayerNames } from "./identifiers.js";
import type {
  TournamentAllInEvidence,
  TournamentEvidence,
  TournamentIcmEvidence,
} from "./types.js";

/**
 * Tournament の Review Evidence の組み立て方の版（OI-007 の暫定 Policy の 1 版目。人間判断を経ていない）。
 * Stack を取る時点・Fold の比較点で Pot を取る Player の決め方・範囲外の扱いを変えたら上げる。
 */
export const REVIEW_TOURNAMENT_POLICY = {
  version: "phase8_review_tournament_v1",
} as const;

/** 判断時点の Tournament の公開の事実（Evidence と Important Spot の両方が使う）。 */
interface TournamentFacts {
  readonly entrants: number;
  readonly remaining: number;
  readonly level: number | null;
  readonly handNumber: number | null;
  readonly bigBlind: number;
  readonly anteKind: TournamentEvidence["anteKind"];
  readonly ante: number;
  readonly prizePool: number;
  readonly payoutsByPlace: readonly number[];
  readonly stage: TournamentStage;
  /** ICM に使う Stack（判断時点の手元の Stack + この Hand で出した額。席順）。 */
  readonly stacks: readonly {
    readonly playerId: string;
    readonly stack: number;
  }[];
}

/**
 * 判断時点の事実。Level・Ante は public の HAND_STARTED、Stack は判断時点の KnowledgeState の席、Payout は Session の設定から作る。
 * HAND_STARTED が無い・参加人数が残人数より少ないなら RangeError（誤った Evidence を作らない）。
 */
function tournamentFactsOf(
  set: HeroInformationSet,
  session: TournamentSessionInfo,
): TournamentFacts {
  const started = set.events[0];
  if (started?.type !== "HAND_STARTED") {
    throw new RangeError("判断時点の Event の先頭が HAND_STARTED ではない");
  }
  const { knowledge } = set;
  const remaining = knowledge.seats.length;
  if (session.entrants < remaining) {
    throw new RangeError(
      `参加人数（${session.entrants}）が残人数（${remaining}）より少ない`,
    );
  }
  const prizePool = prizePoolOf(session.config.entryFee, session.entrants);
  const byPlace = payoutsByPlace(session.config.payout, prizePool);
  return {
    entrants: session.entrants,
    remaining,
    level: started.tournament?.level ?? null,
    handNumber: started.tournament?.handNumber ?? null,
    bigBlind: knowledge.bigBlind,
    anteKind: started.ante?.kind ?? "none",
    ante: started.ante?.amount ?? 0,
    prizePool,
    payoutsByPlace: byPlace,
    stage: tournamentStageOf(remaining, byPlace.length),
    // 判断時点では Pot の行方が決まっていないので、各席がこの Hand で出した額をその席に戻して数える（暫定 Policy）。
    // big_blind_ante の Ante（誰の Commit にも数えない Dead Money）は誰にも戻さない。
    stacks: knowledge.seats.map((s) => ({
      playerId: s.playerId,
      stack: s.stack + s.totalCommitted,
    })),
  };
}

/** Tournament の判断の Important Spot の理由（Bubble / Pay Jump / Short Stack）。Cash の理由（extractImportantSpots）に足して使う。 */
export function tournamentSpotReasonsOf(
  set: HeroInformationSet,
  session: TournamentSessionInfo,
): ImportantSpotReason[] {
  const facts = tournamentFactsOf(set, session);
  const hero = facts.stacks.find((s) => s.playerId === set.heroId);
  if (hero === undefined) throw new RangeError("Hero の席が無い");
  return tournamentImportantSpotReasons({
    stage: facts.stage,
    remaining: facts.remaining,
    payoutsByPlace: facts.payoutsByPlace,
    heroStackBb: hero.stack / facts.bigBlind,
  });
}

/**
 * Tournament の Evidence を作る（判断時点の ICM Equity は常に、All-in の関わる判断では Chip EV と ICM の必要 Equity も）。
 * prefix は `<handId>/d<判断の番号>`（ほかの Evidence の id と同じ）。
 */
export function buildTournamentEvidence(
  set: HeroInformationSet,
  session: TournamentSessionInfo,
  prefix: string,
  playerNames: PlayerNames = {},
): TournamentEvidence {
  const facts = tournamentFactsOf(set, session);
  return {
    id: `tournament:${prefix}`,
    tournamentPolicyVersion: REVIEW_TOURNAMENT_POLICY.version,
    payoutPolicyVersion: PAYOUT_POLICY_VERSION,
    entrants: facts.entrants,
    remaining: facts.remaining,
    level: facts.level,
    handNumber: facts.handNumber,
    anteKind: facts.anteKind,
    ante: facts.ante,
    prizePool: facts.prizePool,
    payoutsByPlace: facts.payoutsByPlace,
    stage: facts.stage,
    icm: icmEvidence(set, facts, prefix, playerNames),
    allIn: allInEvidence(set, facts, prefix, playerNames),
  };
}

/** 判断時点の全席の ICM Equity（丸めるのは Evidence に出すときだけ。docs/02 §7）。 */
function icmEvidence(
  set: HeroInformationSet,
  facts: TournamentFacts,
  prefix: string,
  playerNames: PlayerNames,
): TournamentIcmEvidence {
  const icm = icmEquities(facts.stacks, facts.payoutsByPlace);
  return {
    id: `icm:${prefix}`,
    icmPolicyVersion: icm.policyVersion,
    method: icm.method,
    stackBasis: "decision_point",
    seats: icm.players.map((p) => ({
      playerId: p.playerId,
      ...withName(playerNames, p.playerId),
      isHero: p.playerId === set.heroId,
      icmStack: p.stack,
      stackBb: round1(p.stack / facts.bigBlind),
      icmEquity: round1(p.equity),
      icmEquityPercent: round1(p.equityPercent),
    })),
  };
}

/** Hero の判断の種類（All-in の関わる判断か）。All-in の関わらない判断は null。 */
type AllInKind =
  | { readonly decision: "shove" }
  | { readonly decision: "call_all_in"; readonly villainId: string };

/**
 * All-in の関わる判断を見分ける（判断時点の KnowledgeState と Hero 自身の選択だけを見る）。
 * - Hero が All-in して、出した後の額が Fold していない相手の誰の額も超え、Call できる（Stack の残る）相手がいる: shove
 * - Hero が All-in したがほかの相手の額を超えない（足りない額の Call）・All-in した相手に直面している（Call / Fold を選ぶ判断）・
 *   Call すると Hero が All-in になる: call_all_in（相手は Fold していない相手のうち、この Hand で出した額が最も大きい Player）
 */
function allInKindOf(set: HeroInformationSet): AllInKind | null {
  const { knowledge, decision } = set;
  const hero = knowledge.seats.find((s) => s.playerId === set.heroId);
  if (hero === undefined) return null;
  const opponents = knowledge.seats.filter(
    (s) => s.playerId !== set.heroId && !s.folded,
  );
  const top = maxBy(opponents, (s) => s.totalCommitted);
  if (top === undefined) return null;
  const heroTotal = hero.totalCommitted + hero.stack;
  if (decision.allIn) {
    // 相手の誰の額も超え、Call できる（Stack の残る）相手がいれば Shove。そうでなければ All-in での Call。
    return heroTotal > top.totalCommitted && opponents.some((s) => s.stack > 0)
      ? { decision: "shove" }
      : { decision: "call_all_in", villainId: top.playerId };
  }
  const { callAmount } = knowledge.math;
  if (callAmount === 0) return null;
  const facingAllIn = opponents.some((s) => s.allIn);
  if (facingAllIn || callAmount >= hero.stack) {
    return { decision: "call_all_in", villainId: top.playerId };
  }
  return null;
}

/** All-in の関わる判断の Chip EV / ICM の必要 Equity。All-in の関わらない判断は null。 */
function allInEvidence(
  set: HeroInformationSet,
  facts: TournamentFacts,
  prefix: string,
  playerNames: PlayerNames,
): TournamentAllInEvidence | null {
  const kind = allInKindOf(set);
  if (kind === null) return null;
  const { knowledge } = set;
  const committed = knowledge.seats.reduce(
    (sum, s) => sum + s.totalCommitted,
    0,
  );
  const spot: IcmSpot = {
    seats: knowledge.seats.map((s) => ({
      playerId: s.playerId,
      stack: s.stack,
      committed: s.totalCommitted,
      folded: s.folded,
    })),
    // Pot のうち誰の Commit にも数えない額（big_blind_ante の Ante。D128）。
    deadMoney: knowledge.pot - committed,
    payouts: facts.payoutsByPlace,
    heroId: set.heroId,
  };
  let analysis: AllInIcmAnalysis;
  try {
    analysis =
      kind.decision === "shove"
        ? icmShove(spot, potWinnerIfHeroFolds(knowledge, set.heroId))
        : icmCallAllIn(spot, kind.villainId);
  } catch (error) {
    // ICM Calculator が拒否する Spot（Multiway の All-in・すでに All-in した相手がいる Shove 等）は範囲外として残す（正常系）。
    if (!(error instanceof RangeError)) throw error;
    return {
      status: "out_of_scope",
      decision: kind.decision,
      reason: OUT_OF_SCOPE_REASON,
    };
  }
  const potWinner = analysis.assumptions.potWinnerIfHeroFolds;
  return {
    status: "available",
    decision: analysis.decision,
    assumptions: {
      othersFold: true,
      foldEquityIncluded: false,
      callFrequencyIncluded: false,
      potWinnerIfHeroFolds: potWinner,
      notes: assumptionNotes(
        analysis.decision,
        playerNames[potWinner] ?? potWinner,
      ),
    },
    requirements: analysis.requirements.map((r) => ({
      villainId: r.villainId,
      ...withName(playerNames, r.villainId),
      chipEv: {
        id: `chipev:${prefix}/${r.villainId}`,
        requiredEquityPercent: percent1(r.chipEvRequiredEquity),
        heroStack: r.heroStack,
      },
      icm: {
        id: `icmreq:${prefix}/${r.villainId}`,
        requiredEquityPercent:
          r.icmRequiredEquity === null ? null : percent1(r.icmRequiredEquity),
        heroIcmEquity: roundOutcomes(r.heroIcmEquity),
      },
    })),
  };
}

const OUT_OF_SCOPE_REASON =
  "ICM の必要 Equity を計算できる範囲の外（Hero と 1 人の相手だけで争う All-in ではない。Multiway の All-in・すでに All-in した相手がいる Shove 等）。Chip EV だけで評価しない";

/**
 * Hero が Fold した比較点で今の Pot を取る Player（Shove の比較点。暫定 Policy）。Fold していない相手のうち、この Hand で出した額が
 * 最も大きい Player。同じ額が複数なら、その中で最後に Bet / Raise（額を引き上げる All-in を含む）した Player、それも無ければ席順で先の Player。
 */
function potWinnerIfHeroFolds(
  knowledge: KnowledgeState,
  heroId: string,
): string {
  const opponents = knowledge.seats.filter(
    (s) => s.playerId !== heroId && !s.folded,
  );
  const top = Math.max(...opponents.map((s) => s.totalCommitted));
  const tied = opponents.filter((s) => s.totalCommitted === top);
  const tiedIds = new Set(tied.map((s) => s.playerId));
  const lastAggressor = [...knowledge.actionHistory]
    .reverse()
    .find(
      (a) =>
        tiedIds.has(a.playerId) &&
        (a.action === "bet" || a.action === "raise" || a.action === "all_in"),
    );
  return lastAggressor?.playerId ?? (tied[0]?.playerId as string);
}

/** 前提の文（Review AI と画面にそのまま出す。D130）。 */
function assumptionNotes(
  decision: "call_all_in" | "shove",
  potWinnerName: string,
): string[] {
  const common = [
    "ICM Equity は、判断時点の各席の手元の Stack にこの Hand で出した額を戻した Stack（Pot の行方は決めない）から、決定論の ICM Calculator（Malmuth-Harville）で計算した値。",
    "Chip EV の必要 Equity と ICM の必要 Equity は別の量。どちらも Fold・Call されて勝つ・負けるの 3 つの結果の Hero の値から出した損益分岐の勝率。",
  ];
  return decision === "call_all_in"
    ? [
        ...common,
        "All-in への Call: 相手の額は決まっている。Call したら Hero とこの相手だけで争い、ほかのまだ Fold していない Player は Fold する前提。Hero が Fold したら、この相手が今の Pot を取る。",
      ]
    : [
        ...common,
        "Shove: 相手ごとに「その 1 人に Call され、ほかは Fold した場合」の条件付きの値。相手が Fold する確率（Fold Equity）と Call の頻度は含めない。",
        `Hero が Fold した比較点では ${potWinnerName} が今の Pot を取る前提（この Hand で出した額が最も大きい相手）。`,
      ];
}

function withName(
  playerNames: PlayerNames,
  playerId: string,
): { displayName?: string } {
  const name = playerNames[playerId];
  return name === undefined ? {} : { displayName: name };
}

function maxBy<T>(
  items: readonly T[],
  key: (item: T) => number,
): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (best === undefined || key(item) > key(best)) best = item;
  }
  return best;
}

/** 小数第 1 位に四捨五入（pt・%・BB の表示の丸め。docs/02 §7）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 0〜1 の勝率を %（小数第 1 位）にする。 */
function percent1(value: number): number {
  return Math.round(value * 1000) / 10;
}

function roundOutcomes(outcomes: AllInOutcomes): AllInOutcomes {
  return {
    fold: round1(outcomes.fold),
    win: round1(outcomes.win),
    lose: round1(outcomes.lose),
  };
}

/** Tournament の Evidence の id（無ければ空）。 */
export function tournamentIdsOf(
  tournament: TournamentEvidence | undefined,
): string[] {
  if (tournament === undefined) return [];
  const requirements =
    tournament.allIn?.status === "available"
      ? tournament.allIn.requirements.flatMap((r) => [r.chipEv.id, r.icm.id])
      : [];
  return [tournament.id, tournament.icm.id, ...requirements];
}
