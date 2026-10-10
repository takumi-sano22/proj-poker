// UX-02 #217 の技術検証: Home 向けの副作用の無い Session 状態の照会（D136）を、今の Orchestrator / Event Store が支えられるか。
// 製品の挙動は変えない（検証のテストだけ。新しい API は人間の承認まで作らない）。調べること:
// - 照会に必要な値（今の Session の有無・Hand の途中か次 Hand 待ちか終わったか・cash / Tournament の種類・再起動後の Resume）が、
//   読むだけの経路（Orchestrator の Session の指し先・Event Log・Session Projection）から揃うか
// - 読むだけの経路を何度呼んでも、Hand の開始・CPU の進行（Opponent の判断＝Claude の呼び出しの唯一の入口）・Event の追記が起きないか
// - Cold Start・再起動（Hand の合間 / Hand の途中）・卓の設定の変更・Session の終了・Tournament・Drill の除外で、照会の答えがどうなるか
// Session の指し先（this.session）は今は private なので、検証では型を外して読む（公開する形は API の契約と一緒に人間が決める）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE1_TABLE_SETUP, buildTableSetup } from "./config.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import {
  HandOrchestrator,
  type HandOrchestratorOptions,
  type SessionRequest,
} from "./hand-orchestrator.js";
import {
  OpponentOutageError,
  type OpponentFactory,
} from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import {
  LEARNING_HANDS,
  loadLearningFixtures,
} from "./testing/learning-fixtures.js";

const HERO = "hero";
const TOURNAMENT: SessionRequest = {
  mode: "tournament",
  presetId: "stt6_hand_count",
};

/**
 * Home の照会が返す候補の値（契約の案。docs/taskLog/issue-217-session-readonly-verification.md）。
 * Session ID・Stack・Persona・札は載せない（Home の表示に要らない）。
 */
type HomeSessionProbe =
  | { readonly state: "none" }
  | {
      readonly state: "in_hand" | "ready_for_next_hand" | "ended";
      readonly kind: SessionRequest;
      /** このプロセスで進めた Hand（卓に戻る先）。再起動後の Resume ではこのプロセスに Hand が無いので null。 */
      readonly handId: string | null;
    };

interface SessionPointerView {
  readonly lastHandId: string;
}

/**
 * 読むだけの経路だけで照会の値を作る（PoC）。Orchestrator の Session の指し先と、公開の読み取り（sessionStatus・sessionKindOf）だけを使う。
 * startHand・heroAction・proceed は呼ばない。
 */
function probe(orchestrator: HandOrchestrator): HomeSessionProbe {
  const pointer = (
    orchestrator as unknown as { session: SessionPointerView | null }
  ).session;
  if (pointer === null) return { state: "none" };
  const kind = orchestrator.sessionKindOf(pointer.lastHandId);
  // このプロセスで進めた Hand なら、その Hand の Event から状態を作る。
  const status = orchestrator.sessionStatus(pointer.lastHandId);
  if (status !== null) {
    return { state: status.state, kind, handId: pointer.lastHandId };
  }
  // 再起動後の Resume: 指し先があるのは Projection が ready_for_next_hand で、今の卓の設定で続けられるときだけ（resumeSession）。
  return { state: "ready_for_next_hand", kind, handId: null };
}

/** Event Store の中身の指紋（Hand ごとの Event の件数と論理順序の最後の番号）。追記が起きたら変わる。 */
function fingerprint(store: EventStore): string {
  const hands = store
    .listHands(10_000)
    .map((h) => `${h.handId}:${store.read(h.handId).length}`);
  return JSON.stringify({ hands, last: store.lastOrdinal() });
}

/** Opponent の生成と判断の回数を数える（Claude の CPU も Opponent の decide からしか呼ばれない）。 */
function countingOpponents(inner: OpponentFactory = createRuleBot) {
  const counts = { created: 0, decided: 0 };
  const factory: OpponentFactory = (seed, playerId, persona) => {
    counts.created++;
    const agent = inner(seed, playerId, persona);
    return {
      decide: (input, signal) => {
        counts.decided++;
        return agent.decide(input, signal);
      },
    };
  };
  return { counts, factory };
}

