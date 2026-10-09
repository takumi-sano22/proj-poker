// Hand Summary Projection と、判断時点の Hero Information Set・Important Spot の抽出（docs/04 §1・docs/05 §7・docs/03 §7）。
// どれも Event Log（正本。D37）から作る派生で、別の「正しい Hand の表現」として保存しない。
// 入力に使うのは Hero に見える Event（public と Hero 宛ての private）だけ。他者の Hidden Cards・Deck（未来の Card）・
// engine / system Visibility の Event は読まない（D28）。Decision Review（Pass A）の入力は判断時点までの Event だけから作り、
// 判断より後の Event（結果・Showdown・その後の Board）を混ぜない（不変条件 3・Hindsight Leak の防止）。
// Hand 後に全員の札を見せる Learning-only Full Reveal は learning-reveal.ts の別の Projection で、ここからは参照しない。
import type { Card } from "./card.js";
import {
  isVisibleTo,
  type ActionType,
  type HandEvent,
  type PlayerChips,
  type SeatInit,
  type Street,
} from "./hand-events.js";
import {
  projectKnowledgeState,
  visibleEvents,
  type KnowledgeState,
} from "./projection.js";
import type { RulingCode } from "./ruling.js";
import type { TournamentStage } from "./tournament-knowledge.js";

/** Hero の 1 回の判断（Hero の ACTION_TAKEN 1 つ）。 */
export interface HeroDecision {
  /** この Hand での Hero の判断の順番（0 始まり）。 */
  readonly index: number;
  readonly street: Street;
  readonly action: ActionType;
  /** この Action で Stack から出した額。 */
  readonly amount: number;
  /** この Action の後の、この Street での累計 Commit（Bet / Raise の "to" 額）。 */
  readonly toAmount: number;
  readonly allIn: boolean;
  /** Hero の ACTION_TAKEN の seq。 */
  readonly actionSeq: number;
  /**
   * 判断を始める直前に Hero に見えていた最後の Event の seq（判断時点）。
   * Replay の step（Hero に見える Event の prefix ごとの視点）のうち、末尾の Event の seq がこの値の step が判断時点の卓になる。
   */
  readonly decisionPointSeq: number;
  /** この判断の Hero の操作への Dealer の裁定の理由（裁定が無い・理由の無い裁定だけなら空。D90・D91）。 */
  readonly rulingNotes: readonly RulingCode[];
}

/**
 * 判断時点の Hero Information Set（docs/05 §7 Pass A の入力の元）。
 * 判断時点までに Hero に見えた Event だけから作る。判断そのもの（decision）は Hero 自身の選択なので添える。
 */
export interface HeroInformationSet {
  readonly handId: string;
  readonly heroId: string;
  readonly decision: HeroDecision;
  /**
   * 判断時点の Hero の KnowledgeState（自分の札・公開 Board・Pot / Stack・Position・Public Action の履歴・裁定の履歴・
   * Legal Action・Math）。CPU へ渡すものと同じ whitelist で組む（projectKnowledgeState）。
   */
  readonly knowledge: KnowledgeState;
  /** 判断時点までに Hero に見えた Event（public と Hero 宛ての private。時系列）。Hero の User Read は userReads に分けて入れない。 */
  readonly events: readonly HandEvent[];
  /**
   * 判断の前（この判断の ACTION_TAKEN より前）に Hero が記録した User Read（記録の順。D112）。判断の直前の手番の間に記録した読みも
   * 判断時点の情報として入り、判断より後に記録した読みは入らない。前の判断の前に記録した読みも入る（その Hand のそれまでの読み）。
   */
  readonly userReads: readonly UserReadRecord[];
}

/** Hero が記録した User Read 1 つ（USER_READ_RECORDED の写し。seq が provenance）。 */
export interface UserReadRecord {
  readonly seq: number;
  readonly street: Street;
  /** 読みの対象の席（この Hand の playerId）。相手を特定しない読み・意図は null。 */
  readonly targetPlayerId: string | null;
  readonly text: string;
}

