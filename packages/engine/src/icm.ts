// 2〜8 人の決定論の ICM Calculator（D109・D130・docs/02 §7・#187）。
// ICM（Prize Equity）は Stack（Chip）と Payout（pt。順位ごとの賞金）から各 Player の賞金の期待値を出す。Chip EV とは別の量で、
// LLM には計算させない（この関数群が数値の正本）。CPU の Public Tournament Context（#188）と Review の Evidence（#189）が使う。
//
// 方式は Malmuth-Harville（OI-007 の暫定 Policy。確定ではない）。方式は IcmPolicy の method で分岐し、Version を結果に残すので、
// ほかの方式へ差し替えるときは method を足して Version を上げる。
//
// 数値精度: Stack・Payout は整数（Chip は D74、pt は payoutsByPlace の出力）で受け取り、確率と Equity は倍精度の浮動小数で計算する
// （丸めない）。Σ Equity = 争う順位の賞金の合計は、浮動小数の誤差の範囲（テストは相対 1e-9）で成り立つ。表示・Evidence に出すときだけ
// 丸める（pt と % は小数第 1 位に四捨五入。比較・判定は丸める前の値で行う。docs/02 §7）。
import { buildPots, type PotContributor } from "./side-pots.js";
import type { TournamentResult } from "./tournament-payout.js";

/** ICM の方式。今は Malmuth-Harville だけ（ほかの方式は値を足して switch で分岐する）。 */
export type IcmMethod = "malmuth_harville";

/** ICM の Policy（方式と版）。結果に版を残し、どの方式で計算した値かを読み手が分かるようにする。 */
export interface IcmPolicy {
  readonly version: string;
  readonly method: IcmMethod;
}

/** 既定の ICM Policy（OI-007 の暫定値の 1 版目。人間判断を経ていない。docs/02 §7）。 */
export const ICM_POLICY: IcmPolicy = {
  version: "phase8_icm_provisional_v1",
  method: "malmuth_harville",
};

/** ICM が扱う人数（D109。Single Table の 2〜8 人）。 */
export const ICM_MIN_PLAYERS = 2;
export const ICM_MAX_PLAYERS = 8;

/** ICM の入力の 1 人分。stack は Chip（最小単位の整数。D74）。 */
export interface IcmStack {
  readonly playerId: string;
  readonly stack: number;
}

/** 1 人の ICM Equity。 */
export interface IcmPlayerEquity {
  readonly playerId: string;
  readonly stack: number;
  /** 賞金の期待値（pt。倍精度・丸めない）。 */
  readonly equity: number;
  /** 争う賞金の合計（prizePool）に対する割合（%。0〜100。倍精度・丸めない）。 */
  readonly equityPercent: number;
}

export interface IcmEquities {
  readonly policyVersion: string;
  readonly method: IcmMethod;
  /**
   * 争う賞金の合計（pt）= 1 位から残っている人数分の順位の賞金の合計。残っている人数より下の順位の賞金は、すでに Bust した Player
   * のもの（入賞の数より残りが少ない場合）なので含めない。Σ equity はこの値に（浮動小数の誤差の範囲で）一致する。
   */
  readonly prizePool: number;
  /** 入力と同じ並びの各 Player の Equity。 */
  readonly players: readonly IcmPlayerEquity[];
}

/**
 * Stack と順位ごとの賞金（pt。1 位から。payoutsByPlace の出力）から、各 Player の ICM Equity を計算する。同じ入力からは同じ結果になる。
 *
 * - n 人（2〜8 人）は 1〜n 位を争う。賞金の列が n より長ければ n 位までを使い（下の順位はすでに Bust した Player のもの）、
 *   短ければ足りない順位の賞金は 0 とする
 * - Stack 0 の Player は、Stack の残っている全員より下の順位になる。Stack 0 が複数なら、その順位を等しい確率で分け合う
 *   （同順位の賞金を合算して等分する Payout の扱い〔docs/02 §7〕と同じ値になる）
 * - 同額の Stack の Player は同じ Equity になる（浮動小数の誤差の範囲で）
 *
 * 人数が 2〜8 人でない・playerId が重複・Stack が 0 以上の整数でない・Stack の合計が 0・賞金が 0 以上の有限の数でない・
 * 争う賞金の合計が 0 なら RangeError を投げる。
 */
