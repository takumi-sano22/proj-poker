// Decision Analysis（Pot Odds・Equity・Alternative Action の比較）と Range Model の Scenario テスト。
// 積んだ Deck で 6-max の Hand を進め、判断時点の Hero Information Set（#78）から作る値を手計算で確かめる。
// Hindsight Leak が無いこと（判断より後の Card・相手の実際の札を変えても結果が変わらない）も確かめる（不変条件 3）。
import { describe, expect, it } from "vitest";
import { cardToString } from "./card.js";
import { analyzeDecision, compareRangeProfiles } from "./decision-analysis.js";
import { DEFAULT_EQUITY_OPTIONS } from "./equity.js";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import { heroInformationSets } from "./hand-summary.js";
import type { HandState } from "./hand-state.js";
import { cardCode, handScore } from "./hand-strength.js";
import type { PlayerAction } from "./legal-actions.js";
import { STANDARD_RANGE_PROFILE, TIGHT_RANGE_PROFILE } from "./range-config.js";
import { villainRange } from "./range-model.js";
import { comboKey, parseRange, type Combo } from "./range.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { stackedDeck } from "./testing/stacked-deck.js";

// 席順 = 時計回り。Button が hero なので、Button からの距離は sb 1・bb 2・utg 3・hj 4・co 5。
const seats: SeatInit[] = ["hero", "sb", "bb", "utg", "hj", "co"].map(
  (playerId) => ({ playerId, stack: 200 }),
);

interface Hand {
  state: HandState;
  events: HandEvent[];
}