/** Important Spot として選んだ理由。 */
export type ImportantSpotReason =
  /** 判断時点の Pot が大きい（bigPotBb 以上） */
  | "big_pot"
  /** Hero が All-in した、または All-in した相手がいて Call が要る */
  | "all_in"
  /** River で大きい Bet に直面した（Pot Odds が riverBigBetMinPotOdds 以上） */
  | "river_big_bet"
  /** Hero の操作に Dealer の裁定が入った */
  | "ruling"
  /** Tournament の Bubble（残人数が入賞の数 + 1）での判断（tournamentImportantSpotReasons。#189） */
  | "bubble"
  /** Tournament で、次に Bust する 1 人で残りの全員の賞金が上がる（入賞圏で 3 人以上が残り、順位の賞金に差がある）判断 */
  | "pay_jump"
  /** Tournament で、Hero の Stack が shortStackBb 以下の判断 */
  | "short_stack";

/** Review の対象にする Hero の判断（理由を 1 つ以上持つ判断だけ。判断の順）。 */
export interface ImportantSpot {
  readonly decisionIndex: number;
  readonly street: Street;
  readonly actionSeq: number;
  /** 判断時点（HeroDecision.decisionPointSeq）。Replay の Jump to Important Spot（#84）の飛び先。 */
  readonly decisionPointSeq: number;
  readonly reasons: readonly ImportantSpotReason[];
}

/**
 * Important Spot の抽出の規則。値はすべて暫定値で、Review の運用を見て変える（永久仕様にしない）。
 * 規則は判断時点の Information Set だけを見る（結果・後の Street を見ない）ので、抽出そのものも Hindsight を含まない。
 */
export interface ImportantSpotRules {
  /** 判断時点の Pot がこの BB 数以上なら big_pot。 */
  readonly bigPotBb: number;
  /** River で直面した Bet の Pot Odds（Call 額 /（Pot + Call 額））がこの値以上なら river_big_bet。 */
  readonly riverBigBetMinPotOdds: number;
}

export const DEFAULT_IMPORTANT_SPOT_RULES: ImportantSpotRules = {
  // 暫定値: 100BB の Cash で、3-Bet Pot の Flop 程度（Single Raised Pot の River も届きうる）を「大きい Pot」とみなす。
  bigPotBb: 20,
  // 暫定値: Hero がその Street で未 Commit なら、0.3 は Pot の 3/4 の Bet に当たる（3/4 Pot = 0.75 / 2.5）。
  // Half Pot（0.25）は拾わず、3/4 Pot 以上の Bet・Overbet を拾う。
  riverBigBetMinPotOdds: 0.3,
};

/**
 * Tournament の Important Spot の規則（#189。OI-007 の暫定 Policy。人間判断を経ていない。値は Review の運用を見て変える）。
 * 版を Review の Evidence（tournament の policyVersion と同じ扱い）で読めるよう、規則を変えたら version を上げる。
 */
export interface TournamentImportantSpotRules {
  readonly version: string;
  /** Hero の Stack（判断時点の手元 + この Hand で出した額）がこの BB 数以下なら short_stack。 */
  readonly shortStackBb: number;
}

export const DEFAULT_TOURNAMENT_IMPORTANT_SPOT_RULES: TournamentImportantSpotRules =
  {
    version: "phase8_tournament_spot_v1",
    // 暫定値: 10BB 以下は Push / Fold が主になる Stack の目安（ICM と All-in の判断が Review の中心になる）。
    shortStackBb: 10,
  };

