// 決定論の ICM Calculator の Scenario Regression（D109・D130・docs/02 §7・#187）。期待値は手計算（Malmuth-Harville）。
// Equity・必要 Equity は倍精度で丸めずに返すので、比較は toBeCloseTo（小数第 9 位まで）で行う（docs/02 §7 の許容誤差）。
import { describe, expect, it } from "vitest";
import {
  ICM_POLICY,
  bubbleFactors,
  icmCallAllIn,
  icmEquities,
  icmShove,
  tournamentIcm,
  type IcmSpotSeat,
  type IcmStack,
} from "./icm.js";
import type { TournamentResult } from "./tournament-payout.js";

const DIGITS = 9;
/** 標準 6-max STT の賞金（600pt を 50 / 30 / 20。D127）。 */
const STANDARD = [300, 180, 120];

function stacksOf(...amounts: number[]): IcmStack[] {
  return amounts.map((stack, i) => ({ playerId: `p${i + 1}`, stack }));
}

function equitiesOf(stacks: IcmStack[], payouts: number[]): number[] {
  return icmEquities(stacks, payouts).players.map((p) => p.equity);
}

function seat(
  playerId: string,
  stack: number,
  committed = 0,
  folded = false,
): IcmSpotSeat {
  return { playerId, stack, committed, folded };
}

