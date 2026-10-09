// CPU の KnowledgeState に足す Public Tournament Context（D109・D130・docs/02 §7・#188）。
// 卓の全員が知る公開の情報（残人数・Level・Blind / Ante・全席の Stack・Payout）と、そこから決定論の ICM Calculator（icm.ts。#187）で
// 計算した値（全席の ICM Equity・Stage・自分から見た相手ごとの Bubble Factor）だけを積む（whitelist）。
// - 入力は、その Player に見える Event（HAND_STARTED は public）と、Session の開始の Event（SESSION_STARTED）に残した設定の Snapshot・
//   参加人数だけ。Hidden Cards・Deck・他 CPU の Memory / Persona / Tilt・Learning-only Reveal は型の上でも受け取らない（D28・D109）
// - ICM の数値の正本はこのコード（LLM に計算させない。D109）。値は倍精度のまま持ち、丸めるのは表示・Prompt に出すときだけ（docs/02 §7）
// - Push/Fold Solver（Shove / Call の Range）は入れない（D109・D130。Phase 8 の初期 Scope 外）
import type { HandEvent } from "./hand-events.js";
import {
  ICM_POLICY,
  bubbleFactors,
  icmEquities,
  type BubbleFactor,
  type IcmPolicy,
} from "./icm.js";
import {
  PAYOUT_POLICY_VERSION,
  payoutsByPlace,
  prizePoolOf,
} from "./tournament-payout.js";
import type { AnteKind, TournamentConfig } from "./tournament.js";

/**
 * Public Tournament Context の組み立て方の版（OI-007 の暫定 Policy の 1 版目。人間判断を経ていない。docs/02 §7）。
 * Stack を取る時点（Hand の開始時）・Stage の決め方を変えたら上げる。
 */
export const TOURNAMENT_KNOWLEDGE_VERSION = "phase8_tournament_knowledge_v1";

/**
 * Tournament の段階（D130）。残人数と入賞の数（Payout の順位の数）から決める（OI-007 の暫定 Policy）。
 * - heads_up: 残り 2 人
 * - in_the_money: 残人数が入賞の数以下（残っている全員が入賞する）
 * - bubble: 残人数が入賞の数 + 1（次に Bust した 1 人だけが入賞しない）
 * - before_bubble: それより前（D130 の 3 つの段階のどれにも当たらない段階。この版で足した名前）
 * 上ほど優先する（Heads-Up は入賞の数に依らず heads_up）。
 */
export type TournamentStage =
  "before_bubble" | "bubble" | "in_the_money" | "heads_up";

/** Public Tournament Context を作るための Session の情報（Session の最初の Hand の SESSION_STARTED と HAND_STARTED から読む）。 */
export interface TournamentSessionInfo {
  /** Session の開始の Event に残した設定の Snapshot（D129）。 */
  readonly config: TournamentConfig;
  /** 参加人数（Session の最初の Hand に座った人数。Prize Pool = 参加費 × 参加人数。D127）。 */
  readonly entrants: number;
}

/** 1 席の公開の Stack と ICM Equity。 */
export interface TournamentSeatKnowledge {
  readonly playerId: string;
  /** Hand の開始時の Stack（Chip。HAND_STARTED の seats の stack。Blind・Ante を払う前）。 */
  readonly stack: number;
  /** stack ÷ この Hand の Big Blind（倍精度・丸めない）。 */
  readonly stackBb: number;
  /** ICM Equity（pt。倍精度・丸めない）。 */
  readonly icmEquity: number;
  /** 争う賞金の合計に対する ICM Equity の割合（%。倍精度・丸めない）。 */
  readonly icmEquityPercent: number;
}