export function icmEquities(
  stacks: readonly IcmStack[],
  payouts: readonly number[],
  policy: IcmPolicy = ICM_POLICY,
): IcmEquities {
  validateStacks(stacks);
  if (payouts.length === 0) {
    throw new RangeError("賞金の列は 1 つ以上");
  }
  for (const amount of payouts) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`賞金は 0 以上の有限の数: ${amount}`);
    }
  }
  const prizes = stacks.map((_, place) => payouts[place] ?? 0);
  const prizePool = prizes.reduce((sum, a) => sum + a, 0);
  if (prizePool === 0) {
    throw new RangeError("争う賞金の合計が 0");
  }

  let equities: number[];
  switch (policy.method) {
    case "malmuth_harville":
      equities = malmuthHarville(
        stacks.map((s) => s.stack),
        prizes,
      );
      break;
  }
  return {
    policyVersion: policy.version,
    method: policy.method,
    prizePool,
    players: stacks.map((s, i) => {
      const equity = equities[i] as number;
      return {
        playerId: s.playerId,
        stack: s.stack,
        equity,
        equityPercent: (equity / prizePool) * 100,
      };
    }),
  };
}

/**
 * Malmuth-Harville: まだ順位の決まっていない Player の中から、Stack に比例する確率で次の（上の）順位を 1 人ずつ決める。
 * 「上位から決まった Player の集合」を bit で表した部分集合ごとに確率を持つ DP（2^n × n。8 人で約 2,000 回の更新）で、
 * 全順列（8! = 40,320）を数えない。部分集合は数値の小さい順に処理すれば、bit を足した先は必ず後に来るので確率が揃ってから使われる。
 */
function malmuthHarville(
  stacks: readonly number[],
  prizes: readonly number[],
): number[] {
  const n = stacks.length;
  const total = stacks.reduce((sum, s) => sum + s, 0);
  // 賞金のある順位までだけ展開する（それより下の順位の確率は Equity に効かない）。
  let paidPlaces = prizes.length;
  while (paidPlaces > 0 && prizes[paidPlaces - 1] === 0) paidPlaces -= 1;

  const size = 1 << n;
  const probability = new Float64Array(size);
  const chipsOf = new Float64Array(size);
  const placedCount = new Uint8Array(size);
  probability[0] = 1;
  const equities = new Array<number>(n).fill(0);

  for (let mask = 0; mask < size; mask += 1) {
    const p = probability[mask] as number;
    const place = placedCount[mask] as number;
    if (p === 0 || place >= paidPlaces) continue;
    const prize = prizes[place] as number;
    const rest = total - (chipsOf[mask] as number);
    const unplaced = n - place;
    for (let j = 0; j < n; j += 1) {
      const bit = 1 << j;
      if ((mask & bit) !== 0) continue;
      // 残りの Chip が 0（残りが Stack 0 の Player だけ）なら、残りの順位を等しい確率で分け合う。
      const pick = rest > 0 ? (stacks[j] as number) / rest : 1 / unplaced;
      if (pick === 0) continue;
      const next = mask | bit;
      equities[j] = (equities[j] as number) + p * pick * prize;
      probability[next] = (probability[next] as number) + p * pick;
      chipsOf[next] = (chipsOf[mask] as number) + (stacks[j] as number);
      placedCount[next] = place + 1;
    }
  }
  return equities;
}

/** 自分から見た 1 人の相手との Bubble Factor。 */
export interface BubbleFactor {
  readonly opponentId: string;
  /** All-in で賭けることになる Chip（自分と相手の Stack の小さい方）。 */
  readonly riskedChips: number;
  /**
   * Bubble Factor =（負けたときに失う ICM Equity）÷（勝ったときに得る ICM Equity）。riskedChips を 1 対 1 で取り合う（Pot の
   * Dead Money なし）ときの値で、1 なら Chip EV と同じ、1 より大きいほど負けの痛みが大きい。自分か相手の Stack が 0（賭けられない）・
   * 勝っても Equity が増えない（賞金が同じ順位しか残らない等）なら null。
   */
  readonly bubbleFactor: number | null;
}

/**
 * Hero から見た、Stack の残っている相手ごとの Bubble Factor（D130）。並びは入力の席の並び（Hero を除く）。
 * 入力の検証は icmEquities と同じで、heroId が stacks に無ければ RangeError を投げる。
 */