describe("icmEquities: 手計算の Scenario", () => {
  it("2 人（1,000 / 500）・3 位まで入賞: 1〜2 位の 300 / 180 を争い 260 / 220（3 位の 120 は Bust した Player のもの）", () => {
    const result = icmEquities(stacksOf(1000, 500), STANDARD);
    expect(result.prizePool).toBe(480);
    expect(result.policyVersion).toBe(ICM_POLICY.version);
    expect(result.method).toBe("malmuth_harville");
    // 1,000 の側: 2/3 × 300 + 1/3 × 180 = 260。500 の側: 1/3 × 300 + 2/3 × 180 = 220。
    const [a, b] = result.players;
    expect(a?.equity).toBeCloseTo(260, DIGITS);
    expect(b?.equity).toBeCloseTo(220, DIGITS);
    expect(a?.equityPercent).toBeCloseTo((260 / 480) * 100, DIGITS);
    expect(b?.equityPercent).toBeCloseTo((220 / 480) * 100, DIGITS);
  });

  it("3 人（50 / 30 / 20）: 1 位から Stack に比例して順に決める", () => {
    const [a, b, c] = equitiesOf(stacksOf(50, 30, 20), STANDARD);
    // p1: 1 位 1/2・2 位 19/56（p2 → p1: 3/10 × 50/70、p3 → p1: 2/10 × 50/80）・3 位 9/56。
    expect(a).toBeCloseTo(150 + (180 * 19) / 56 + (120 * 9) / 56, DIGITS);
    // p2: 1 位 3/10・2 位 3/8（1/2 × 30/50 + 1/5 × 30/80）・3 位 13/40。
    expect(b).toBeCloseTo(90 + (180 * 3) / 8 + (120 * 13) / 40, DIGITS);
    // p3: 1 位 1/5・2 位 2/7（1/2 × 20/50 + 3/10 × 20/70）・3 位 18/35。
    expect(c).toBeCloseTo(60 + (180 * 2) / 7 + (120 * 18) / 35, DIGITS);
    expect((a ?? 0) + (b ?? 0) + (c ?? 0)).toBeCloseTo(600, DIGITS);
  });

  it("同額の Stack は同じ Equity（3 人同額は 600 / 3 = 200）", () => {
    for (const equity of equitiesOf(stacksOf(1500, 1500, 1500), STANDARD)) {
      expect(equity).toBeCloseTo(200, DIGITS);
    }
  });

  it("Winner Take All は Chip に比例する（Chip EV と同じ）", () => {
    const [a, b, c] = equitiesOf(stacksOf(600, 300, 100), [1000]);
    expect(a).toBeCloseTo(600, DIGITS);
    expect(b).toBeCloseTo(300, DIGITS);
    expect(c).toBeCloseTo(100, DIGITS);
  });

  it("Stack 0 は最下位。Stack 0 が複数ならその順位の賞金を等分する", () => {
    // 1 人が 0: 0 の Player は 3 位（120）、残り 2 人で 300 / 180 を半々。
    const one = equitiesOf(stacksOf(100, 100, 0), STANDARD);
    expect(one[0]).toBeCloseTo(240, DIGITS);
    expect(one[1]).toBeCloseTo(240, DIGITS);
    expect(one[2]).toBeCloseTo(120, DIGITS);
    // 2 人が 0: 2 位と 3 位の (180 + 120) / 2 = 150 ずつ（同順位の等分と同じ値）。
    const two = equitiesOf(stacksOf(100, 0, 0), STANDARD);
    expect(two[0]).toBeCloseTo(300, DIGITS);
    expect(two[1]).toBeCloseTo(150, DIGITS);
    expect(two[2]).toBeCloseTo(150, DIGITS);
  });

  it("賞金の列が人数より短ければ、足りない順位は 0（4 人で 3 位まで）", () => {
    const result = icmEquities(stacksOf(1, 1, 1, 1), STANDARD);
    expect(result.prizePool).toBe(600);
    for (const p of result.players) {
      expect(p.equity).toBeCloseTo(150, DIGITS);
      expect(p.equityPercent).toBeCloseTo(25, DIGITS);
    }
  });

  it("2〜8 人以外・重複・負や小数の Stack・合計 0・賞金の不正は拒否する", () => {
    expect(() => icmEquities(stacksOf(100), STANDARD)).toThrow(RangeError);
    expect(() =>
      icmEquities(stacksOf(1, 1, 1, 1, 1, 1, 1, 1, 1), STANDARD),
    ).toThrow(RangeError);
    expect(() =>
      icmEquities(
        [
          { playerId: "a", stack: 1 },
          { playerId: "a", stack: 2 },
        ],
        STANDARD,
      ),
    ).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(10, -1), STANDARD)).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(10, 1.5), STANDARD)).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(0, 0), STANDARD)).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(10, 10), [])).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(10, 10), [100, -1])).toThrow(RangeError);
    // 賞金は pt の整数（payoutsByPlace の出力）。小数・合計が安全な整数を超える額は拒否する。
    expect(() => icmEquities(stacksOf(10, 10), [50.5, 49.5])).toThrow(
      RangeError,
    );
    expect(() =>
      icmEquities(stacksOf(10, 10), [
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ]),
    ).toThrow(RangeError);
    expect(() => icmEquities(stacksOf(10, 10), [0, 0, 100])).toThrow(
      RangeError,
    );
  });

  it("8 人を扱える（Σ Equity = Prize Pool）", () => {
    const result = icmEquities(
      stacksOf(4000, 2500, 1500, 900, 600, 300, 150, 50),
      [500, 250, 150, 100],
    );
    const sum = result.players.reduce((s, p) => s + p.equity, 0);
    expect(sum).toBeCloseTo(1000, DIGITS);
  });
});

describe("bubbleFactors（D130）", () => {
  it("Heads-Up は ICM が Chip に比例するので Bubble Factor は 1", () => {
    const [factor] = bubbleFactors(stacksOf(1000, 500), STANDARD, "p1");
    expect(factor?.opponentId).toBe("p2");
    expect(factor?.riskedChips).toBe(500);
    expect(factor?.bubbleFactor).toBeCloseTo(1, DIGITS);
  });

  it("3 人同額（20 / 20 / 20）: 負けで 200 → 120、勝ちで 200 → 260 なので 80 / 60 = 4/3", () => {
    const factors = bubbleFactors(stacksOf(20, 20, 20), STANDARD, "p1");
    expect(factors.map((f) => f.opponentId)).toEqual(["p2", "p3"]);
    for (const f of factors) {
      expect(f.riskedChips).toBe(20);
      expect(f.bubbleFactor).toBeCloseTo(4 / 3, DIGITS);
    }
  });

  it("Stack 0 の相手・勝っても Equity が増えないときは null", () => {
    const zero = bubbleFactors(stacksOf(100, 0, 50), STANDARD, "p1");
    expect(zero[0]).toEqual({
      opponentId: "p2",
      riskedChips: 0,
      bubbleFactor: null,
    });
    expect(zero[1]?.bubbleFactor).not.toBeNull();
    // 全順位の賞金が同じなら勝っても負けても Equity は変わらない。
    const flat = bubbleFactors(stacksOf(10, 10, 10), [100, 100, 100], "p1");
    expect(flat.every((f) => f.bubbleFactor === null)).toBe(true);
  });

  it("Hero がいなければ拒否する", () => {
    expect(() => bubbleFactors(stacksOf(10, 10), STANDARD, "x")).toThrow(
      RangeError,
    );
  });
});

