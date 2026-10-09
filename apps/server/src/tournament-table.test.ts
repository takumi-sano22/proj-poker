// 卓に出す Tournament の状況（#190・docs/06 §15）と、Replay・Session Review の Tournament の Important Spot（#189 の引き継ぎ）。
// - GET /api/hands/:handId/tournament: この Hand の Level・Blind・Ante・次の Level までの残り（hand_count は Hand の番号、time_base は
//   プレイ時間）と、この Hand までの残人数・Elimination・順位・Payout。Event Log から都度計算し、公開の情報だけを返す
// - Cash の Hand は tournament: null（Cash の経路は変えない）。このプロセスで進めていない Hand は 404
// - Replay・Session Review の Important Spot は、Review と同じ関数で Bubble / Pay Jump / Short Stack を足す
import {
  TOURNAMENT_PRESETS,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PHASE1_TABLE_SETUP } from "./config.js";
import { InMemoryEventStore } from "./event-store.js";
import {
  HandOrchestrator,
  type SessionRequest,
  type TournamentTableStatus,
} from "./hand-orchestrator.js";
import { computeSessionReview } from "./learning/session-review.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { ReplayService } from "./replay.js";
import { InMemoryReviewStore } from "./review/review-store.js";
import {
  BTN_VS_UTG,
  BUBBLE_CALL,
  BUBBLE_SHOVE,
  playScriptedHand,
  type ScriptedHand,
} from "./testing/review-eval/hands.js";

const HERO = "hero";
const HAND_COUNT: SessionRequest = {
  mode: "tournament",
  presetId: "stt6_hand_count",
};
const TIME_BASE: SessionRequest = {
  mode: "tournament",
  presetId: "stt6_time_base",
};
const MINUTE = 60_000;

function orchestratorOn(store: InMemoryEventStore, playClock?: () => number) {
  let handNo = 0;
  let sessionNo = 0;
  return new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    createOpponent: createRuleBot,
    botDelayMs: 0,
    opponentTimeoutMs: 1000,
    nextSeed: () => 42 + handNo,
    nextHandId: () => `t-hand-${++handNo}`,
    nextSessionId: () => `t-session-${++sessionNo}`,
    ...(playClock === undefined ? {} : { playClock }),
  });
}

/** Check できれば Check、できなければ Fold（Hero の Stack を減らしにくい）。 */
function foldOrCheck(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  return types.includes("check") ? { type: "check" } : { type: "fold" };
}

/** All-in できれば All-in、できなければ Call / Check（Tournament を早く終わらせる）。 */
function shove(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("all_in")) return { type: "all_in" };
  if (types.includes("call")) return { type: "call" };
  return { type: "check" };
}

/** Hand の残りを policy で最後まで進める。 */
async function finish(
  orchestrator: HandOrchestrator,
  handId: string,
  view: HeroView,
  policy: (view: HeroView) => PlayerAction,
): Promise<void> {
  let current = view;
  for (let guard = 0; current.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    const result = await orchestrator.heroAction(
      handId,
      current.log.at(-1)?.seq ?? -1,
      policy(current),
    );
    if (!result.ok) throw new Error(result.error.message);
    current = result.value;
  }
}

/** 公開の情報だけの形か（Persona・札・内部の設定を持たない）。 */
function expectPublicShape(status: TournamentTableStatus): void {
  expect(Object.keys(status).sort()).toEqual(
    [
      "handId",
      "presetId",
      "schedule",
      "level",
      "levelCount",
      "handNumber",
      "smallBlind",
      "bigBlind",
      "anteKind",
      "ante",
      "nextLevel",
      "result",
    ].sort(),
  );
  for (const p of status.result.placements) {
    expect(Object.keys(p).sort()).toEqual(
      ["eliminatedInHandId", "payout", "place", "playerId"].sort(),
    );
  }
}

