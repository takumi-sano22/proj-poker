import {
  type HandEvent,
  type HeroView,
  type LegalActionSet,
  type PlayerAction,
  type PlayerChips,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE1_TABLE_SETUP, buildTableSetup } from "./config.js";
import { InMemoryEventStore, type AppendContext } from "./event-store.js";
import {
  HandOrchestrator,
  type HandOrchestratorOptions,
} from "./hand-orchestrator.js";
import type {
  OpponentAgent,
  OpponentFactory,
  OpponentInput,
} from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { forbiddenKeys, leakedCards } from "./testing/leaks.js";

const HERO = "hero";
const TOTAL_CHIPS =
  PHASE1_TABLE_SETUP.startingStack * PHASE1_TABLE_SETUP.players.length;

/** Hand ごとに、最初の追記で渡された Session ID を覚える Store。 */
class SessionRecordingStore extends InMemoryEventStore {
  readonly sessionOf = new Map<string, string | undefined>();
  /** true の間は追記を失敗させる（Hand の進行が内部エラーで止まる場合の再現用）。 */
  failing = false;

  override append(
    handId: string,
    events: readonly HandEvent[],
    context?: AppendContext,
  ) {
    if (this.failing) throw new Error("書き込みに失敗した");
    if (!this.sessionOf.has(handId)) {
      this.sessionOf.set(handId, context?.sessionId);
    }
    return super.append(handId, events);
  }
}

function setup(overrides: Partial<HandOrchestratorOptions> = {}) {
  const store = new SessionRecordingStore();
  let handNo = 0;
  let sessionNo = 0;
  const orchestrator = new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    createOpponent: createRuleBot,
    botDelayMs: 0,
    nextSeed: () => 42,
    nextHandId: () => `hand-${++handNo}`,
    nextSessionId: () => `session-${++sessionNo}`,
    ...overrides,
  });
  const events = (handId: string): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { store, orchestrator, events };
}

/** テスト用の Hero: Call できれば Call、できなければ Check、どちらも無ければ Fold（Showdown まで進みやすい）。 */
function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

