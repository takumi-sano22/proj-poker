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
  /** 判断時点までに Hero に見えた Event（public と Hero 宛ての private。時系列）。 */
  readonly events: readonly HandEvent[];
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
  | "ruling";

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

/** Hero の操作の Event（宣言・Chip の操作・裁定）か。判断そのものに属し、判断時点の情報には入れない。 */
function isHeroOperation(event: HandEvent, heroId: string): boolean {
  return (
    (event.type === "PLAYER_DECLARED" ||
      event.type === "PHYSICAL_CHIP_ACTION" ||
      event.type === "DEALER_RULING") &&
    event.playerId === heroId
  );
}

/**
 * Hero の判断の一覧（Hero の ACTION_TAKEN ごと。時系列）。Hero に見える Event だけを読む。
 * 判断時点は、その ACTION_TAKEN の直前に続く Hero 自身の操作（宣言・Chip の操作・裁定。Action の決まらない裁定の後の
 * 選び直しを含む）を除いた、その前の Event。Out-of-Turn で保留した操作は手番より前の出来事なので判断時点の情報に残り、
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
    while (
      start > 0 &&
      isHeroOperation(visible[start - 1] as HandEvent, heroId)
    ) {
      start--;
    }
    // 先頭は HAND_STARTED（Hero の操作ではない）なので、判断時点の Event は必ずある。
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
 */
export function heroInformationSets(
  events: readonly HandEvent[],
  heroId: string,
): HeroInformationSet[] {
  return heroDecisions(events, heroId).map((decision) => {
    const known = events.filter(
      (e) => e.seq <= decision.decisionPointSeq && isVisibleTo(e, heroId),
    );
    const knowledge = projectKnowledgeState(known, heroId);
    return {
      handId: knowledge.handId,
      heroId,
      decision,
      knowledge,
      events: known,
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
