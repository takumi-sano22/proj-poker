// Tournament の Review（D109・D130・#189）の Prompt・Grounding・Service のテスト。Claude は呼ばない（Fake。D87）。
// - Tournament の Evidence があるときだけ、System Prompt の 1 行目をトーナメントにし、ICM の読み方・項目の説明を添える（構造ゲート）。
//   All-in の判断・Shove の判断の読み方は、その値があるときだけ節ごと出す。Cash の Prompt は #189 より前と同じ文字列
// - Grounding: All-in の判断（ICM の必要 Equity がある）では、ICM の必要 Equity の id を 1 つ以上根拠に挙げる
// - ReviewService は Event Log の SESSION_STARTED（設定の Snapshot）と Session の最初の Hand の人数から Tournament の Evidence を作り、
//   Solver には mode: tournament で渡す（Cash だけを解く Solver は Unsupported の正常な Fallback）
// - Drill: Tournament の Hand は Drill の題材にしない（暫定 Policy）
import {
  heroInformationSets,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  BUBBLE_CALL,
  BUBBLE_SHOVE,
  playScriptedHand,
  tournamentSessionOf,
  type ScriptedHand,
} from "../testing/review-eval/hands.js";
import { buildReviewEvidence, reviewSpotReasons } from "./evidence.js";
import { createFakeReviewQuery } from "./fake-review-query.js";
import { buildFollowUpPrompt, followUpSystemPrompt } from "./followup.js";
import { toPlayerNames } from "./identifiers.js";
import {
  InMemoryFollowUpStore,
  InMemoryRevealReviewStore,
} from "./reveal-store.js";
import {
  REVIEW_SYSTEM_PROMPT,
  TOURNAMENT_ALL_IN_GUIDE,
  TOURNAMENT_GUIDE,
  TOURNAMENT_REVIEW_SYSTEM_PROMPT,
  TOURNAMENT_SHOVE_GUIDE,
  buildReviewPrompt,
  checkReviewOutput,
  reviewSystemPromptFor,
} from "./review-ai.js";
import { InMemoryReviewStore } from "./review-store.js";
import { ReviewService } from "./review-service.js";
import type { ReviewEvidence } from "./types.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});
const names = toPlayerNames(PHASE1_TABLE_SETUP.players);

