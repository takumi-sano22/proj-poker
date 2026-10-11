// UX-11（#226・D145）: ETIQUETTE の確認（Ack）まで server が CPU を実際に進めないことの結合テスト（Fake CPU）。
// PR #240 の先行技術検証では、ここで「今の server は Ack を待たず CPU を進める」を固定していた。本実装でその成功条件を
// 「Ack まで CPU が進まない」へ置き換えた（skip・削除で回避しない。D145）。
// 確かめる事実:
// 1. ETIQUETTE の要る裁定（DEALER_RULING）を追記したら、Ack まで次の CPU に判断を求めない（思考待ちの有無に依らない）。Ack の後に 1 回だけ再開する。
// 2. 保留した Out-of-Turn の裁定で止まり、Ack の後に CPU が進み、Hero の要求の外で置く拘束の裁定（+ Oversized Chip）で再び止まる。
// 3. CPU の判断待ちの間に Hero の手番外の操作が入ると、待っていた判断（遅れて届く判断・Timeout の障害）は適用せず、Ack まで止まる。
// 4. 障害（Outage）と同時なら、Retry / Emergency Bot を選んでも Ack まで CPU を進めない。Session 終了でも Ack 待ちは残る。
// 5. Hand を終える裁定（同じ追記に HAND_FINISHED）でも Ack 待ちは残り、確認まで次の Hand の開始を拒否する。Hand を返すだけの再要求は受ける。
// 6. Ack の判定（待っている seq は受ける・確認済みの再送は 200 で何もしない・それ以外は stale_etiquette）。Ack は Event を足さず lastSeq を変えない。
// 7. Fast Forward・Tournament のプレイ時間（T1=A: Hand の進行中の待ちだけを数える）との互換。
import {
  TOURNAMENT_PRESETS,
  etiquetteAckRulingSeqs,
  projectHeroView,
  type HandEvent,
  type HeroView,
  type LegalActionSet,
  type PhysicalAction,
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

const HERO = "hero";
const MINUTE = 60_000;
const TOTAL_CHIPS =
  PHASE1_TABLE_SETUP.startingStack * PHASE1_TABLE_SETUP.players.length;

afterEach(() => {
  vi.useRealTimers();
});

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

/** CPU に判断を求めた時点の記録。 */
interface DecideCall {
  readonly handId: string;
  readonly playerId: string;
  /** その時点で server が確認を待っていた裁定の seq（待っていなければ null）。 */
  readonly pendingAtCall: number | null;
  /** 判断の待ちを server が打ち切った（signal の abort）。 */
  aborted: boolean;
}

/** CPU の Call か Check（出力の形）。 */
const passiveOutput = (legal: LegalActionSet): OpponentOutput =>
  legal.actions.some((a) => a.type === "call")
    ? { action: "call" }
    : { action: "check" };

/** Check できれば Check、できなければ Fold（Hero 以外が Pot を争わずに Hand を早く終える）。 */
const checkOrFold = (legal: LegalActionSet): OpponentOutput =>
  legal.actions.some((a) => a.type === "check")
    ? { action: "check" }
    : { action: "fold" };

/**
 * Fake CPU。判断を求められるたびに、その時点で server が確認を待っていた裁定を記録する。
 * hold が true を返す判断は、release されるまで（または signal が abort されるまで）返さない。
 */
function fakeCpus(
  options: {
    readonly respond?: (input: OpponentInput) => OpponentOutput;
    readonly hold?: (call: DecideCall, index: number) => boolean;
  } = {},
) {
  const calls: DecideCall[] = [];
  const releases: (() => void)[] = [];
  let probe: (handId: string) => number | null = () => null;
  const factory: OpponentFactory = (_seed, playerId) => ({
    decide: async (input, signal) => {
      const handId = input.knowledge.handId;
      const call: DecideCall = {
        handId,
        playerId,
        pendingAtCall: probe(handId),
        aborted: false,
      };
      const index = calls.push(call) - 1;
      if (options.hold?.(call, index) === true) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          signal?.addEventListener("abort", () => {
            call.aborted = true;
            resolve();
          });
        });
      }
      return (options.respond ?? ((i) => passiveOutput(i.legal)))(input);
    },
  });
  return {
    factory,
    calls,
    releaseAll: () => releases.splice(0).forEach((r) => r()),
    bind: (orchestrator: HandOrchestrator) => {
      probe = (handId) =>
        orchestrator.etiquetteStatus(handId)?.pendingRulingSeq ?? null;
    },
  };
}