/** Tournament の Important Spot の判定に使う、判断時点の公開の事実（呼び出し側が Session の設定と判断時点の Stack から作る）。 */
export interface TournamentSpotFacts {
  readonly stage: TournamentStage;
  /** 残人数（この Hand に座っている人数）。 */
  readonly remaining: number;
  /** 順位ごとの賞金（pt。1 位から入賞の数だけ）。 */
  readonly payoutsByPlace: readonly number[];
  /** Hero の Stack の BB 換算（判断時点の手元 + この Hand で出した額。丸めない）。 */
  readonly heroStackBb: number;
}

/**
 * Tournament の判断の Important Spot の理由（bubble / pay_jump / short_stack）。判断時点の公開の事実だけを見る（結果を見ない）。
 * extractImportantSpots（Cash と共通の理由）とは別に呼び、Tournament の Hand でだけ足す（Cash の Important Spot を変えない）。
 * - bubble: Stage が bubble
 * - pay_jump: 残りの全員が入賞する（残人数 ≤ 入賞の数）・3 人以上が残る（Heads-Up は ICM が Chip EV と同じ）・
 *   残人数の順位の賞金より 1 つ上の順位の賞金が多い
 * - short_stack: Hero の Stack が shortStackBb 以下
 */
export function tournamentImportantSpotReasons(
  facts: TournamentSpotFacts,
  rules: TournamentImportantSpotRules = DEFAULT_TOURNAMENT_IMPORTANT_SPOT_RULES,
): ImportantSpotReason[] {
  const reasons: ImportantSpotReason[] = [];
  if (facts.stage === "bubble") reasons.push("bubble");
  const { remaining, payoutsByPlace } = facts;
  if (
    remaining >= 3 &&
    remaining <= payoutsByPlace.length &&
    (payoutsByPlace[remaining - 2] ?? 0) > (payoutsByPlace[remaining - 1] ?? 0)
  ) {
    reasons.push("pay_jump");
  }
  if (facts.heroStackBb <= rules.shortStackBb) reasons.push("short_stack");
  return reasons;
}

/** Hand の終わり方（Hero の視点）。 */
export type HandOutcome = "complete" | "aborted" | "in_progress";

/** 配分した Pot（POT_AWARDED 1 つ）。 */
export interface PotResult {
  readonly potIndex: number;
  readonly potTotal: number;
  readonly eligible: readonly string[];
  readonly awards: readonly PlayerChips[];
  readonly showdown: boolean;
}

/** Showdown で公開された札（CARDS_TABLED 1 つ）。 */
export interface ShowdownRecord {
  readonly playerId: string;
  readonly cards: readonly Card[];
}

/**
 * Hand Summary Projection（docs/04 §1 の Hand Summary）。Hero に見える Event から作る。
 * 他者の札は Showdown で公開されたものだけで、Learning-only Full Reveal は含まない。
 */
export interface HandSummary {
  readonly handId: string;
  readonly heroId: string;
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly buttonPlayerId: string;
  /** 席順と Hand 開始時の Stack。 */
  readonly seats: readonly SeatInit[];
  readonly outcome: HandOutcome;
  /** 配られた Board（打ち切った・Fold で決着した Hand では途中まで）。 */
  readonly board: readonly Card[];
  /** 配分した Pot（Main Pot が先）。配分の無い Hand（打ち切り・進行中）は空。 */
  readonly pots: readonly PotResult[];
  /** 配分した Pot の合計。 */
  readonly totalPot: number;
  readonly showdown: readonly ShowdownRecord[];
  /** HAND_FINISHED の Stack。終わっていない・打ち切った Hand は null。 */
  readonly finalStacks: readonly PlayerChips[] | null;
  /** Hero の収支（HAND_FINISHED の Stack − HAND_STARTED の Stack）。終わっていない・打ち切った Hand は null。 */
  readonly heroNet: number | null;
  readonly heroDecisions: readonly HeroDecision[];
  readonly importantSpots: readonly ImportantSpot[];
}

