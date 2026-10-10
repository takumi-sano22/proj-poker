// UX-11（#226）の先行技術検証。ETIQUETTE の確認（Ack）待ちで CPU の進行を止める仕組みを設計するために、今の
// Hand Orchestrator の振る舞いを Fake CPU で固定する（製品のコードは変えない。Ack の API / 停止はまだ無い）。
// 確かめる事実:
// 1. ETIQUETTE が要る裁定（DEALER_RULING）を追記した直後に、server は Ack を待たず次の CPU に判断を求める（止める仕組みが無い）。
//    止める位置は「裁定の追記の後、次の CPU の思考待ち・判断の前」= runCpuTurns のループの先頭で足りる。
// 2. 拘束した Out-of-Turn（Hero の要求の外で runCpuTurns が置く裁定）にも ETIQUETTE が付きうる（Ack の単位は裁定の seq）。
// 3. CPU の判断待ちの間に Hero の Out-of-Turn が入ると、待っていた判断（障害の Timeout を含む）は isCurrent で捨てられる。
//    ループの先頭で止めれば、遅れて届いた判断が Ack の前に適用されることは無い（捨てた推論の費用は残る）。
// 4. CPU の障害（Outage）で止まっている間も Hero の物理的な操作は受け付けられ、障害と Ack 待ちは同時に起こりうる
//    （優先順位の定義が要る）。今は Retry すると Ack を待たずに CPU が進む。
// 5. Hand を終える裁定は同じ追記に HAND_FINISHED を含み、止める CPU の進行が残らない。終わった Hand への追記は Store が拒否する
//    （Ack を Event にする案では、この裁定の Ack を Hand の Event として残せない）。
// 判定に使う述語（ETIQUETTE_ACK_CODES）は apps/web の etiquette-ack-verification.test.ts で今の表示と一致を網羅している。
// 設計の比較と推奨は docs/taskLog/issue-226-etiquette-ack-design.md（人間の承認前の案であり、採用済みではない）。
import {
  projectHeroView,
  type HandEvent,
  type HeroView,
  type LegalActionSet,
  type PhysicalAction,
  type RulingCode,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
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

const HERO = "hero";

/** 候補の述語: Ack が要る RulingCode（今の dealer-feedback.ts の ETIQUETTE の表のキー）。 */
const ETIQUETTE_ACK_CODES: ReadonlySet<RulingCode> = new Set<RulingCode>([
  "out_of_turn",
  "string_bet",
  "oversized_chip",
  "declaration_ignored",
  "half_raise_completed",
  "under_half_raise",
  "check_facing_bet",
]);

/** log の中で Ack が要る Hero への裁定の seq（log の順）。 */
function ackRequiredSeqs(log: readonly HandEvent[]): number[] {
  return log
    .filter(
      (e) =>
        e.type === "DEALER_RULING" &&
        e.playerId === HERO &&
        e.notes.some((c) => ETIQUETTE_ACK_CODES.has(c)),
    )
    .map((e) => e.seq);
}

/** 追記の 1 回ごとの Event の列を残す Store（同じ追記に何が入ったかを見る）。 */
class BatchRecordingStore extends InMemoryEventStore {
  readonly batches: HandEvent[][] = [];

  override append(
    handId: string,
    events: readonly HandEvent[],
    context?: AppendContext,
  ) {
    const result = super.append(handId, events, context);
    this.batches.push([...events]);
    return result;
  }
}

/** CPU に判断を求めた時点の記録（その時点の Log の長さと、Ack が要る裁定がすでにあったか）。 */
interface DecideCall {
  readonly playerId: string;
  readonly logLength: number;
  readonly ackRequiredBefore: readonly number[];
}

/** CPU の Call か Check（出力の形）。 */
const passiveOutput = (legal: LegalActionSet): OpponentOutput =>
  legal.actions.some((a) => a.type === "call")
    ? { action: "call" }
    : { action: "check" };

/**
 * Fake CPU。判断を求められるたびに、その時点の Event Log（Store）を読んで DecideCall を残す。
 * hold が true を返す判断は、release されるまで（または signal が abort されるまで）返さない。
 */
function fakeCpus(
  store: InMemoryEventStore,
  options: {
    readonly respond?: (input: OpponentInput) => OpponentOutput;
    readonly hold?: (call: DecideCall, index: number) => boolean;
  } = {},
) {
  const calls: DecideCall[] = [];
  const releases: (() => void)[] = [];
  const factory: OpponentFactory = (_seed, playerId) => ({
    decide: async (input, signal) => {
      const log = store.read("hand-1").map((s) => s.event);
      const call: DecideCall = {
        playerId,
        logLength: log.length,
        ackRequiredBefore: ackRequiredSeqs(log),
      };
      const index = calls.push(call) - 1;
      if (options.hold?.(call, index) === true) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          signal?.addEventListener("abort", () => resolve());
        });
      }
      return (options.respond ?? ((i) => passiveOutput(i.legal)))(input);
    },
  });
  return { factory, calls, releaseAll: () => releases.forEach((r) => r()) };
}