export function bubbleFactors(
  stacks: readonly IcmStack[],
  payouts: readonly number[],
  heroId: string,
  policy: IcmPolicy = ICM_POLICY,
): BubbleFactor[] {
  const base = icmEquities(stacks, payouts, policy);
  const hero = indexOf(stacks, heroId);
  const heroEquity = base.players[hero]?.equity as number;
  const heroStack = stacks[hero]?.stack as number;

  return stacks.flatMap((opponent, index) => {
    if (index === hero) return [];
    const risked = Math.min(heroStack, opponent.stack);
    if (risked === 0) {
      return [
        { opponentId: opponent.playerId, riskedChips: 0, bubbleFactor: null },
      ];
    }
    // 勝ち: Hero が risked を取る。負け: 相手が risked を取る。ほかの Player の Stack は変えない。
    const after = (delta: number) =>
      icmEquities(
        stacks.map((s, i) =>
          i === hero
            ? { ...s, stack: s.stack + delta }
            : i === index
              ? { ...s, stack: s.stack - delta }
              : s,
        ),
        payouts,
        policy,
      ).players[hero]?.equity as number;
    const gain = after(risked) - heroEquity;
    const loss = heroEquity - after(-risked);
    return [
      {
        opponentId: opponent.playerId,
        riskedChips: risked,
        bubbleFactor: gain > 0 ? loss / gain : null,
      },
    ];
  });
}

/** All-in の判断の Spot の 1 人分（判断時点）。 */
export interface IcmSpotSeat {
  readonly playerId: string;
  /** 手元に残っている Chip（この Hand でまだ出していない分）。 */
  readonly stack: number;
  /** この Hand で出した累計（Blind・per_player の Ante を含む。buildPots の totalCommitted と同じ）。 */
  readonly committed: number;
  /** すでに Fold したか。Fold した Player の committed は Dead Money として Pot に残る。 */
  readonly folded: boolean;
}

export interface IcmSpot {
  /** Tournament に残っている全員（2〜8 人。Fold した Player を含む）。 */
  readonly seats: readonly IcmSpotSeat[];
  /** 誰の committed にも数えない Pot の Dead Money（big_blind_ante の Ante。D128。既定 0）。 */
  readonly deadMoney?: number;
  /** 順位ごとの賞金（pt。1 位から。icmEquities と同じ）。 */
  readonly payouts: readonly number[];
  readonly heroId: string;
}

/**
 * 必要 Equity の計算の前提（D130。Evidence と画面にそのまま出し、Review AI へ前提ごと渡す）。
 * Push/Fold Solver を暗黙に入れないため、Fold Equity と Call の頻度は含めない。
 */
export interface AllInAssumptions {
  /** 判断に関わる 2 人（Hero と相手）以外の、まだ Fold していない Player はすべて Fold する（その committed は Dead Money）。 */
  readonly othersFold: true;
  /** Shove で相手が Fold する確率（Fold Equity）は含めない（Call された場合の条件付き）。 */
  readonly foldEquityIncluded: false;
  /** 相手が Call する頻度は含めない。 */
  readonly callFrequencyIncluded: false;
  /** 比較点（Hero が Fold した場合）で、今の Pot を取る Player。 */
  readonly potWinnerIfHeroFolds: string;
}

/** Hero の 3 つの結果ごとの値（Fold・Call されて勝つ・負ける）。 */
export interface AllInOutcomes {
  readonly fold: number;
  readonly win: number;
  readonly lose: number;
}

/** 相手 1 人との All-in の必要 Equity。 */
export interface AllInRequirement {
  readonly villainId: string;
  /**
   * Chip EV の必要 Equity（Pot Odds と同じ考え方）=（Fold − 負け）÷（勝ち − 負け）を Hero の Chip で計算した値。
   * All-in への Call では Pot Odds（Call 額 ÷ Call 後に Hero が取りうる Pot）と一致する。ICM の値とは別の項目（D130）。
   * ふつうは 0〜1 だが、Fold した Player の Dead Money が相手の All-in の額を超える Spot では、その超過は負けても Hero に戻るので
   * 0 より小さくなりうる（丸めたり切り詰めたりしない）。
   */
  readonly chipEvRequiredEquity: number;
  /**
   * ICM の必要 Equity =（Fold − 負け）÷（勝ち − 負け）を Hero の ICM Equity（pt）で計算した値（倍精度・丸めない）。
   * 勝っても負けても Equity が変わらないなら null。
   */
  readonly icmRequiredEquity: number | null;
  /** Hero の Stack（Chip）。 */
  readonly heroStack: AllInOutcomes;
  /** Hero の ICM Equity（pt）。 */
  readonly heroIcmEquity: AllInOutcomes;
}

