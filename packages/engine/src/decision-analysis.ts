// Decision Analysis: Hero の 1 回の判断について、Pot Odds・Equity・Alternative Action（Fold / Check / Call / Bet / Raise）の
// 必要 Equity と簡易 EV を決定論で出す（docs/05 §6 の Math Evidence / Range Evidence・docs/03 §7 の Deterministic Math → Range Analysis）。
// 入力は判断時点の Hero Information Set（#78 の heroInformationSets）だけ。判断より後の Event・相手の実際の札は受け取らないので、
// 結果論（Hindsight）は混ざらない（不変条件 3）。
// 簡易 EV は Assumption 付きの目安で、GTO / Solver の値ではない（D20。理論基準は Solver Evidence が別に示す）。
import type { ActionType, Street } from "./hand-events.js";
import type { HeroInformationSet } from "./hand-summary.js";
import {
  DEFAULT_EQUITY_OPTIONS,
  EquityUnavailableError,
  equityVsRanges,
  type EquityOptions,
  type EquityResult,
} from "./equity.js";
import { breakEvenFoldFrequency } from "./pot-math.js";
import type { KnowledgeState, SeatView } from "./projection.js";
import {
  RANGE_PROFILES,
  STANDARD_RANGE_PROFILE,
  type RangeProfile,
} from "./range-config.js";
import {
  villainRange,
  type RangeAssumption,
  type VillainRange,
} from "./range-model.js";

/** Alternative Action 1 つ分の比較。額はすべて Chip の実額（D49）。 */
export interface AlternativeAction {
  readonly action: ActionType;
  /** bet / raise / all_in の、この Street の累計（to 額）。fold / check / call は null。 */
  readonly toAmount: number | null;
  /** 今から出す額（相手が Call しきれない超過分は戻るので除く）。 */
  readonly risk: number;
  /**
   * Hero が取りうる Pot（Hero の Commit 以下の部分だけ。Side Pot は分けない）。
   * check / call は相手がこれ以上出さない前提、bet / raise / all_in は Fold していない相手全員が Call する前提の額。fold は 0。
   */
  readonly winnablePot: number;
  /** この Action が損をしないのに要る Equity（risk ÷ winnablePot）。bet / raise / all_in は Call された場合。fold / check は null。 */
  readonly requiredEquity: number | null;
  /** 簡易 EV（Fold を 0 とした Chip の差。Equity が無ければ null）。前提は DecisionAnalysis.assumptions。 */
  readonly ev: number | null;
  /** bet / raise / all_in だけ: Equity 0 でも損をしない Fold 率（risk ÷（Pot + risk））。それ以外は null。 */
  readonly breakEvenFoldFrequency: number | null;
  /** Hero が実際に選んだ Action か。 */
  readonly chosen: boolean;
}

export interface DecisionAnalysis {
  readonly handId: string;
  readonly heroId: string;
  readonly decisionIndex: number;
  readonly street: Street;
  /** 判断時点の Pot・Call 額・Pot Odds・有効 Stack・SPR（KnowledgeState の math と同じ値）。 */
  readonly pot: number;
  readonly callAmount: number;
  readonly potOdds: number | null;
  readonly effectiveStack: number;
  readonly spr: number | null;
  /** Fold していない相手ごとの Range の Assumption。 */
  readonly ranges: readonly RangeAssumption[];
  /** 仮定した Range に対する Hero の Equity。札が無い・Range が空・相手同士の Range が重なって試行が作れないなら null。 */
  readonly equity: EquityResult | null;
  readonly alternatives: readonly AlternativeAction[];
  /** 簡易 EV の性質（GTO / Solver の値ではない）。 */
  readonly evBasis: "simplified";
  /** 計算の前提（表示・Review の Evidence にそのまま添える文）。 */
  readonly assumptions: readonly string[];
}

export interface DecisionAnalysisOptions {
  readonly profile?: RangeProfile;
  readonly equity?: EquityOptions;
}