async function evidenceOf(
  hand: ScriptedHand,
  index = 0,
  options: { readonly cash?: boolean } = {},
): Promise<ReviewEvidence> {
  const sets = heroInformationSets(playScriptedHand(hand), "hero");
  const tournament =
    options.cash === true ? undefined : tournamentSessionOf(hand);
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

/** 検証を通る出力（evidenceIds は渡した id）。 */
function outputCiting(evidence: ReviewEvidence, ids: readonly string[]) {
  return {
    assessment: "reasonable",
    confidence: "medium",
    practical: "Bubble の ICM を考えると妥当。",
    theoryBasis: "general_theory",
    theory: "賞金の構造で必要 Equity が上がる。",
    exploitBasis: "none",
    exploit: "",
    assumptions: ["ほかの Player は Fold する前提"],
    conclusionChangers: ["相手の Range がもっと広いなら結論が変わる"],
    evidenceIds: [evidence.math.id, ...ids],
  };
}

describe("Tournament の Prompt（構造ゲート）", () => {
  it("Shove: トーナメントの System Prompt に、状況・All-in・Shove の読み方と Tournament の項目の説明を添える", async () => {
    const evidence = await evidenceOf(BUBBLE_SHOVE);
    expect(reviewSystemPromptFor(evidence)).toBe(
      TOURNAMENT_REVIEW_SYSTEM_PROMPT,
    );
    expect(TOURNAMENT_REVIEW_SYSTEM_PROMPT).toContain("（トーナメント）");
    // 2 行目以降は Cash と同じ。
    expect(TOURNAMENT_REVIEW_SYSTEM_PROMPT.split("\n").slice(1)).toEqual(
      REVIEW_SYSTEM_PROMPT.split("\n").slice(1),
    );
    const prompt = buildReviewPrompt(evidence);
    for (const section of [
      TOURNAMENT_GUIDE,
      TOURNAMENT_ALL_IN_GUIDE,
      TOURNAMENT_SHOVE_GUIDE,
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("- icmEquity: ICM Equity（賞金の期待値。pt）");
    expect(prompt).toContain("- chipEv: Chip EV の必要 Equity");
  });

  it("All-in への Call: Shove の読み方は出さない", async () => {
    const prompt = buildReviewPrompt(await evidenceOf(BUBBLE_CALL));
    expect(prompt).toContain(TOURNAMENT_ALL_IN_GUIDE);
    expect(prompt).not.toContain(TOURNAMENT_SHOVE_GUIDE);
  });

  it("Cash: System Prompt・Prompt に Tournament の文も項目の説明も出さない（#189 より前と同じ）", async () => {
    const evidence = await evidenceOf(BTN_VS_UTG, 3);
    expect(reviewSystemPromptFor(evidence)).toBe(REVIEW_SYSTEM_PROMPT);
    const prompt = buildReviewPrompt(evidence);
    expect(prompt).not.toContain("トーナメント");
    expect(prompt).not.toContain("- icmEquity:");
    expect(prompt).not.toContain("- stage:");
  });

  it("Follow-up（Pass A への質問）: Tournament の Evidence があるときだけ System Prompt の 1 行目・読み方・項目の説明を変える", async () => {
    const target = (e: ReviewEvidence) =>
      ({
        pass: "decision",
        reviewId: "r1",
        handId: e.handId,
        decisionIndex: e.decisionIndex,
        version: 1,
        evidence: e,
        explanation: {
          practical: "妥当。",
          theory: { basis: "none", text: "" },
          exploit: { basis: "none", text: "" },
          conclusionChangers: ["相手の Range"],
        },
      }) as const;
    const tournament = buildFollowUpPrompt(
      target(await evidenceOf(BUBBLE_CALL)),
      [],
      "ICM は？",
    );
    expect(tournament).toContain(TOURNAMENT_GUIDE);
    expect(tournament).toContain("- icmEquity:");
    const cash = buildFollowUpPrompt(
      target(await evidenceOf(BTN_VS_UTG, 3)),
      [],
      "ICM は？",
    );
    expect(cash).not.toContain(TOURNAMENT_GUIDE);
    expect(cash).not.toContain("- icmEquity:");
    expect(followUpSystemPrompt("decision", { tournament: true })).toContain(
      "（トーナメント）",
    );
    expect(followUpSystemPrompt("decision")).toContain("（キャッシュゲーム）");
  });
});

describe("Tournament の Grounding", () => {
  it("All-in の判断では、ICM の必要 Equity の id を挙げない出力は不正（Chip EV の id だけでも不正）", async () => {
    const evidence = await evidenceOf(BUBBLE_SHOVE);
    const allIn = evidence.tournament?.allIn;
    if (allIn?.status !== "available") throw new Error("必要 Equity が無い");
    const [first] = allIn.requirements;
    if (first === undefined) throw new Error("相手が無い");
    expect(
      checkReviewOutput(outputCiting(evidence, []), evidence),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(outputCiting(evidence, [first.chipEv.id]), evidence),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(outputCiting(evidence, [first.icm.id]), evidence),
    ).toMatchObject({ ok: true });
  });

  it("Tournament の Evidence の id（状況・ICM Equity）は根拠に挙げてよく、無い id は不正", async () => {
    const evidence = await evidenceOf(BUBBLE_CALL);
    const t = evidence.tournament;
    const allIn = t?.allIn;
    if (t === undefined || allIn?.status !== "available") {
      throw new Error("Tournament の Evidence が無い");
    }
    const icmReq = allIn.requirements.map((r) => r.icm.id);
    expect(
      checkReviewOutput(
        outputCiting(evidence, [t.id, t.icm.id, ...icmReq]),
        evidence,
      ),
    ).toMatchObject({ ok: true });
    expect(
      checkReviewOutput(
        outputCiting(evidence, [
          ...icmReq,
          "icmreq:review-bubble_call/d0/cpu9",
        ]),
        evidence,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
  });
});

describe("ReviewService: Tournament の Session の Hand", () => {
  const SESSION = "session-tournament";

  /** Session の最初の Hand（6 人。SESSION_STARTED に設定の Snapshot）と、Review の対象の Bubble の Hand を保存した Store。 */
  function tournamentStore(reviewed: ScriptedHand) {
    const events = new InMemoryEventStore();
    const first: ScriptedHand = {
      ...BTN_VS_UTG,
      id: "tournament-first",
      tournament: {
        config: BUBBLE_CALL.tournament!.config,
        entrants: 6,
        level: 1,
        handNumber: 1,
        seats: PHASE1_TABLE_SETUP.players.map((p) => ({
          playerId: p.playerId,
          stack: 1_500,
        })),
      },
      script: [
        ["cpu3", { type: "fold" }],
        ["cpu4", { type: "fold" }],
        ["cpu5", { type: "fold" }],
        ["hero", { type: "fold" }],
        ["cpu1", { type: "fold" }],
      ],
    };
    events.append(
      "review-tournament-first",
      playScriptedHand(first, { sessionId: SESSION }),
      { sessionId: SESSION },
    );
    events.append(`review-${reviewed.id}`, playScriptedHand(reviewed), {
      sessionId: SESSION,
    });
    return events;
  }

  function serviceFor(events: InMemoryEventStore) {
    const reviews = new InMemoryReviewStore();
    const service = new ReviewService({
      events,
      reviews,
      reveals: new InMemoryRevealReviewStore(),
      followUps: new InMemoryFollowUpStore(),
      heroId: "hero",
      players: PHASE1_TABLE_SETUP.players,
      kb,
      solver,
      env: {},
      query: createFakeReviewQuery(),
      timeoutMs: 60_000,
    });
    return { service, reviews };
  }

  it("Event Log の設定の Snapshot と最初の Hand の人数から Tournament の Evidence を作り、Fake の Review AI の出力が Grounding を通る", async () => {
    const events = tournamentStore(BUBBLE_CALL);
    const { service, reviews } = serviceFor(events);
    service.request("review-bubble_call", 0, "standard");
    await service.idle();
    const record = reviews.list("review-bubble_call", 0, "decision").at(-1);
    if (record === undefined) throw new Error("Review が作られていない");
    // 本番と同じ経路で作った Evidence と一致する（参加人数 6・標準 STT の設定）。
    expect(record.evidence.tournament).toEqual(
      (await evidenceOf(BUBBLE_CALL)).tournament,
    );
    expect(record.evidence.tournament?.entrants).toBe(6);
    expect(record.evidenceIds.tournament).toContain(
      "icmreq:review-bubble_call/d0/cpu2",
    );
    // Fake は ICM の必要 Equity の id を挙げるので、Grounding を通って review_ai になる。
    expect(record.generatedBy).toBe("review_ai");
    expect(record.evidenceIds.cited).toContain(
      "icmreq:review-bubble_call/d0/cpu2",
    );
  });

  it("Tournament の Spot は Solver の Capability Gate に mode: tournament で渡り、Unsupported（mode）の正常な Fallback になる", async () => {
    // HU の Turn の最初の判断（Solver の Root）を Tournament の卓で作る（SB_VS_BTN と同じ形を 2 人で）。
    const huTurn: ScriptedHand = {
      id: "tournament_hu_turn",
      label: "Tournament の Heads-Up の Turn で最初に Bet",
      button: "cpu1",
      holes: { hero: "9h 8h", cpu1: "Ac Td" },
      board: "Th 7c 2s 6d Kd",
      script: [
        ["cpu1", { type: "call" }],
        ["hero", { type: "check" }],
        ["hero", { type: "check" }],
        ["cpu1", { type: "check" }],
        ["hero", { type: "bet", amount: 200 }],
        ["cpu1", { type: "fold" }],
      ],
      tournament: {
        config: BUBBLE_CALL.tournament!.config,
        entrants: 6,
        level: 1,
        handNumber: 80,
        seats: [
          { playerId: "hero", stack: 4_500 },
          { playerId: "cpu1", stack: 4_500 },
        ],
      },
    };
    const tournament = await evidenceOf(huTurn, 2);
    expect(tournament.solver).toMatchObject({
      status: "unsupported",
      reason: "mode",
    });
    // 同じ Spot を Cash として作れば mode では止まらない（Solver 未導入の理由になる）。
    const cash = await evidenceOf(huTurn, 2, { cash: true });
    expect(cash.solver).toMatchObject({
      status: "unsupported",
      reason: "solver_not_installed",
    });
  });
});