/** CPU の KnowledgeState の tournament（Tournament の Hand だけが持つ。D130）。 */
export interface TournamentKnowledge {
  /** 組み立て方の版（TOURNAMENT_KNOWLEDGE_VERSION）。 */
  readonly version: string;
  /** ICM の Policy の版（icm.ts の ICM_POLICY.version）。 */
  readonly icmPolicyVersion: string;
  /** Payout の端数の配り方の版（tournament-payout.ts の PAYOUT_POLICY_VERSION）。 */
  readonly payoutPolicyVersion: string;
  /** Stack を取った時点。この版では Hand の開始時（Hand の途中の Stack・Pot は KnowledgeState の seats・pot にある）。 */
  readonly stackBasis: "hand_start";
  /** 参加人数。 */
  readonly entrants: number;
  /** 残人数（この Hand に座っている人数。Bust した Player は座らない）。 */
  readonly remaining: number;
  /** この Hand の Level（1 始まり）。 */
  readonly level: number;
  /** Session の何 Hand 目か（1 始まり）。 */
  readonly handNumber: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** この Hand の Ante の種類（Ante の無い Hand は none）。 */
  readonly anteKind: AnteKind;
  /** この Hand の Ante の 1 回分の額（big_blind_ante は BB の席が払う額、per_player は 1 人分。無ければ 0）。 */
  readonly ante: number;
  /** Prize Pool（pt）= 参加費 × 参加人数。 */
  readonly prizePool: number;
  /** 順位ごとの賞金（pt。1 位から入賞の数だけ）。 */
  readonly payoutsByPlace: readonly number[];
  readonly stage: TournamentStage;
  /** 全席（この Hand の席順）の Stack・BB 換算・ICM Equity。 */
  readonly seats: readonly TournamentSeatKnowledge[];
  /** 自分から見た相手ごとの Bubble Factor（席順。自分を除く）。 */
  readonly bubbleFactors: readonly BubbleFactor[];
}

/** 残人数と入賞の数から Tournament の段階を決める（OI-007 の暫定 Policy）。 */
export function tournamentStageOf(
  remaining: number,
  paidPlaces: number,
): TournamentStage {
  if (remaining <= 2) return "heads_up";
  if (remaining <= paidPlaces) return "in_the_money";
  if (remaining === paidPlaces + 1) return "bubble";
  return "before_bubble";
}

/**
 * Tournament の Hand で、viewer から見た Public Tournament Context を作る（純粋関数。同じ入力なら同じ結果）。
 * 入力の events は viewer に見える Event（visibleEvents の結果）で、読むのは public の HAND_STARTED だけ
 * （席順・Hand の開始時の Stack・Blind / Ante・Level と経過）。Payout は Session の設定の Snapshot と参加人数から作る。
 *
 * HAND_STARTED が無い・Level と経過（tournament）を持たない（Tournament の Hand でない）・viewer が座っていない・参加人数が残人数より
 * 少ないなら RangeError を投げる（誤った Context を CPU に渡さない）。
 */
export function tournamentKnowledgeOf(
  events: readonly HandEvent[],
  viewerId: string,
  session: TournamentSessionInfo,
  policy: IcmPolicy = ICM_POLICY,
): TournamentKnowledge {
  const started = events.find((e) => e.type === "HAND_STARTED");
  if (started?.type !== "HAND_STARTED") {
    throw new RangeError("HAND_STARTED の無い Hand の Tournament Context");
  }
  if (started.tournament === undefined) {
    throw new RangeError(
      `Level と経過の無い Hand は Tournament の Hand として読まない: ${started.handId}`,
    );
  }
  if (!started.seats.some((s) => s.playerId === viewerId)) {
    throw new RangeError(
      `卓にいない Player の Tournament Context: ${viewerId}`,
    );
  }
  const remaining = started.seats.length;
  if (session.entrants < remaining) {
    throw new RangeError(
      `参加人数（${session.entrants}）が残人数（${remaining}）より少ない`,
    );
  }
  const { config } = session;
  const prizePool = prizePoolOf(config.entryFee, session.entrants);
  const byPlace = payoutsByPlace(config.payout, prizePool);
  const stacks = started.seats.map((s) => ({
    playerId: s.playerId,
    stack: s.stack,
  }));
  const icm = icmEquities(stacks, byPlace, policy);
  return {
    version: TOURNAMENT_KNOWLEDGE_VERSION,
    icmPolicyVersion: icm.policyVersion,
    payoutPolicyVersion: PAYOUT_POLICY_VERSION,
    stackBasis: "hand_start",
    entrants: session.entrants,
    remaining,
    level: started.tournament.level,
    handNumber: started.tournament.handNumber,
    smallBlind: started.smallBlind,
    bigBlind: started.bigBlind,
    anteKind: started.ante?.kind ?? "none",
    ante: started.ante?.amount ?? 0,
    prizePool,
    payoutsByPlace: byPlace,
    stage: tournamentStageOf(remaining, byPlace.length),
    seats: icm.players.map((p) => ({
      playerId: p.playerId,
      stack: p.stack,
      stackBb: p.stack / started.bigBlind,
      icmEquity: p.equity,
      icmEquityPercent: p.equityPercent,
    })),
    bubbleFactors: bubbleFactors(stacks, byPlace, viewerId, policy),
  };
}
