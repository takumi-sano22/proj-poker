// Replay の API の統合テスト（#68・D38・D93）。Hand API で実際に Hand を進め、保存済みの Event を Replay の API で読む。
// 一覧と再生のどの応答にも Hero に見えない情報（Showdown で公開されていない他者の札・Deck・seed・system の記録・
// CPU の Persona）が入らないこと、HAND_FINISHED の無い Hand（D88）でも壊れないことを確かめる。
import {
  projectHeroView,
  visibleEvents,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryEventStore } from "../event-store.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { RuleBot } from "../opponents/rule-bot.js";
import type { ReplayHand, ReplayHandSummary } from "../replay.js";
import { forbiddenKeys, leakedCards, personaTerms } from "../testing/leaks.js";

const HERO = "hero";
/** CPU の不正な出力に入れる値。system の記録（AI_ACTION_INVALID の reason）にだけ残り、Replay に出てはいけない。 */
const INVALID_ACTION = "teleport";
/** 内部のエラー本文。Replay に出てはいけない。 */
const SECRET = "/home/u/.claude/.credentials.json sk-ant-secret";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** RuleBot と同じ判断を返す CPU。 */
function ruleBotDecision(
  bot: RuleBot,
  input: Parameters<RuleBot["choose"]>[0],
) {
  const action = bot.choose(input);
  return "amount" in action
    ? { action: action.type, amount: action.amount }
    : { action: action.type };
}

/** 判断を求められるたび 3 回に 1 回、不正な出力を返す CPU（Retry で RuleBot の判断に戻る）。system の Event を Log に残すため。 */
const sometimesInvalid: OpponentFactory = (seed, _playerId, persona) => {
  const bot = new RuleBot(seed, persona);
  let calls = 0;
  return {
    decide: (input) =>
      Promise.resolve(
        calls++ % 3 === 0
          ? { action: INVALID_ACTION }
          : ruleBotDecision(bot, input),
      ),
  };
};

/** 最初に判断を求められた CPU だけが例外を投げ続ける（AI 障害。D86）。App ごとに作る。 */
function brokenFirstCpu(): OpponentFactory {
  let broken: string | null = null;
  return (seed, _playerId, persona) => {
    const bot = new RuleBot(seed, persona);
    return {
      decide: (input) => {
        broken ??= input.knowledge.viewerId;
        return input.knowledge.viewerId === broken
          ? Promise.reject(new Error(SECRET))
          : Promise.resolve(ruleBotDecision(bot, input));
      },
    };
  };
}

function makeApp(seed: number, createOpponent: OpponentFactory) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    createOpponent,
    nextSeed: () => seed,
    nextHandId: () => `hand-${++handNo}`,
  });
  apps.push(app);
  const events = (handId: string): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { app, events };
}

type App = ReturnType<typeof buildApp>;

async function start(app: App): Promise<{ handId: string; view: HeroView }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/hands",
    payload: { afterHandId: null },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ handId: string; view: HeroView }>();
}

function lastSeq(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

/** Hero は Call / Check だけで Hand を最後まで進める。 */
async function playToEnd(app: App, handId: string, view: HeroView) {
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    const res = await app.inject({
      method: "POST",
      url: `/api/hands/${handId}/actions`,
      payload: { lastSeq: lastSeq(view), action: passiveHero(view) },
    });
    expect(res.statusCode).toBe(200);
    view = res.json<{ view: HeroView }>().view;
  }
}

async function getList(app: App): Promise<ReplayHandSummary[]> {
  const res = await app.inject({ method: "GET", url: "/api/replay/hands" });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ hands: ReplayHandSummary[] }>();
  expectNoInternals(body);
  return body.hands;
}

