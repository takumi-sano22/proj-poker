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
  OpponentFactory,
  OpponentInput,
  OpponentOutput,
} from "./opponents/opponent-agent.js";
import { RuleBot, createRuleBot } from "./opponents/rule-bot.js";
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
    opponentTimeoutMs: 1000,
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
async function playOut(
  orchestrator: HandOrchestrator,
  handId: string,
  start: HeroView,
  hero: (view: HeroView) => PlayerAction = passiveHero,
): Promise<HeroView> {
  let view = start;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    expect(view.actorId).toBe(HERO);
    const result = await orchestrator.heroAction(
      handId,
      lastSeq(view),
      hero(view),
    );
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  return view;
}

type InvalidEvent = Extract<HandEvent, { type: "AI_ACTION_INVALID" }>;
type FallbackEvent = Extract<HandEvent, { type: "AI_FALLBACK_USED" }>;

/** Log の AI_ACTION_INVALID（CPU の不正な出力の記録。D83）。 */
function invalidsIn(events: readonly HandEvent[]): InvalidEvent[] {
  return events.filter(
    (e): e is InvalidEvent => e.type === "AI_ACTION_INVALID",
  );
}

/** Log の AI_FALLBACK_USED（Bot の判断で続けた記録。D83）。 */
function fallbacksIn(events: readonly HandEvent[]): FallbackEvent[] {
  return events.filter(
    (e): e is FallbackEvent => e.type === "AI_FALLBACK_USED",
  );
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

/** PlayerAction を CPU の出力の形（OpponentOutput）にする。 */
function toOutput(action: PlayerAction): OpponentOutput {
  return "amount" in action
    ? { action: action.type, amount: action.amount }
    : { action: action.type };
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
      if (policy[playerId] === "shove") {
        return Promise.resolve(toOutput(shove(legal)));
      }
      return Promise.resolve(
        legal.actions.some((a) => a.type === "check")
          ? { action: "check" }
          : { action: "fold" },
      );
    },
  });
}

const shoveHero = (view: HeroView): PlayerAction =>
  view.legalActions === null ? { type: "fold" } : shove(view.legalActions);

/**
 * 3 人卓（hero・cpu1・cpu2）の最初の Hand を、Hero が All-in し CPU が方針どおりに動く形で最後まで進める。
 * seed を 1 から順に試し、最初の Hand の結果が条件に合う最初の seed で止める（Deck は seed だけで決まる）。
 */