export interface AllInIcmAnalysis {
  /** call_all_in: All-in（か Hero の Stack 全部）への Call。shove: Hero の All-in（Bet / Raise）。 */
  readonly decision: "call_all_in" | "shove";
  readonly heroId: string;
  readonly policyVersion: string;
  readonly assumptions: AllInAssumptions;
  /** call_all_in は相手 1 人。shove は Call しうる相手ごと（席の並び）。Call しうる相手がいなければ空。 */
  readonly requirements: readonly AllInRequirement[];
}

/**
 * All-in への Call の ICM の必要 Equity（D130）。相手の額は決まっているのでそのまま計算する。
 * Fold の比較点では相手が今の Pot を取る。Call したら Hero と相手だけで争い、ほかのまだ Fold していない Player は Fold する
 * （othersFold）。Hero の Stack が相手の Bet に足りなければ All-in の Call で、相手の超過分は相手に戻る（Side Pot）。
 *
 * 相手が All-in か、Call すると Hero が All-in になる（どちらか）でなければ All-in の判断でないので RangeError。Hero の Stack が 0・相手の Bet が Hero の
 * committed 以下（Call するものが無い）・相手以外に Fold できない Player（All-in した・すでに相手の Bet に揃えた）がいる
 * （Multiway の All-in は範囲外）なら RangeError を投げる。
 */
export function icmCallAllIn(
  spot: IcmSpot,
  villainId: string,
  policy: IcmPolicy = ICM_POLICY,
): AllInIcmAnalysis {
  const { hero, seats } = validateSpot(spot);
  const villain = activeOpponent(spot, villainId);
  if (hero.stack === 0) {
    throw new RangeError("Hero の Stack が 0 で Call できない");
  }
  if (villain.committed <= hero.committed) {
    throw new RangeError(`Call する Bet が無い: ${villainId}`);
  }
  const heroAllIn = hero.committed + hero.stack <= villain.committed;
  if (villain.stack > 0 && !heroAllIn) {
    throw new RangeError("相手も Hero も All-in にならない Call は範囲外");
  }
  for (const other of seats) {
    if (
      other === hero ||
      other === villain ||
      other.folded ||
      (other.stack > 0 && other.committed < villain.committed)
    ) {
      continue;
    }
    throw new RangeError(`Fold できない Player がいる: ${other.playerId}`);
  }

  const heroTotal = Math.min(hero.committed + hero.stack, villain.committed);
  return {
    decision: "call_all_in",
    heroId: spot.heroId,
    policyVersion: policy.version,
    assumptions: assumptionsOf(villain.playerId),
    requirements: [
      requirementOf(
        spot,
        villain,
        heroTotal,
        villain.committed,
        villain,
        policy,
      ),
    ],
  };
}

/**
 * Hero の Shove（All-in の Bet / Raise）の ICM の必要 Equity を、Call しうる相手ごとに返す（D130）。
 * それぞれ「その 1 人に Call され、ほかは Fold した場合」の条件付きで、Fold Equity・Call の頻度は含めない。
 * 比較点は Hero が今 Fold し、potWinnerIfHeroFolds が今の Pot を取る場合（Preflop なら BB や最後に Bet / Raise した Player。
 * 呼び出し側が決めて前提に残す）。相手の Stack が Hero の Shove に足りなければ All-in の Call で、Hero の超過分は Hero に戻る。
 *
 * Call しうる相手 = Hero 以外でまだ Fold しておらず Stack が残っている Player。Hero の Stack が 0・Hero の Shove の額（committed +
 * stack）がまだ Fold していない相手の committed 以下（Shove でなく Call）・相手に All-in した Player がいる（Multiway の All-in は
 * 範囲外）・potWinnerIfHeroFolds が Hero かすでに Fold した Player なら RangeError を投げる。
 */
export function icmShove(
  spot: IcmSpot,
  potWinnerIfHeroFolds: string,
  policy: IcmPolicy = ICM_POLICY,
): AllInIcmAnalysis {
  const { hero, seats } = validateSpot(spot);
  if (hero.stack === 0) {
    throw new RangeError("Hero の Stack が 0 で Shove できない");
  }
  const potWinner = activeOpponent(spot, potWinnerIfHeroFolds);
  const heroTotal = hero.committed + hero.stack;
  for (const other of seats) {
    if (other === hero || other.folded) continue;
    if (other.stack === 0 && other.committed > 0) {
      throw new RangeError(`All-in した相手がいる: ${other.playerId}`);
    }
    if (other.committed >= heroTotal) {
      throw new RangeError(
        `Hero の All-in が Shove でなく Call: ${other.playerId}`,
      );
    }
  }

  const callers = seats.filter((s) => s !== hero && !s.folded && s.stack > 0);
  return {
    decision: "shove",
    heroId: spot.heroId,
    policyVersion: policy.version,
    assumptions: assumptionsOf(potWinner.playerId),
    requirements: callers.map((villain) =>
      requirementOf(
        spot,
        villain,
        heroTotal,
        Math.min(villain.committed + villain.stack, heroTotal),
        potWinner,
        policy,
      ),
    ),
  };
}