function lastSeq(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/** Hero の方針で Hand を最後まで進め、最後の View を返す。 */
function playOut(
  orchestrator: HandOrchestrator,
  handId: string,
  start: HeroView,
  hero: (view: HeroView) => PlayerAction = passiveHero,
): HeroView {
  let view = start;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    expect(view.actorId).toBe(HERO);
    const result = orchestrator.heroAction(handId, lastSeq(view), hero(view));
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  return view;
}

function finishedStacks(events: readonly HandEvent[]): number {
  return sum(finishedOf(events).stacks);
}

function finishedOf(events: readonly HandEvent[]) {
  const finished = events.find((e) => e.type === "HAND_FINISHED");
  if (finished?.type !== "HAND_FINISHED")
    throw new Error("HAND_FINISHED が無い");
  return finished;
}

function startedOf(events: readonly HandEvent[]) {
  const started = events[0];
  if (started?.type !== "HAND_STARTED") throw new Error("HAND_STARTED が無い");
  return started;
}

function sum(chips: readonly { amount: number }[]): number {
  return chips.reduce((total, c) => total + c.amount, 0);
}

function stackOf(chips: readonly PlayerChips[], playerId: string): number {
  return chips.find((c) => c.playerId === playerId)?.amount ?? 0;
}

/** All-in できれば All-in、できなければ Call、それも無ければ Check（Bust を起こしやすい）。 */
function shove(legal: LegalActionSet): PlayerAction {
  const types = legal.actions.map((a) => a.type);
  if (types.includes("all_in")) return { type: "all_in" };
  if (types.includes("call")) return { type: "call" };
  return { type: "check" };
}

/** CPU ごとに方針を決めた CPU（shove か fold）。出力の合法性は Engine が検証する。 */
function scriptedCpus(
  policy: Readonly<Record<string, "shove" | "fold">>,
): OpponentFactory {
  return (_seed, playerId) => ({
    decide: ({ legal }) => {
      if (policy[playerId] === "shove") return shove(legal);
      return legal.actions.some((a) => a.type === "check")
        ? { type: "check" }
        : { type: "fold" };
    },
  });
}

const shoveHero = (view: HeroView): PlayerAction =>
  view.legalActions === null ? { type: "fold" } : shove(view.legalActions);

/**
 * 3 人卓（hero・cpu1・cpu2）の最初の Hand を、Hero が All-in し CPU が方針どおりに動く形で最後まで進める。
 * seed を 1 から順に試し、最初の Hand の結果が条件に合う最初の seed で止める（Deck は seed だけで決まる）。
 */
function firstHandWhere(
  policy: Readonly<Record<string, "shove" | "fold">>,
  matches: (stacks: readonly PlayerChips[]) => boolean,
) {
  for (let seed = 1; seed <= 300; seed++) {
    const ctx = setup({
      setup: buildTableSetup(3),
      createOpponent: scriptedCpus(policy),
      nextSeed: () => seed,
    });
    const started = ctx.orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    playOut(ctx.orchestrator, handId, view, shoveHero);
    if (matches(finishedOf(ctx.events(handId)).stacks)) {
      return { ...ctx, handId };
    }
  }
  throw new Error("条件に合う seed が見つからない");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HandOrchestrator", () => {
  it("Hero の手番で止まり、Hero の Action で Hand が最後まで終わる（Chip 総量は不変）", () => {
    const { orchestrator, events } = setup();
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    // Hand の開始直後は、Hero の手番か、Hand が終わっているかのどちらか（CPU の手番では止まらない）。
    expect(view.status === "complete" || view.actorId === HERO).toBe(true);

    const final = playOut(orchestrator, handId, view);
    expect(final.status).toBe("complete");
    expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
    expect(orchestrator.fallbacksOf(handId)).toEqual([]);
  });

  it("多数の seed で、CPU は合法 Action だけを選び（Fallback なし）、CPU の入力に見えない札・Deck が入らない", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const store = new InMemoryEventStore();
      const inputs: { playerId: string; input: OpponentInput; upto: number }[] =
        [];
      let currentHand = "";
      // 本物の Rule Bot を包み、渡された入力をそのまま記録する。
      const spyFactory: OpponentFactory = (botSeed, playerId) => {
        const inner = createRuleBot(botSeed, playerId);
        return {
          decide(input) {
            const upto = store.read(currentHand).length - 1;
            inputs.push({ playerId, input, upto });
            return inner.decide(input);
          },
        };
      };
      const orchestrator = new HandOrchestrator({
        store,
        setup: PHASE1_TABLE_SETUP,
        createOpponent: spyFactory,
        botDelayMs: 0,
        nextSeed: () => seed,
        nextHandId: () => {
          currentHand = `hand-${seed}`;
          return currentHand;
        },
      });
      const started = orchestrator.startHand();
      if (!started.ok) throw new Error(started.error.message);
      // seed ごとに Hero の方針を変え、Fold で終わる Hand も通す。
      const hero =
        seed % 3 === 0 ? (): PlayerAction => ({ type: "fold" }) : passiveHero;
      playOut(orchestrator, currentHand, started.value.view, hero);

      const log = store.read(currentHand).map((s) => s.event);
      expect(finishedStacks(log)).toBe(TOTAL_CHIPS);
      expect(orchestrator.fallbacksOf(currentHand)).toEqual([]);
      for (const { playerId, input, upto } of inputs) {
        expect(Object.keys(input).sort()).toEqual(["legal", "view"]);
        expect(input.view.viewerId).toBe(playerId);
        expect(leakedCards(input, log, playerId, upto)).toEqual([]);
        expect(forbiddenKeys(input)).toEqual([]);
      }
    }
  });

  it.each([2, 6, 8])(
    "%i 人卓で Session を通して、Stack を持ち越し Chip 総量が保存され、Bust した席は退席し、CPU は Fallback しない",
    (size) => {
      const tableSetup = buildTableSetup(size);
      const total = tableSetup.startingStack * size;
      // 20 seed のどこかで Bust が起きている（退席・Session 終了の経路を実際に通している）こと。
      let busts = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const { orchestrator, events, store } = setup({
          setup: tableSetup,
          nextSeed: () => seed,
        });
        let previous: { started: HandEvent[]; handId: string } | null = null;
        // Session が終わるまで（長くても 30 Hand）回す
        for (let h = 0; h < 30; h++) {
          const started = orchestrator.startHand();
          if (!started.ok) throw new Error(started.error.message);
          const { handId, view } = started.value;
          const opening = startedOf(events(handId));
          // Hand の開始時点で Chip 総量は Session の最初と同じ（持ち越しで増減しない）。
          expect(sum(opening.seats.map((s) => ({ amount: s.stack })))).toBe(
            total,
          );
          expect(view.seats).toHaveLength(opening.seats.length);
          if (previous !== null) {
            // 前 Hand の終了時の Stack をそのまま持ち越し、Stack 0 の席だけが抜ける（席順は保つ）。
            const before = finishedOf(previous.started).stacks;
            const prevOrder = startedOf(previous.started).seats.map(
              (s) => s.playerId,
            );
            expect(opening.seats).toEqual(
              prevOrder
                .map((playerId) => ({
                  playerId,
                  stack: stackOf(before, playerId),
                }))
                .filter((s) => s.stack > 0),
            );
            expect(store.sessionOf.get(handId)).toBe(
              store.sessionOf.get(previous.handId),
            );
          }
          const hero =
            seed % 3 === 0 ? () => ({ type: "fold" as const }) : passiveHero;
          playOut(orchestrator, handId, view, hero);
          expect(finishedStacks(events(handId))).toBe(total);
          expect(orchestrator.fallbacksOf(handId)).toEqual([]);
          busts += finishedOf(events(handId)).stacks.filter(
            (s) => s.amount === 0,
          ).length;
          if (orchestrator.sessionStatus(handId)?.state === "ended") break;
          expect(orchestrator.sessionStatus(handId)).toEqual({
            state: "ready_for_next_hand",
          });
          previous = { started: events(handId), handId };
        }
      }
      expect(busts).toBeGreaterThan(0);
    },
  );

  it("3 人卓で CPU が Bust すると退席し、次 Hand は 2 人（Heads-Up・Button = SB）で Stack を持ち越して続く", () => {
    const { orchestrator, events, store, handId } = firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "hero") > 0,
    );
    const total = buildTableSetup(3).startingStack * 3;
    // 最初の Hand は均等 Stack・Button は席順の先頭（hero）。
    const first = startedOf(events(handId));
    expect(first.buttonPlayerId).toBe("hero");
    expect(new Set(first.seats.map((s) => s.stack)).size).toBe(1);
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ready_for_next_hand",
    });
    const before = finishedOf(events(handId)).stacks;

    const next = orchestrator.startHand();
    if (!next.ok) throw new Error(next.error.message);
    const log = events(next.value.handId);
    const opening = startedOf(log);
    // cpu1 は退席し、Hero と cpu2 が前 Hand の Stack のまま座る。
    expect(opening.seats).toEqual([
      { playerId: "hero", stack: stackOf(before, "hero") },
      { playerId: "cpu2", stack: stackOf(before, "cpu2") },
    ]);
    expect(sum(opening.seats.map((s) => ({ amount: s.stack })))).toBe(total);
    // 前 Button（hero）の次の席 cpu1 は Bust したので、その次の cpu2 が Button。Heads-Up は Button = SB。
    expect(opening.buttonPlayerId).toBe("cpu2");
    const small = log.find(
      (e) => e.type === "BLIND_POSTED" && e.blind === "small",
    );
    expect(small).toMatchObject({ playerId: "cpu2" });
    expect(next.value.view.seats.map((s) => s.playerId)).toEqual([
      "hero",
      "cpu2",
    ]);
    expect(store.sessionOf.get(next.value.handId)).toBe(
      store.sessionOf.get(handId),
    );
  });

  it("Hero が Bust したら Session を終え、次の Hand は新しい Session として均等 Stack で始まる", () => {
    const { orchestrator, events, store, handId } = firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "hero") === 0,
    );
    // CPU が 2 人残っていても、Hero が Bust したら Session は終わる（D80）。
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ended",
      reason: "hero_busted",
    });

    const next = orchestrator.startHand();
    if (!next.ok) throw new Error(next.error.message);
    const opening = startedOf(events(next.value.handId));
    const { startingStack } = buildTableSetup(3);
    expect(opening.seats).toEqual(
      ["hero", "cpu1", "cpu2"].map((playerId) => ({
        playerId,
        stack: startingStack,
      })),
    );
    expect(opening.buttonPlayerId).toBe("hero");
    expect(store.sessionOf.get(next.value.handId)).not.toBe(
      store.sessionOf.get(handId),
    );
  });

  it("CPU が全員 Bust して Hero だけが残ったら Session を終える", () => {
    const { orchestrator, handId } = firstHandWhere(
      { cpu1: "shove", cpu2: "shove" },
      (stacks) =>
        stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "cpu2") === 0,
    );
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ended",
      reason: "hero_last_standing",
    });
  });

  it("今の Session の Hand が進行中なら、新しい Hand を作らずその Hand を返す（開始の再送で Session を捨てない）", () => {
    const policy: Record<string, "shove" | "fold"> = {
      cpu1: "shove",
      cpu2: "fold",
    };
    const { orchestrator, events } = firstHandWhere(
      policy,
      (stacks) => stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "hero") > 0,
    );
    // 2 Hand 目（Heads-Up・Button = SB = cpu2）で cpu2 が All-in し、Hero の手番で止まるようにする。
    policy["cpu2"] = "shove";
    const next = orchestrator.startHand();
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.created).toBe(true);
    expect(next.value.view.actorId).toBe(HERO);
    const before = events(next.value.handId).length;

    const again = orchestrator.startHand();
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toMatchObject({
      handId: next.value.handId,
      created: false,
    });
    expect(again.value.view).toEqual(next.value.view);
    expect(events(next.value.handId)).toHaveLength(before);
    expect(orchestrator.sessionStatus(next.value.handId)).toEqual({
      state: "in_hand",
    });
  });

  it("6 人卓の開始直後（Hero の手番）に開始を再送しても、同じ Hand を返す", () => {
    const { orchestrator } = setup();
    const first = orchestrator.startHand();
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.view.status).toBe("in_progress");
    const again = orchestrator.startHand();
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toMatchObject({
      handId: first.value.handId,
      created: false,
    });
    expect(orchestrator.sessionStatus("nope")).toBeNull();
  });

  it("最後の Hand が内部エラーで止まっていたら、新しい Session として均等 Stack で始める", () => {
    vi.useFakeTimers();
    const { orchestrator, events, store } = setup({ botDelayMs: 100 });
    const first = orchestrator.startHand();
    if (!first.ok) throw new Error(first.error.message);
    // 最初の Hand の Preflop は CPU（UTG）から。予約した CPU の手番の書き込みを失敗させて進行を止める。
    expect(first.value.view.actorId).not.toBe(HERO);
    store.failing = true;
    vi.advanceTimersByTime(100);
    store.failing = false;

    const second = orchestrator.startHand();
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.created).toBe(true);
    expect(second.value.handId).not.toBe(first.value.handId);
    const opening = startedOf(events(second.value.handId));
    expect(opening.seats.map((s) => s.stack)).toEqual(
      PHASE1_TABLE_SETUP.players.map(() => PHASE1_TABLE_SETUP.startingStack),
    );
    expect(opening.buttonPlayerId).toBe("hero");
    expect(store.sessionOf.get(second.value.handId)).not.toBe(
      store.sessionOf.get(first.value.handId),
    );
  });

  it("同じ seed と同じ Hero の Action なら、同じ Event Log になる（再現性）", () => {
    const run = () => {
      const { orchestrator, events } = setup({ nextSeed: () => 20261005 });
      const started = orchestrator.startHand();
      if (!started.ok) throw new Error(started.error.message);
      playOut(orchestrator, started.value.handId, started.value.view);
      return events(started.value.handId);
    };
    expect(run()).toEqual(run());
  });

  it("CPU の出力が非合法なら Safe Fallback（Check、できなければ Fold）にして記録する", () => {
    // 常に非合法な額の Raise を返す CPU。
    const broken: OpponentFactory = () => ({
      decide: () => ({ type: "raise", amount: -1 }),
    });
    const { orchestrator, events } = setup({ createOpponent: broken });
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    playOut(orchestrator, handId, view);

    const fallbacks = orchestrator.fallbacksOf(handId);
    expect(fallbacks.length).toBeGreaterThan(0);
    const log = events(handId);
    for (const record of fallbacks) {
      const applied = log.find((e) => e.seq === record.seq);
      expect(applied?.type).toBe("ACTION_TAKEN");
      if (applied?.type !== "ACTION_TAKEN") continue;
      expect(applied.playerId).toBe(record.playerId);
      expect(["check", "fold"]).toContain(applied.action);
      expect(record.reason).toContain("illegal_action");
    }
    expect(finishedStacks(log)).toBe(TOTAL_CHIPS);
  });

  it("CPU が例外を投げても Safe Fallback で Hand を進める", () => {
    const throwing: OpponentFactory = (): OpponentAgent => ({
      decide: () => {
        throw new Error("boom");
      },
    });
    const { orchestrator } = setup({ createOpponent: throwing });
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const final = playOut(
      orchestrator,
      started.value.handId,
      started.value.view,
    );
    expect(final.status).toBe("complete");
    expect(orchestrator.fallbacksOf(started.value.handId)[0]?.reason).toContain(
      "boom",
    );
  });

  it("古い lastSeq（二重送信・古い画面）は stale_view で拒否し、Log を変えない", () => {
    const { orchestrator, events } = setup();
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    expect(view.actorId).toBe(HERO);

    const first = orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(first.ok).toBe(true);
    const before = events(handId).length;
    // 同じリクエストをもう一度送る。
    const again = orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(again).toMatchObject({ ok: false, error: { kind: "stale_view" } });
    expect(events(handId).length).toBe(before);
  });

  it("未知の Hand は hand_not_found", () => {
    const { orchestrator } = setup();
    expect(orchestrator.heroAction("nope", 0, { type: "fold" })).toMatchObject({
      ok: false,
      error: { kind: "hand_not_found" },
    });
    expect(orchestrator.heroView("nope")).toBeNull();
    expect(orchestrator.subscribe("nope", () => {})).toBeNull();
  });

  it("思考待ちがあると CPU は 1 手ずつ進み、その間の Hero の Action は not_actor で拒否される", () => {
    vi.useFakeTimers();
    // 最初の Hand は Button = hero なので、Preflop の最初の Actor は CPU（UTG）。
    const { orchestrator, events } = setup({ botDelayMs: 100 });
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    expect(view.actorId).not.toBe(HERO);

    const pushed: HeroView[] = [];
    orchestrator.subscribe(handId, (v) => pushed.push(v));
    const early = orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(early).toMatchObject({ ok: false, error: { kind: "not_actor" } });

    const before = events(handId).length;
    vi.advanceTimersByTime(99);
    expect(events(handId).length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(events(handId).length).toBeGreaterThan(before);
    expect(pushed.length).toBe(1);

    vi.runAllTimers();
    const latest = orchestrator.heroView(handId);
    expect(latest?.status === "complete" || latest?.actorId === HERO).toBe(
      true,
    );
  });

  it("close 後は予約済みの CPU の手番を実行しない", () => {
    vi.useFakeTimers();
    const { orchestrator, events } = setup({ botDelayMs: 100 });
    const started = orchestrator.startHand();
    if (!started.ok) throw new Error(started.error.message);
    const before = events(started.value.handId).length;
    orchestrator.close();
    vi.runAllTimers();
    expect(events(started.value.handId).length).toBe(before);
  });

  it("Hero はちょうど 1 人でなければ組み立てを拒否する", () => {
    expect(() =>
      setup({
        setup: {
          ...PHASE1_TABLE_SETUP,
          players: PHASE1_TABLE_SETUP.players.map((p) => ({
            ...p,
            kind: "cpu" as const,
          })),
        },
      }),
    ).toThrow(RangeError);
  });
});
