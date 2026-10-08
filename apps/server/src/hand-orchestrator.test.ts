import {
  composeChips,
  MAX_PLAYERS,
  type HandEvent,
  type HeroView,
  type LegalActionSet,
  type PhysicalAction,
  type PlayerAction,
  type PlayerChips,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppVersion } from "./app-version.js";
import { PHASE1_TABLE_SETUP, buildTableSetup } from "./config.js";
import { InMemoryEventStore, type AppendContext } from "./event-store.js";
import {
  deriveSeed,
  HandOrchestrator,
  type HandOrchestratorOptions,
} from "./hand-orchestrator.js";
import {
  composeSessionParticipants,
  PHASE7_CPU_POOL,
  type SessionParticipant,
} from "./opponents/cpu-pool.js";
import {
  OpponentOutageError,
  type OpponentFactory,
  type OpponentInput,
  type OpponentOutput,
} from "./opponents/opponent-agent.js";
import {
  createClaudeOpponentFactory,
  type ClaudeQuery,
} from "./opponents/claude-opponent.js";
import {
  PERSONA_PRESETS,
  PERSONA_PROFILE_VERSION,
} from "./opponents/persona.js";
import { RuleBot, createRuleBot } from "./opponents/rule-bot.js";
import { forbiddenKeys, leakedCards, personaTerms } from "./testing/leaks.js";

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
    return super.append(handId, events, context);
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