function setup(
  cpuOptions: Parameters<typeof fakeCpus>[0] = {},
  options: Partial<HandOrchestratorOptions> = {},
) {
  const store = new BatchRecordingStore();
  const cpus = fakeCpus(cpuOptions);
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
    createOpponent: cpus.factory,
    ...options,
  });
  cpus.bind(orchestrator);
  const events = (handId = "hand-1"): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { store, orchestrator, events, cpus };
}

const lastSeq = (view: HeroView): number => view.log.at(-1)?.seq ?? -1;

/** log の中で Ack が要る Hero への裁定の seq（log の順）。 */
const ackSeqs = (log: readonly HandEvent[]): number[] =>
  etiquetteAckRulingSeqs(log, HERO);

function rulingAt(log: readonly HandEvent[], seq: number) {
  const e = log.find((x) => x.seq === seq);
  if (e?.type !== "DEALER_RULING") throw new Error(`裁定が無い: ${seq}`);
  return e;
}

/** seq より後の CPU の ACTION_TAKEN。 */
const cpuActionsAfter = (log: readonly HandEvent[], seq: number) =>
  log.filter(
    (e) => e.seq > seq && e.type === "ACTION_TAKEN" && e.playerId !== HERO,
  );

/** Hand が終わるまで Hero は Call / Check（Ack の要る裁定は出ない）。最後の View を返す。 */
async function playOut(
  orchestrator: HandOrchestrator,
  handId: string,
  start: HeroView,
): Promise<HeroView> {
  let view = start;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    const types = view.legalActions?.actions.map((a) => a.type) ?? [];
    const result = await orchestrator.heroAction(handId, lastSeq(view), {
      type: types.includes("call") ? "call" : "check",
    });
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  return view;
}

const finishedChips = (log: readonly HandEvent[]): number => {
  const finished = log.find((e) => e.type === "HAND_FINISHED");
  if (finished?.type !== "HAND_FINISHED")
    throw new Error("Hand が終わっていない");
  return finished.stacks.reduce((sum, s) => sum + s.amount, 0);
};

/** 6 人卓の最初の Hand を始め、Hero（Button）の手番（BB の 2 への Call）まで CPU を進めた View。 */
async function startToHeroTurn(orchestrator: HandOrchestrator) {
  const started = await orchestrator.startHand(null);
  if (!started.ok) throw new Error(started.error.message);
  expect(started.value.view.actorId).toBe(HERO);
  return started.value.view;
}