function assumptionsOf(potWinnerIfHeroFolds: string): AllInAssumptions {
  return {
    othersFold: true,
    foldEquityIncluded: false,
    callFrequencyIncluded: false,
    potWinnerIfHeroFolds,
  };
}

/**
 * Hero と villain が heroTotal / villainTotal まで出して争い、ほかは Fold した場合の、Fold・勝ち・負けの Stack と ICM Equity から
 * 必要 Equity を出す。Pot は buildPots で組み、Hero が争えない段（相手の超過分）は相手に、相手が争えない段（Hero の超過分）は Hero に戻る。
 */
function requirementOf(
  spot: IcmSpot,
  villain: IcmSpotSeat,
  heroTotal: number,
  villainTotal: number,
  potWinnerIfHeroFolds: IcmSpotSeat,
  policy: IcmPolicy,
): AllInRequirement {
  const { seats, heroId } = spot;
  const deadMoney = spot.deadMoney ?? 0;
  const totalOf = (s: IcmSpotSeat) =>
    s.playerId === heroId
      ? heroTotal
      : s === villain
        ? villainTotal
        : s.committed;
  const contributors: PotContributor[] = seats.map((s) => ({
    playerId: s.playerId,
    totalCommitted: totalOf(s),
    folded: s.playerId !== heroId && s !== villain,
  }));
  const pots = buildPots(contributors, deadMoney);
  // Pot を配る前の手元（出した後に残る Chip）。
  const behind = seats.map((s) => s.stack + s.committed - totalOf(s));
  const potTotal = seats.reduce((sum, s) => sum + s.committed, 0) + deadMoney;

  const stacksWhen = (winner: "hero" | "villain"): IcmStack[] => {
    const won = new Map<string, number>();
    for (const pot of pots) {
      const taker =
        winner === "hero" && pot.eligible.includes(heroId)
          ? heroId
          : pot.eligible.includes(villain.playerId)
            ? villain.playerId
            : heroId;
      won.set(taker, (won.get(taker) ?? 0) + pot.amount);
    }
    return seats.map((s, i) => ({
      playerId: s.playerId,
      stack: (behind[i] as number) + (won.get(s.playerId) ?? 0),
    }));
  };
  // Fold: 誰の Chip も動かさず、今の Pot（全員の committed と Dead Money）を potWinnerIfHeroFolds が取る。
  const foldStacks = seats.map((s) => ({
    playerId: s.playerId,
    stack: s.stack + (s === potWinnerIfHeroFolds ? potTotal : 0),
  }));
  const winStacks = stacksWhen("hero");
  const loseStacks = stacksWhen("villain");

  const heroIndex = indexOf(seats, heroId);
  const chipOf = (stacks: IcmStack[]) => stacks[heroIndex]?.stack as number;
  const equityOf = (stacks: IcmStack[]) =>
    icmEquities(stacks, spot.payouts, policy).players[heroIndex]
      ?.equity as number;
  const heroStack = {
    fold: chipOf(foldStacks),
    win: chipOf(winStacks),
    lose: chipOf(loseStacks),
  };
  const heroIcmEquity = {
    fold: equityOf(foldStacks),
    win: equityOf(winStacks),
    lose: equityOf(loseStacks),
  };
  return {
    villainId: villain.playerId,
    chipEvRequiredEquity: requiredEquity(heroStack) as number,
    icmRequiredEquity: requiredEquity(heroIcmEquity),
    heroStack,
    heroIcmEquity,
  };
}

/** 損益分岐の勝率 q（q × 勝ち +（1 − q）× 負け = Fold）。勝ちと負けが同じなら null。 */
function requiredEquity(outcomes: AllInOutcomes): number | null {
  const spread = outcomes.win - outcomes.lose;
  return spread > 0 ? (outcomes.fold - outcomes.lose) / spread : null;
}

