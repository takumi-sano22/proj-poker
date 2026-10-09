// Tournament の Review Evidence（D109・D130・#189）のテスト。Claude は呼ばない。
// - 値は Engine の ICM Calculator（icm.ts）と同じ計算を、判断時点の Stack から作り、Evidence に出すときだけ丸める
// - 判断時点の ICM Equity は常に出し、All-in の関わる判断では Chip EV と ICM の必要 Equity を別の項目・別の id で並べる
// - Shove は Call しうる相手ごとの条件付きで、Fold Equity・Call の頻度を含めない前提を Evidence に明記する
// - Multiway の All-in は範囲外（out_of_scope）で、Evidence Sufficiency Gate が Review AI を呼ばない
// - 判断より後の Event・見えない Event（他者の札・Deck）を変えても値は変わらない（Pass A の情報境界）
// - Cash の Hand の Evidence は Tournament の項目を持たない（Prompt を #189 より前と同じに保つ）
import {
  createDeck,
  heroInformationSets,
  icmCallAllIn,
  icmEquities,
  icmShove,
  isVisibleTo,
  type HandEvent,
  type HeroInformationSet,
  type TournamentSessionInfo,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import { forbiddenKeys, leakedCards } from "../testing/leaks.js";
import {
  BTN_VS_UTG,
  BUBBLE_CALL,
  BUBBLE_SHOVE,
  playScriptedHand,
  tournamentSessionOf,
  type ScriptedHand,
} from "../testing/review-eval/hands.js";
import {
  buildReviewEvidence,
  evidenceIdsOf,
  reviewSpotReasons,
} from "./evidence.js";
import { generateReview } from "./generate.js";
import { toPlayerNames } from "./identifiers.js";
import { checkEvidenceSufficiency } from "./sufficiency.js";
import {
  REVIEW_TOURNAMENT_POLICY,
  buildTournamentEvidence,
} from "./tournament-evidence.js";
import type { ReviewEvidence } from "./types.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});
const names = toPlayerNames(PHASE1_TABLE_SETUP.players);

const setOf = (events: readonly HandEvent[], index = 0): HeroInformationSet =>
  heroInformationSets(events, "hero")[index] as HeroInformationSet;

async function evidenceOf(
  hand: ScriptedHand,
  index = 0,
  events: readonly HandEvent[] = playScriptedHand(hand),
): Promise<ReviewEvidence> {
  const sets = heroInformationSets(events, "hero");
  const tournament = tournamentSessionOf(hand);
  return buildReviewEvidence(
    sets[index] as HeroInformationSet,
    reviewSpotReasons(sets, index, tournament),
    {
      kb,
      solver,
      playerNames: names,
      ...(tournament === undefined ? {} : { tournament }),
    },
  );
}

/** Bubble の 4 人で、UTG と BTN が All-in し、BB の Hero が 2 つの All-in に直面する（Multiway の All-in。ICM の範囲外）。 */
const MULTIWAY_ALL_IN: ScriptedHand = {
  ...BUBBLE_CALL,
  id: "bubble_multiway_all_in",
  script: [
    ["cpu1", { type: "all_in" }],
    ["cpu2", { type: "all_in" }],
    ["cpu3", { type: "fold" }],
    ["hero", { type: "call" }],
  ],
};

/** Bubble の 4 人で、UTG の Min Raise に BTN の Hero（1,500）が Call する（All-in の関わらない判断）。 */
const BUBBLE_FLAT: ScriptedHand = {
  ...BUBBLE_SHOVE,
  id: "bubble_flat",
  script: [
    ["cpu3", { type: "raise", amount: 300 }],
    ["hero", { type: "call" }],
    ["cpu1", { type: "fold" }],
    ["cpu2", { type: "fold" }],
    ["cpu3", { type: "check" }],
    ["hero", { type: "check" }],
    ["cpu3", { type: "check" }],
    ["hero", { type: "check" }],
    ["cpu3", { type: "check" }],
    ["hero", { type: "check" }],
  ],
};

const round1 = (v: number) => Math.round(v * 10) / 10;
const percent1 = (v: number) => Math.round(v * 1000) / 10;

describe("buildTournamentEvidence: 判断時点の ICM Equity", () => {
  it("公開の状況（残人数・Level・Ante・Payout・Stage）と、判断時点の Stack（手元 + この Hand で出した額）の ICM Equity を常に出す", async () => {
    const evidence = await evidenceOf(BUBBLE_FLAT);
    const t = evidence.tournament;
    if (t === undefined) throw new Error("Tournament の Evidence が無い");
    expect(t.id).toBe("tournament:review-bubble_flat/d0");
    expect(t.tournamentPolicyVersion).toBe(REVIEW_TOURNAMENT_POLICY.version);
    expect([t.entrants, t.remaining, t.level, t.handNumber]).toEqual([
      6, 4, 5, 41,
    ]);
    expect([t.anteKind, t.ante]).toEqual(["big_blind_ante", 150]);
    expect([t.prizePool, t.payoutsByPlace, t.stage]).toEqual([
      600,
      [300, 180, 120],
      "bubble",
    ]);
    // All-in の関わらない判断は、必要 Equity を出さない（ICM Equity だけ）。
    expect(t.allIn).toBeNull();

    // 判断時点（Hero の Call の前）: UTG は 300 を出し、BB の Ante 150 は誰の Commit にも数えない Dead Money。
    const knowledge = setOf(playScriptedHand(BUBBLE_FLAT)).knowledge;
    const stacks = knowledge.seats.map((s) => ({
      playerId: s.playerId,
      stack: s.stack + s.totalCommitted,
    }));
    expect(stacks).toEqual([
      { playerId: "hero", stack: 1_500 },
      { playerId: "cpu1", stack: 3_000 },
      { playerId: "cpu2", stack: 2_350 },
      { playerId: "cpu3", stack: 2_000 },
    ]);
    const icm = icmEquities(stacks, [300, 180, 120]);
    expect(t.icm.id).toBe("icm:review-bubble_flat/d0");
    expect(t.icm.stackBasis).toBe("decision_point");
    expect(t.icm.seats).toEqual(
      icm.players.map((p) => ({
        playerId: p.playerId,
        displayName: names[p.playerId],
        isHero: p.playerId === "hero",
        icmStack: p.stack,
        stackBb: round1(p.stack / 150),
        icmEquity: round1(p.equity),
        icmEquityPercent: round1(p.equityPercent),
      })),
    );
    // Bubble で 10BB の Hero は、Bubble と Short Stack の Important Spot（Cash と共通の理由は無い）。
    expect(evidence.context.importantSpotReasons).toEqual([
      "bubble",
      "short_stack",
    ]);
  });
});

describe("buildTournamentEvidence: All-in の Chip EV と ICM の必要 Equity（D130）", () => {
  it("All-in への Call: 相手 1 人で、Chip EV（Pot Odds と同じ）と ICM の必要 Equity を別の id で並べる", async () => {
    const evidence = await evidenceOf(BUBBLE_CALL);
    const allIn = evidence.tournament?.allIn;
    if (allIn?.status !== "available") throw new Error("必要 Equity が無い");
    expect(allIn.decision).toBe("call_all_in");
    expect(allIn.assumptions).toMatchObject({
      othersFold: true,
      foldEquityIncluded: false,
      callFrequencyIncluded: false,
      potWinnerIfHeroFolds: "cpu2",
    });
    const [r] = allIn.requirements;
    if (r === undefined) throw new Error("相手が無い");
    expect(allIn.requirements).toHaveLength(1);
    expect(r.villainId).toBe("cpu2");
    expect(r.chipEv.id).toBe("chipev:review-bubble_call/d0/cpu2");
    expect(r.icm.id).toBe("icmreq:review-bubble_call/d0/cpu2");
    expect(r.chipEv.id).not.toBe(r.icm.id);

    // 値は Engine の icmCallAllIn と同じ計算（丸めるのは Evidence に出すときだけ）。
    const set = setOf(playScriptedHand(BUBBLE_CALL));
    const k = set.knowledge;
    const engine = icmCallAllIn(
      {
        seats: k.seats.map((s) => ({
          playerId: s.playerId,
          stack: s.stack,
          committed: s.totalCommitted,
          folded: s.folded,
        })),
        deadMoney: 150,
        payouts: [300, 180, 120],
        heroId: "hero",
      },
      "cpu2",
    ).requirements[0];
    if (engine === undefined) throw new Error("Engine の値が無い");
    expect(r.chipEv.requiredEquityPercent).toBe(
      percent1(engine.chipEvRequiredEquity),
    );
    expect(r.icm.requiredEquityPercent).toBe(
      percent1(engine.icmRequiredEquity as number),
    );
    expect(r.chipEv.heroStack).toEqual(engine.heroStack);
    // All-in への Call の Chip EV の必要 Equity は、Math Evidence の Pot Odds と一致する。
    expect(r.chipEv.requiredEquityPercent).toBe(
      percent1(evidence.math.potOdds as number),
    );
    // Bubble では ICM の必要 Equity が Chip EV より高い（負けの痛みが大きい）。
    expect(r.icm.requiredEquityPercent as number).toBeGreaterThan(
      r.chipEv.requiredEquityPercent,
    );
  });

  it("Shove: Call しうる相手ごとに条件付きで出し、Hero が Fold した比較点の Pot を取る Player と前提を明記する", async () => {
    const evidence = await evidenceOf(BUBBLE_SHOVE);
    const allIn = evidence.tournament?.allIn;
    if (allIn?.status !== "available") throw new Error("必要 Equity が無い");
    expect(allIn.decision).toBe("shove");
    // UTG は Fold 済み。Call しうるのは SB（CPU 1）と BB（CPU 2）。比較点では出した額が最も大きい BB が Pot を取る。
    expect(allIn.requirements.map((r) => r.villainId)).toEqual([
      "cpu1",
      "cpu2",
    ]);
    expect(allIn.assumptions.potWinnerIfHeroFolds).toBe("cpu2");
    expect(allIn.assumptions.notes.join("\n")).toContain(
      "その 1 人に Call され、ほかは Fold した場合",
    );
    expect(allIn.assumptions.notes.join("\n")).toContain(
      "Fold Equity）と Call の頻度は含めない",
    );
    expect(allIn.assumptions.notes.join("\n")).toContain("CPU 2 が今の Pot");

    const k = setOf(playScriptedHand(BUBBLE_SHOVE)).knowledge;
    const engine = icmShove(
      {
        seats: k.seats.map((s) => ({
          playerId: s.playerId,
          stack: s.stack,
          committed: s.totalCommitted,
          folded: s.folded,
        })),
        deadMoney: 150,
        payouts: [300, 180, 120],
        heroId: "hero",
      },
      "cpu2",
    );
    expect(
      allIn.requirements.map((r) => [
        r.chipEv.requiredEquityPercent,
        r.icm.requiredEquityPercent,
      ]),
    ).toEqual(
      engine.requirements.map((r) => [
        percent1(r.chipEvRequiredEquity),
        percent1(r.icmRequiredEquity as number),
      ]),
    );
    expect(evidence.context.importantSpotReasons).toEqual([
      "all_in",
      "bubble",
      "short_stack",
    ]);
  });

  it("Multiway の All-in は範囲外（out_of_scope）で、Evidence Sufficiency Gate が Review AI を呼ばずに Insufficient Evidence にする", async () => {
    const evidence = await evidenceOf(MULTIWAY_ALL_IN);
    expect(evidence.tournament?.allIn).toMatchObject({
      status: "out_of_scope",
      decision: "call_all_in",
    });
    expect(checkEvidenceSufficiency(evidence)).toEqual({
      sufficient: false,
      missing: ["tournament_icm"],
    });
    const draft = await generateReview(evidence, {
      depth: "standard",
      actionSeq: 1,
      env: {},
      query: () => {
        throw new Error("Review AI を呼んではいけない");
      },
    });
    expect(draft.generatedBy).toBe("sufficiency_gate");
    expect(draft.assessment).toBe("insufficient_evidence");
    // 範囲外の判断には必要 Equity の id が無い（Evidence の id は状況と ICM Equity だけ）。
    expect(evidenceIdsOf(evidence).tournament).toEqual([
      "tournament:review-bubble_multiway_all_in/d0",
      "icm:review-bubble_multiway_all_in/d0",
    ]);
  });

  it("Evidence の id は Tournament の項目に種類ごとに残り、Review AI が挙げてよい id になる", async () => {
    const evidence = await evidenceOf(BUBBLE_SHOVE);
    expect(evidenceIdsOf(evidence).tournament).toEqual([
      "tournament:review-bubble_shove/d0",
      "icm:review-bubble_shove/d0",
      "chipev:review-bubble_shove/d0/cpu1",
      "icmreq:review-bubble_shove/d0/cpu1",
      "chipev:review-bubble_shove/d0/cpu2",
      "icmreq:review-bubble_shove/d0/cpu2",
    ]);
  });
});

describe("Tournament の Evidence の情報境界（Pass A）", () => {
  /** Hero に見えない Event の中身（他者の札・Deck）を差し替える。 */
  function tamperHidden(events: readonly HandEvent[]): HandEvent[] {
    const reversed = createDeck().reverse();
    return events.map((e) => {
      if (isVisibleTo(e, "hero")) return e;
      switch (e.type) {
        case "HOLE_CARD_DEALT":
          return { ...e, cards: reversed.slice(0, 2) };
        case "DECK_SHUFFLED":
          return { ...e, seed: 999, deck: reversed };
        default:
          return e;
      }
    });
  }

  it("判断より後の Event を切り落としても、見えない Event を差し替えても、Tournament の Evidence は変わらない", () => {
    const events = playScriptedHand(BUBBLE_CALL);
    const set = setOf(events);
    const session = tournamentSessionOf(BUBBLE_CALL) as TournamentSessionInfo;
    const full = buildTournamentEvidence(set, session, "p", names);
    const cut = events.filter((e) => e.seq <= set.decision.decisionPointSeq);
    // 判断の直後で切った Log（Hand が終わっていない）からも、同じ判断の Information Set が作れる。
    const cutSet = setOf([
      ...cut,
      ...events.filter((e) => e.seq === set.decision.actionSeq),
    ]);
    expect(buildTournamentEvidence(cutSet, session, "p", names)).toEqual(full);
    expect(
      buildTournamentEvidence(setOf(tamperHidden(events)), session, "p", names),
    ).toEqual(full);
  });

  it("Evidence に他者の札・未来の Card・Deck・seed・system の Event が入らない", async () => {
    for (const hand of [BUBBLE_SHOVE, BUBBLE_CALL]) {
      const events = playScriptedHand(hand);
      const evidence = await evidenceOf(hand, 0, events);
      const upto = setOf(events).decision.decisionPointSeq;
      expect(leakedCards(evidence, events, "hero", upto)).toEqual([]);
      expect(
        forbiddenKeys({
          ...evidence,
          knowledge: { ...evidence.knowledge, items: [] },
        }),
      ).toEqual([]);
    }
  });
});

describe("Cash の Hand の Evidence は変えない", () => {
  it("Session の情報を渡さない（Cash）なら Tournament の項目・id・Important Spot の理由を持たない", async () => {
    const evidence = await evidenceOf(BTN_VS_UTG, 3);
    expect("tournament" in evidence).toBe(false);
    expect("tournament" in evidenceIdsOf(evidence)).toBe(false);
    // Cash と共通の理由だけ（extractImportantSpots と同じ）。
    expect(evidence.context.importantSpotReasons).toEqual([
      "big_pot",
      "river_big_bet",
    ]);
  });
});