/**
 * 判断時点を探すときに飛ばす、Hero 自身の入力の Event か。
 * - 操作（宣言・Chip の操作・裁定）は判断そのものに属し、判断時点の情報には入れない
 * - User Read（D112）は手番の間に記録する Hero 自身の記録で、卓の状態を変えない。判断時点（卓の状態）を動かさないよう飛ばし、
 *   判断時点の情報としては HeroInformationSet の userReads に入れる
 */
function isHeroInput(event: HandEvent, heroId: string): boolean {
  return (
    (event.type === "PLAYER_DECLARED" ||
      event.type === "PHYSICAL_CHIP_ACTION" ||
      event.type === "DEALER_RULING" ||
      event.type === "USER_READ_RECORDED") &&
    event.playerId === heroId
  );
}

/**
 * Hero の判断の一覧（Hero の ACTION_TAKEN ごと。時系列）。Hero に見える Event だけを読む。
 * 判断時点は、その ACTION_TAKEN の直前に続く Hero 自身の操作（宣言・Chip の操作・裁定。Action の決まらない裁定の後の
 * 選び直しを含む）と User Read を除いた、その前の Event。Out-of-Turn で保留した操作は手番より前の出来事なので判断時点の情報に残り、
 * 手番で拘束した裁定（basis: pending_out_of_turn）だけが判断に属する。
 */
export function heroDecisions(
  events: readonly HandEvent[],
  heroId: string,
): HeroDecision[] {
  const visible = visibleEvents(events, heroId);
  const decisions: HeroDecision[] = [];
  visible.forEach((e, i) => {
    if (e.type !== "ACTION_TAKEN" || e.playerId !== heroId) return;
    let start = i;
    while (start > 0 && isHeroInput(visible[start - 1] as HandEvent, heroId)) {
      start--;
    }
    // 先頭は HAND_STARTED（Hero の入力ではない）なので、判断時点の Event は必ずある。
    const point = visible[start - 1] as HandEvent;
    const rulingNotes = visible
      .slice(start, i)
      .flatMap((op) => (op.type === "DEALER_RULING" ? op.notes : []));
    decisions.push({
      index: decisions.length,
      street: e.street,
      action: e.action,
      amount: e.amount,
      toAmount: e.toAmount,
      allIn: e.allIn,
      actionSeq: e.seq,
      decisionPointSeq: point.seq,
      rulingNotes,
    });
  });
  return decisions;
}

/**
 * Hero の判断ごとの、判断時点の Hero Information Set。
 * 判断時点（decisionPointSeq）までの Event を先に切り出してから Hero に見える Event だけを畳み込むので、
 * 判断より後の Event（その後の Board・Showdown・Pot の配分・結果）と、Hero に見えない Event は入らない。
 * Hero の User Read は、判断の ACTION_TAKEN より前に記録したものだけを userReads に入れる（判断より後の読みは入らない）。
 */
export function heroInformationSets(
  events: readonly HandEvent[],
  heroId: string,
): HeroInformationSet[] {
  return heroDecisions(events, heroId).map((decision) => {
    const known = events.filter(
      (e) =>
        e.seq <= decision.decisionPointSeq &&
        isVisibleTo(e, heroId) &&
        e.type !== "USER_READ_RECORDED",
    );
    const knowledge = projectKnowledgeState(known, heroId);
    const userReads: UserReadRecord[] = [];
    for (const e of events) {
      if (
        e.type === "USER_READ_RECORDED" &&
        e.playerId === heroId &&
        e.seq < decision.actionSeq
      ) {
        userReads.push({
          seq: e.seq,
          street: e.street,
          targetPlayerId: e.targetPlayerId,
          text: e.text,
        });
      }
    }
    return {
      handId: knowledge.handId,
      heroId,
      decision,
      knowledge,
      events: known,
      userReads,
    };
  });
}

/**
 * Important Spot を決定論で抽出する。判断時点の Information Set だけを見る（結果を見ない）。
 * 理由を 1 つも持たない判断は返さない。
 */