describe("UX-11: ETIQUETTE の裁定の後、server は確認（Ack）まで CPU を進めない（D145）", () => {
  it("手番の Oversized Chip: 裁定の後は Ack まで次の CPU に判断を求めず、Ack の後に再開して Hand が最後まで進む（Chip の総量は変わらない）", async () => {
    const { orchestrator, events, cpus } = setup();
    const view = await startToHeroTurn(orchestrator);
    expect(
      view.legalActions?.actions.find((a) => a.type === "call"),
    ).toMatchObject({ amount: 2 });
    const callsBefore = cpus.calls.length;

    // 宣言なしで 5 の Chip を 1 枚出す → Oversized Chip で Call（ETIQUETTE: 先に Raise を宣言する）。
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [{ type: "chip_push", chips: [5] }],
    );
    if (!result.ok) throw new Error(result.error.message);

    const log = events();
    const [rulingSeq] = ackSeqs(log);
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    expect(rulingAt(log, rulingSeq)).toMatchObject({
      outcome: "action",
      action: { type: "call" },
      notes: ["oversized_chip"],
    });
    // Ack の要る裁定は Hero の View（public）に同じ seq で入る → Ack の対象を Hero の公開情報だけで指せる。
    expect(ackSeqs(projectHeroView(log, HERO).log)).toEqual([rulingSeq]);
    expect(orchestrator.etiquetteStatus("hand-1")).toEqual({
      revision: 1,
      pendingRulingSeq: rulingSeq,
    });
    // 同じ要求の中で次の CPU（SB の cpu1）に判断を求めず、CPU の Action も無い。
    expect(cpus.calls.length).toBe(callsBefore);
    expect(cpuActionsAfter(log, rulingSeq)).toEqual([]);
    expect(result.value.actorId).toBe("cpu1");

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", rulingSeq);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(orchestrator.etiquetteStatus("hand-1")).toEqual({
      revision: 2,
      pendingRulingSeq: null,
    });
    expect(cpus.calls.length).toBeGreaterThan(callsBefore);
    expect(cpuActionsAfter(events(), rulingSeq).length).toBeGreaterThan(0);
    // どの判断も、確認を待っている間には求めていない。
    expect(cpus.calls.every((c) => c.pendingAtCall === null)).toBe(true);
    const final = await playOut(orchestrator, "hand-1", acked.value);
    expect(final.status).toBe("complete");
    expect(finishedChips(events())).toBe(TOTAL_CHIPS);
  });

  it("思考待ちがある設定（botDelayMs > 0）でも、Ack まで思考待ち・判断を始めない", async () => {
    vi.useFakeTimers();
    const THINK_MS = 100;
    const { orchestrator, events, cpus } = setup({}, { botDelayMs: THINK_MS });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(50);
      if (orchestrator.heroView("hand-1")?.actorId === HERO) break;
      await vi.advanceTimersByTimeAsync(THINK_MS);
    }
    const view = orchestrator.heroView("hand-1") as HeroView;
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [{ type: "chip_push", chips: [5] }],
    );
    if (!result.ok) throw new Error(result.error.message);
    const [rulingSeq] = ackSeqs(events());
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    const callsBefore = cpus.calls.length;
    // 思考待ちを何回分進めても、CPU は動かない。
    await vi.advanceTimersByTimeAsync(THINK_MS * 20);
    expect(cpus.calls.length).toBe(callsBefore);
    expect(cpuActionsAfter(events(), rulingSeq)).toEqual([]);

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", rulingSeq);
    if (!acked.ok) throw new Error(acked.error.message);
    // Ack の後は思考待ちを経て CPU が 1 手ずつ進む。
    expect(cpus.calls.length).toBe(callsBefore);
    await vi.advanceTimersByTimeAsync(THINK_MS);
    expect(cpus.calls.length).toBe(callsBefore + 1);
    expect(cpus.calls.every((c) => c.pendingAtCall === null)).toBe(true);
    orchestrator.close();
  });

  it("Out-of-Turn: 保留の裁定で止まり、Ack の後に CPU が進み、Hero の要求の外で置く拘束の裁定（+ Oversized Chip）で再び止まる", async () => {
    // 最初の判断（UTG の cpu3）だけ release まで返さない（Hero が CPU の手番を見ている間を作る）。
    const { orchestrator, events, store, cpus } = setup({
      hold: (_c, index) => index === 0,
    });
    const starting = orchestrator.startHand(null);
    const seen = orchestrator.heroView("hand-1");
    if (seen === null) throw new Error("Hand が無い");
    expect(seen.actorId).toBe("cpu3");
    // cpu3 の判断待ちの間に、Hero（Button）が宣言なしで 5 の Chip を 1 枚出す（手番外）。
    const acting = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(seen),
      [{ type: "chip_push", chips: [5] }],
    );
    if (!acting.ok) throw new Error(acting.error.message);
    await starting;
    const [warned] = ackSeqs(events());
    if (warned === undefined) throw new Error("保留の裁定が無い");
    expect(rulingAt(events(), warned)).toMatchObject({
      basis: "operations",
      outcome: "out_of_turn",
      notes: ["out_of_turn"],
    });
    // 待っていた cpu3 の判断は打ち切り（abort）、遅れて返しても適用しない。Ack まで次の判断を求めない。
    expect(cpus.calls).toHaveLength(1);
    expect(cpus.calls[0]?.aborted).toBe(true);
    cpus.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(cpus.calls).toHaveLength(1);
    expect(cpuActionsAfter(events(), warned)).toEqual([]);
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      warned,
    );

    // Ack → cpu3・cpu4・cpu5 が進み、Hero の手番で runCpuTurns が拘束の裁定を置いて、再び止まる。
    const first = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!first.ok) throw new Error(first.error.message);
    const [, bound] = ackSeqs(events());
    if (bound === undefined) throw new Error("拘束の裁定が無い");
    expect(rulingAt(events(), bound)).toMatchObject({
      basis: "pending_out_of_turn",
      outcome: "action",
      action: { type: "call" },
      notes: ["out_of_turn_binding", "oversized_chip"],
    });
    expect(
      cpuActionsAfter(events(), warned).filter((e) => e.seq < bound),
    ).toHaveLength(3);
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
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      bound,
    );
    expect(cpuActionsAfter(events(), bound)).toEqual([]);
    expect(first.value.actorId).toBe("cpu1");

    const second = await orchestrator.acknowledgeEtiquette("hand-1", bound);
    if (!second.ok) throw new Error(second.error.message);
    expect(cpuActionsAfter(events(), bound).length).toBeGreaterThan(0);
    expect(cpus.calls.every((c) => c.pendingAtCall === null)).toBe(true);
    // cpu3 の Preflop の Action は 1 回だけ（捨てた判断を適用していない）。
    expect(
      events().filter(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.playerId === "cpu3" &&
          e.street === "preflop",
      ),
    ).toHaveLength(1);
    const final = await playOut(orchestrator, "hand-1", second.value);
    expect(final.status).toBe("complete");
    expect(finishedChips(events())).toBe(TOTAL_CHIPS);
  });

  it("CPU の判断が Timeout する前に Hero の Out-of-Turn が入ると、障害を立てず Ack まで止まり、Ack の後の判断は 1 回だけ", async () => {
    const { orchestrator, events, cpus } = setup(
      // 最初の判断は返さない（打ち切らなければ Timeout で障害になる）。
      { hold: (_c, index) => index === 0 },
      { opponentTimeoutMs: 30 },
    );
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
    // Timeout の時間を過ぎても障害は立たず、CPU にも求めない。
    await new Promise((r) => setTimeout(r, 60));
    expect(orchestrator.outageStatus("hand-1")).toEqual({
      current: null,
      revision: 0,
    });
    expect(cpus.calls).toHaveLength(1);
    const [warned] = ackSeqs(events());
    if (warned === undefined) throw new Error("保留の裁定が無い");

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!acked.ok) throw new Error(acked.error.message);
    // 打ち切った判断の後、cpu3 の Preflop の判断を求め直すのは Ack の後の 1 回だけ（Action も 1 回だけ）。
    const cpu3 = cpus.calls.filter((c) => c.playerId === "cpu3");
    expect(cpu3[0]?.aborted).toBe(true);
    expect(cpu3.slice(1).every((c) => c.pendingAtCall === null)).toBe(true);
    expect(
      events().filter(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.playerId === "cpu3" &&
          e.street === "preflop",
      ),
    ).toHaveLength(1);
    expect(orchestrator.outageStatus("hand-1")?.current).toBeNull();
  });

  it("同時の 2 つの Ack は両方 200 で、再開は 1 回だけ（同じ手番を 2 回判断させない）", async () => {
    let gateIndex = Number.POSITIVE_INFINITY;
    const { orchestrator, events, cpus } = setup({
      hold: (_c, index) => index === gateIndex,
    });
    const view = await startToHeroTurn(orchestrator);
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [{ type: "chip_push", chips: [5] }],
    );
    if (!result.ok) throw new Error(result.error.message);
    const [rulingSeq] = ackSeqs(events());
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    // Ack の後の最初の判断（SB の cpu1）を止めて、同時の Ack の間に判断がいくつ求められるかを見る。
    gateIndex = cpus.calls.length;
    const both = Promise.all([
      orchestrator.acknowledgeEtiquette("hand-1", rulingSeq),
      orchestrator.acknowledgeEtiquette("hand-1", rulingSeq),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(cpus.calls).toHaveLength(gateIndex + 1);
    expect(orchestrator.etiquetteStatus("hand-1")?.revision).toBe(2);
    cpus.releaseAll();
    const [a, b] = await both;
    expect(a.ok && b.ok).toBe(true);
    expect(
      events().filter(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.playerId === "cpu1" &&
          e.street === "preflop",
      ),
    ).toHaveLength(1);
    expect(orchestrator.etiquetteStatus("hand-1")?.revision).toBe(2);
  });

  it("Ack の判定: 待っている seq は受け、確認済みの再送は今の待ちを変えずに 200、Ack の要らない・未来・存在しない seq は stale_etiquette。Ack は lastSeq を変えない", async () => {
    const { orchestrator, events, cpus } = setup();
    const view = await startToHeroTurn(orchestrator);
    // Bet（BB）に直面して Check を宣言 → 裁定は Action を決めず（no_action）、Hero の手番のまま確認を待つ。
    const checked = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [{ type: "declare", declaration: { kind: "check" } }],
    );
    if (!checked.ok) throw new Error(checked.error.message);
    const [first] = ackSeqs(events());
    if (first === undefined) throw new Error("Ack が要る裁定が無い");
    expect(rulingAt(events(), first)).toMatchObject({
      outcome: "no_action",
      notes: ["check_facing_bet"],
    });
    expect(checked.value.actorId).toBe(HERO);

    // 確認を待つ間の Hero の操作は拒否し、Log を変えない（操作を暗黙の確認にしない）。
    const logged = events().length;
    const action = await orchestrator.heroAction(
      "hand-1",
      lastSeq(checked.value),
      {
        type: "call",
      },
    );
    expect(action.ok ? null : action.error.kind).toBe("etiquette_ack_required");
    const physical = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(checked.value),
      [{ type: "declare", declaration: { kind: "call" } }],
    );
    expect(physical.ok ? null : physical.error.kind).toBe(
      "etiquette_ack_required",
    );
    expect(events()).toHaveLength(logged);
    // User Read は既存の条件（Hero の手番）で受ける（CPU を進めない）。
    const read = orchestrator.heroUserRead("hand-1", lastSeq(checked.value), {
      targetPlayerId: null,
      text: "BB は弱い",
    });
    if (!read.ok) throw new Error(read.error.message);
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      first,
    );

    // Ack の要らない Event の seq（HAND_STARTED）・未来の seq・別 Hand は受けない。
    for (const seq of [0, 9_999]) {
      const stale = await orchestrator.acknowledgeEtiquette("hand-1", seq);
      expect(stale.ok ? null : stale.error.kind).toBe("stale_etiquette");
    }
    const missing = await orchestrator.acknowledgeEtiquette("nope", first);
    expect(missing.ok ? null : missing.error.kind).toBe("hand_not_found");
    expect(orchestrator.etiquetteStatus("hand-1")).toEqual({
      revision: 1,
      pendingRulingSeq: first,
    });

    // 待っている seq の Ack。Hero の手番なので CPU は動かず、Ack は Event を足さないので lastSeq は変わらない。
    const seen = lastSeq(read.value);
    const callsBefore = cpus.calls.length;
    const acked = await orchestrator.acknowledgeEtiquette("hand-1", first);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(lastSeq(acked.value)).toBe(seen);
    expect(cpus.calls).toHaveLength(callsBefore);
    expect(orchestrator.etiquetteStatus("hand-1")).toEqual({
      revision: 2,
      pendingRulingSeq: null,
    });
    // 二重の Ack は何もしない（revision も変えない）。
    const again = await orchestrator.acknowledgeEtiquette("hand-1", first);
    expect(again.ok).toBe(true);
    expect(orchestrator.etiquetteStatus("hand-1")?.revision).toBe(2);

    // もう一度 Bet に直面した Check を宣言 → 新しい待ち。古い（確認済みの）seq の再送は 200 で、今の待ちを解かない。
    const checkedAgain = await orchestrator.heroPhysicalAction("hand-1", seen, [
      { type: "declare", declaration: { kind: "check" } },
    ]);
    if (!checkedAgain.ok) throw new Error(checkedAgain.error.message);
    const [, second] = ackSeqs(events());
    if (second === undefined) throw new Error("2 つ目の裁定が無い");
    const resent = await orchestrator.acknowledgeEtiquette("hand-1", first);
    expect(resent.ok).toBe(true);
    expect(orchestrator.etiquetteStatus("hand-1")).toEqual({
      revision: 3,
      pendingRulingSeq: second,
    });
    // 古い View（Ack の前の lastSeq）からの操作は、今どおり stale_view（Ack の後）。
    const ackedSecond = await orchestrator.acknowledgeEtiquette(
      "hand-1",
      second,
    );
    if (!ackedSecond.ok) throw new Error(ackedSecond.error.message);
    const stale = await orchestrator.heroAction("hand-1", seen, {
      type: "call",
    });
    expect(stale.ok ? null : stale.error.kind).toBe("stale_view");
    const final = await playOut(orchestrator, "hand-1", ackedSecond.value);
    expect(final.status).toBe("complete");
    expect(finishedChips(events())).toBe(TOTAL_CHIPS);
  });
});