async function getHand(app: App, handId: string): Promise<ReplayHand> {
  const res = await app.inject({
    method: "GET",
    url: `/api/replay/hands/${handId}`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<ReplayHand>();
  expectNoInternals(body);
  return body;
}

/** Deck・seed・system / engine の記録・Persona・CPU の出力の値・エラー本文が応答に無い。 */
function expectNoInternals(payload: unknown) {
  expect(forbiddenKeys(payload)).toEqual([]);
  expect(personaTerms(payload)).toEqual([]);
  const json = JSON.stringify(payload);
  expect(json).not.toContain(INVALID_ACTION);
  expect(json).not.toContain("sk-ant");
}

/**
 * 再生の各 step が「保存済み Event の Hero に見える prefix の Hero の視点」で、その時点の Hero が知り得ない札を含まない。
 * step は Hero に見える Event 1 件ごとで、Action に決まった裁定だけはその ACTION_TAKEN と 1 step にまとめる。
 * 最後の step は、その Hand の今の Hero の視点（Live の View）と同じ（操作しないので legalActions だけ null）。
 */
function expectStepsArePrefixes(hand: ReplayHand, log: readonly HandEvent[]) {
  const visible = visibleEvents(log, HERO);
  const joined = visible.filter(
    (e, i) =>
      e.type === "DEALER_RULING" &&
      e.outcome === "action" &&
      visible[i + 1]?.type === "ACTION_TAKEN",
  ).length;
  expect(hand.steps).toHaveLength(visible.length - joined);
  let previous = 0;
  hand.steps.forEach((step) => {
    expect(step.log.length).toBeGreaterThan(previous);
    previous = step.log.length;
    expect(step.log).toEqual(visible.slice(0, step.log.length));
    const last = step.log.at(-1);
    if (last?.type === "DEALER_RULING") expect(last.outcome).not.toBe("action");
    expect(step.legalActions).toBeNull();
    expect(leakedCards(step, log, HERO, lastSeq(step))).toEqual([]);
  });
  expect(hand.steps.at(-1)).toEqual({
    ...projectHeroView(log, HERO),
    legalActions: null,
  });
}

describe("Replay API（完了した Hand）", () => {
  it("一覧と再生を返し、各 step は Hero に見える Event の prefix で、他者の札は Showdown で公開した時点から見える", async () => {
    let sawSystemEvent = false;
    let sawShowdownReveal = false;
    for (const seed of [1, 2, 3, 42, 777]) {
      const { app, events } = makeApp(seed, sometimesInvalid);
      const { handId, view } = await start(app);
      await playToEnd(app, handId, view);
      const log = events(handId);
      sawSystemEvent ||= log.some((e) => e.visibility.type === "system");

      const [summary] = await getList(app);
      const started = log[0];
      const finished = log.at(-1);
      if (
        started?.type !== "HAND_STARTED" ||
        finished?.type !== "HAND_FINISHED"
      ) {
        throw new Error("Hand が終わっていない");
      }
      const heroBefore = started.seats.find((s) => s.playerId === HERO)?.stack;
      const heroAfter = finished.stacks.find(
        (s) => s.playerId === HERO,
      )?.amount;
      expect(summary).toMatchObject({
        handId,
        complete: true,
        bigBlind: started.bigBlind,
        heroNet: (heroAfter ?? 0) - (heroBefore ?? 0),
      });
      expect(summary?.finishedAt).not.toBeNull();
      expect(leakedCards(summary, log, HERO, finished.seq)).toEqual([]);

      const hand = await getHand(app, handId);
      expect(hand.complete).toBe(true);
      expect(hand.players.map((p) => p.playerId)).toEqual(
        started.seats.map((s) => s.playerId),
      );
      expectStepsArePrefixes(hand, log);

      // Showdown で公開された CPU の札は、その CARDS_TABLED の step から見え、その前の step では伏せたまま。
      for (const [i, step] of hand.steps.entries()) {
        const e = step.log.at(-1);
        if (e?.type !== "CARDS_TABLED" || e.playerId === HERO) continue;
        const seatOf = (v: HeroView | undefined) =>
          v?.seats.find((s) => s.playerId === e.playerId);
        expect(seatOf(step)?.holeCards).toEqual(e.cards);
        expect(seatOf(hand.steps[i - 1])?.holeCards).toBeNull();
        sawShowdownReveal = true;
      }
    }
    // 検査が空振りしていない（system の記録と Showdown の公開を含む Hand を通った）。
    expect(sawSystemEvent).toBe(true);
    expect(sawShowdownReveal).toBe(true);
  });

  it("Hero の宣言・Chip の操作・Dealer の裁定（#64）も一手ずつ再生し、Action に決まった裁定はその Action と同じ step に入る", async () => {
    const { app, events } = makeApp(7, sometimesInvalid);
    const started = await start(app);
    let view = started.view;
    let declaredCheckFacingBet = false;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      const call = view.legalActions?.actions.find((a) => a.type === "call");
      // 最初の Call できる手番では、Bet に直面して Check を宣言する（Action の決まらない裁定 no_action になる）。
      const checkFacingBet: boolean =
        call !== undefined && !declaredCheckFacingBet;
      declaredCheckFacingBet ||= checkFacingBet;
      const actions = checkFacingBet
        ? [{ type: "declare", declaration: { kind: "check" } }]
        : call?.type === "call" && call.amount <= 100
          ? [
              {
                type: "chip_push",
                chips: Array.from({ length: call.amount }, () => 1),
              },
            ]
          : [{ type: "declare", declaration: { kind: "check" } }];
      const res = await app.inject({
        method: "POST",
        url: `/api/hands/${started.handId}/physical-actions`,
        payload: { lastSeq: lastSeq(view), actions },
      });
      expect(res.statusCode).toBe(200);
      view = res.json<{ view: HeroView }>().view;
    }
    const log = events(started.handId);
    const hand = await getHand(app, started.handId);
    expectStepsArePrefixes(hand, log);
    const lastTypes = hand.steps.map((s) => s.log.at(-1)?.type);
    expect(lastTypes).toContain("PLAYER_DECLARED");
    expect(lastTypes).toContain("PHYSICAL_CHIP_ACTION");
    // Action の決まらない裁定は単独の step。
    expect(
      hand.steps.some((s) => {
        const e = s.log.at(-1);
        return e?.type === "DEALER_RULING" && e.outcome === "no_action";
      }),
    ).toBe(true);
    // Action に決まった裁定は、その ACTION_TAKEN で終わる step の 1 つ前の Event。
    expect(
      hand.steps.some((s) => {
        const [ruling, action] = s.log.slice(-2);
        return (
          ruling?.type === "DEALER_RULING" &&
          ruling.outcome === "action" &&
          action?.type === "ACTION_TAKEN"
        );
      }),
    ).toBe(true);
  });
});

describe("Replay API（HAND_FINISHED の無い Hand。D88）", () => {
  it("進行中の Hand は未完了として一覧に出し、その時点までを再生する（収支は null）", async () => {
    const { app, events } = makeApp(42, sometimesInvalid);
    const { handId, view } = await start(app);
    expect(view.status).toBe("in_progress");

    const [summary] = await getList(app);
    expect(summary).toMatchObject({
      handId,
      complete: false,
      finishedAt: null,
      heroNet: null,
    });
    expect(summary?.heroHoleCards).toHaveLength(2);

    const hand = await getHand(app, handId);
    expect(hand.complete).toBe(false);
    expectStepsArePrefixes(hand, events(handId));
  });

  it("AI 障害の後に Session 終了で打ち切った Hand も未完了として一覧に出し、再生できる。エラー本文は出ない", async () => {
    const { app, events } = makeApp(42, brokenFirstCpu());
    const { handId } = await start(app);
    const ended = await app.inject({
      method: "POST",
      url: `/api/hands/${handId}/outage`,
      payload: { revision: 1, choice: "end_session" },
    });
    expect(ended.statusCode).toBe(200);
    // 次の Session の Hand を始めても、打ち切った Hand は一覧に残る（新しい順で 2 番目）。
    const next = await start(app);

    const list = await getList(app);
    expect(list.map((h) => h.handId)).toEqual([next.handId, handId]);
    expect(list[1]).toMatchObject({ complete: false, heroNet: null });

    const hand = await getHand(app, handId);
    expect(hand.complete).toBe(false);
    expectStepsArePrefixes(hand, events(handId));
  });
});

describe("Replay API（入力）", () => {
  it("Event の無い Hand は 404、形の不正な handId は 400", async () => {
    const { app } = makeApp(1, sometimesInvalid);
    const missing = await app.inject({
      method: "GET",
      url: "/api/replay/hands/unknown",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { kind: "hand_not_found" } });

    const tooLong = await app.inject({
      method: "GET",
      url: `/api/replay/hands/${"x".repeat(65)}`,
    });
    expect(tooLong.statusCode).toBe(400);

    expect(await getList(app)).toEqual([]);
  });
});