/** 判断時点の Information Set から、Pot Odds・Equity・Alternative Action の比較を作る。 */
export function analyzeDecision(
  set: HeroInformationSet,
  options: DecisionAnalysisOptions = {},
): DecisionAnalysis {
  const { knowledge, decision } = set;
  const profile = options.profile ?? STANDARD_RANGE_PROFILE;
  const villains = rangesOf(knowledge, profile);
  const equity = equityOf(knowledge, villains, options.equity);
  const alternatives = alternativesOf(knowledge, equity?.equity ?? null, {
    action: decision.action,
    toAmount: decision.toAmount,
  });
  const assumptions = [
    "Equity は、相手ごとに仮定した Range（ranges）に対する Showdown までの勝率（引き分けは等分）。Range は判断時点の公開情報からの推定で、実際の札ではない。",
    "Postflop の Range の絞り込みは、その Street の Board での役の強さ（Made Hand）の上位を残す簡易モデルで、Draw は数えない。",
    "簡易 EV は Fold を 0 とした Chip の差。Check / Call はこの後の Bet が無く Showdown まで進む前提、Bet / Raise / All-in は Fold していない相手全員が Call する前提（Fold Equity は含めず、Break-even Fold Frequency を別に示す）。",
    "Side Pot は分けず、Hero が取りうる Pot だけで計算する。Implied Odds・Rake・Equity Realization は含まない。",
    "これは GTO / Solver の値ではない（理論基準は Solver Evidence で別に示す。D20）。",
  ];
  if (villains.length > 1) {
    assumptions.push(
      "Multiway では相手ごとの Range を独立に仮定する（相手同士の相関は見ない）。Heads-Up の結論をそのまま当てはめない。",
    );
  }
  if (equity === null) {
    assumptions.push(
      "Hero の札が無い、相手の Range が空、または相手同士の Range が重なって試行が作れないため、Equity と簡易 EV は出していない。",
    );
  }
  return {
    handId: set.handId,
    heroId: set.heroId,
    decisionIndex: decision.index,
    street: knowledge.street,
    pot: knowledge.pot,
    callAmount: knowledge.math.callAmount,
    potOdds: knowledge.math.potOdds,
    effectiveStack: knowledge.math.effectiveStack,
    spr: knowledge.math.spr,
    ranges: villains.map((v) => v.assumption),
    equity,
    alternatives,
    evBasis: "simplified",
    assumptions,
  };
}

/** Range の想定ごとの Equity の比較（D08: 重要 Spot で別の Range 想定と比べる）。 */
export interface RangeComparison {
  readonly profileId: string;
  readonly label: string;
  readonly ranges: readonly RangeAssumption[];
  readonly equity: EquityResult | null;
}

/** 同じ判断時点の Information Set で、Range の想定（既定は標準・狭い・広い）ごとに Equity を比べる。 */
export function compareRangeProfiles(
  set: HeroInformationSet,
  profiles: readonly RangeProfile[] = RANGE_PROFILES,
  equityOptions?: EquityOptions,
): RangeComparison[] {
  return profiles.map((profile) => {
    const villains = rangesOf(set.knowledge, profile);
    return {
      profileId: profile.id,
      label: profile.label,
      ranges: villains.map((v) => v.assumption),
      equity: equityOf(set.knowledge, villains, equityOptions),
    };
  });
}

/** Fold していない相手ごとの Range（席順）。 */
function rangesOf(
  knowledge: KnowledgeState,
  profile: RangeProfile,
): VillainRange[] {
  return knowledge.seats
    .filter((s) => s.playerId !== knowledge.viewerId && !s.folded)
    .map((s) => villainRange(knowledge, s.playerId, profile));
}

function equityOf(
  knowledge: KnowledgeState,
  villains: readonly VillainRange[],
  options: EquityOptions = DEFAULT_EQUITY_OPTIONS,
): EquityResult | null {
  const hero = knowledge.holeCards;
  if (
    hero === null ||
    villains.length === 0 ||
    villains.some((v) => v.combos.length === 0)
  ) {
    return null;
  }
  try {
    return equityVsRanges(
      hero,
      knowledge.board,
      villains.map((v) => v.combos),
      options,
    );
  } catch (error) {
    // 相手同士の Range が重なって試行が作れないときだけ「出せない」として null にする（Assumption に理由を書く）。
    // 不正な入力など、それ以外の失敗は握りつぶさずに投げ直す。
    if (error instanceof EquityUnavailableError) return null;
    throw error;
  }
}

/**
 * Legal Action から比べる候補を作る。bet は Pot の半分・Pot、raise は最小・Pot Size（Call 後の Pot 分の上乗せ）、
 * それに All-in を候補にし、Hero が実際に選んだ額が候補に無ければ足す。
 */