function setup(
  build: (store: BatchRecordingStore) => Partial<HandOrchestratorOptions>,
) {
  const store = new BatchRecordingStore();
  let handNo = 0;
  let sessionNo = 0;
  const orchestrator = new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    botDelayMs: 0,
    opponentTimeoutMs: 1000,
    nextSeed: () => 42,
    nextHandId: () => `hand-${++handNo}`,
    nextSessionId: () => `session-${++sessionNo}`,
    createOpponent: () => {
      throw new Error("createOpponent を build で渡す");
    },
    ...build(store),
  });
  const events = (): HandEvent[] => store.read("hand-1").map((s) => s.event);
  return { store, orchestrator, events };
}

const lastSeq = (view: HeroView): number => view.log.at(-1)?.seq ?? -1;

function rulingAt(log: readonly HandEvent[], seq: number) {
  const e = log.find((x) => x.seq === seq);
  if (e?.type !== "DEALER_RULING") throw new Error(`裁定が無い: ${seq}`);
  return e;
}

describe("UX-11 検証: ETIQUETTE の裁定の後、今の server は Ack を待たず CPU を進める", () => {
  it("手番の Oversized Chip: 裁定と Hero の Call を 1 回で追記した同じ要求の中で、次の CPU に判断を求める", async () => {
    let cpus!: ReturnType<typeof fakeCpus>;
    const { orchestrator, events } = setup((store) => {
      cpus = fakeCpus(store);
      return { createOpponent: cpus.factory };
    });
    // 6 人卓の Preflop は UTG（cpu3）から。CPU は Call / Check なので、Hero（Button）は BB（2）への Call の手番で止まる。
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const view = started.value.view;
    expect(view.actorId).toBe(HERO);
    const call = view.legalActions?.actions.find((a) => a.type === "call");
    expect(call).toMatchObject({ type: "call", amount: 2 });
    const callsBefore = cpus.calls.length;

    // 宣言なしで 5 の Chip を 1 枚出す → Oversized Chip で Call（ETIQUETTE: 先に Raise を宣言する）。
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [{ type: "chip_push", chips: [5] }],
    );
    if (!result.ok) throw new Error(result.error.message);

    const log = events();
    const [rulingSeq] = ackRequiredSeqs(log);
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    expect(rulingAt(log, rulingSeq)).toMatchObject({
      outcome: "action",
      action: { type: "call" },
      notes: ["oversized_chip"],
    });
    // Ack の要る裁定は Hero の View（public）に同じ seq で入る → Ack の対象を Hero の公開情報だけで指せる。
    expect(ackRequiredSeqs(projectHeroView(log, HERO).log)).toEqual(
      ackRequiredSeqs(log),
    );
    // 同じ要求の中で、裁定の後の CPU（SB の cpu1 以降）に判断を求めている（Ack の機会が無い）。
    const after = cpus.calls.slice(callsBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.ackRequiredBefore.includes(rulingSeq))).toBe(
      true,
    );
    expect(
      log.some(
        (e) =>
          e.seq > rulingSeq && e.type === "ACTION_TAKEN" && e.playerId !== HERO,
      ),
    ).toBe(true);
  });

  it("Out-of-Turn: 保留の裁定（ETIQUETTE: 手番を待つ）の後も CPU は進み、拘束の裁定（Oversized Chip）は Hero の要求の外で runCpuTurns が置く", async () => {
    let cpus!: ReturnType<typeof fakeCpus>;
    const { orchestrator, events, store } = setup((s) => {
      // 最初の判断（UTG の cpu3）だけ release まで返さない（Hero が CPU の手番を見ている間を作る）。
      cpus = fakeCpus(s, { hold: (_c, index) => index === 0 });
      return { createOpponent: cpus.factory };
    });
    const starting = orchestrator.startHand(null);
    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    expect(seen.actorId).toBe("cpu3");
    // cpu3 の判断待ちの間に、Hero（Button）が宣言なしで 5 の Chip を 1 枚出す（手番外）。
    const acting = orchestrator.heroPhysicalAction("hand-1", lastSeq(seen), [
      { type: "chip_push", chips: [5] },
    ]);
    cpus.releaseAll();
    const result = await acting;
    if (!result.ok) throw new Error(result.error.message);
    await starting;

    const log = events();
    const [warned, bound] = ackRequiredSeqs(log);
    if (warned === undefined || bound === undefined) {
      throw new Error("Ack が要る裁定が 2 つ無い");
    }
    expect(rulingAt(log, warned)).toMatchObject({
      basis: "operations",
      outcome: "out_of_turn",
      notes: ["out_of_turn"],
    });
    expect(rulingAt(log, bound)).toMatchObject({
      basis: "pending_out_of_turn",
      outcome: "action",
      action: { type: "call" },
      notes: ["out_of_turn_binding", "oversized_chip"],
    });
    // 保留の裁定の前に求めた cpu3 の判断は捨て（isCurrent）、裁定の後に求め直している。
    const cpu3 = cpus.calls.filter((c) => c.playerId === "cpu3");
    expect(cpu3[0]?.ackRequiredBefore).toEqual([]);
    expect(cpu3[1]?.ackRequiredBefore).toEqual([warned]);
    expect(
      log.filter(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.playerId === "cpu3" &&
          e.street === "preflop",
      ),
    ).toHaveLength(1);
    // 保留の裁定と拘束の裁定の間に CPU の Action がある（保留の Ack を待たずに進んでいる）。
    expect(
      log.some(
        (e) =>
          e.seq > warned &&
          e.seq < bound &&
          e.type === "ACTION_TAKEN" &&
          e.playerId !== HERO,
      ),
    ).toBe(true);
    // 拘束の裁定は、Hero の操作の追記とは別の追記（runCpuTurns の resolveHeroOutOfTurn）に入る。
    const boundBatch = store.batches.find((b) =>
      b.some((e) => e.seq === bound),
    );
    expect(
      boundBatch?.some(
        (e) =>
          e.type === "PLAYER_DECLARED" || e.type === "PHYSICAL_CHIP_ACTION",
      ),
    ).toBe(false);
    // 拘束の裁定の後も、Ack を待たずに次の CPU（SB の cpu1）に判断を求めている。
    expect(cpus.calls.some((c) => c.ackRequiredBefore.includes(bound))).toBe(
      true,
    );
  });

  it("CPU の判断が Timeout する前に Hero の Out-of-Turn が入ると、遅れて届いた障害は捨てられ、障害のダイアログにならない", async () => {
    let cpus!: ReturnType<typeof fakeCpus>;
    const { orchestrator, events } = setup((s) => {
      // 最初の判断は返さない（Timeout で障害になる）。2 回目からは Call / Check。
      cpus = fakeCpus(s, { hold: (_c, index) => index === 0 });
      return { createOpponent: cpus.factory, opponentTimeoutMs: 30 };
    });
    const starting = orchestrator.startHand(null);
    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(seen),
      [{ type: "declare", declaration: { kind: "call" } }],
    );
    if (!result.ok) throw new Error(result.error.message);
    await starting;

    // Timeout の障害は isCurrent で捨て、裁定の後の KnowledgeState で求め直した（障害の状態は立たない）。
    expect(orchestrator.outageStatus("hand-1")).toEqual({
      current: null,
      revision: 0,
    });
    const [warned] = ackRequiredSeqs(events());
    if (warned === undefined) throw new Error("保留の裁定が無い");
    // 1 回目（Timeout した判断）は裁定の前、2 回目（求め直し）は裁定の後。
    const cpu3 = cpus.calls.filter((c) => c.playerId === "cpu3");
    expect(cpu3[0]?.ackRequiredBefore).toEqual([]);
    expect(cpu3[1]?.ackRequiredBefore).toEqual([warned]);
  });

  it("CPU の障害で止まっている間も Hero の Out-of-Turn は追記され、Retry すると Ack を待たずに CPU が進む（優先順位の定義が要る）", async () => {
    let cpus!: ReturnType<typeof fakeCpus>;
    const { orchestrator, events } = setup((s) => {
      cpus = fakeCpus(s, { hold: (_c, index) => index === 0 });
      return { createOpponent: cpus.factory, opponentTimeoutMs: 30 };
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    // 最初の CPU（cpu3）の Timeout で障害になり、Hand は止まっている。
    const outage = orchestrator.outageStatus("hand-1");
    expect(outage?.current).toMatchObject({
      playerId: "cpu3",
      kind: "timeout",
    });

    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    const physical: PhysicalAction[] = [
      { type: "declare", declaration: { kind: "call" } },
    ];
    const acted = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(seen),
      physical,
    );
    if (!acted.ok) throw new Error(acted.error.message);
    const [warned] = ackRequiredSeqs(events());
    if (warned === undefined) throw new Error("保留の裁定が無い");
    // 障害は解けておらず（revision は障害の発生の 1 回だけ）、Ack が要る裁定もある → 2 つの待ちが同時に立つ。
    expect(orchestrator.outageStatus("hand-1")).toMatchObject({
      revision: outage?.revision,
      current: { playerId: "cpu3" },
    });
    const callsBeforeRetry = cpus.calls.length;

    const resolved = await orchestrator.resolveOutage(
      "hand-1",
      outage?.revision ?? -1,
      "retry",
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    // Retry の後、保留の裁定の Ack を待たずに CPU が進む。
    expect(
      cpus.calls
        .slice(callsBeforeRetry)
        .some((c) => c.ackRequiredBefore.includes(warned)),
    ).toBe(true);
  });

  it("Hand を終える裁定（宣言 2 回 → declaration_ignored で Fold）は同じ追記に HAND_FINISHED を含み、終わった Hand へは追記できない", async () => {
    let cpus!: ReturnType<typeof fakeCpus>;
    const { orchestrator, events, store } = setup((s) => {
      // CPU は Raise できれば最小 Raise（Hero は必ず Bet に向き合い、Fold が合法）。
      cpus = fakeCpus(s, {
        respond: ({ legal }) => {
          const raise = legal.actions.find((a) => a.type === "raise");
          return raise?.type === "raise"
            ? { action: "raise", amount: raise.min }
            : passiveOutput(legal);
        },
      });
      return { setup: buildTableSetup(2), createOpponent: cpus.factory };
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const view = started.value.view;
    expect(view.actorId).toBe(HERO);
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [
        { type: "declare", declaration: { kind: "fold" } },
        { type: "declare", declaration: { kind: "fold" } },
      ],
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("complete");

    const log = events();
    const [rulingSeq] = ackRequiredSeqs(log);
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    expect(rulingAt(log, rulingSeq)).toMatchObject({
      outcome: "action",
      action: { type: "fold" },
      notes: ["declaration_ignored"],
    });
    // 裁定と HAND_FINISHED は同じ追記（止める CPU の進行が残らない）。
    const last = store.batches.at(-1) ?? [];
    expect(last.some((e) => e.seq === rulingSeq)).toBe(true);
    expect(last.some((e) => e.type === "HAND_FINISHED")).toBe(true);
    // 終わった Hand への追記は Store が拒否する（Ack を Hand の Event にする案は、この裁定の Ack を残せない）。
    // 追記するのは任意の Event でよい（ここでは最後の Event の seq だけを進めた写し）。
    const tail = log.at(-1);
    if (tail === undefined) throw new Error("Event が無い");
    expect(() =>
      store.append("hand-1", [{ ...tail, seq: log.length }], {}),
    ).toThrow();
  });
});