describe("卓の Tournament の状況（tournamentTableOf。#190）", () => {
  it("hand_count: 進行中の Hand の Level・Blind・Ante・次の Level が始まる Hand・残人数・Payout を返す（Bust はまだ無い）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const started = await orchestrator.startHand(null, HAND_COUNT);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    const status = orchestrator.tournamentTableOf(handId);
    if (status === null) throw new Error("Tournament の状況が無い");
    expectPublicShape(status);
    const config = TOURNAMENT_PRESETS.stt6_hand_count;
    expect(status).toMatchObject({
      handId,
      presetId: "stt6_hand_count",
      level: 1,
      levelCount: config.levels.length,
      handNumber: 1,
      smallBlind: 10,
      bigBlind: 20,
      anteKind: "big_blind_ante",
      ante: 20,
      nextLevel: {
        level: 2,
        smallBlind: 15,
        bigBlind: 30,
        ante: 30,
        // 1〜10 Hand 目が Level 1（levelAt と同じ数え方）。
        until: { kind: "hand_count", handNumber: 11 },
      },
    });
    expect(status.result).toMatchObject({
      status: "in_progress",
      entrants: 6,
      remaining: 6,
      prizePool: 600,
      payoutsByPlace: [300, 180, 120],
    });
    expect(status.result.placements.every((p) => p.place === null)).toBe(true);
    orchestrator.close();
  });

  it("hand_count: 2 Hand 目以降も、この Hand の開始時の番号から次の Level を数える", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    let previous: string | null = null;
    for (let k = 1; k <= 3; k++) {
      const started = await orchestrator.startHand(
        previous,
        k === 1 ? HAND_COUNT : undefined,
      );
      if (!started.ok) throw new Error(started.error.message);
      const { handId, view } = started.value;
      expect(orchestrator.tournamentTableOf(handId)).toMatchObject({
        handNumber: k,
        level: 1,
        nextLevel: { until: { kind: "hand_count", handNumber: 11 } },
      });
      await finish(orchestrator, handId, view, foldOrCheck);
      previous = handId;
    }
    orchestrator.close();
  });

  it("time_base: 次の Level までの残りは、開始時の累計とこの Hand のこれまでのプレイ時間から測り、0 を下回らない", async () => {
    let now = 0;
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store, () => now);
    const started = await orchestrator.startHand(null, TIME_BASE);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    const duration = 10 * MINUTE;
    const remaining = () => {
      const until = orchestrator.tournamentTableOf(handId)?.nextLevel?.until;
      if (until?.kind !== "time_base") throw new Error("time_base ではない");
      return until.remainingPlayMs;
    };
    expect(remaining()).toBe(duration);
    now += 4 * MINUTE;
    expect(remaining()).toBe(6 * MINUTE);
    // Level は Hand の開始時に決まる（Hand の途中では上がらない）ので、時間が過ぎても 0 で止まる（次の Hand から上がる）。
    now += 20 * MINUTE;
    expect(remaining()).toBe(0);
    expect(orchestrator.tournamentTableOf(handId)?.level).toBe(1);
    orchestrator.close();
  });

  it("Hero の Bust か優勝で終えた後は、Hero の順位と Payout・確定した順位を返し、Hero の Bust で残った CPU は未決（D129）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    let previous: string | null = null;
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(200);
      const started = await orchestrator.startHand(
        previous,
        previous === null ? HAND_COUNT : undefined,
      );
      if (!started.ok) throw new Error(started.error.message);
      const { handId, view } = started.value;
      await finish(orchestrator, handId, view, shove);
      previous = handId;
      if (orchestrator.sessionStatus(handId)?.state === "ended") break;
    }
    const last = previous;
    const status = orchestrator.tournamentTableOf(last);
    if (status === null) throw new Error("Tournament の状況が無い");
    expectPublicShape(status);
    // Result は Hand Orchestrator の Result（Session の終わった Hand から作る）と同じ。
    expect(status.result).toEqual(orchestrator.tournamentResultOf(last));
    expect(status.result.status).toBe("finished");
    const hero = status.result.placements.find((p) => p.playerId === HERO);
    expect(hero?.place).not.toBeNull();
    expect(hero?.payout).not.toBeNull();
    if (hero?.place !== 1) {
      const undecided = status.result.placements.filter(
        (p) => p.place === null,
      );
      expect(undecided).toHaveLength(status.result.remaining);
      expect(undecided.every((p) => p.payout === null)).toBe(true);
    }
    orchestrator.close();
  });

  it("Cash の Hand は null（Cash の経路は変えない）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    expect(orchestrator.tournamentTableOf(started.value.handId)).toBeNull();
    expect(orchestrator.tournamentTableOf("unknown")).toBeNull();
    orchestrator.close();
  });
});