async function firstHandWhere(
  policy: Readonly<Record<string, "shove" | "fold">>,
  matches: (stacks: readonly PlayerChips[]) => boolean,
) {
  for (let seed = 1; seed <= 300; seed++) {
    const ctx = setup({
      setup: buildTableSetup(3),
      createOpponent: scriptedCpus(policy),
      nextSeed: () => seed,
    });
    const started = await ctx.orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    await playOut(ctx.orchestrator, handId, view, shoveHero);
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
  it("Hero の手番で止まり、Hero の Action で Hand が最後まで終わる（Chip 総量は不変）", async () => {
    const { orchestrator, events } = setup();
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    // Hand の開始直後は、Hero の手番か、Hand が終わっているかのどちらか（CPU の手番では止まらない）。
    expect(view.status === "complete" || view.actorId === HERO).toBe(true);

    const final = await playOut(orchestrator, handId, view);
    expect(final.status).toBe("complete");
    expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
    expect(fallbacksIn(events(handId))).toEqual([]);
  });

  it("多数の seed で、CPU は合法 Action だけを選び（Fallback なし）、CPU の入力に見えない札・Deck が入らない", async () => {
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
        opponentTimeoutMs: 1000,
        nextSeed: () => seed,
        nextHandId: () => {
          currentHand = `hand-${seed}`;
          return currentHand;
        },
      });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      // seed ごとに Hero の方針を変え、Fold で終わる Hand も通す。
      const hero =
        seed % 3 === 0 ? (): PlayerAction => ({ type: "fold" }) : passiveHero;
      await playOut(orchestrator, currentHand, started.value.view, hero);

      const log = store.read(currentHand).map((s) => s.event);
      expect(finishedStacks(log)).toBe(TOTAL_CHIPS);
      expect(fallbacksIn(log)).toEqual([]);
      for (const { playerId, input, upto } of inputs) {
        expect(Object.keys(input).sort()).toEqual(["knowledge", "legal"]);
        expect(input.knowledge.viewerId).toBe(playerId);
        expect(leakedCards(input, log, playerId, upto)).toEqual([]);
        expect(forbiddenKeys(input)).toEqual([]);
      }
    }
  });

  it.each([2, 6, 8])(
    "%i 人卓で Session を通して、Stack を持ち越し Chip 総量が保存され、Bust した席は退席し、CPU は Fallback しない",
    async (size) => {
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
          const started = await orchestrator.startHand(
            previous?.handId ?? null,
          );
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
          await playOut(orchestrator, handId, view, hero);
          expect(finishedStacks(events(handId))).toBe(total);
          expect(fallbacksIn(events(handId))).toEqual([]);
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

  it("3 人卓で CPU が Bust すると退席し、次 Hand は 2 人（Heads-Up・Button = SB）で Stack を持ち越して続く", async () => {
    const { orchestrator, events, store, handId } = await firstHandWhere(
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

    const next = await orchestrator.startHand(handId);
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

  it("Hero が Bust したら Session を終え、次の Hand は新しい Session として均等 Stack で始まる", async () => {
    const { orchestrator, events, store, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "hero") === 0,
    );
    // CPU が 2 人残っていても、Hero が Bust したら Session は終わる（D80）。
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ended",
      reason: "hero_busted",
    });

    const next = await orchestrator.startHand(handId);
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

  it("CPU が全員 Bust して Hero だけが残ったら Session を終える", async () => {
    const { orchestrator, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "shove" },
      (stacks) =>
        stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "cpu2") === 0,
    );
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ended",
      reason: "hero_last_standing",
    });
  });

  it("今の Session の Hand が進行中なら、新しい Hand を作らずその Hand を返す（開始の再送で Session を捨てない）", async () => {
    const policy: Record<string, "shove" | "fold"> = {
      cpu1: "shove",
      cpu2: "fold",
    };
    const { orchestrator, events, handId } = await firstHandWhere(
      policy,
      (stacks) => stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "hero") > 0,
    );
    // 2 Hand 目（Heads-Up・Button = SB = cpu2）で cpu2 が All-in し、Hero の手番で止まるようにする。
    policy["cpu2"] = "shove";
    const next = await orchestrator.startHand(handId);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.created).toBe(true);
    expect(next.value.view.actorId).toBe(HERO);
    const before = events(next.value.handId).length;

    const again = await orchestrator.startHand(handId);
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

  it("開始直後に終わった Hand も、クライアントがまだ見ていなければ再送で同じ Hand を返し、見た後の開始で次へ進む", async () => {
    const { orchestrator, events, store, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "hero") > 0,
    );
    // 2 Hand 目（Heads-Up）は Button = SB の cpu2 が Fold するので、開始の時点で終わる。
    const next = await orchestrator.startHand(handId);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value).toMatchObject({ created: true });
    expect(next.value.view.status).toBe("complete");

    // 応答が失われて同じ要求（1 Hand 目の次）を再送しても、2 Hand 目を返し、3 Hand 目へ進めない。
    const again = await orchestrator.startHand(handId);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toMatchObject({
      handId: next.value.handId,
      created: false,
    });
    expect(again.value.view).toEqual(next.value.view);

    // 2 Hand 目を見たうえでの開始なら 3 Hand 目へ進み、Stack を持ち越す（同じ Session）。
    const third = await orchestrator.startHand(next.value.handId);
    if (!third.ok) throw new Error(third.error.message);
    expect(third.value.created).toBe(true);
    expect(third.value.handId).not.toBe(next.value.handId);
    expect(startedOf(events(third.value.handId)).seats).toEqual(
      finishedOf(events(next.value.handId)).stacks.map((s) => ({
        playerId: s.playerId,
        stack: s.amount,
      })),
    );
    expect(store.sessionOf.get(third.value.handId)).toBe(
      store.sessionOf.get(handId),
    );
  });

  it("Session が終わった Hand も、クライアントがまだ見ていなければ新しい Session へ進めずその Hand を返す", async () => {
    const { orchestrator, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "hero") === 0,
    );
    // 結果を見ていない（null のまま）要求には、終わった Hand をそのまま返す。
    const unseen = await orchestrator.startHand(null);
    if (!unseen.ok) throw new Error(unseen.error.message);
    expect(unseen.value).toMatchObject({ handId, created: false });
    expect(orchestrator.sessionStatus(handId)).toMatchObject({
      state: "ended",
    });
  });

  it("6 人卓の開始直後（Hero の手番）に開始を再送しても、同じ Hand を返す", async () => {
    const { orchestrator } = setup();
    const first = await orchestrator.startHand(null);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.view.status).toBe("in_progress");
    const again = await orchestrator.startHand(null);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toMatchObject({
      handId: first.value.handId,
      created: false,
    });
    expect(orchestrator.sessionStatus("nope")).toBeNull();
  });

  it("最後の Hand が内部エラーで止まっていたら、新しい Session として均等 Stack で始める", async () => {
    vi.useFakeTimers();
    const { orchestrator, events, store } = setup({ botDelayMs: 100 });
    const first = await orchestrator.startHand(null);
    if (!first.ok) throw new Error(first.error.message);
    // 最初の Hand の Preflop は CPU（UTG）から。予約した CPU の手番の書き込みを失敗させて進行を止める。
    expect(first.value.view.actorId).not.toBe(HERO);
    store.failing = true;
    await vi.advanceTimersByTimeAsync(100);
    store.failing = false;

    const second = await orchestrator.startHand(first.value.handId);
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

  it("同じ seed と同じ Hero の Action なら、同じ Event Log になる（再現性）", async () => {
    const run = async () => {
      const { orchestrator, events } = setup({ nextSeed: () => 20261005 });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      await playOut(orchestrator, started.value.handId, started.value.view);
      return events(started.value.handId);
    };
    expect(await run()).toEqual(await run());
  });

  describe("CPU 出力の検証・Retry・Fallback（Fake Model）", () => {
    /** RuleBot と同じ判断をする Fake Model の正常な出力。 */
    const valid = (input: OpponentInput): Promise<unknown> =>
      Promise.resolve(toOutput(new RuleBot(1).choose(input)));

    /** Fake Model: 呼ばれるたびに respond の結果を返し、受け取った入力を記録する。 */
    function fakeModel(respond: (input: OpponentInput) => Promise<unknown>) {
      const inputs: OpponentInput[] = [];
      const factory: OpponentFactory = () => ({
        decide: (input) => {
          inputs.push(input);
          return respond(input);
        },
      });
      return { factory, inputs };
    }

    it("不正 → 正常: Correction（理由）付きで 1 回だけ再要求し、正常な出力を使う（Fallback しない）", async () => {
      const { factory, inputs } = fakeModel((input) =>
        input.correction === undefined
          ? Promise.resolve({ action: "shove" })
          : valid(input),
      );
      const { orchestrator, events } = setup({ createOpponent: factory });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      const { handId, view } = started.value;
      await playOut(orchestrator, handId, view);

      const log = events(handId);
      expect(fallbacksIn(log)).toEqual([]);
      const invalid = invalidsIn(log);
      expect(invalid.length).toBeGreaterThan(0);
      // CPU の手番ごとに、1 回目が不正・2 回目（Correction 付き）が正常。
      expect(inputs).toHaveLength(invalid.length * 2);
      for (const [i, record] of invalid.entries()) {
        expect(record).toMatchObject({
          attempt: 1,
          stage: "schema",
          visibility: { type: "system" },
        });
        expect(inputs[i * 2]?.correction).toBeUndefined();
        expect(inputs[i * 2 + 1]?.correction).toEqual({
          stage: "schema",
          reason: record.reason,
        });
        // 再要求の入力も KnowledgeState と Legal Action は同じ（Correction だけが足される）。
        expect(inputs[i * 2 + 1]?.knowledge).toEqual(inputs[i * 2]?.knowledge);
        // 記録の直後の seq に、正常な出力の Action が入っている。
        expect(log.find((e) => e.seq === record.seq + 1)).toMatchObject({
          type: "ACTION_TAKEN",
          playerId: record.playerId,
        });
      }
      expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
    });

    /** 各段で必ず不正になる出力を、その手番の Legal Action から作る。 */
    const invalidAt: Record<
      "schema" | "legal_action" | "amount_range",
      (legal: LegalActionSet) => unknown
    > = {
      // bet / raise なのに amount が無い。
      schema: () => ({ action: "raise" }),
      // Check できる手番で Call、できない手番で Check。
      legal_action: (legal) =>
        legal.actions.some((a) => a.type === "check")
          ? { action: "call" }
          : { action: "check" },
      // 選べる bet / raise の上限を 1 超える額。
      amount_range: (legal) => {
        const sized = legal.actions.find(
          (a) => a.type === "bet" || a.type === "raise",
        );
        if (sized?.type !== "bet" && sized?.type !== "raise") {
          throw new Error("bet / raise を選べない手番");
        }
        return { action: sized.type, amount: sized.max + 1 };
      },
    };

    it.each(["schema", "legal_action", "amount_range"] as const)(
      "不正 → 不正（%s）: 再要求の後、RuleBot の判断（Deterministic Fallback）で続け、記録を残す",
      async (stage) => {
        const { factory, inputs } = fakeModel(({ legal }) =>
          Promise.resolve(invalidAt[stage](legal)),
        );
        const { orchestrator, events } = setup({ createOpponent: factory });
        const started = await orchestrator.startHand(null);
        if (!started.ok) throw new Error(started.error.message);
        const { handId, view } = started.value;
        await playOut(orchestrator, handId, view);

        const log = events(handId);
        const fallbacks = fallbacksIn(log);
        const invalid = invalidsIn(log);
        expect(fallbacks.length).toBeGreaterThan(0);
        // 1 手につき 2 回だけ求め（1 回の Retry）、2 回とも不正として記録する。
        expect(inputs).toHaveLength(fallbacks.length * 2);
        expect(invalid).toHaveLength(fallbacks.length * 2);
        for (const record of fallbacks) {
          // 手番ごとに AI_ACTION_INVALID（1 回目・2 回目）→ AI_FALLBACK_USED → Fallback の ACTION_TAKEN が続く。
          const turn = log.slice(record.seq - 2, record.seq + 2);
          expect(
            turn.map((e) => [
              e.type,
              e.type === "AI_ACTION_INVALID" ? e.attempt : null,
              "playerId" in e ? e.playerId : null,
            ]),
          ).toEqual([
            ["AI_ACTION_INVALID", 1, record.playerId],
            ["AI_ACTION_INVALID", 2, record.playerId],
            ["AI_FALLBACK_USED", null, record.playerId],
            ["ACTION_TAKEN", null, record.playerId],
          ]);
          expect(
            turn
              .slice(0, 2)
              .map((e) => e.type === "AI_ACTION_INVALID" && e.stage),
          ).toEqual([stage, stage]);
          expect(record).toMatchObject({
            fallbackKind: "automatic",
            visibility: { type: "system" },
          });
          expect(record.reason).toContain(stage);
        }
        expect(orchestrator.outageOf(handId)).toBeNull();
        expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
      },
    );

    it("出力が常に不正なら、各 CPU は同じ seed の RuleBot と同じ判断になる（Fallback は決定論）", async () => {
      const run = async (createOpponent: OpponentFactory) => {
        const { orchestrator, events } = setup({
          createOpponent,
          nextSeed: () => 777,
        });
        const started = await orchestrator.startHand(null);
        if (!started.ok) throw new Error(started.error.message);
        await playOut(orchestrator, started.value.handId, started.value.view);
        return events(started.value.handId);
      };
      const broken = await run(fakeModel(() => Promise.resolve(null)).factory);
      const ruleBot = await run(createRuleBot);
      expect(fallbacksIn(broken).length).toBeGreaterThan(0);
      expect(fallbacksIn(ruleBot)).toEqual([]);
      // 判断の経緯の記録（system）を除けば、seq 以外は同じ Event 列になる。
      const tableEvents = (log: HandEvent[]) =>
        log
          .filter((e) => e.visibility.type !== "system")
          .map((e) => ({ ...e, seq: 0 }));
      expect(tableEvents(broken)).toEqual(tableEvents(ruleBot));
    });

    it("記録（AI_ACTION_INVALID / AI_FALLBACK_USED）は Hero の応答・SSE と、他の CPU の入力に入らない", async () => {
      // CPU ごとに違う生の出力（不正な action の名前）を返させる。不正の理由にはその値が入る。
      const markerOf = (playerId: string) => `raw-output-of-${playerId}`;
      const inputs: { playerId: string; input: OpponentInput }[] = [];
      const factory: OpponentFactory = (_seed, playerId) => ({
        decide: (input) => {
          inputs.push({ playerId, input });
          return Promise.resolve({ action: markerOf(playerId) });
        },
      });
      const { orchestrator, events } = setup({ createOpponent: factory });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      const { handId } = started.value;
      const pushed: HeroView[] = [];
      orchestrator.subscribe(handId, (v) => pushed.push(v));
      const responses: HeroView[] = [started.value.view];
      let view = started.value.view;
      while (view.status !== "complete") {
        const next = await orchestrator.heroAction(
          handId,
          lastSeq(view),
          passiveHero(view),
        );
        if (!next.ok) throw new Error(next.error.message);
        view = next.value;
        responses.push(view);
      }
      const log = events(handId);
      // 記録は Event Log に残り、理由にその CPU の生の出力の値が入っている。
      const invalid = invalidsIn(log);
      expect(invalid.length).toBeGreaterThan(0);
      expect(fallbacksIn(log).length).toBeGreaterThan(0);
      for (const record of invalid) {
        expect(record.reason).toContain(markerOf(record.playerId));
      }
      // Hero の応答・SSE には、記録の種別も、どの CPU の生の出力も出ない。
      expect(pushed.length).toBeGreaterThan(0);
      const cpuIds = PHASE1_TABLE_SETUP.players
        .filter((p) => p.kind === "cpu")
        .map((p) => p.playerId);
      for (const payload of [...responses, ...pushed]) {
        expect(forbiddenKeys(payload)).toEqual([]);
        for (const id of cpuIds) {
          expect(JSON.stringify(payload)).not.toContain(markerOf(id));
        }
      }
      // CPU の KnowledgeState には誰の記録も入らない。Correction（D41）は本人の再要求にだけ付く。
      expect(new Set(inputs.map((i) => i.playerId)).size).toBeGreaterThan(1);
      for (const { playerId, input } of inputs) {
        expect(forbiddenKeys(input)).toEqual([]);
        for (const id of cpuIds) {
          expect(JSON.stringify(input.knowledge)).not.toContain(markerOf(id));
          if (id !== playerId) {
            expect(JSON.stringify(input)).not.toContain(markerOf(id));
          }
        }
      }
    });

    it.each([
      [
        "Promise の reject",
        () => Promise.reject(new Error("API が 500 を返した")),
      ],
      [
        "Promise を返す前の例外",
        () => {
          throw new Error("API が 500 を返した");
        },
      ],
    ] as const)(
      "例外（%s）は障害として Hand をその手番で止め、RuleBot へ自動で切り替えない",
      async (_label, respond) => {
        const { factory, inputs } = fakeModel(respond);
        const { orchestrator, events } = setup({ createOpponent: factory });
        const started = await orchestrator.startHand(null);
        if (!started.ok) throw new Error(started.error.message);
        const { handId, view } = started.value;
        // 最初の Hand の Preflop は CPU（UTG）から。その手番で止まる。
        expect(view.actorId).not.toBe(HERO);
        expect(view.status).toBe("in_progress");
        const outage = orchestrator.outageOf(handId);
        expect(outage).toMatchObject({
          seq: events(handId).length,
          playerId: view.actorId,
          kind: "error",
        });
        expect(outage?.message).toContain("API が 500 を返した");
        // 障害は再要求しない（不正な出力ではない）・Fallback もしない。
        expect(inputs).toHaveLength(1);
        expect(fallbacksIn(events(handId))).toEqual([]);
        expect(invalidsIn(events(handId))).toEqual([]);

        // 止まった Hand は保持され、開始の再送でも同じ Hand を返す（新しい Session を始めない）。
        const before = events(handId).length;
        const again = await orchestrator.startHand(null);
        expect(again).toMatchObject({
          ok: true,
          value: { handId, created: false },
        });
        expect(
          await orchestrator.heroAction(handId, lastSeq(view), {
            type: "fold",
          }),
        ).toMatchObject({ ok: false, error: { kind: "not_actor" } });
        expect(events(handId)).toHaveLength(before);
        expect(inputs).toHaveLength(1);
      },
    );

    it("不正 → 例外は、再要求の途中でも障害として止める", async () => {
      const { factory, inputs } = fakeModel((input) =>
        input.correction === undefined
          ? Promise.resolve({ action: "fold", amount: 1 })
          : Promise.reject(new Error("timeout from API")),
      );
      const { orchestrator, events } = setup({ createOpponent: factory });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      const { handId } = started.value;
      expect(inputs).toHaveLength(2);
      expect(invalidsIn(events(handId))).toMatchObject([
        { attempt: 1, stage: "schema", seq: events(handId).length - 1 },
      ]);
      expect(orchestrator.outageOf(handId)).toMatchObject({
        seq: events(handId).length,
        kind: "error",
      });
      expect(fallbacksIn(events(handId))).toEqual([]);
    });

    it("遅延: 上限を超えたら障害（timeout）として止め、後から届いた判断を適用しない", async () => {
      vi.useFakeTimers();
      const { factory, inputs } = fakeModel(
        (input) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(valid(input)), 5000);
          }),
      );
      const { orchestrator, events } = setup({
        createOpponent: factory,
        opponentTimeoutMs: 1000,
      });
      const pending = orchestrator.startHand(null);
      await vi.advanceTimersByTimeAsync(999);
      expect(inputs).toHaveLength(1);
      const handId = "hand-1";
      expect(orchestrator.outageOf(handId)).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const started = await pending;
      if (!started.ok) throw new Error(started.error.message);
      expect(orchestrator.outageOf(handId)).toMatchObject({
        seq: events(handId).length,
        kind: "timeout",
      });
      const before = events(handId).length;

      // 上限の後に判断が届いても、Log は変わらず、次の判断も求めない。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events(handId)).toHaveLength(before);
      expect(inputs).toHaveLength(1);
      expect(fallbacksIn(events(handId))).toEqual([]);
    });

    it("遅延: 上限以内に届いた判断はそのまま使う", async () => {
      vi.useFakeTimers();
      const { factory } = fakeModel(
        (input) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(valid(input)), 999);
          }),
      );
      const { orchestrator, events } = setup({
        createOpponent: factory,
        opponentTimeoutMs: 1000,
      });
      const pending = orchestrator.startHand(null);
      // CPU の手番の数だけ 999ms ずつ待つ（上限の 1000ms には届かない）。
      await vi.advanceTimersByTimeAsync(999 * 20);
      const started = await pending;
      if (!started.ok) throw new Error(started.error.message);
      const { handId, view } = started.value;
      expect(view.status === "complete" || view.actorId === HERO).toBe(true);
      expect(orchestrator.outageOf(handId)).toBeNull();
      expect(fallbacksIn(events(handId))).toEqual([]);
    });

    it("判断を待っている間に close したら、後から届いた判断を適用しない", async () => {
      vi.useFakeTimers();
      const { factory } = fakeModel(
        (input) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(valid(input)), 500);
          }),
      );
      const { orchestrator, events } = setup({
        createOpponent: factory,
        opponentTimeoutMs: 1000,
      });
      const pending = orchestrator.startHand(null);
      await vi.advanceTimersByTimeAsync(100);
      const before = events("hand-1").length;
      orchestrator.close();
      const started = await pending;
      expect(started.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events("hand-1")).toHaveLength(before);
      expect(orchestrator.outageOf("hand-1")).toBeNull();
    });
  });

  it("古い lastSeq（二重送信・古い画面）は stale_view で拒否し、Log を変えない", async () => {
    const { orchestrator, events } = setup();
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    expect(view.actorId).toBe(HERO);

    const first = await orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(first.ok).toBe(true);
    const before = events(handId).length;
    // 同じリクエストをもう一度送る。
    const again = await orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(again).toMatchObject({ ok: false, error: { kind: "stale_view" } });
    expect(events(handId).length).toBe(before);
  });

  it("未知の Hand は hand_not_found", async () => {
    const { orchestrator } = setup();
    expect(
      await orchestrator.heroAction("nope", 0, { type: "fold" }),
    ).toMatchObject({
      ok: false,
      error: { kind: "hand_not_found" },
    });
    expect(orchestrator.heroView("nope")).toBeNull();
    expect(orchestrator.subscribe("nope", () => {})).toBeNull();
  });

  it("思考待ちがあると CPU は 1 手ずつ進み、その間の Hero の Action は not_actor で拒否される", async () => {
    vi.useFakeTimers();
    // 最初の Hand は Button = hero なので、Preflop の最初の Actor は CPU（UTG）。
    const { orchestrator, events } = setup({ botDelayMs: 100 });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    expect(view.actorId).not.toBe(HERO);

    const pushed: HeroView[] = [];
    orchestrator.subscribe(handId, (v) => pushed.push(v));
    const early = await orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    expect(early).toMatchObject({ ok: false, error: { kind: "not_actor" } });

    const before = events(handId).length;
    await vi.advanceTimersByTimeAsync(99);
    expect(events(handId).length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(handId).length).toBeGreaterThan(before);
    expect(pushed.length).toBe(1);

    await vi.runAllTimersAsync();
    const latest = orchestrator.heroView(handId);
    expect(latest?.status === "complete" || latest?.actorId === HERO).toBe(
      true,
    );
  });

  it("close 後は予約済みの CPU の手番を実行しない", async () => {
    vi.useFakeTimers();
    const { orchestrator, events } = setup({ botDelayMs: 100 });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const before = events(started.value.handId).length;
    orchestrator.close();
    await vi.runAllTimersAsync();
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
