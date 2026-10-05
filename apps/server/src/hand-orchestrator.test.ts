import {
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE1_TABLE_SETUP, buildTableSetup } from "./config.js";
import { InMemoryEventStore } from "./event-store.js";
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

function setup(overrides: Partial<HandOrchestratorOptions> = {}) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const orchestrator = new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    createOpponent: createRuleBot,
    botDelayMs: 0,
    nextSeed: () => 42,
    nextHandId: () => `hand-${++handNo}`,
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
  const finished = events.find((e) => e.type === "HAND_FINISHED");
  if (finished?.type !== "HAND_FINISHED")
    throw new Error("HAND_FINISHED が無い");
  return finished.stacks.reduce((sum, s) => sum + s.amount, 0);
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
    "%i 人卓でも Hand が最後まで終わり、Button を回しても Chip 総量が不変で CPU は Fallback しない",
    (size) => {
      const tableSetup = buildTableSetup(size);
      const total = tableSetup.startingStack * size;
      for (let seed = 1; seed <= 20; seed++) {
        const { orchestrator, events } = setup({
          setup: tableSetup,
          nextSeed: () => seed,
        });
        // 全員が 1 回ずつ Button になるまで回す
        for (let h = 0; h < size; h++) {
          const started = orchestrator.startHand();
          if (!started.ok) throw new Error(started.error.message);
          const { handId, view } = started.value;
          expect(view.seats).toHaveLength(size);
          const hero =
            seed % 3 === 0 ? () => ({ type: "fold" as const }) : passiveHero;
          playOut(orchestrator, handId, view, hero);
          expect(finishedStacks(events(handId))).toBe(total);
          expect(orchestrator.fallbacksOf(handId)).toEqual([]);
        }
      }
    },
  );

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