describe("UX-11: 障害（Outage）と同時の Ack 待ち（D145）", () => {
  /** 最初の CPU（cpu3）の Timeout で障害にし、障害の間に Hero の Out-of-Turn を入れて、障害と Ack 待ちを同時に立てる。 */
  async function outageWithPendingAck() {
    const ctx = setup(
      { hold: (_c, index) => index === 0 },
      { opponentTimeoutMs: 30 },
    );
    const started = await ctx.orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const outage = ctx.orchestrator.outageStatus("hand-1");
    expect(outage?.current).toMatchObject({
      playerId: "cpu3",
      kind: "timeout",
    });
    const seen = ctx.orchestrator.heroView("hand-1") as HeroView;
    const physical: PhysicalAction[] = [
      { type: "declare", declaration: { kind: "call" } },
    ];
    const acted = await ctx.orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(seen),
      physical,
    );
    if (!acted.ok) throw new Error(acted.error.message);
    const [warned] = ackSeqs(ctx.events());
    if (warned === undefined) throw new Error("保留の裁定が無い");
    // 障害は解けておらず、Ack の要る裁定もある → 2 つの待ちが同時に立つ。
    expect(ctx.orchestrator.outageStatus("hand-1")).toMatchObject({
      revision: outage?.revision,
      current: { playerId: "cpu3" },
    });
    expect(ctx.orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      warned,
    );
    return { ...ctx, warned, revision: outage?.revision ?? -1 };
  }

  it("Retry を選んでも Ack まで CPU を進めず、Ack の後に進む", async () => {
    const { orchestrator, events, cpus, warned, revision } =
      await outageWithPendingAck();
    const callsBefore = cpus.calls.length;
    const resolved = await orchestrator.resolveOutage(
      "hand-1",
      revision,
      "retry",
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(orchestrator.outageStatus("hand-1")?.current).toBeNull();
    expect(cpus.calls).toHaveLength(callsBefore);
    expect(cpuActionsAfter(events(), warned)).toEqual([]);

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(cpuActionsAfter(events(), warned).length).toBeGreaterThan(0);
    expect(
      cpus.calls.slice(callsBefore).every((c) => c.pendingAtCall === null),
    ).toBe(true);
  });

  it("Emergency Bot を選んでも Ack まで CPU を進めず（選択の記録だけ残る）、Ack の後は RuleBot で進む", async () => {
    const { orchestrator, events, warned, revision } =
      await outageWithPendingAck();
    const resolved = await orchestrator.resolveOutage(
      "hand-1",
      revision,
      "emergency_bot",
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(events().some((e) => e.type === "EMERGENCY_BOT_ENGAGED")).toBe(true);
    expect(cpuActionsAfter(events(), warned)).toEqual([]);

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(
      events().some(
        (e) =>
          e.type === "AI_FALLBACK_USED" &&
          e.playerId === "cpu3" &&
          e.fallbackKind === "emergency_bot",
      ),
    ).toBe(true);
    expect(cpuActionsAfter(events(), warned).length).toBeGreaterThan(0);
  });

  it("障害の間に先に Ack しても CPU は進まず（障害の選択が先）、Retry の後に進む", async () => {
    const { orchestrator, events, cpus, warned, revision } =
      await outageWithPendingAck();
    const callsBefore = cpus.calls.length;
    const acked = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBeNull();
    expect(cpus.calls).toHaveLength(callsBefore);
    expect(cpuActionsAfter(events(), warned)).toEqual([]);
    expect(orchestrator.outageStatus("hand-1")?.current).not.toBeNull();

    const resolved = await orchestrator.resolveOutage(
      "hand-1",
      revision,
      "retry",
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(cpuActionsAfter(events(), warned).length).toBeGreaterThan(0);
  });

  it("Session 終了（HAND_ABORTED）でも Ack 待ちは残り、確認まで次の Hand を始めない。確認の後は新しい Session で始まる", async () => {
    const { orchestrator, store, events, warned, revision } =
      await outageWithPendingAck();
    const ended = await orchestrator.resolveOutage(
      "hand-1",
      revision,
      "end_session",
    );
    if (!ended.ok) throw new Error(ended.error.message);
    expect(events().some((e) => e.type === "HAND_ABORTED")).toBe(true);
    expect(orchestrator.sessionStatus("hand-1")).toEqual({
      state: "ended",
      reason: "ai_outage",
    });
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      warned,
    );
    for (const after of ["hand-1", null]) {
      const next = await orchestrator.startHand(after);
      expect(next.ok ? null : next.error.kind).toBe("etiquette_ack_required");
    }
    expect(store.read("hand-2")).toEqual([]);

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", warned);
    if (!acked.ok) throw new Error(acked.error.message);
    const next = await orchestrator.startHand("hand-1");
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value).toMatchObject({ handId: "hand-2", created: true });
    expect(orchestrator.etiquetteStatus("hand-2")).toEqual({
      revision: 0,
      pendingRulingSeq: null,
    });
  });
});