/** Log の HAND_METADATA_RECORDED（Hand ごとの Metadata。#97）。HAND_STARTED の直後（seq 1）にある。 */
function metadataOf(events: readonly HandEvent[]) {
  const metadata = events[1];
  if (metadata?.type !== "HAND_METADATA_RECORDED")
    throw new Error("HAND_METADATA_RECORDED が seq 1 に無い");
  return metadata;
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
    // 20 seed × 最大 30 Hand の開始ごとに、CPU の Memory（#139）と Tilt（#140）が Session の保存済みの Hand を読み直すので、
    // 並列に走る CI では既定の 5 秒を超えることがある（8 人卓で 5.2 秒の実測）。判定の中身は変えず、上限だけを広げる。
    20_000,
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
    // Session の終わりは HAND_FINISHED の直後の SESSION_ENDED（system）として同じ追記で残る（D95）。
    expect(events(handId).slice(-2)).toMatchObject([
      { type: "HAND_FINISHED" },
      {
        type: "SESSION_ENDED",
        sessionId: store.sessionOf.get(handId),
        reason: "hero_busted",
        visibility: { type: "system" },
      },
    ]);
    expect(store.latestSessionProjection()).toMatchObject({
      lastHandId: handId,
      state: "ended",
      endReason: "hero_busted",
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
    const { orchestrator, events, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "shove" },
      (stacks) =>
        stackOf(stacks, "cpu1") === 0 && stackOf(stacks, "cpu2") === 0,
    );
    expect(orchestrator.sessionStatus(handId)).toEqual({
      state: "ended",
      reason: "hero_last_standing",
    });
    expect(events(handId).at(-1)).toMatchObject({
      type: "SESSION_ENDED",
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

    /** Fake Model: 呼ばれるたびに respond の結果を返し、受け取った入力と signal を記録する。 */
    function fakeModel(respond: (input: OpponentInput) => Promise<unknown>) {
      const inputs: OpponentInput[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      const factory: OpponentFactory = () => ({
        decide: (input, signal) => {
          inputs.push(input);
          signals.push(signal);
          return respond(input);
        },
      });
      return { factory, inputs, signals };
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

    it("遅延: 上限を超えたら decide に渡した signal を abort する（Claude の子プロセス等を止めさせる）", async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const factory: OpponentFactory = () => ({
        decide: (input, signal) => {
          if (signal !== undefined) signals.push(signal);
          return new Promise((resolve) => {
            setTimeout(() => resolve(valid(input)), 5000);
          });
        },
      });
      const { orchestrator } = setup({
        createOpponent: factory,
        opponentTimeoutMs: 1000,
      });
      const pending = orchestrator.startHand(null);
      await vi.advanceTimersByTimeAsync(999);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(signals[0]?.aborted).toBe(true);
    });

    it("判断が返った・例外で止まった後は signal を abort しない", async () => {
      const signals: AbortSignal[] = [];
      const factory: OpponentFactory = () => ({
        decide: (input, signal) => {
          if (signal !== undefined) signals.push(signal);
          return signals.length === 1
            ? valid(input)
            : Promise.reject(new Error("障害"));
        },
      });
      const { orchestrator } = setup({ createOpponent: factory });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      expect(signals).toHaveLength(2);
      expect(signals.map((s) => s.aborted)).toEqual([false, false]);
      expect(orchestrator.outageOf(started.value.handId)).toMatchObject({
        kind: "error",
      });
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
      const { factory, signals } = fakeModel(
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
      expect(signals[0]?.aborted).toBe(false);
      orchestrator.close();
      const started = await pending;
      expect(started.ok).toBe(true);
      // 待ちを打ち切ったので、CPU 側の処理にも中断を伝える。
      expect(signals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events("hand-1")).toHaveLength(before);
      expect(orchestrator.outageOf("hand-1")).toBeNull();
    });

    describe("障害の続け方（Retry / Emergency Bot / Session 終了。#52・D86）", () => {
      /** 内部のエラー本文（資格情報やパスを含みうる）。Hero に返す障害の状態に入ってはいけない。 */
      const SECRET = "/home/u/.claude/.credentials.json sk-ant-secret";

      /**
       * 最初に判断を求められた CPU だけが障害を起こす Fake Model。broken.down が true の間は例外を投げる。
       * その CPU が誰かは broken.playerId に入る。
       */
      function brokenFirstCpu(error: () => Error = () => new Error(SECRET)) {
        const broken = { playerId: null as string | null, down: true };
        const model = fakeModel((input) => {
          broken.playerId ??= input.knowledge.viewerId;
          return broken.down && input.knowledge.viewerId === broken.playerId
            ? Promise.reject(error())
            : valid(input);
        });
        return { broken, ...model };
      }

      async function startBroken(error?: () => Error) {
        const model = brokenFirstCpu(error);
        const ctx = setup({ createOpponent: model.factory });
        const started = await ctx.orchestrator.startHand(null);
        if (!started.ok) throw new Error(started.error.message);
        const cpu = model.broken.playerId;
        if (cpu === null) throw new Error("CPU に判断を求めていない");
        return { ...ctx, ...model, ...started.value, cpu };
      }

      it("Hero に返す障害の状態は、どの CPU の手番か・種類と revision だけ（エラー本文・Persona を含まない）", async () => {
        const { orchestrator, handId, view, cpu } = await startBroken();
        const status = orchestrator.outageStatus(handId);
        expect(status).toEqual({
          revision: 1,
          current: { playerId: cpu, kind: "error" },
        });
        expect(view.actorId).toBe(cpu);
        expect(JSON.stringify(status)).not.toContain("sk-ant");
        expect(JSON.stringify(status)).not.toContain(".credentials");
        expect(personaTerms(status)).toEqual([]);
        // サーバー内の記録（outageOf）には本文を残す（ログ・調査用）。
        expect(orchestrator.outageOf(handId)?.message).toContain(SECRET);
        expect(orchestrator.outageStatus("nope")).toBeNull();
      });

      it("種類の分かる例外（OpponentOutageError）はその種類で障害にする", async () => {
        for (const kind of ["unauthenticated", "usage_limit"] as const) {
          const { orchestrator, handId } = await startBroken(
            () => new OpponentOutageError("枠の上限", kind),
          );
          expect(orchestrator.outageStatus(handId)?.current?.kind).toBe(kind);
        }
      });

      it("Retry: 同じ手番を同じ入力でもう一度求め、通れば Hand を続ける（Fallback しない）", async () => {
        const { orchestrator, events, handId, cpu, inputs, broken } =
          await startBroken();
        const before = events(handId).length;
        broken.down = false;
        const result = await orchestrator.resolveOutage(handId, 1, "retry");
        if (!result.ok) throw new Error(result.error.message);
        // 再試行の入力は、障害の前と同じ KnowledgeState と Legal Action（Correction は付かない）。
        expect(inputs[1]?.knowledge).toEqual(inputs[0]?.knowledge);
        expect(inputs[1]?.legal).toEqual(inputs[0]?.legal);
        expect(inputs[1]?.correction).toBeUndefined();
        expect(events(handId)[before]).toMatchObject({
          type: "ACTION_TAKEN",
          playerId: cpu,
        });
        expect(orchestrator.outageStatus(handId)).toEqual({
          revision: 2,
          current: null,
        });
        const view = await playOut(orchestrator, handId, result.value);
        expect(view.status).toBe("complete");
        expect(fallbacksIn(events(handId))).toEqual([]);
        expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
      });

      it("Retry でまた障害なら、同じ手番でまた止まる（revision が進む）", async () => {
        const { orchestrator, events, handId, cpu, inputs } =
          await startBroken();
        const before = events(handId).length;
        const result = await orchestrator.resolveOutage(handId, 1, "retry");
        expect(result.ok).toBe(true);
        expect(inputs).toHaveLength(2);
        expect(events(handId)).toHaveLength(before);
        expect(orchestrator.outageStatus(handId)).toEqual({
          revision: 3,
          current: { playerId: cpu, kind: "error" },
        });
        expect(orchestrator.outageOf(handId)?.seq).toBe(before);
      });

      it("古い revision・障害が無いときの選択は stale_outage で拒否し、何もしない", async () => {
        const { orchestrator, events, handId, inputs, broken } =
          await startBroken();
        expect(
          await orchestrator.resolveOutage(handId, 0, "emergency_bot"),
        ).toMatchObject({ ok: false, error: { kind: "stale_outage" } });
        expect(inputs).toHaveLength(1);
        broken.down = false;
        expect((await orchestrator.resolveOutage(handId, 1, "retry")).ok).toBe(
          true,
        );
        const after = events(handId).length;
        // 二重送信（同じ revision の 2 回目）は、もう障害が無いので拒否する。
        expect(
          await orchestrator.resolveOutage(handId, 1, "emergency_bot"),
        ).toMatchObject({ ok: false, error: { kind: "stale_outage" } });
        expect(
          await orchestrator.resolveOutage(handId, 2, "end_session"),
        ).toMatchObject({ ok: false, error: { kind: "stale_outage" } });
        expect(events(handId)).toHaveLength(after);
        expect(orchestrator.sessionStatus(handId)).toEqual({
          state: "in_hand",
        });
        expect(
          await orchestrator.resolveOutage("nope", 1, "retry"),
        ).toMatchObject({ ok: false, error: { kind: "hand_not_found" } });
      });

      it("Emergency Bot: その CPU を Session の終わりまで RuleBot で動かし、手番ごとに AI_FALLBACK_USED（emergency_bot）を残す", async () => {
        const { orchestrator, events, store, handId, cpu, inputs } =
          await startBroken();
        const result = await orchestrator.resolveOutage(
          handId,
          1,
          "emergency_bot",
        );
        if (!result.ok) throw new Error(result.error.message);
        expect(orchestrator.outageStatus(handId)).toEqual({
          revision: 2,
          current: null,
        });
        // 切り替えは、障害で止まった手番の位置に EMERGENCY_BOT_ENGAGED（system）として残る（D95）。
        const outageSeq = events(handId).findIndex(
          (e) => e.type === "EMERGENCY_BOT_ENGAGED",
        );
        expect(events(handId)[outageSeq]).toEqual({
          type: "EMERGENCY_BOT_ENGAGED",
          playerId: cpu,
          cause: "error",
          seq: outageSeq,
          visibility: { type: "system" },
        });
        expect(events(handId)[outageSeq + 1]).toMatchObject({
          type: "AI_FALLBACK_USED",
          playerId: cpu,
          fallbackKind: "emergency_bot",
        });
        const first = await playOut(orchestrator, handId, result.value);
        expect(first.status).toBe("complete");

        // 同じ Session の次の Hand でも、その CPU は RuleBot のまま（CPU に判断を求めない）。
        const next = await orchestrator.startHand(handId);
        if (!next.ok) throw new Error(next.error.message);
        expect(next.value.created).toBe(true);
        expect(
          orchestrator.outageStatus(next.value.handId)?.current,
        ).toBeNull();
        await playOut(orchestrator, next.value.handId, next.value.view);
        // Hand の開始時の Metadata（#97）: 切り替えた Hand は開始時の実装のまま、次の Hand からその CPU は emergency_bot。
        const providerOf = (id: string) =>
          metadataOf(events(id)).cpuSeats.find((c) => c.playerId === cpu);
        expect(providerOf(handId)?.provider).toBe("rule_bot");
        expect(providerOf(next.value.handId)).toEqual({
          playerId: cpu,
          provider: "emergency_bot",
          modelRole: null,
          model: null,
        });
        expect(
          metadataOf(events(next.value.handId))
            .cpuSeats.filter((c) => c.playerId !== cpu)
            .every((c) => c.provider === "rule_bot"),
        ).toBe(true);

        for (const id of [handId, next.value.handId]) {
          const log = events(id);
          const emergency = fallbacksIn(log);
          // 障害の CPU の Action は、すべて直前に emergency_bot の記録を持つ。
          const cpuActions = log.filter(
            (e) => e.type === "ACTION_TAKEN" && e.playerId === cpu,
          );
          expect(emergency).toHaveLength(cpuActions.length);
          for (const record of emergency) {
            expect(record).toMatchObject({
              playerId: cpu,
              fallbackKind: "emergency_bot",
              visibility: { type: "system" },
            });
            expect(record.reason).toContain("error");
            expect(record.reason).not.toContain("sk-ant");
            expect(log.find((e) => e.seq === record.seq + 1)).toMatchObject({
              type: "ACTION_TAKEN",
              playerId: cpu,
            });
          }
          expect(finishedStacks(log)).toBe(TOTAL_CHIPS);
        }
        // 切り替えの記録は切り替えた Hand にだけあり、Session Projection が次の Hand へ引き継ぐ。
        expect(
          events(next.value.handId).some(
            (e) => e.type === "EMERGENCY_BOT_ENGAGED",
          ),
        ).toBe(false);
        expect(store.latestSessionProjection()?.emergencyBots).toEqual([
          { playerId: cpu, cause: "error" },
        ]);
        // 障害の CPU に判断を求めたのは、障害を起こした 1 回だけ。ほかの CPU には引き続き求める。
        expect(inputs.filter((i) => i.knowledge.viewerId === cpu)).toHaveLength(
          1,
        );
        expect(inputs.some((i) => i.knowledge.viewerId !== cpu)).toBe(true);
        // Hero の View には Emergency Bot の記録が入らない。
        expect(forbiddenKeys(orchestrator.heroView(handId))).toEqual([]);
      });

      it("Session 終了: その Hand を打ち切って Session を終え、次の開始は新しい Session（均等 Stack・Emergency Bot も解除）", async () => {
        const { orchestrator, events, store, handId, cpu, inputs } =
          await startBroken();
        const before = events(handId).length;
        const result = await orchestrator.resolveOutage(
          handId,
          1,
          "end_session",
        );
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.status).toBe("in_progress");
        expect(orchestrator.sessionStatus(handId)).toEqual({
          state: "ended",
          reason: "ai_outage",
        });
        expect(orchestrator.outageStatus(handId)).toEqual({
          revision: 2,
          current: null,
        });
        // 打ち切りと Session の終わりを Event で残し（D95）、以降は進めない（CPU にも求めない）。
        expect(events(handId).slice(before)).toEqual([
          {
            type: "HAND_ABORTED",
            reason: "ai_outage",
            seq: before,
            visibility: { type: "system" },
          },
          {
            type: "SESSION_ENDED",
            sessionId: store.sessionOf.get(handId),
            reason: "ai_outage",
            seq: before + 1,
            visibility: { type: "system" },
          },
        ]);
        expect(inputs).toHaveLength(1);
        expect(
          await orchestrator.heroAction(handId, lastSeq(result.value), {
            type: "fold",
          }),
        ).toMatchObject({ ok: false, error: { kind: "hand_complete" } });
        expect(events(handId)).toHaveLength(before + 2);
        // 打ち切った Hand は終わった Hand として一覧に残り、Session Projection は ai_outage で終わる。
        expect(store.listHands(1)).toMatchObject([
          { handId, finishedAt: null, aborted: true },
        ]);
        expect(store.latestSessionProjection()).toMatchObject({
          lastHandId: handId,
          state: "ended",
          endReason: "ai_outage",
        });

        // 開始は（結果を見ていなくても）新しい Session として均等 Stack で始める。
        const next = await orchestrator.startHand(null);
        if (!next.ok) throw new Error(next.error.message);
        expect(next.value.created).toBe(true);
        expect(store.sessionOf.get(next.value.handId)).not.toBe(
          store.sessionOf.get(handId),
        );
        expect(
          startedOf(events(next.value.handId)).seats.every(
            (s) => s.stack === PHASE1_TABLE_SETUP.startingStack,
          ),
        ).toBe(true);
        // 障害の CPU にも、新しい Session ではまた判断を求める（Emergency Bot を選んでいないので当然 Fallback もしない）。
        expect(
          inputs.filter((i) => i.knowledge.viewerId === cpu).length,
        ).toBeGreaterThanOrEqual(1);
        expect(fallbacksIn(events(next.value.handId))).toEqual([]);
      });

      it("Emergency Bot は新しい Session に持ち越さない", async () => {
        const { orchestrator, handId, cpu, inputs, broken } =
          await startBroken();
        expect(
          (await orchestrator.resolveOutage(handId, 1, "emergency_bot")).ok,
        ).toBe(true);
        // 次は別の CPU を障害にし、その障害で Session 終了を選ぶ（障害が起きるまで Hand を続ける）。
        const other = PHASE1_TABLE_SETUP.players.find(
          (p) => p.kind === "cpu" && p.playerId !== cpu,
        )?.playerId;
        if (other === undefined) throw new Error("ほかの CPU がいない");
        broken.playerId = other;
        let current = handId;
        for (let guard = 0; ; guard++) {
          expect(guard).toBeLessThan(20);
          const status = orchestrator.outageStatus(current);
          if (status?.current != null) {
            expect(status.current.playerId).toBe(other);
            const ended = await orchestrator.resolveOutage(
              current,
              status.revision,
              "end_session",
            );
            expect(ended.ok).toBe(true);
            break;
          }
          const view = orchestrator.heroView(current);
          if (view === null) throw new Error("View が無い");
          if (view.status === "complete") {
            const next = await orchestrator.startHand(current);
            if (!next.ok) throw new Error(next.error.message);
            current = next.value.handId;
            continue;
          }
          const acted = await orchestrator.heroAction(
            current,
            lastSeq(view),
            passiveHero(view),
          );
          if (!acted.ok) throw new Error(acted.error.message);
        }
        // 新しい Session では、Emergency Bot を選んだ CPU にもまた判断を求める。
        broken.down = false;
        const asked = inputs.length;
        const fresh = await orchestrator.startHand(current);
        if (!fresh.ok) throw new Error(fresh.error.message);
        await playOut(orchestrator, fresh.value.handId, fresh.value.view);
        expect(
          inputs.slice(asked).some((i) => i.knowledge.viewerId === cpu),
        ).toBe(true);
      });

      it("障害の状態が変わるたびに購読者へ配る（本文は含まない）", async () => {
        const model = brokenFirstCpu();
        const { orchestrator } = setup({
          createOpponent: model.factory,
          botDelayMs: 1,
        });
        vi.useFakeTimers();
        const started = await orchestrator.startHand(null);
        if (!started.ok) throw new Error(started.error.message);
        const { handId } = started.value;
        const pushed: unknown[] = [];
        orchestrator.subscribeOutage(handId, (s) => pushed.push(s));
        await vi.advanceTimersByTimeAsync(10);
        expect(pushed).toEqual([
          {
            revision: 1,
            current: { playerId: model.broken.playerId, kind: "error" },
          },
        ]);
        model.broken.down = false;
        await orchestrator.resolveOutage(handId, 1, "retry");
        expect(pushed.at(-1)).toEqual({ revision: 2, current: null });
        expect(JSON.stringify(pushed)).not.toContain("sk-ant");
        expect(orchestrator.subscribeOutage("nope", () => {})).toBeNull();
      });
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

/** Claude を呼ばない Fake: Prompt を CPU ごとに prompts へ記録し、call / check / fold の順に選べるものを返す。 */
function recordingClaudeQuery(prompts: Map<string, string[]>): ClaudeQuery {
  return (params) => {
    const viewer = /あなたの ID は (\w+)/.exec(params.prompt)?.[1] ?? "?";
    prompts.set(viewer, [...(prompts.get(viewer) ?? []), params.prompt]);
    const schema = params.options.outputFormat as unknown as {
      schema: { properties: { action: { enum: string[] } } };
    };
    const allowed = schema.schema.properties.action.enum;
    const action =
      ["call", "check", "fold"].find((a) => allowed.includes(a)) ?? "fold";
    return (async function* () {
      await Promise.resolve();
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { action },
      } as never;
    })();
  };
}

describe("Persona（#51）", () => {
  it("Claude の Prompt には自分の Persona だけが入り、CPU の入力（KnowledgeState）・Event Log・Hero の View には誰の Persona も入らない", async () => {
    const prompts = new Map<string, string[]>();
    const claude = createClaudeOpponentFactory({
      model: "test-model",
      env: {},
      query: recordingClaudeQuery(prompts),
    });
    const inputs: OpponentInput[] = [];
    const spy: OpponentFactory = (seed, playerId, persona) => {
      const inner = claude(seed, playerId, persona);
      return {
        decide(input, signal) {
          inputs.push(input);
          return inner.decide(input, signal);
        },
      };
    };
    const { orchestrator, events } = setup({ createOpponent: spy });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const finalView = await playOut(
      orchestrator,
      started.value.handId,
      started.value.view,
    );

    // 全員 call / check なので CPU 5 人とも判断している。
    expect([...prompts.keys()].sort()).toEqual([
      "cpu1",
      "cpu2",
      "cpu3",
      "cpu4",
      "cpu5",
    ]);
    const labels = Object.values(PERSONA_PRESETS).map((p) => p.label);
    for (const [playerId, list] of prompts) {
      const own =
        PERSONA_PRESETS[
          PHASE1_TABLE_SETUP.personas[playerId] as keyof typeof PERSONA_PRESETS
        ].label;
      for (const prompt of list) {
        expect(prompt).toContain(`スタイル: ${own}`);
        // 他の Preset の名前は出てこない（他 CPU の Secret Persona を渡していない）。
        for (const other of labels.filter((l) => l !== own)) {
          expect(prompt).not.toContain(other);
        }
      }
    }
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(forbiddenKeys(input)).toEqual([]);
    // Event Log（DB に保存される正本）には Deck の記録もあるので、Persona の語だけを見る。
    expect(personaTerms(events(started.value.handId))).toEqual([]);
    expect(forbiddenKeys(finalView)).toEqual([]);
  });
});

describe("Hand ごとの Metadata（#97）", () => {
  it("Hand の開始時に HAND_STARTED の直後へ system の Metadata を置き、座った CPU を席順に残す（Hero は入れない）", async () => {
    const { orchestrator, events } = setup();
    const first = await orchestrator.startHand(null);
    if (!first.ok) throw new Error(first.error.message);
    await playOut(orchestrator, first.value.handId, first.value.view);
    const second = await orchestrator.startHand(first.value.handId);
    if (!second.ok) throw new Error(second.error.message);
    for (const id of [first.value.handId, second.value.handId]) {
      const log = events(id);
      const started = startedOf(log);
      expect(metadataOf(log)).toEqual({
        type: "HAND_METADATA_RECORDED",
        seq: 1,
        visibility: { type: "system" },
        // App Version は apps/server の package.json の version（省略時の既定）。
        appVersion: readAppVersion(),
        ruleProfileVersion: PHASE1_TABLE_SETUP.table.ruleProfile,
        cpuProfileVersion: PERSONA_PROFILE_VERSION,
        // 既定の実装は RuleBot（Model を使わないので null）。
        cpuSeats: started.seats
          .filter((s) => s.playerId !== HERO)
          .map((s) => ({
            playerId: s.playerId,
            provider: "rule_bot",
            modelRole: null,
            model: null,
          })),
      });
      // 1 Hand に 1 つだけ。
      expect(
        log.filter((e) => e.type === "HAND_METADATA_RECORDED"),
      ).toHaveLength(1);
    }
  });

  it("Claude の CPU は Model Role と解決した具体モデルを残し、Prompt・CPU の入力・Hero の View には Metadata が入らない", async () => {
    const prompts = new Map<string, string[]>();
    const claude = createClaudeOpponentFactory({
      model: "meta-test-model",
      env: {},
      query: recordingClaudeQuery(prompts),
    });
    const inputs: OpponentInput[] = [];
    const spy: OpponentFactory = (seed, playerId, persona) => {
      const inner = claude(seed, playerId, persona);
      return {
        decide(input, signal) {
          inputs.push(input);
          return inner.decide(input, signal);
        },
      };
    };
    const { orchestrator, events } = setup({
      createOpponent: spy,
      opponentInfo: {
        provider: "claude",
        modelRole: "opponent_fast",
        model: "meta-test-model",
      },
      appVersion: "9.8.7-meta",
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const finalView = await playOut(
      orchestrator,
      started.value.handId,
      started.value.view,
    );

    const metadata = metadataOf(events(started.value.handId));
    expect(metadata.appVersion).toBe("9.8.7-meta");
    expect(metadata.cpuSeats).toHaveLength(5);
    for (const seat of metadata.cpuSeats) {
      expect(seat).toMatchObject({
        provider: "claude",
        modelRole: "opponent_fast",
        model: "meta-test-model",
      });
    }
    // Metadata は system Visibility: Opponent の Prompt・KnowledgeState・Hero の View・SSE の View に入らない。
    expect(prompts.size).toBeGreaterThan(0);
    const leaked =
      /HAND_METADATA|cpuSeats|appVersion|9\.8\.7-meta|meta-test-model|opponent_fast/;
    for (const list of prompts.values()) {
      for (const prompt of list) expect(prompt).not.toMatch(leaked);
    }
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(forbiddenKeys(input)).toEqual([]);
      expect(JSON.stringify(input)).not.toMatch(leaked);
    }
    expect(forbiddenKeys(finalView)).toEqual([]);
    expect(JSON.stringify(finalView)).not.toMatch(leaked);
    // Event Log には Persona の割り当てを入れない（Metadata は Preset 一式の版だけ）。
    expect(personaTerms(events(started.value.handId))).toEqual([]);
  });
});

describe("Hero の物理的な操作（#64・D90・D91）", () => {
  /** 額ちょうどの Chip の額面の列（大きい額面から）。 */
  const chipsFor = (amount: number): number[] =>
    composeChips(amount).flatMap((c) =>
      Array.from({ length: c.count }, () => c.denomination.value),
    );

  /** Hero: Call 額ちょうどの Chip を宣言なしで出す（→ Call）。Call が無ければ Check を宣言する。 */
  function physicalHero(view: HeroView): PhysicalAction[] {
    const call = view.legalActions?.actions.find((a) => a.type === "call");
    return call?.type === "call"
      ? [{ type: "chip_push", chips: chipsFor(call.amount) }]
      : [{ type: "declare", declaration: { kind: "check" } }];
  }

  /** CPU の Call か Check（出力の形）。 */
  const passiveOutput = (legal: LegalActionSet): OpponentOutput =>
    legal.actions.some((a) => a.type === "call")
      ? { action: "call" }
      : { action: "check" };

  /**
   * 最初の 1 回の判断だけ release() まで返さない CPU（Hero が CPU の手番を見ている間を作る）。
   * respond は判断の中身（省略時は Call か Check）。渡された入力は inputs に残る。
   */
  function gatedCpus(
    respond: (input: OpponentInput) => OpponentOutput = (input) =>
      passiveOutput(input.legal),
  ) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const inputs: OpponentInput[] = [];
    const factory: OpponentFactory = () => ({
      decide: async (input) => {
        inputs.push(input);
        if (first) {
          first = false;
          await gate;
        }
        return respond(input);
      },
    });
    return { factory, inputs, release: () => release() };
  }

  /** Event を種類・Player・裁定の要点の文字列にする（並びを比べる）。 */
  function outline(events: readonly HandEvent[]): string[] {
    return events.map((e) => {
      switch (e.type) {
        case "DEALER_RULING":
          return `${e.type} ${e.playerId} ${e.basis} ${e.outcome}${e.action === null ? "" : ` ${e.action.type}`}`;
        case "ACTION_TAKEN":
          return `${e.type} ${e.playerId} ${e.action}`;
        case "PLAYER_DECLARED":
        case "PHYSICAL_CHIP_ACTION":
          return `${e.type} ${e.playerId}`;
        default:
          return e.type;
      }
    });
  }

  it("手番の操作は裁定して Canonical Action を適用し、操作・裁定・Action を Log に残して Hand を最後まで進める", async () => {
    const { orchestrator, events } = setup();
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    let view = started.value.view;
    const { handId } = started.value;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      expect(view.actorId).toBe(HERO);
      const result = await orchestrator.heroPhysicalAction(
        handId,
        lastSeq(view),
        physicalHero(view),
      );
      if (!result.ok) throw new Error(result.error.message);
      view = result.value;
      // Hero の View の log に裁定が入る（public）。
      expect(view.log.some((e) => e.type === "DEALER_RULING")).toBe(true);
    }
    const log = events(handId);
    expect(finishedStacks(log)).toBe(TOTAL_CHIPS);
    // 裁定で Action が決まったら、直後が同じ Player のその Action。
    log.forEach((e, i) => {
      if (e.type !== "DEALER_RULING") return;
      expect(e.playerId).toBe(HERO);
      expect(e.visibility).toEqual({ type: "public" });
      expect(e.outcome).toBe("action");
      expect(log[i + 1]).toMatchObject({
        type: "ACTION_TAKEN",
        playerId: HERO,
        action: e.action?.type,
      });
    });
  });

  it("古い画面からの操作は stale_view で拒否し、何も残さない", async () => {
    const { orchestrator, events } = setup();
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    const before = events(handId).length;
    const result = await orchestrator.heroPhysicalAction(
      handId,
      lastSeq(view) - 1,
      physicalHero(view),
    );
    expect(result.ok ? null : result.error.kind).toBe("stale_view");
    expect(events(handId)).toHaveLength(before);
    expect(
      (await orchestrator.heroPhysicalAction("nope", 0, physicalHero(view))).ok,
    ).toBe(false);
  });

  it("Out-of-Turn: CPU の手番の操作は保留して警告し、間が Call だけなら Hero の手番で拘束する。CPU は保留を公開の事実として見る", async () => {
    const cpus = gatedCpus();
    const { orchestrator, events } = setup({ createOpponent: cpus.factory });
    // 6 人卓の Preflop は UTG（cpu3）から。最初の判断で止まっている間に、Hero（Button）が Call を宣言する。
    const starting = orchestrator.startHand(null);
    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    expect(seen.actorId).toBe("cpu3");
    const acting = orchestrator.heroPhysicalAction("hand-1", lastSeq(seen), [
      { type: "declare", declaration: { kind: "call" } },
    ]);
    cpus.release();
    const result = await acting;
    if (!result.ok) throw new Error(result.error.message);
    await starting;

    const log = events("hand-1");
    const warned = log.findIndex(
      (e) => e.type === "DEALER_RULING" && e.outcome === "out_of_turn",
    );
    expect(outline(log.slice(warned - 1, warned + 6))).toEqual([
      "PLAYER_DECLARED hero",
      "DEALER_RULING hero operations out_of_turn",
      "ACTION_TAKEN cpu3 call",
      "ACTION_TAKEN cpu4 call",
      "ACTION_TAKEN cpu5 call",
      "DEALER_RULING hero pending_out_of_turn action call",
      "ACTION_TAKEN hero call",
    ]);
    expect(log[warned + 4]).toMatchObject({ notes: ["out_of_turn_binding"] });

    // 保留の前に求めた判断は捨て、保留を含む KnowledgeState でもう一度求める（Log が進んだため）。
    const [beforeWarning, afterWarning] = cpus.inputs;
    expect(beforeWarning?.knowledge).not.toHaveProperty("rulingHistory");
    expect(afterWarning?.knowledge.viewerId).toBe("cpu3");
    expect(afterWarning?.knowledge.rulingHistory).toEqual([
      {
        playerId: HERO,
        street: "preflop",
        basis: "operations",
        operations: [{ type: "declare", declaration: { kind: "call" } }],
        outcome: "out_of_turn",
        action: null,
        notes: ["out_of_turn"],
      },
    ]);
    // CPU の入力に入るのは公開の事実だけ（他者の札・Deck・system の記録・Persona は入らない）。
    for (const input of cpus.inputs) {
      expect(Object.keys(input).sort()).toEqual(["knowledge", "legal"]);
      expect(forbiddenKeys(input)).toEqual([]);
    }
    expect(personaTerms(log)).toEqual([]);
    expect(forbiddenKeys(result.value)).toEqual([]);

    // 続きは普通に最後まで進む。
    const final = await playOut(orchestrator, "hand-1", result.value);
    expect(final.status).toBe("complete");
    expect(finishedStacks(events("hand-1"))).toBe(TOTAL_CHIPS);
  });

  it("Out-of-Turn: 間の CPU が Raise したら撤回し、Hero の手番で選び直させる（2 回目の操作は保留中なら not_actor）", async () => {
    // UTG（cpu3）だけが最小 Raise し、他は Call か Check。
    const cpus = gatedCpus((input) => {
      const raise = input.legal.actions.find((a) => a.type === "raise");
      return input.knowledge.viewerId === "cpu3" && raise?.type === "raise"
        ? { action: "raise", amount: raise.min }
        : passiveOutput(input.legal);
    });
    const { orchestrator, events } = setup({ createOpponent: cpus.factory });
    const starting = orchestrator.startHand(null);
    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    const acting = orchestrator.heroPhysicalAction("hand-1", lastSeq(seen), [
      { type: "chip_push", chips: [1, 1] },
    ]);
    // 保留中の 2 回目の操作は受け付けない（Log が進んでいるので、見ていた seq を取り直して送る）。
    const pendingView = orchestrator.heroView("hand-1");
    if (pendingView === null) throw new Error("Hand が無い");
    const again = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(pendingView),
      [{ type: "declare", declaration: { kind: "fold" } }],
    );
    expect(again.ok ? null : again.error.kind).toBe("not_actor");
    cpus.release();
    const result = await acting;
    if (!result.ok) throw new Error(result.error.message);
    await starting;

    const view = result.value;
    expect(view.actorId).toBe(HERO);
    expect(outline(view.log.slice(-1))).toEqual([
      "DEALER_RULING hero pending_out_of_turn no_action",
    ]);
    expect(view.log.at(-1)).toMatchObject({ notes: ["out_of_turn_released"] });
    // 撤回したので、Hero は Raise に対する全部の選択肢から選べる。
    expect(view.legalActions?.actions.map((a) => a.type)).toContain("call");
    const final = await playOut(orchestrator, "hand-1", view);
    expect(final.status).toBe("complete");
    expect(finishedStacks(events("hand-1"))).toBe(TOTAL_CHIPS);
  });
});

describe("Fast Forward（#67・D12・D15・D93）", () => {
  const THINK_MS = 100;

  /** 思考待ちがある Orchestrator で最初の Hand を始め、Hero の手番まで進めて Fold する（その後も Hand は続く）。 */
  async function startAndFoldHero(overrides: Partial<HandOrchestratorOptions>) {
    vi.useFakeTimers();
    const ctx = setup({ botDelayMs: THINK_MS, ...overrides });
    const started = await ctx.orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    const pushed: HeroView[] = [];
    ctx.orchestrator.subscribe(handId, (v) => pushed.push(v));
    // Hero の手番が来るまで CPU を進める（1 手ずつ時間を進めて、手番になったところで止める）。
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(50);
      const view = ctx.orchestrator.heroView(handId) as HeroView;
      if (view.actorId === HERO) break;
      await vi.advanceTimersByTimeAsync(overrides.botDelayMs ?? 10_000);
    }
    const view = ctx.orchestrator.heroView(handId) as HeroView;
    const folded = await ctx.orchestrator.heroAction(handId, lastSeq(view), {
      type: "fold",
    });
    if (!folded.ok) throw new Error(folded.error.message);
    expect(folded.value.status).toBe("in_progress");
    return { ...ctx, handId, pushed };
  }

  it("Hero がまだ Hand にいる間・Hand が終わった後は入れられず（not_spectating）、切るのはいつでも受け付ける", async () => {
    vi.useFakeTimers();
    const { orchestrator } = setup({ botDelayMs: THINK_MS });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    expect(orchestrator.setFastForward(handId, true)).toMatchObject({
      ok: false,
      error: { kind: "not_spectating" },
    });
    expect(orchestrator.fastForwardOf(handId)).toBe(false);
    expect(orchestrator.setFastForward(handId, false)).toEqual({
      ok: true,
      value: { fastForward: false },
    });
    expect(orchestrator.setFastForward("nope", true)).toMatchObject({
      ok: false,
      error: { kind: "hand_not_found" },
    });
    expect(orchestrator.fastForwardOf("nope")).toBeNull();
  });

  it("Hero の Fold 後に入れると、残りの CPU の思考待ちを待たずに Hand が終わり、Hand の終了で通常の速さに戻る", async () => {
    const { orchestrator, handId, pushed, events } = await startAndFoldHero({});
    // 入れる前は、CPU の手番は思考待ち（100ms）ごとにしか進まない。
    const before = events(handId).length;
    await vi.advanceTimersByTimeAsync(THINK_MS - 1);
    expect(events(handId).length).toBe(before);

    const on = orchestrator.setFastForward(handId, true);
    expect(on).toEqual({ ok: true, value: { fastForward: true } });
    expect(orchestrator.fastForwardOf(handId)).toBe(true);
    // 待っている最中の思考待ちも終わり、時間を進めなくても Hand の終わりまで進む（microtask だけ流す）。
    await vi.advanceTimersByTimeAsync(0);
    const view = orchestrator.heroView(handId) as HeroView;
    expect(view.status).toBe("complete");
    expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
    // 終わった Hand の Fast Forward は切れている。もう入れられない。
    expect(orchestrator.fastForwardOf(handId)).toBe(false);
    expect(orchestrator.setFastForward(handId, true)).toMatchObject({
      ok: false,
      error: { kind: "not_spectating" },
    });

    // 観戦中の View（Push されたもの）も、Hand が終わるまで他者の札を含まない（Showdown で公開される前は伏せたまま）。
    const log = events(handId);
    const inProgress = pushed.filter((v) => v.status !== "complete");
    expect(inProgress.length).toBeGreaterThan(0);
    for (const v of pushed) {
      expect(leakedCards(v, log, HERO, lastSeq(v))).toEqual([]);
    }
    for (const v of inProgress) {
      for (const seat of v.seats.filter((s) => s.playerId !== HERO)) {
        expect(seat.holeCards).toBeNull();
      }
    }

    // 次の Hand は通常の速さ（思考待ちが効く）。
    const second = await orchestrator.startHand(handId);
    if (!second.ok) throw new Error(second.error.message);
    const next = second.value.handId;
    expect(orchestrator.fastForwardOf(next)).toBe(false);
    expect(second.value.view.actorId).not.toBe(HERO);
    const start = events(next).length;
    await vi.advanceTimersByTimeAsync(THINK_MS - 1);
    expect(events(next).length).toBe(start);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(next).length).toBeGreaterThan(start);
  });

  it("CPU の判断の待ち（Claude の応答）は縮めない: 思考待ちだけが 0 になり、判断が返るまでは Fast Forward 中でも進まない", async () => {
    const DECIDE_MS = 5000;
    // 判断（decide）に 5 秒かかる CPU。Claude の応答時間の代わり。
    const slowCpus: OpponentFactory = (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              bot.decide(input, signal).then(resolve, reject);
            }, DECIDE_MS);
          }),
      };
    };
    const { orchestrator, handId, events } = await startAndFoldHero({
      createOpponent: slowCpus,
      opponentTimeoutMs: 30_000,
    });
    expect(orchestrator.setFastForward(handId, true).ok).toBe(true);
    // 思考待ち（100ms）は飛ばしたので、判断の 5 秒ちょうどで 1 手進む。1 手より早くは進まない。
    const before = events(handId).length;
    await vi.advanceTimersByTimeAsync(DECIDE_MS - 1);
    expect(events(handId).length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(handId).length).toBeGreaterThan(before);
    // 次の CPU も、判断の 5 秒がかかる（思考待ちは無いが、判断の待ちはそのまま）。
    const after = events(handId).length;
    const view = orchestrator.heroView(handId) as HeroView;
    if (view.status !== "complete") {
      await vi.advanceTimersByTimeAsync(DECIDE_MS - 1);
      expect(events(handId).length).toBe(after);
    }
  });

  it("Fast Forward 中でも判断の待ちの上限（OPPONENT_TIMEOUT_MS）は変わらず、超えたら障害として止まる（D86）", async () => {
    const hangingCpus: OpponentFactory = () => ({
      decide: () => new Promise<OpponentOutput>(() => {}),
    });
    // Hero が Fold するまでは判断が返る CPU、Fold 後は返らない CPU にする。
    let hung = false;
    const factory: OpponentFactory = (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      const hanging = hangingCpus(seed, playerId, persona);
      return {
        decide: (input, signal) =>
          hung ? hanging.decide(input, signal) : bot.decide(input, signal),
      };
    };
    const { orchestrator, handId } = await startAndFoldHero({
      createOpponent: factory,
      opponentTimeoutMs: 2000,
    });
    hung = true;
    expect(orchestrator.setFastForward(handId, true).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(orchestrator.outageStatus(handId)?.current).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(orchestrator.outageStatus(handId)?.current).toMatchObject({
      kind: "timeout",
    });
  });
});