/** 照会と、今ある読み取り専用の経路を何度も呼ぶ（Home の再描画・複数タブ・リロードの代わり）。 */
function readRepeatedly(orchestrator: HandOrchestrator, times = 5) {
  for (let i = 0; i < times; i++) {
    const p = probe(orchestrator);
    if (p.state !== "none" && p.handId !== null) {
      orchestrator.heroView(p.handId);
      orchestrator.sessionStatus(p.handId);
      orchestrator.outageStatus(p.handId);
      orchestrator.fastForwardOf(p.handId);
      orchestrator.tournamentTableOf(p.handId);
    }
  }
}

/** Call できれば Call、できなければ Check。 */
function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

async function playHand(
  orchestrator: HandOrchestrator,
  afterHandId: string | null,
  request?: SessionRequest,
): Promise<string> {
  const started = await orchestrator.startHand(afterHandId, request);
  if (!started.ok) throw new Error(started.error.message);
  let view = started.value.view;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    const result = await orchestrator.heroAction(
      started.value.handId,
      view.log.at(-1)?.seq ?? -1,
      passive(view),
    );
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  return started.value.handId;
}

describe("Home 向けの読み取り専用の Session 照会の技術検証（UX-02 #217・SQLite）", () => {
  let dir: string;
  const opened: SqliteEventStore[] = [];
  const orchestrators: HandOrchestrator[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proj-poker-home-session-"));
  });

  afterEach(() => {
    orchestrators.splice(0).forEach((o) => o.close());
    opened.splice(0).forEach((store) => store.close());
    rmSync(dir, { recursive: true, force: true });
  });

  /** 同じ DB を開き直す（プロセスの再起動の代わり。メモリにだけある進行中の Hand は消える。D62）。 */
  function open(): SqliteEventStore {
    const store = SqliteEventStore.open(join(dir, "poker.sqlite"), {});
    opened.push(store);
    return store;
  }

  function boot(
    store: EventStore,
    prefix: string,
    overrides: Partial<HandOrchestratorOptions> = {},
  ) {
    let handNo = 0;
    let sessionNo = 0;
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: createRuleBot,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42 + handNo,
      nextHandId: () => `${prefix}-hand-${++handNo}`,
      nextSessionId: () => `${prefix}-session-${++sessionNo}`,
      ...overrides,
    });
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  it("Cold Start（DB が空）: 起動と照会で Hand を始めず、Opponent も作らず、Session なしを返す", () => {
    const store = open();
    const { counts, factory } = countingOpponents();
    const before = fingerprint(store);
    const orchestrator = boot(store, "a", { createOpponent: factory });
    readRepeatedly(orchestrator);
    expect(probe(orchestrator)).toEqual({ state: "none" });
    expect(fingerprint(store)).toBe(before);
    expect(counts).toEqual({ created: 0, decided: 0 });
  });

  it("このプロセスの Hand の途中（Hero の手番）: 照会は in_hand と卓に戻る先の Hand を返し、何度読んでも Log・CPU は進まない", async () => {
    const store = open();
    const { counts, factory } = countingOpponents();
    const orchestrator = boot(store, "a", { createOpponent: factory });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId, view } = started.value;
    expect(view.status).not.toBe("complete");
    expect(view.actorId).toBe(HERO);

    const before = { print: fingerprint(store), counts: { ...counts } };
    const events = store.read(handId).length;
    readRepeatedly(orchestrator, 20);
    expect(probe(orchestrator)).toEqual({
      state: "in_hand",
      kind: { mode: "cash" },
      handId,
    });
    expect(store.read(handId).length).toBe(events);
    expect(fingerprint(store)).toBe(before.print);
    expect(counts).toEqual(before.counts);
  });

  it("CPU の思考の途中: 照会は in_hand を返し、判断の要求を増やさない（CPU の進行を起こさない・二重に進めない）", async () => {
    const store = open();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 判断を gate が開くまで止める（Claude の応答待ちの代わり）。
    const { counts, factory } = countingOpponents((seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: async (input, signal) => {
          await gate;
          return bot.decide(input, signal);
        },
      };
    });
    const orchestrator = boot(store, "a", { createOpponent: factory });
    const starting = orchestrator.startHand(null);
    // 最初の手番が Hero なら Fold して CPU の手番へ進める（どちらでも CPU の判断の待ちを作る）。
    const first = await Promise.race([
      starting,
      vi.waitFor(() => {
        if (counts.decided === 0) throw new Error("CPU の判断待ちが無い");
      }),
    ]);
    let acting: Promise<unknown> = starting;
    if (first !== undefined && first.ok) {
      acting = orchestrator.heroAction(
        first.value.handId,
        first.value.view.log.at(-1)?.seq ?? -1,
        { type: "fold" },
      );
      await vi.waitFor(() => {
        if (counts.decided === 0) throw new Error("CPU の判断待ちが無い");
      });
    }
    const decided = counts.decided;
    const print = fingerprint(store);
    readRepeatedly(orchestrator, 20);
    const p = probe(orchestrator);
    expect(p.state).toBe("in_hand");
    expect(counts.decided).toBe(decided);
    expect(fingerprint(store)).toBe(print);
    release();
    await acting;
  });

  it("再起動（Hand の合間）: 照会は ready_for_next_hand（このプロセスの Hand は無い）を返し、起動と照会で追記・Opponent の生成をしない", async () => {
    const first = open();
    const handId = await playHand(boot(first, "a"), null);
    orchestrators.splice(0).forEach((o) => o.close());
    first.close();

    const store = open();
    const { counts, factory } = countingOpponents();
    const before = fingerprint(store);
    const resumed = boot(store, "b", { createOpponent: factory });
    readRepeatedly(resumed, 20);
    expect(probe(resumed)).toEqual({
      state: "ready_for_next_hand",
      kind: { mode: "cash" },
      handId: null,
    });
    expect(store.latestSessionProjection()?.lastHandId).toBe(handId);
    expect(fingerprint(store)).toBe(before);
    expect(counts).toEqual({ created: 0, decided: 0 });
  });

  it("再起動（Hand の途中）: 途中の Hand は消え、照会は最後に終わった Hand から ready_for_next_hand を返す（Hand 途中の復帰は無い。D62）", async () => {
    const first = open();
    const orchestrator = boot(first, "a");
    const finished = await playHand(orchestrator, null);
    const started = await orchestrator.startHand(finished);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.value.view.status).not.toBe("complete");
    const midHand = started.value.handId;
    expect(probe(orchestrator)).toMatchObject({
      state: "in_hand",
      handId: midHand,
    });
    orchestrators.splice(0).forEach((o) => o.close());
    first.close();

    const store = open();
    expect(store.read(midHand)).toEqual([]);
    const resumed = boot(store, "b");
    expect(probe(resumed)).toEqual({
      state: "ready_for_next_hand",
      kind: { mode: "cash" },
      handId: null,
    });
    expect(store.latestSessionProjection()?.lastHandId).toBe(finished);
  });

  it("再起動（卓の設定を変えた）: Projection は ready_for_next_hand のままでも続けられないので、照会は none（Store だけからは作れない）", async () => {
    const first = open();
    await playHand(boot(first, "a"), null);
    orchestrators.splice(0).forEach((o) => o.close());
    first.close();

    const store = open();
    const resumed = boot(store, "b", {
      setup: buildTableSetup(3),
      logger: { warn: () => {}, error: () => {} },
    });
    expect(store.latestSessionProjection()?.state).toBe("ready_for_next_hand");
    expect(probe(resumed)).toEqual({ state: "none" });
  });

  it("Session の終了（AI 障害の後に終了を選ぶ）: このプロセスでは ended を返し、再起動後は none（終わった Session は Resume しない）", async () => {
    const first = open();
    const failing: OpponentFactory = () => ({
      decide: () => Promise.reject(new OpponentOutageError("検証の障害")),
    });
    const orchestrator = boot(first, "a", { createOpponent: failing });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    if (orchestrator.outageStatus(handId)?.current === null) {
      // 最初の手番が Hero なら Fold して CPU の手番（障害）へ進める。
      const view = started.value.view;
      await orchestrator.heroAction(handId, view.log.at(-1)?.seq ?? -1, {
        type: "fold",
      });
    }
    const outage = orchestrator.outageStatus(handId);
    expect(outage?.current).not.toBeNull();
    expect(probe(orchestrator)).toMatchObject({ state: "in_hand", handId });
    const resolved = await orchestrator.resolveOutage(
      handId,
      outage?.revision ?? -1,
      "end_session",
    );
    expect(resolved.ok).toBe(true);
    expect(probe(orchestrator)).toEqual({
      state: "ended",
      kind: { mode: "cash" },
      handId,
    });
    orchestrators.splice(0).forEach((o) => o.close());
    first.close();

    const store = open();
    expect(store.latestSessionProjection()?.state).toBe("ended");
    expect(probe(boot(store, "b"))).toEqual({ state: "none" });
  });

  it("Tournament: 再起動後も Session の種類（Preset）を照会で返せる（SESSION_STARTED の Snapshot から読む。D129）", async () => {
    const first = open();
    await playHand(boot(first, "a"), null, TOURNAMENT);
    orchestrators.splice(0).forEach((o) => o.close());
    first.close();

    const store = open();
    const before = fingerprint(store);
    const resumed = boot(store, "b");
    expect(probe(resumed)).toEqual({
      state: "ready_for_next_hand",
      kind: TOURNAMENT,
      handId: null,
    });
    expect(fingerprint(store)).toBe(before);
  });

  it("Drill の除外: 通常の Hand の後に Drill の Session の Hand が保存されても、Resume と照会は通常の Session を指す（D116）", async () => {
    const fixtures = await loadLearningFixtures();
    const first = open();
    const normal = await playHand(boot(first, "a"), null);
    orchestrators.splice(0).forEach((o) => o.close());
    // Drill の専用の Session の Hand（終わった Hand）を通常の Hand より後に保存する。
    const drill = fixtures.play(LEARNING_HANDS.btn);
    first.append(drill.handId, drill.events, { sessionId: "drill-session" });
    first.close();

    const store = open();
    // 除外を渡さなければ、最後に保存した Drill の Session が「最後の Session」になる（除外は呼び出し側の責務）。
    expect(store.latestSessionProjection()?.lastHandId).toBe(drill.handId);
    const resumed = boot(store, "b", {
      excludeFromResume: () => new Set([drill.handId]),
    });
    expect(probe(resumed)).toEqual({
      state: "ready_for_next_hand",
      kind: { mode: "cash" },
      handId: null,
    });
    expect(
      store.latestSessionProjection(new Set([drill.handId]))?.lastHandId,
    ).toBe(normal);
  });
});