describe("GET /api/hands/:handId/tournament（#190）", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  function makeApp() {
    let handNo = 0;
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      store: new InMemoryEventStore(),
      nextSeed: () => 42,
      nextHandId: () => `hand-${++handNo}`,
    });
    apps.push(app);
    return app;
  }

  it("Tournament の Hand は状況を、Cash の Hand は tournament: null を返し、知らない Hand は 404", async () => {
    const app = makeApp();
    const started = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null, session: HAND_COUNT },
    });
    const { handId } = started.json<{ handId: string }>();
    const res = await app.inject({
      method: "GET",
      url: `/api/hands/${handId}/tournament`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tournament: TournamentTableStatus }>();
    expectPublicShape(body.tournament);
    expect(body.tournament).toMatchObject({ handId, level: 1, bigBlind: 20 });
    // 情報境界: CPU の Persona・他者の札・Deck は応答に入らない。
    expect(res.body).not.toMatch(/persona|holeCards|deck|seed/i);

    const missing = await app.inject({
      method: "GET",
      url: "/api/hands/unknown/tournament",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { kind: "hand_not_found" } });
  });

  it("Cash の Hand は tournament: null", async () => {
    const app = makeApp();
    const started = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null },
    });
    const { handId } = started.json<{ handId: string }>();
    const res = await app.inject({
      method: "GET",
      url: `/api/hands/${handId}/tournament`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tournament: null });
  });
});

describe("Replay・Session Review の Tournament の Important Spot（#189 の引き継ぎ）", () => {
  const SESSION = "session-tournament";

  /** Session の最初の Hand（6 人。SESSION_STARTED に設定の Snapshot）と、Bubble の Hand を保存した Store。 */
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
    const firstEvents = playScriptedHand(first, { sessionId: SESSION });
    const reviewedEvents = playScriptedHand(reviewed);
    events.append("review-tournament-first", firstEvents, {
      sessionId: SESSION,
    });
    events.append(`review-${reviewed.id}`, reviewedEvents, {
      sessionId: SESSION,
    });
    return { events, firstEvents, reviewedEvents };
  }

  it("Replay の Important Spot に、Bubble と Short Stack（10BB の Shove）の理由が Cash の理由と並んで入る", () => {
    const { events } = tournamentStore(BUBBLE_SHOVE);
    const replay = new ReplayService(events, HERO, PHASE1_TABLE_SETUP.players);
    const hand = replay.hand("review-bubble_shove");
    expect(hand?.importantSpots.map((s) => s.reasons)).toEqual([
      ["all_in", "bubble", "short_stack"],
    ]);
  });

  it("Session Review の Important Hands にも同じ理由が入る（Cash の Session では入らない）", () => {
    const { firstEvents, reviewedEvents } = tournamentStore(BUBBLE_SHOVE);
    const at = (i: number) =>
      new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString();
    const records = [
      {
        handId: "review-tournament-first",
        events: firstEvents,
        startedAt: at(0),
        endedAt: at(1),
      },
      {
        handId: "review-bubble_shove",
        events: reviewedEvents,
        startedAt: at(2),
        endedAt: at(3),
      },
    ];
    const review = computeSessionReview(
      records,
      new InMemoryReviewStore(),
      HERO,
    );
    expect(
      review.importantHands.find((h) => h.handId === "review-bubble_shove")
        ?.reasons,
    ).toEqual(["all_in", "bubble", "short_stack"]);
  });
});