describe("UX-11: Hand を終える裁定と次の Hand の開始（D145）", () => {
  it("宣言 2 回 → declaration_ignored で Fold した Hand は同じ追記で終わるが、Ack 待ちは残り、確認まで次の Hand を始めない（Hand を返すだけの再要求は受ける）", async () => {
    const { orchestrator, events, store } = setup(
      {
        // CPU は Raise できれば最小 Raise（Hero は必ず Bet に向き合い、Fold が合法）。
        respond: ({ legal }) => {
          const raise = legal.actions.find((a) => a.type === "raise");
          return raise?.type === "raise"
            ? { action: "raise", amount: raise.min }
            : passiveOutput(legal);
        },
      },
      { setup: buildTableSetup(2) },
    );
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
    const [rulingSeq] = ackSeqs(log);
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    expect(rulingAt(log, rulingSeq)).toMatchObject({
      outcome: "action",
      action: { type: "fold" },
      notes: ["declaration_ignored"],
    });
    // 裁定と HAND_FINISHED は同じ追記（止める CPU の進行は残らないが、確認の待ちは残る）。
    const last = store.batches.at(-1) ?? [];
    expect(last.some((e) => e.seq === rulingSeq)).toBe(true);
    expect(last.some((e) => e.type === "HAND_FINISHED")).toBe(true);
    expect(orchestrator.etiquetteStatus("hand-1")?.pendingRulingSeq).toBe(
      rulingSeq,
    );

    // 結果を見た上での次の Hand の開始は拒否し、Hand を作らない。
    const rejected = await orchestrator.startHand("hand-1");
    expect(rejected.ok ? null : rejected.error.kind).toBe(
      "etiquette_ack_required",
    );
    expect(store.read("hand-2")).toEqual([]);
    // まだ結果を見ていない（afterHandId が違う）再要求は、その Hand を返す（Ack の状態から確認を出し直せる）。
    const unseen = await orchestrator.startHand(null);
    if (!unseen.ok) throw new Error(unseen.error.message);
    expect(unseen.value).toMatchObject({ handId: "hand-1", created: false });
    // 終わった Hand への操作も確認待ちとして拒否する。
    const action = await orchestrator.heroAction(
      "hand-1",
      lastSeq(result.value),
      {
        type: "check",
      },
    );
    expect(action.ok ? null : action.error.kind).toBe("etiquette_ack_required");

    const acked = await orchestrator.acknowledgeEtiquette("hand-1", rulingSeq);
    if (!acked.ok) throw new Error(acked.error.message);
    expect(lastSeq(acked.value)).toBe(lastSeq(result.value));
    expect(events()).toHaveLength(log.length);
    const next = await orchestrator.startHand("hand-1");
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value).toMatchObject({ handId: "hand-2", created: true });
    // 別 Hand への誤送信（前の Hand の裁定の seq を新しい Hand へ）は、その Hand の状態で判定して受けない。
    const crossed = await orchestrator.acknowledgeEtiquette(
      "hand-2",
      rulingSeq,
    );
    expect(crossed.ok ? null : crossed.error.kind).toBe("stale_etiquette");
    // 前の Hand への再送は確認済みとして 200（新しい Hand の状態は変えない）。
    expect(
      (await orchestrator.acknowledgeEtiquette("hand-1", rulingSeq)).ok,
    ).toBe(true);
    expect(orchestrator.etiquetteStatus("hand-2")).toEqual({
      revision: 0,
      pendingRulingSeq: null,
    });
  });

  it("Fast Forward（Hero の Fold 後）を入れても、Ack まで CPU を進めない", async () => {
    vi.useFakeTimers();
    const THINK_MS = 100;
    const { orchestrator, events, cpus } = setup({}, { botDelayMs: THINK_MS });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(50);
      if (orchestrator.heroView("hand-1")?.actorId === HERO) break;
      await vi.advanceTimersByTimeAsync(THINK_MS);
    }
    const view = orchestrator.heroView("hand-1") as HeroView;
    // 宣言 2 回 → Fold（declaration_ignored）。Hero は Hand から外れ、SB・BB が残る。
    const result = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(view),
      [
        { type: "declare", declaration: { kind: "fold" } },
        { type: "declare", declaration: { kind: "fold" } },
      ],
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("in_progress");
    const [rulingSeq] = ackSeqs(events());
    if (rulingSeq === undefined) throw new Error("Ack が要る裁定が無い");
    expect(orchestrator.setFastForward("hand-1", true)).toMatchObject({
      ok: true,
    });
    const callsBefore = cpus.calls.length;
    await vi.advanceTimersByTimeAsync(THINK_MS * 20);
    expect(cpus.calls).toHaveLength(callsBefore);
    expect(cpuActionsAfter(events(), rulingSeq)).toEqual([]);

    // Ack の後は思考待ちを飛ばして最後まで進む。
    const acked = await orchestrator.acknowledgeEtiquette("hand-1", rulingSeq);
    if (!acked.ok) throw new Error(acked.error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.heroView("hand-1")?.status).toBe("complete");
    expect(finishedChips(events())).toBe(TOTAL_CHIPS);
    orchestrator.close();
  });
});