function start(coHole: string, board: string): Hand {
  const result = startHand({
    handId: "analysis",
    seats,
    buttonPlayerId: "hero",
    config: PHASE1_CASH_PRESET,
    deal: {
      deck: stackedDeck(seats, "hero", { hero: "Ah Qh", co: coHole }, board),
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return { state: result.value.state, events: [...result.value.events] };
}

function play(hand: Hand, steps: [string, PlayerAction][]): Hand {
  return steps.reduce((h, [playerId, action]) => {
    const result = applyAction(h.state, playerId, action);
    if (!result.ok) throw new Error(result.error.message);
    return {
      state: result.value.state,
      events: [...h.events, ...result.value.events],
    };
  }, hand);
}

const call: PlayerAction = { type: "call" };
const fold: PlayerAction = { type: "fold" };
const check: PlayerAction = { type: "check" };

/** CO が 6 に Open Raise、Hero（BTN）が Call、Blind は Fold。Flop Qs 7d 2c で CO が 8 を Bet し、Hero が Call する。 */
function toFlopCall(coHole: string, board: string): Hand {
  return play(start(coHole, board), [
    ["utg", fold],
    ["hj", fold],
    ["co", { type: "raise", amount: 6 }],
    ["hero", call],
    ["sb", fold],
    ["bb", fold],
    // Flop（Pot 6 + 6 + 1 + 2 = 15）
    ["co", { type: "bet", amount: 8 }],
    ["hero", call],
  ]);
}

const BOARD = "Qs 7d 2c 9h 3s";

describe("analyzeDecision: Flop で Bet に直面した判断", () => {
  const hand = play(toFlopCall("Kc Kd", BOARD), [
    // Turn 9h: 両者 Check。River 3s: CO が Bet、Hero が Fold。
    ["co", check],
    ["hero", check],
    ["co", { type: "bet", amount: 20 }],
    ["hero", fold],
  ]);
  const sets = heroInformationSets(hand.events, "hero");
  const flop = sets[1];
  if (flop === undefined) throw new Error("Flop の判断が無い");
  const analysis = analyzeDecision(flop);

  it("Pot・Call 額・Pot Odds は判断時点の KnowledgeState の math と同じ（Pot Odds の計算は 1 か所）", () => {
    // Pot = 15 + CO の Bet 8 = 23。Pot Odds = 8 /（23 + 8）= 8 / 31。
    expect(analysis.street).toBe("flop");
    expect(analysis.pot).toBe(23);
    expect(analysis.callAmount).toBe(8);
    expect(analysis.potOdds).toBe(8 / 31);
    expect(analysis.potOdds).toBe(flop.knowledge.math.potOdds);
  });

  it("相手の Range の Assumption: CO の Open Range を Card Removal し、Flop の Bet で上位半分に絞る", () => {
    expect(analysis.ranges).toHaveLength(1);
    const [co] = analysis.ranges;
    // Hero の Ah Qh と Board の Qs 7d 2c を含む Combo を除く。
    const dead = new Set(["Ah", "Qh", "Qs", "7d", "2c"]);
    const before = parseRange(STANDARD_RANGE_PROFILE.open.CO).filter(
      ([a, b]) => !dead.has(cardToString(a)) && !dead.has(cardToString(b)),
    ).length;
    expect(co).toMatchObject({
      playerId: "co",
      profileId: "standard",
      position: "CO",
      preflopSpot: "open",
      preflopNotation: STANDARD_RANGE_PROFILE.open.CO,
    });
    expect(co?.postflop).toHaveLength(1);
    expect(co?.postflop[0]).toMatchObject({
      street: "flop",
      action: "bet_or_raise",
      keep: 0.5,
      combosBefore: before,
    });
    // 同じ強さは境目でまとめて残すので、半分以上・元の数以下。
    const after = co?.postflop[0]?.combosAfter ?? 0;
    expect(after).toBeGreaterThanOrEqual(Math.ceil(before / 2));
    expect(after).toBeLessThan(before);
    expect(co?.comboCount).toBe(after);
  });

  it("Equity は Range に対する全列挙（相手 1 人の Flop）", () => {
    expect(analysis.equity?.method).toBe("exact");
    expect(analysis.equity?.seed).toBeNull();
    const equity = analysis.equity?.equity ?? -1;
    expect(equity).toBeGreaterThan(0);
    expect(equity).toBeLessThan(1);
  });

  it("Alternative Action: Fold / Call / Raise（最小・Pot Size）/ All-in の必要 Equity と簡易 EV", () => {
    const equity = analysis.equity?.equity ?? 0;
    const byKey = (action: string, to: number | null) =>
      analysis.alternatives.find(
        (a) => a.action === action && a.toAmount === to,
      );
    expect(
      analysis.alternatives.map((a) => `${a.action}:${a.toAmount ?? "-"}`),
    ).toEqual(["fold:-", "call:-", "raise:16", "raise:39", "all_in:194"]);

    expect(byKey("fold", null)).toMatchObject({
      risk: 0,
      ev: 0,
      chosen: false,
    });

    // Call: 8 を出し、取りうる Pot は 23 + 8 = 31。必要 Equity = 8 / 31（= Pot Odds）。EV = Equity × 31 − 8。
    const c = byKey("call", null);
    expect(c).toMatchObject({ risk: 8, winnablePot: 31, chosen: true });
    expect(c?.requiredEquity).toBe(8 / 31);
    expect(c?.ev).toBeCloseTo(equity * 31 - 8, 10);

    // 最小 Raise: to 16（8 + 直前の Bet 幅 8）。Hero は 16、CO が Call すると CO の Hand の Commit は 6 + 16 = 22。
    // 取りうる Pot = Hero 22 + CO 22 + SB 1 + BB 2 = 47。必要 Equity = 16 / 47。Break-even Fold = 16 /（23 + 16）。
    const minRaise = byKey("raise", 16);
    expect(minRaise).toMatchObject({ risk: 16, winnablePot: 47 });
    expect(minRaise?.requiredEquity).toBe(16 / 47);
    expect(minRaise?.breakEvenFoldFrequency).toBe(16 / 39);
    expect(minRaise?.ev).toBeCloseTo(equity * 47 - 16, 10);

    // Pot Size Raise: Call 8 の後の Pot 31 を上乗せ → to 8 + 31 = 39。
    // Hero の Commit は 6 + 39 = 45、CO も Call すると 45。取りうる Pot = 45 + 45 + 1 + 2 = 93。
    expect(byKey("raise", 39)).toMatchObject({ risk: 39, winnablePot: 93 });

    // All-in: Hero の残り 194 を全部（to 194）。CO も 194 まで Call できる（残り 186 + この Street の 8）。
    // 取りうる Pot = 200 + 200 + 1 + 2 = 403。
    expect(byKey("all_in", 194)).toMatchObject({
      risk: 194,
      winnablePot: 403,
    });
  });

  it("簡易 EV は Assumption 付きで、GTO の値として扱わない", () => {
    expect(analysis.evBasis).toBe("simplified");
    expect(analysis.assumptions.join("\n")).toContain(
      "GTO / Solver の値ではない",
    );
    expect(analysis.assumptions.join("\n")).toContain("Range");
  });

  it("同じ入力なら同じ結果（決定論）", () => {
    expect(analyzeDecision(flop)).toEqual(analysis);
  });
});

describe("analyzeDecision: Hindsight Leak が無い（不変条件 3）", () => {
  it("相手の実際の札・判断より後の Board と Action を変えても、判断時点の分析は変わらない", () => {
    // a: CO は KK、Turn 9h・River 3s で Hero が Fold。b: CO は 77（Flop で Set）、Turn Ac・River Kh で Showdown まで進む。
    const a = play(toFlopCall("Kc Kd", BOARD), [
      ["co", check],
      ["hero", check],
      ["co", { type: "bet", amount: 20 }],
      ["hero", fold],
    ]);
    const b = play(toFlopCall("7c 7h", "Qs 7d 2c Ac Kh"), [
      ["co", { type: "bet", amount: 30 }],
      ["hero", call],
      ["co", check],
      ["hero", check],
    ]);
    const flopA = heroInformationSets(a.events, "hero")[1];
    const flopB = heroInformationSets(b.events, "hero")[1];
    if (flopA === undefined || flopB === undefined) {
      throw new Error("Flop の判断が無い");
    }
    expect(analyzeDecision(flopB)).toEqual(analyzeDecision(flopA));
    expect(compareRangeProfiles(flopB)).toEqual(compareRangeProfiles(flopA));
  });

  it("Hand の途中（判断の直後）までの Event から作っても、Hand の最後までの Event から作っても同じ", () => {
    const partial = toFlopCall("Kc Kd", BOARD);
    const full = play(partial, [
      ["co", check],
      ["hero", check],
      ["co", { type: "bet", amount: 20 }],
      ["hero", fold],
    ]);
    const p = heroInformationSets(partial.events, "hero")[1];
    const f = heroInformationSets(full.events, "hero")[1];
    if (p === undefined || f === undefined) throw new Error("判断が無い");
    expect(analyzeDecision(f)).toEqual(analyzeDecision(p));
  });
});

describe("analyzeDecision: Preflop の判断（Multiway）", () => {
  it("まだ Action していない Blind は random、Open した CO は Open Range。Multiway は seed 固定の Monte Carlo", () => {
    const hand = toFlopCall("Kc Kd", BOARD);
    const preflop = heroInformationSets(hand.events, "hero")[0];
    if (preflop === undefined) throw new Error("Preflop の判断が無い");
    const analysis = analyzeDecision(preflop);
    expect(
      analysis.ranges.map(
        (r) => `${r.playerId}:${r.position}:${r.preflopSpot}`,
      ),
    ).toEqual(["sb:SB:not_acted", "bb:BB:not_acted", "co:CO:open"]);
    expect(analysis.ranges[0]?.preflopNotation).toBe("random");
    expect(analysis.equity?.method).toBe("monte_carlo");
    expect(analysis.equity?.seed).toBe(DEFAULT_EQUITY_OPTIONS.seed);
    expect(analysis.assumptions.join("\n")).toContain("Multiway");
    // Preflop: Pot 1 + 2 + 6 = 9、Call 6。Pot Odds = 6 / 15。
    expect(analysis.potOdds).toBe(6 / 15);
    const c = analysis.alternatives.find((x) => x.action === "call");
    expect(c).toMatchObject({ risk: 6, winnablePot: 15, chosen: true });
  });
});

describe("compareRangeProfiles（D08: 重要 Spot で別の Range 想定と比べる）", () => {
  it("標準・狭い・広いの想定ごとに Range と Equity を出す。狭い想定は Combo が少ない", () => {
    const hand = toFlopCall("Kc Kd", BOARD);
    const flop = heroInformationSets(hand.events, "hero")[1];
    if (flop === undefined) throw new Error("Flop の判断が無い");
    const result = compareRangeProfiles(flop);
    expect(result.map((r) => r.profileId)).toEqual([
      "standard",
      "tight",
      "loose",
    ]);
    const combos = result.map((r) => r.ranges[0]?.comboCount ?? 0);
    expect(combos[1]).toBeLessThan(combos[0] as number);
    expect(combos[0]).toBeLessThan(combos[2] as number);
    // 標準の想定は analyzeDecision と同じ Equity。
    expect(result[0]?.equity).toEqual(analyzeDecision(flop).equity);
    // 想定を渡せば、その Profile で分析できる。
    expect(
      analyzeDecision(flop, { profile: TIGHT_RANGE_PROFILE }).ranges[0]
        ?.profileId,
    ).toBe("tight");
  });
});

describe("villainRange: Postflop の絞り込み", () => {
  it("残した Combo は、外した Combo より Board での役が弱くない", () => {
    const hand = toFlopCall("Kc Kd", BOARD);
    const flop = heroInformationSets(hand.events, "hero")[1];
    if (flop === undefined) throw new Error("Flop の判断が無い");
    const knowledge = flop.knowledge;
    const narrowed = villainRange(knowledge, "co");
    const kept = new Set(narrowed.combos.map(comboKey));
    const dead = new Set(
      [...(knowledge.holeCards ?? []), ...knowledge.board].map(cardToString),
    );
    const board = knowledge.board.map(cardCode);
    const score = ([a, b]: Combo) =>
      handScore([cardCode(a), cardCode(b), ...board]);
    const all = parseRange(STANDARD_RANGE_PROFILE.open.CO).filter(
      ([a, b]) => !dead.has(cardToString(a)) && !dead.has(cardToString(b)),
    );
    const keptScores = all.filter((c) => kept.has(comboKey(c))).map(score);
    const droppedScores = all.filter((c) => !kept.has(comboKey(c))).map(score);
    expect(droppedScores.length).toBeGreaterThan(0);
    expect(Math.min(...keptScores)).toBeGreaterThan(Math.max(...droppedScores));
  });

  it("Hero 自身や卓にいない Player の Range は作らない", () => {
    const hand = toFlopCall("Kc Kd", BOARD);
    const flop = heroInformationSets(hand.events, "hero")[1];
    if (flop === undefined) throw new Error("Flop の判断が無い");
    expect(() => villainRange(flop.knowledge, "hero")).toThrow(RangeError);
    expect(() => villainRange(flop.knowledge, "nobody")).toThrow(RangeError);
  });
});