describe("Session の Event と Resume（#77・D95）", () => {
  /** 同じ Store で Orchestrator を作り直す（再起動の代わり。保存の境界は sqlite-event-store.test.ts で見る）。 */
  function restart(
    store: SessionRecordingStore,
    overrides: Partial<HandOrchestratorOptions> = {},
  ) {
    let handNo = 100;
    return new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: createRuleBot,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 7,
      nextHandId: () => `resumed-${++handNo}`,
      nextSessionId: () => `resumed-session-${handNo}`,
      ...overrides,
    });
  }

  /** 1 Hand を始めて最後まで進め、Hand ID を返す。 */
  async function playHand(
    orchestrator: HandOrchestrator,
    afterHandId: string | null,
  ): Promise<string> {
    const started = await orchestrator.startHand(afterHandId);
    if (!started.ok) throw new Error(started.error.message);
    await playOut(orchestrator, started.value.handId, started.value.view);
    return started.value.handId;
  }

  it("SESSION_STARTED は Session の最初の Hand にだけ、開始の Event に続けて置く（system）", async () => {
    const { orchestrator, events, store } = setup();
    const first = await playHand(orchestrator, null);
    const second = await playHand(orchestrator, first);
    const startedAt = events(first).findIndex(
      (e) => e.type === "SESSION_STARTED",
    );
    expect(events(first)[startedAt]).toEqual({
      type: "SESSION_STARTED",
      sessionId: store.sessionOf.get(first),
      seq: startedAt,
      visibility: { type: "system" },
    });
    // 開始の Event（startHand の結果）の直後で、最初の Action より前。
    expect(events(first)[startedAt - 1]?.type).toBe("HOLE_CARD_DEALT");
    expect(
      events(first)
        .slice(0, startedAt)
        .some((e) => e.type === "ACTION_TAKEN"),
    ).toBe(false);
    expect(events(second).some((e) => e.type === "SESSION_STARTED")).toBe(
      false,
    );
    expect(store.sessionOf.get(second)).toBe(store.sessionOf.get(first));
    expect(store.latestSessionProjection()).toMatchObject({
      sessionId: store.sessionOf.get(first),
      lastHandId: second,
      state: "ready_for_next_hand",
      personas: PHASE1_TABLE_SETUP.personas,
      emergencyBots: [],
    });
  });

  it("再起動後、Hand の合間で止まった Session を同じ Session として続ける（Stack・Button を持ち越し、SESSION_STARTED は置かない）", async () => {
    const { orchestrator, events, store } = setup();
    const first = await playHand(orchestrator, null);
    orchestrator.close();

    const resumed = restart(store);
    // クライアントは再起動前の Hand を覚えていない（null）か、最後に見た Hand を送る。どちらでも次の Hand を作る。
    const next = await resumed.startHand(null);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.created).toBe(true);
    const handId = next.value.handId;
    expect(store.sessionOf.get(handId)).toBe(store.sessionOf.get(first));
    expect(events(handId).some((e) => e.type === "SESSION_STARTED")).toBe(
      false,
    );
    const opening = startedOf(events(handId));
    expect(opening.seats).toEqual(
      finishedOf(events(first)).stacks.map((s) => ({
        playerId: s.playerId,
        stack: s.amount,
      })),
    );
    expect(opening.buttonPlayerId).not.toBe(
      startedOf(events(first)).buttonPlayerId,
    );
    await playOut(resumed, handId, next.value.view);
    expect(finishedStacks(events(handId))).toBe(TOTAL_CHIPS);
  });

  it("再起動後も Emergency Bot の CPU は RuleBot のまま（Session Projection から戻す）", async () => {
    const broken = { playerId: null as string | null };
    const asked: string[] = [];
    // 最初に判断を求められた CPU だけが、再起動の前に 1 回障害を起こす。
    const flaky: OpponentFactory = (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) => {
          asked.push(playerId);
          if (broken.playerId === null) {
            broken.playerId = playerId;
            return Promise.reject(new Error("down"));
          }
          return bot.decide(input, signal);
        },
      };
    };
    const { orchestrator, events, store } = setup({ createOpponent: flaky });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const resolved = await orchestrator.resolveOutage(
      started.value.handId,
      1,
      "emergency_bot",
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    await playOut(orchestrator, started.value.handId, resolved.value);
    orchestrator.close();
    const cpu = broken.playerId;
    if (cpu === null) throw new Error("障害が起きていない");

    asked.length = 0;
    const resumed = restart(store, { createOpponent: flaky });
    const handId = await playHand(resumed, null);
    expect(store.sessionOf.get(handId)).toBe(
      store.sessionOf.get(started.value.handId),
    );
    // 再起動後も、その CPU には判断を求めず、手番ごとに emergency_bot の記録を残す。
    expect(asked).not.toContain(cpu);
    const cpuActions = events(handId).filter(
      (e) => e.type === "ACTION_TAKEN" && e.playerId === cpu,
    );
    expect(cpuActions.length).toBeGreaterThan(0);
    expect(
      fallbacksIn(events(handId)).filter((f) => f.playerId === cpu),
    ).toHaveLength(cpuActions.length);
  });

  it("再起動後も Session の Persona の割り当てを使う（設定の割り当てを変えて起動しても、続ける Session では変えない）", async () => {
    const seen = new Map<string, string | undefined>();
    const recordPersona: OpponentFactory = (seed, playerId, persona) => {
      seen.set(playerId, persona?.id);
      return createRuleBot(seed, playerId, persona);
    };
    const { orchestrator, store } = setup({ createOpponent: recordPersona });
    const first = await playHand(orchestrator, null);
    orchestrator.close();
    const before = new Map(seen);

    // 割り当て順を変えた設定で起動する。続ける Session では前の割り当てのまま。
    const changed = buildTableSetup(6, ["maniac"]);
    seen.clear();
    const resumed = restart(store, {
      setup: changed,
      createOpponent: recordPersona,
    });
    const second = await playHand(resumed, null);
    expect(store.sessionOf.get(second)).toBe(store.sessionOf.get(first));
    for (const [playerId, presetId] of seen) {
      expect(presetId).toBe(before.get(playerId));
    }
    expect([...seen.values()]).not.toContain("maniac");
  });

  it("新しい Session の最初の Hand で CPU の席の参加者を seed から決め、同じ Session の Hand・再起動後の Resume では変えない（D118）", async () => {
    const { orchestrator, events, store } = setup();
    expect(orchestrator.sessionParticipants).toEqual([]);
    const first = await playHand(orchestrator, null);
    const sessionId = store.sessionOf.get(first) ?? "";
    // 既定の割り当て順の席の Persona で、Hand の seed（42）から導いた seed で編成する。
    const expected = composeSessionParticipants({
      sessionId,
      seats: PHASE1_TABLE_SETUP.players
        .filter((p) => p.kind === "cpu")
        .map((p) => ({
          playerId: p.playerId,
          persona: PHASE1_TABLE_SETUP.personas[p.playerId],
        })),
      seed: deriveSeed(42, MAX_PLAYERS),
    }).participants;
    expect(store.sessionParticipants(sessionId)).toEqual(expected);
    expect(orchestrator.sessionParticipants).toEqual(expected);

    const second = await playHand(orchestrator, first);
    expect(store.sessionOf.get(second)).toBe(sessionId);
    expect(orchestrator.sessionParticipants).toEqual(expected);
    orchestrator.close();

    const resumed = restart(store);
    expect(resumed.sessionParticipants).toEqual(expected);
    const third = await playHand(resumed, null);
    expect(store.sessionOf.get(third)).toBe(sessionId);
    expect(store.sessionParticipants(sessionId)).toEqual(expected);

    // Identity は Event Log・Hero の View には入れない（Event Log の形は変えない。cpuProfileId から Secret Persona を辿らせない）。
    const ids = expected.map((p) =>
      p.kind === "fixed" ? p.cpuProfileId : p.guestId,
    );
    const exposed = JSON.stringify([
      ...[first, second, third].flatMap((h) => events(h)),
      resumed.players,
    ]);
    for (const id of ids) expect(exposed).not.toContain(id);
  });

  it("CPU_PERSONAS で偏らせても（6-max で全席 maniac）、Fixed CPU は Pool の Persona で打ち、同じ cpuProfileId の Persona は Session を跨いで変わらず、効かなかった席を warn に残す（D118）", async () => {
    const personaOfProfile = new Map(
      PHASE7_CPU_POOL.fixed.map((p) => [p.cpuProfileId, p.persona]),
    );
    const seenByProfile = new Map<string, string | undefined>();
    let warned = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const used = new Map<string, string | undefined>();
      const warn = vi.fn();
      const { orchestrator, store } = setup({
        setup: buildTableSetup(6, ["maniac"]),
        nextSeed: () => seed,
        logger: { warn, error: () => {} },
        createOpponent: (cpuSeed, playerId, persona) => {
          used.set(playerId, persona?.id);
          return createRuleBot(cpuSeed, playerId, persona);
        },
      });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      const participants = orchestrator.sessionParticipants;
      expect(
        participants.filter((p) => p.kind === "guest").length,
      ).toBeLessThanOrEqual(1);
      for (const p of participants) {
        if (p.kind !== "fixed") {
          expect(used.get(p.playerId)).toBe("maniac");
          continue;
        }
        // 実際に打つ Persona は Pool の Persona（Session・seed が変わっても同じ cpuProfileId は同じ Persona）。
        expect(used.get(p.playerId)).toBe(personaOfProfile.get(p.cpuProfileId));
        if (seenByProfile.has(p.cpuProfileId)) {
          expect(used.get(p.playerId)).toBe(seenByProfile.get(p.cpuProfileId));
        }
        seenByProfile.set(p.cpuProfileId, used.get(p.playerId));
      }
      const unmatched = participants.filter(
        (p) => used.get(p.playerId) !== "maniac",
      );
      // maniac の Fixed CPU は 1 人なので、CPU 5 席のうち少なくとも 3 席は上書きが効かず、warn に席と求めた Persona が残る。
      expect(unmatched.length).toBeGreaterThanOrEqual(3);
      expect(warn).toHaveBeenCalledWith(
        {
          sessionId: store.sessionOf.get(started.value.handId),
          seats: unmatched.map((p) => ({
            playerId: p.playerId,
            requested: "maniac",
          })),
        },
        expect.stringContaining("CPU_PERSONAS"),
      );
      warned++;
      orchestrator.close();
    }
    expect(warned).toBe(20);
    // 20 Session で、少なくとも maniac 以外の Fixed CPU が複数回座っている（Session を跨いだ比較が空振りしていない）。
    expect(seenByProfile.size).toBeGreaterThan(3);
  });

  it("Session が終わって新しい Session になると参加者を決め直し、Fixed CPU は同じ cpuProfileId、Guest の id は持ち越さない（D106・D118）", async () => {
    const { orchestrator, store, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "hero") === 0,
    );
    const before = store.sessionParticipants(store.sessionOf.get(handId) ?? "");
    expect(before.map((p) => p.playerId)).toEqual(["cpu1", "cpu2"]);
    const next = await orchestrator.startHand(handId);
    if (!next.ok) throw new Error(next.error.message);
    const after = orchestrator.sessionParticipants;
    // 同じ seed なので同じ席に同じ種類が座り、Fixed CPU は同じ cpuProfileId。
    const fixedOf = (ps: readonly SessionParticipant[]) =>
      ps.map((p) => (p.kind === "fixed" ? p.cpuProfileId : null));
    expect(fixedOf(after)).toEqual(fixedOf(before));
    // Guest の id は前の Session のものを使わない。
    const guestIds = (ps: readonly SessionParticipant[]) =>
      ps.flatMap((p) => (p.kind === "guest" ? [p.guestId] : []));
    // この seed の編成には Guest が 1 席いる（Guest の持ち越しを空振りせずに確かめる）。
    expect(guestIds(before)).toHaveLength(1);
    for (const id of guestIds(after)) {
      expect(guestIds(before)).not.toContain(id);
    }
    expect(guestIds(after)).toHaveLength(guestIds(before).length);
  });

  it("終わった Session（Bust・AI 障害での Session 終了）は再起動後に続けず、新しい Session で始める", async () => {
    const { store, handId } = await firstHandWhere(
      { cpu1: "shove", cpu2: "fold" },
      (stacks) => stackOf(stacks, "hero") === 0,
    );
    const resumed = restart(store, {
      setup: buildTableSetup(3),
      createOpponent: scriptedCpus({ cpu1: "fold", cpu2: "fold" }),
    });
    const next = await resumed.startHand(null);
    if (!next.ok) throw new Error(next.error.message);
    expect(store.sessionOf.get(next.value.handId)).not.toBe(
      store.sessionOf.get(handId),
    );
    const events = store.read(next.value.handId).map((s) => s.event);
    expect(events.some((e) => e.type === "SESSION_STARTED")).toBe(true);
    expect(
      startedOf(events).seats.every(
        (s) => s.stack === buildTableSetup(3).startingStack,
      ),
    ).toBe(true);
  });

  it("卓の設定（人数）を変えて起動したら、前の Session は続けられないので新しい Session で始め、warn を残す", async () => {
    const { orchestrator, store } = setup();
    const first = await playHand(orchestrator, null);
    orchestrator.close();
    const warn = vi.fn();
    const resumed = restart(store, {
      setup: buildTableSetup(3),
      logger: { warn, error: () => {} },
    });
    const next = await resumed.startHand(null);
    if (!next.ok) throw new Error(next.error.message);
    expect(store.sessionOf.get(next.value.handId)).not.toBe(
      store.sessionOf.get(first),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ lastHandId: first }),
      expect.stringContaining("新しい Session"),
    );
  });
});