describe("照会と開始の判定のずれ（UX-02 #217・メモリ内の Store）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("内部エラーで止まった Hand: Event だけから作る照会は in_hand のままだが、開始は新しい Session を作る（照会は開始と同じ判定から作る必要がある）", async () => {
    vi.useFakeTimers();
    let failing = false;
    const store = new (class extends InMemoryEventStore {
      override append(...args: Parameters<InMemoryEventStore["append"]>) {
        if (failing) throw new Error("書き込みに失敗した");
        return super.append(...args);
      }
    })();
    let handNo = 0;
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: createRuleBot,
      botDelayMs: 100,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => `hand-${++handNo}`,
      nextSessionId: () => `session-${handNo}`,
      logger: { warn: () => {}, error: () => {} },
    });
    const first = await orchestrator.startHand(null);
    if (!first.ok) throw new Error(first.error.message);
    // 最初の Hand の Preflop は CPU（UTG）から。CPU の手番の書き込みを失敗させて進行を止める。
    expect(first.value.view.actorId).not.toBe(HERO);
    failing = true;
    await vi.advanceTimersByTimeAsync(100);
    failing = false;

    // 照会（PoC）は Event から in_hand と言うが、「続きから」を押すと止まった Hand へは戻らない。
    expect(probe(orchestrator)).toMatchObject({
      state: "in_hand",
      handId: first.value.handId,
    });
    const next = await orchestrator.startHand(null);
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.created).toBe(true);
    expect(next.value.handId).not.toBe(first.value.handId);
    orchestrator.close();
  });
});