/** Spot の入力を検証し、Hero の席を返す。Stack の検証は icmEquities と同じ（committed も Chip として足す）。 */
function validateSpot(spot: IcmSpot): {
  hero: IcmSpotSeat;
  seats: readonly IcmSpotSeat[];
} {
  const { seats } = spot;
  for (const s of seats) {
    for (const [name, value] of [
      ["stack", s.stack],
      ["committed", s.committed],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} は 0 以上の整数: ${s.playerId} ${value}`);
      }
    }
  }
  const deadMoney = spot.deadMoney ?? 0;
  if (!Number.isSafeInteger(deadMoney) || deadMoney < 0) {
    throw new RangeError(`Dead Money は 0 以上の整数: ${deadMoney}`);
  }
  // 人数・playerId の重複・Chip の合計は、Hand の開始時の Stack（手元 + 出した分）で icmEquities と同じ検証をする。
  validateStacks(
    seats.map((s) => ({ playerId: s.playerId, stack: s.stack + s.committed })),
  );
  const total =
    seats.reduce((sum, s) => sum + s.stack + s.committed, 0) + deadMoney;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`Chip の合計が整数で表せない: ${total}`);
  }
  const hero = seats[indexOf(seats, spot.heroId)] as IcmSpotSeat;
  if (hero.folded) {
    throw new RangeError(`Hero がすでに Fold している: ${spot.heroId}`);
  }
  return { hero, seats };
}

/** Hero 以外のまだ Fold していない Player（相手・Fold したときに Pot を取る Player）。 */
function activeOpponent(spot: IcmSpot, playerId: string): IcmSpotSeat {
  const seat = spot.seats[indexOf(spot.seats, playerId)] as IcmSpotSeat;
  if (playerId === spot.heroId || seat.folded) {
    throw new RangeError(
      `Hero 以外のまだ Fold していない Player でない: ${playerId}`,
    );
  }
  return seat;
}

function indexOf(
  stacks: readonly { readonly playerId: string }[],
  playerId: string,
): number {
  const index = stacks.findIndex((s) => s.playerId === playerId);
  if (index < 0) throw new RangeError(`Player がいない: ${playerId}`);
  return index;
}

function validateStacks(stacks: readonly IcmStack[]): void {
  if (stacks.length < ICM_MIN_PLAYERS || stacks.length > ICM_MAX_PLAYERS) {
    throw new RangeError(
      `ICM は ${ICM_MIN_PLAYERS}〜${ICM_MAX_PLAYERS} 人: ${stacks.length} 人`,
    );
  }
  if (new Set(stacks.map((s) => s.playerId)).size !== stacks.length) {
    throw new RangeError("playerId が重複している");
  }
  for (const s of stacks) {
    if (!Number.isSafeInteger(s.stack) || s.stack < 0) {
      throw new RangeError(`Stack は 0 以上の整数: ${s.playerId} ${s.stack}`);
    }
  }
  const total = stacks.reduce((sum, s) => sum + s.stack, 0);
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`Stack の合計が整数で表せない: ${total}`);
  }
  if (total === 0) {
    throw new RangeError("Stack の合計が 0");
  }
}

/**
 * Tournament の Result（#186。順位と順位ごとの賞金）と、残っている Player の今の Stack から ICM Equity を計算する（Payout / Standings
 * との接続）。残っている Player（順位が未決で Bust していない）は 1〜残人数位を争い、賞金は result.payoutsByPlace を使う。
 * Stack をどの時点で取るか（Hand の開始時・判断時点）は呼び出し側（#188 の CPU・#189 の Review）が決める。Review で過去の判断を
 * 見るときは、その Hand より前の Hand だけから作った Result を渡す（その時点で残っていた Player と一致させる）。
 * stacks の顔ぶれが Result の残っている Player と一致しなければ RangeError を投げる。
 */
export function tournamentIcm(
  result: TournamentResult,
  stacks: readonly IcmStack[],
  policy: IcmPolicy = ICM_POLICY,
): IcmEquities {
  const alive = result.placements
    .filter((p) => p.place === null && p.eliminatedInHandId === null)
    .map((p) => p.playerId);
  const given = new Set(stacks.map((s) => s.playerId));
  if (
    alive.length !== result.remaining ||
    alive.length !== stacks.length ||
    !alive.every((id) => given.has(id))
  ) {
    throw new RangeError(
      "Stack の顔ぶれが Tournament に残っている Player と違う",
    );
  }
  return icmEquities(stacks, result.payoutsByPlace, policy);
}