export function extractImportantSpots(
  sets: readonly HeroInformationSet[],
  rules: ImportantSpotRules = DEFAULT_IMPORTANT_SPOT_RULES,
): ImportantSpot[] {
  const spots: ImportantSpot[] = [];
  for (const { decision, knowledge } of sets) {
    const reasons: ImportantSpotReason[] = [];
    if (knowledge.pot >= rules.bigPotBb * knowledge.bigBlind) {
      reasons.push("big_pot");
    }
    const facingAllIn =
      knowledge.math.callAmount > 0 &&
      knowledge.seats.some(
        (s) => s.playerId !== knowledge.viewerId && !s.folded && s.allIn,
      );
    if (decision.allIn || facingAllIn) reasons.push("all_in");
    if (
      knowledge.street === "river" &&
      knowledge.math.potOdds !== null &&
      knowledge.math.potOdds >= rules.riverBigBetMinPotOdds
    ) {
      reasons.push("river_big_bet");
    }
    if (decision.rulingNotes.length > 0) reasons.push("ruling");
    if (reasons.length === 0) continue;
    spots.push({
      decisionIndex: decision.index,
      street: decision.street,
      actionSeq: decision.actionSeq,
      decisionPointSeq: decision.decisionPointSeq,
      reasons,
    });
  }
  return spots;
}

/**
 * Hand Summary Projection を Event Log から作る。値は Hero に見える Event から作る。
 * 例外として、Hand の打ち切り（HAND_ABORTED は system Visibility）だけは、AI 障害の後に Hero 自身が選んだ打ち切りなので
 * outcome: aborted として読む（Replay と同じ扱い。D95）。中身（理由）は読まない。
 */
export function projectHandSummary(
  events: readonly HandEvent[],
  heroId: string,
  rules: ImportantSpotRules = DEFAULT_IMPORTANT_SPOT_RULES,
): HandSummary {
  const visible = visibleEvents(events, heroId);
  const started = visible[0];
  if (started?.type !== "HAND_STARTED") {
    throw new RangeError("Event 列の先頭が HAND_STARTED ではない");
  }
  if (!started.seats.some((s) => s.playerId === heroId)) {
    throw new RangeError(`卓にいない Player の Summary は作らない: ${heroId}`);
  }
  const board: Card[] = [];
  const pots: PotResult[] = [];
  const showdown: ShowdownRecord[] = [];
  let finalStacks: readonly PlayerChips[] | null = null;
  for (const e of visible) {
    if (e.type === "BOARD_DEALT") board.push(...e.cards);
    else if (e.type === "POT_AWARDED") {
      pots.push({
        potIndex: e.potIndex,
        potTotal: e.potTotal,
        eligible: e.eligible,
        awards: e.awards,
        showdown: e.showdown,
      });
    } else if (e.type === "CARDS_TABLED") {
      showdown.push({ playerId: e.playerId, cards: e.cards });
    } else if (e.type === "HAND_FINISHED") finalStacks = e.stacks;
  }
  const aborted = events.some((e) => e.type === "HAND_ABORTED");
  const before = started.seats.find((s) => s.playerId === heroId)?.stack;
  const after = finalStacks?.find((s) => s.playerId === heroId)?.amount;
  const sets = heroInformationSets(events, heroId);
  return {
    handId: started.handId,
    heroId,
    ruleProfile: started.ruleProfile,
    smallBlind: started.smallBlind,
    bigBlind: started.bigBlind,
    buttonPlayerId: started.buttonPlayerId,
    seats: started.seats,
    outcome:
      finalStacks !== null ? "complete" : aborted ? "aborted" : "in_progress",
    board,
    pots,
    totalPot: pots.reduce((sum, p) => sum + p.potTotal, 0),
    showdown,
    finalStacks,
    heroNet:
      before === undefined || after === undefined ? null : after - before,
    heroDecisions: sets.map((s) => s.decision),
    importantSpots: extractImportantSpots(sets, rules),
  };
}