function alternativesOf(
  knowledge: KnowledgeState,
  equity: number | null,
  chosen: { readonly action: ActionType; readonly toAmount: number },
): AlternativeAction[] {
  const legal = knowledge.legalActions;
  if (legal === null) return [];
  const hero = knowledge.seats.find(
    (s) => s.playerId === knowledge.viewerId,
  ) as SeatView;
  const chosenAggressive =
    chosen.action === "bet" ||
    chosen.action === "raise" ||
    (chosen.action === "all_in" && chosen.toAmount > knowledge.currentBet);
  const result: AlternativeAction[] = [];
  const aggressiveTos: { action: ActionType; to: number }[] = [];
  for (const a of legal.actions) {
    if (a.type === "fold") {
      result.push({
        action: "fold",
        toAmount: null,
        risk: 0,
        winnablePot: 0,
        requiredEquity: null,
        ev: 0,
        breakEvenFoldFrequency: null,
        chosen: chosen.action === "fold",
      });
    } else if (a.type === "check") {
      const pot = winnablePot(knowledge.seats, hero, hero.totalCommitted, null);
      result.push({
        action: "check",
        toAmount: null,
        risk: 0,
        winnablePot: pot,
        requiredEquity: null,
        ev: equity === null ? null : equity * pot,
        breakEvenFoldFrequency: null,
        chosen: chosen.action === "check",
      });
    } else if (a.type === "call") {
      const total = hero.totalCommitted + a.amount;
      const pot = winnablePot(knowledge.seats, hero, total, null);
      result.push({
        action: "call",
        toAmount: null,
        risk: a.amount,
        winnablePot: pot,
        requiredEquity: a.amount / pot,
        ev: equity === null ? null : equity * pot - a.amount,
        breakEvenFoldFrequency: null,
        chosen:
          !chosenAggressive &&
          (chosen.action === "call" || chosen.action === "all_in"),
      });
    } else if (a.type === "bet" || a.type === "raise") {
      const sizes =
        a.type === "bet"
          ? [Math.round(knowledge.pot / 2), knowledge.pot]
          : [a.min, knowledge.currentBet + knowledge.pot + legal.toCall];
      for (const to of sizes) {
        const clamped = Math.min(Math.max(to, a.min), a.max);
        // max は All-in の候補が受け持つ。
        if (clamped < a.max)
          aggressiveTos.push({ action: a.type, to: clamped });
      }
      if (
        chosenAggressive &&
        chosen.action === a.type &&
        chosen.toAmount < a.max
      ) {
        aggressiveTos.push({ action: a.type, to: chosen.toAmount });
      }
    } else {
      // all_in: Call に届かない All-in は Call の候補（legal の call）と同じなので、上乗せになるときだけ候補にする。
      if (a.amount > knowledge.currentBet) {
        aggressiveTos.push({ action: "all_in", to: a.amount });
      }
    }
  }
  const seen = new Set<number>();
  for (const { action, to } of aggressiveTos.sort((x, y) => x.to - y.to)) {
    if (seen.has(to)) continue;
    seen.add(to);
    result.push(
      aggressive(
        knowledge,
        hero,
        action,
        to,
        equity,
        chosenAggressive && chosen.toAmount === to,
      ),
    );
  }
  return result;
}

/** bet / raise / all_in で to 額まで出したとき（Fold していない相手全員が Call する前提）の比較。 */
function aggressive(
  knowledge: KnowledgeState,
  hero: SeatView,
  action: ActionType,
  to: number,
  equity: number | null,
  chosen: boolean,
): AlternativeAction {
  // 相手が Call したときのその相手の Hand 全体の Commit（Stack で頭打ち）。
  const calledTotal = (s: SeatView): number =>
    Math.min(
      s.totalCommitted - s.streetCommitted + to,
      s.totalCommitted + s.stack,
    );
  const opponents = knowledge.seats.filter(
    (s) => s.playerId !== hero.playerId && !s.folded,
  );
  // 誰も Call しきれない超過分は戻る（Uncalled Bet）ので、Hero の Commit は相手の最大の Commit で頭打ちにする。
  const heroTotal = Math.min(
    hero.totalCommitted - hero.streetCommitted + to,
    Math.max(...opponents.map(calledTotal)),
  );
  const risk = heroTotal - hero.totalCommitted;
  const pot = winnablePot(knowledge.seats, hero, heroTotal, calledTotal);
  return {
    action,
    toAmount: to,
    risk,
    winnablePot: pot,
    requiredEquity: risk / pot,
    ev: equity === null ? null : equity * pot - risk,
    breakEvenFoldFrequency: breakEvenFoldFrequency(risk, knowledge.pot),
    chosen,
  };
}

/**
 * Hero の Hand 全体の Commit が heroTotal になったときに Hero が取りうる Pot（各席の Commit の heroTotal 以下の部分の合計）。
 * calledTotal を渡すと、Fold していない相手はその額まで出した前提で数える（渡さなければ今の Commit のまま）。
 */
function winnablePot(
  seats: readonly SeatView[],
  hero: SeatView,
  heroTotal: number,
  calledTotal: ((s: SeatView) => number) | null,
): number {
  let pot = 0;
  for (const s of seats) {
    const total =
      s.playerId === hero.playerId
        ? heroTotal
        : !s.folded && calledTotal !== null
          ? calledTotal(s)
          : s.totalCommitted;
    pot += Math.min(total, heroTotal);
  }
  return pot;
}