/** 3 人で 1〜2 位だけ入賞（3 人目が Bubble）。 */
const BUBBLE = [300, 180];

describe("icmCallAllIn（D130）", () => {
  it("同額 3 人・Dead Money なしの All-in への Call: Chip EV は 1/2、ICM は 160 / 260 = 8/13", () => {
    const analysis = icmCallAllIn(
      {
        seats: [seat("hero", 20), seat("v", 0, 20), seat("t", 20, 0, true)],
        payouts: BUBBLE,
        heroId: "hero",
      },
      "v",
    );
    expect(analysis.decision).toBe("call_all_in");
    expect(analysis.assumptions).toEqual({
      othersFold: true,
      foldEquityIncluded: false,
      callFrequencyIncluded: false,
      potWinnerIfHeroFolds: "v",
    });
    const [req] = analysis.requirements;
    expect(req?.villainId).toBe("v");
    expect(req?.heroStack).toEqual({ fold: 20, win: 40, lose: 0 });
    // Fold: 3 人 20 で 160。勝ち: 40 / 0 / 20 で 2/3 × 300 + 1/3 × 180 = 260。負け: 3 位で 0。
    expect(req?.heroIcmEquity.fold).toBeCloseTo(160, DIGITS);
    expect(req?.heroIcmEquity.win).toBeCloseTo(260, DIGITS);
    expect(req?.heroIcmEquity.lose).toBeCloseTo(0, DIGITS);
    expect(req?.chipEvRequiredEquity).toBe(0.5);
    expect(req?.icmRequiredEquity).toBeCloseTo(8 / 13, DIGITS);
  });

  it("Blind の Dead Money あり: Chip EV は Pot Odds（18 / 41）、ICM は Fold・勝ちの Equity から", () => {
    // BB の Hero（2 を出して 18 残り）が、SB（1 を出して Fold）の後に All-in 20 の相手へ Call するか。
    const analysis = icmCallAllIn(
      {
        seats: [seat("hero", 18, 2), seat("v", 0, 20), seat("sb", 19, 1, true)],
        payouts: BUBBLE,
        heroId: "hero",
      },
      "v",
    );
    const [req] = analysis.requirements;
    expect(req?.heroStack).toEqual({ fold: 18, win: 41, lose: 0 });
    expect(req?.chipEvRequiredEquity).toBe(18 / 41);
    // Fold: hero 18 / sb 19 / v 23。hero の 2 位は sb → hero（19/60 × 18/41）か v → hero（23/60 × 18/37）。
    const fold =
      (300 * 18) / 60 + 180 * ((19 * 18) / (60 * 41) + (23 * 18) / (60 * 37));
    // 勝ち: hero 41 / sb 19 / v 0。hero は 1 位か、sb が 1 位なら 2 位。
    const win = (300 * 41) / 60 + (180 * 19) / 60;
    expect(req?.heroIcmEquity.fold).toBeCloseTo(fold, DIGITS);
    expect(req?.heroIcmEquity.win).toBeCloseTo(win, DIGITS);
    expect(req?.heroIcmEquity.lose).toBeCloseTo(0, DIGITS);
    expect(req?.icmRequiredEquity).toBeCloseTo(fold / win, DIGITS);
  });

  it("Hero の Stack が相手の Bet に足りなければ All-in の Call で、相手の超過分は相手に戻る", () => {
    // 相手は 30 を出していて 10 残り。Hero は 20 しかない（Call すると All-in）。
    const analysis = icmCallAllIn(
      {
        seats: [seat("hero", 20), seat("v", 10, 30), seat("t", 30, 0, true)],
        payouts: BUBBLE,
        heroId: "hero",
      },
      "v",
    );
    const [req] = analysis.requirements;
    // 勝ち: 20 + 20 = 40（相手の超過 10 は相手へ）。負け: 0。Fold: 20。
    expect(req?.heroStack).toEqual({ fold: 20, win: 40, lose: 0 });
    expect(req?.chipEvRequiredEquity).toBe(0.5);
  });

  it("All-in の判断でない・Call するものが無い・Multiway の All-in は拒否する", () => {
    const payouts = BUBBLE;
    // 相手も Hero も All-in にならない。
    expect(() =>
      icmCallAllIn(
        {
          seats: [seat("hero", 50), seat("v", 40, 10), seat("t", 60)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
    // Call するものが無い。
    expect(() =>
      icmCallAllIn(
        {
          seats: [seat("hero", 50, 10), seat("v", 0, 10), seat("t", 60)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
    // もう 1 人 All-in している（Multiway の All-in）。
    expect(() =>
      icmCallAllIn(
        {
          seats: [seat("hero", 50), seat("v", 0, 20), seat("t", 0, 15)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
    // もう 1 人がすでに相手の Bet に揃えている。
    expect(() =>
      icmCallAllIn(
        {
          seats: [seat("hero", 50), seat("v", 0, 20), seat("t", 30, 20)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
    // 相手が Fold している・Hero 自身。
    expect(() =>
      icmCallAllIn(
        {
          seats: [seat("hero", 50), seat("v", 0, 20, true), seat("t", 30)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
  });
});

describe("icmShove（D130）", () => {
  it("SB の Shove を BB が Call した場合の条件付き: Chip EV は 19 / 40、ICM は Fold（BB が Pot を取る）と勝ちの Equity から", () => {
    const analysis = icmShove(
      {
        seats: [
          seat("btn", 20, 0, true),
          seat("hero", 19, 1),
          seat("bb", 18, 2),
        ],
        payouts: BUBBLE,
        heroId: "hero",
      },
      "bb",
    );
    expect(analysis.decision).toBe("shove");
    expect(analysis.assumptions).toEqual({
      othersFold: true,
      foldEquityIncluded: false,
      callFrequencyIncluded: false,
      potWinnerIfHeroFolds: "bb",
    });
    // Fold 済みの btn は Call しうる相手でない。
    expect(analysis.requirements.map((r) => r.villainId)).toEqual(["bb"]);
    const [req] = analysis.requirements;
    expect(req?.heroStack).toEqual({ fold: 19, win: 40, lose: 0 });
    expect(req?.chipEvRequiredEquity).toBe(19 / 40);
    // Fold: btn 20 / hero 19 / bb 21。hero の 2 位は btn → hero（20/60 × 19/40）か bb → hero（21/60 × 19/39）。
    const fold =
      (300 * 19) / 60 + 180 * ((20 * 19) / (60 * 40) + (21 * 19) / (60 * 39));
    // 勝ち: btn 20 / hero 40 / bb 0。
    const win = (300 * 40) / 60 + (180 * 20) / 60;
    expect(req?.heroIcmEquity.fold).toBeCloseTo(fold, DIGITS);
    expect(req?.heroIcmEquity.win).toBeCloseTo(win, DIGITS);
    expect(req?.icmRequiredEquity).toBeCloseTo(fold / win, DIGITS);
  });

  it("まだ Action していない相手ごとに出し、相手の Stack が足りなければ Hero の超過分は Hero に戻る", () => {
    const analysis = icmShove(
      {
        seats: [seat("hero", 30), seat("short", 10), seat("big", 50)],
        payouts: BUBBLE,
        heroId: "hero",
      },
      "big",
    );
    expect(analysis.requirements.map((r) => r.villainId)).toEqual([
      "short",
      "big",
    ]);
    const [short, big] = analysis.requirements;
    // short に Call されると 10 だけ争う: 勝ち 40・負け 20（超過 20 が戻る）・Fold 30 → 10 / 20。
    expect(short?.heroStack).toEqual({ fold: 30, win: 40, lose: 20 });
    expect(short?.chipEvRequiredEquity).toBe(0.5);
    // big に Call されると 30 を争う: 勝ち 60・負け 0・Fold 30。
    expect(big?.heroStack).toEqual({ fold: 30, win: 60, lose: 0 });
    expect(big?.chipEvRequiredEquity).toBe(0.5);
    // 3 人で 1〜2 位だけ入賞: 全部失うと Bubble で 0 になるので、ICM の必要 Equity は Chip EV より高い。
    expect(big?.icmRequiredEquity).toBeGreaterThan(0.5);
  });

  it("Call ではない Shove・All-in した相手がいる・比較点の Player が不正なら拒否する", () => {
    const payouts = BUBBLE;
    // 相手の Bet が Hero の全額以上（Shove でなく Call）。
    expect(() =>
      icmShove(
        {
          seats: [seat("hero", 10, 0), seat("v", 20, 10), seat("t", 30)],
          payouts,
          heroId: "hero",
        },
        "v",
      ),
    ).toThrow(RangeError);
    // All-in した相手がいる。
    expect(() =>
      icmShove(
        {
          seats: [seat("hero", 50), seat("v", 0, 20), seat("t", 30)],
          payouts,
          heroId: "hero",
        },
        "t",
      ),
    ).toThrow(RangeError);
    // 比較点の Player が Hero・Fold 済み。
    expect(() =>
      icmShove(
        {
          seats: [seat("hero", 50), seat("v", 20), seat("t", 30, 0, true)],
          payouts,
          heroId: "hero",
        },
        "hero",
      ),
    ).toThrow(RangeError);
    expect(() =>
      icmShove(
        {
          seats: [seat("hero", 50), seat("v", 20), seat("t", 30, 0, true)],
          payouts,
          heroId: "hero",
        },
        "t",
      ),
    ).toThrow(RangeError);
  });
});

describe("tournamentIcm（Payout / Standings との接続）", () => {
  const result: TournamentResult = {
    status: "in_progress",
    entrants: 4,
    remaining: 2,
    entryFee: 100,
    prizePool: 400,
    payoutPolicyVersion: "phase8_provisional_v1",
    payoutsByPlace: [200, 120, 80],
    placements: [
      { playerId: "a", place: null, eliminatedInHandId: null, payout: null },
      { playerId: "b", place: 4, eliminatedInHandId: "h1", payout: 0 },
      { playerId: "c", place: null, eliminatedInHandId: null, payout: null },
      { playerId: "d", place: 3, eliminatedInHandId: "h2", payout: 80 },
    ],
  };

  it("残っている Player が 1〜残人数位の賞金を争う（3 位の 80 は Bust した Player のもの）", () => {
    const icm = tournamentIcm(result, [
      { playerId: "c", stack: 1000 },
      { playerId: "a", stack: 3000 },
    ]);
    expect(icm.prizePool).toBe(320);
    // c: 1/4 × 200 + 3/4 × 120 = 140。a: 3/4 × 200 + 1/4 × 120 = 180。
    expect(icm.players[0]?.equity).toBeCloseTo(140, DIGITS);
    expect(icm.players[1]?.equity).toBeCloseTo(180, DIGITS);
  });

  it("Stack の顔ぶれが残っている Player と違えば拒否する", () => {
    expect(() =>
      tournamentIcm(result, [
        { playerId: "a", stack: 1000 },
        { playerId: "b", stack: 1000 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      tournamentIcm(result, [
        { playerId: "a", stack: 1000 },
        { playerId: "c", stack: 1000 },
        { playerId: "d", stack: 1000 },
      ]),
    ).toThrow(RangeError);
  });
});