describe("UX-11: Tournament のプレイ時間（D128・D145 の T1=A）", () => {
  it("time_base: Hand の進行中の Ack 待ちはプレイ時間に入り、HAND_FINISHED の後から Ack までの待ちは入らない", async () => {
    const TIME = TOURNAMENT_PRESETS.stt6_time_base;
    let now = 1_000;
    const { orchestrator, events } = setup(
      {
        // cpu5 は Raise できれば最小 Raise、他は Check か Fold（Hero が Bet に向き合い、Hand が早く終わる）。
        respond: ({ knowledge, legal }) => {
          const raise = legal.actions.find((a) => a.type === "raise");
          return knowledge.viewerId === "cpu5" && raise?.type === "raise"
            ? { action: "raise", amount: raise.min }
            : checkOrFold(legal);
        },
      },
      { playClock: () => now },
    );
    // Hand 1（Hero が Button）: Bet に直面した Check の宣言で確認を待つ間に 4 分経つ（Hand の進行中）。
    const started = await orchestrator.startHand(null, {
      mode: "tournament",
      presetId: TIME.presetId,
    });
    if (!started.ok) throw new Error(started.error.message);
    const checked = await orchestrator.heroPhysicalAction(
      "hand-1",
      lastSeq(started.value.view),
      [{ type: "declare", declaration: { kind: "check" } }],
    );
    if (!checked.ok) throw new Error(checked.error.message);
    const [inHand] = ackSeqs(events("hand-1"));
    if (inHand === undefined) throw new Error("Ack が要る裁定が無い");
    now += 4 * MINUTE;
    const acked = await orchestrator.acknowledgeEtiquette("hand-1", inHand);
    if (!acked.ok) throw new Error(acked.error.message);
    const folded = await orchestrator.heroAction(
      "hand-1",
      lastSeq(acked.value),
      {
        type: "fold",
      },
    );
    if (!folded.ok) throw new Error(folded.error.message);
    expect(orchestrator.heroView("hand-1")?.status).toBe("complete");

    // Hand 2〜4: Hero は Fold（時計は進めない）。Hand 5 で Hero が BB になる。
    let previous = "hand-1";
    for (let k = 2; k <= 4; k++) {
      const next = await orchestrator.startHand(previous);
      if (!next.ok) throw new Error(next.error.message);
      let view = next.value.view;
      while (view.status !== "complete") {
        const r = await orchestrator.heroAction(
          next.value.handId,
          lastSeq(view),
          {
            type: "fold",
          },
        );
        if (!r.ok) throw new Error(r.error.message);
        view = r.value;
      }
      previous = next.value.handId;
    }
    // Hand 5: cpu5（SB）の Raise に Hero（BB）が宣言 2 回で Fold → 同じ追記で Hand が終わり、確認を待つ。
    const fifth = await orchestrator.startHand(previous);
    if (!fifth.ok) throw new Error(fifth.error.message);
    expect(fifth.value.view.actorId).toBe(HERO);
    const ending = await orchestrator.heroPhysicalAction(
      "hand-5",
      lastSeq(fifth.value.view),
      [
        { type: "declare", declaration: { kind: "fold" } },
        { type: "declare", declaration: { kind: "fold" } },
      ],
    );
    if (!ending.ok) throw new Error(ending.error.message);
    expect(ending.value.status).toBe("complete");
    const [afterFinish] = ackSeqs(events("hand-5"));
    if (afterFinish === undefined) throw new Error("Ack が要る裁定が無い");
    const remainingBefore = orchestrator.tournamentTableOf("hand-5")?.nextLevel;
    // HAND_FINISHED の後、確認までの 30 分（Hand の間）は数えない。
    now += 30 * MINUTE;
    expect(orchestrator.tournamentTableOf("hand-5")?.nextLevel).toEqual(
      remainingBefore,
    );
    const blocked = await orchestrator.startHand("hand-5");
    expect(blocked.ok ? null : blocked.error.kind).toBe(
      "etiquette_ack_required",
    );
    const ackedAfter = await orchestrator.acknowledgeEtiquette(
      "hand-5",
      afterFinish,
    );
    if (!ackedAfter.ok) throw new Error(ackedAfter.error.message);
    const sixth = await orchestrator.startHand("hand-5");
    if (!sixth.ok) throw new Error(sixth.error.message);
    const startedSixth = events("hand-6")[0];
    if (startedSixth?.type !== "HAND_STARTED") throw new Error("開始が無い");
    // 累計は Hand 1 の進行中の 4 分だけ（Hand 5 の終わりの後の 30 分は入らない）。
    expect(startedSixth.tournament).toMatchObject({
      handNumber: 6,
      playTimeMs: 4 * MINUTE,
    });
  });
});
