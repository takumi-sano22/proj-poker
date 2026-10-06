// Hero の物理的な操作の Event 化（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING。D90）の Unit Test。
// 裁定そのもの（どの操作がどの Canonical Action になるか）は ruling.test.ts が見る。ここでは、
// Event の並び・Visibility・State（Chip・手番は変えない／保留の出入り）・Event の畳み込みでの復元・Projection を確かめる。
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  resolvePendingOutOfTurn,
  startHand,
  type HandProgress,
  type PhysicalProgress,
} from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import { projectHeroView, projectKnowledgeState } from "./projection.js";
import type { PhysicalAction } from "./ruling.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";
import { checkInvariants, initialChipTotal } from "./testing/invariants.js";
import { hiddenMarkers, leakedCards } from "./testing/view-leaks.js";

// ruling.test.ts と同じ Blind 5/10。
const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

const push = (...chips: number[]): PhysicalAction => ({
  type: "chip_push",
  chips,
});

/** Hand を始めて Canonical Action を順に適用した、Event Log と State。 */
function play(
  seats: readonly SeatInit[],
  button: string,
  actions: readonly (readonly [string, PlayerAction])[],
): { events: HandEvent[]; state: HandState } {
  const started = startHand({
    handId: "live",
    seats,
    buttonPlayerId: button,
    config: CONFIG,
    deal: { seed: 1 },
  });
  if (!started.ok) throw new Error(started.error.message);
  const log = { events: [...started.value.events], state: started.value.state };
  for (const [player, action] of actions) {
    append(log, applyAction(log.state, player, action));
  }
  return log;
}

/** Command の結果を Log へ足す（失敗なら投げる）。 */
function append(
  log: { events: HandEvent[]; state: HandState },
  result:
    | { ok: true; value: HandProgress | PhysicalProgress }
    | { ok: false; error: { message: string } },
): readonly HandEvent[] {
  if (!result.ok) throw new Error(result.error.message);
  log.events.push(...result.value.events);
  log.state = result.value.state;
  return result.value.events;
}

/** Event の種類・Player・裁定の要点だけを並べる（並びを比べる）。 */
function outline(events: readonly HandEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case "DEALER_RULING":
        return `${e.type} ${e.playerId} ${e.basis} ${e.outcome}${e.action === null ? "" : ` ${e.action.type}`}`;
      case "ACTION_TAKEN":
        return `${e.type} ${e.playerId} ${e.action} ${e.toAmount}`;
      case "PLAYER_DECLARED":
      case "PHYSICAL_CHIP_ACTION":
        return `${e.type} ${e.playerId}`;
      default:
        return e.type;
    }
  });
}

// Heads-Up: cpu が Button（SB 5）、hero が BB（10）。Postflop は hero から。
const HU = [
  { playerId: "cpu", stack: 1000 },
  { playerId: "hero", stack: 1000 },
];
/** Flop で hero Check → cpu が 100 を Bet（hero の Call 額 100）。 */
const facingBet100 = () =>
  play(HU, "cpu", [
    ["cpu", { type: "call" }],
    ["hero", { type: "check" }],
    ["hero", { type: "check" }],
    ["cpu", { type: "bet", amount: 100 }],
  ]);

// 3 人: btn が Button、sb、hero が BB。Flop は sb → hero → btn。
const THREE = [
  { playerId: "btn", stack: 1000 },
  { playerId: "sb", stack: 1000 },
  { playerId: "hero", stack: 1000 },
];
const flop3 = () =>
  play(THREE, "btn", [
    ["btn", { type: "call" }],
    ["sb", { type: "call" }],
    ["hero", { type: "check" }],
  ]);

describe("手番の Hero の操作（applyPhysicalActions）", () => {
  it("操作 → 裁定 → 決まった Action の順に置き、Chip は Canonical Action と同じだけ動く（Oversized Chip → Call）", () => {
    const log = facingBet100();
    const total = initialChipTotal(HU);
    const canonical = applyAction(log.state, "hero", { type: "call" });
    if (!canonical.ok) throw new Error(canonical.error.message);

    const added = append(
      log,
      applyPhysicalActions(log.state, "hero", [push(500)], CONFIG),
    );
    expect(outline(added).slice(0, 3)).toEqual([
      "PHYSICAL_CHIP_ACTION hero",
      "DEALER_RULING hero operations action call",
      "ACTION_TAKEN hero call 100",
    ]);
    expect(added[0]).toMatchObject({
      type: "PHYSICAL_CHIP_ACTION",
      street: "flop",
      motion: "chip_push",
      chips: [500],
    });
    expect(added[1]).toMatchObject({
      type: "DEALER_RULING",
      street: "flop",
      action: { type: "call" },
      notes: ["oversized_chip"],
    });
    // 操作と裁定は卓の全員が見聞きする事実（D90）。
    for (const e of added.slice(0, 2)) {
      expect(e.visibility).toEqual({ type: "public" });
    }
    // 操作と裁定は Chip・手番を変えないので、Canonical Action を直接適用した State と seq 以外は同じ。
    expect({ ...log.state, nextSeq: 0 }).toEqual({
      ...canonical.value.state,
      nextSeq: 0,
    });
    expect(checkInvariants(log.state, total)).toEqual([]);
    // Event Log だけから同じ State を作り直せる（D37）。
    expect(foldHandEvents(log.events)).toEqual(log.state);
  });

  it("宣言と Chip はした順に PLAYER_DECLARED / PHYSICAL_CHIP_ACTION で残す", () => {
    const log = facingBet100();
    const added = append(
      log,
      applyPhysicalActions(
        log.state,
        "hero",
        [
          { type: "declare", declaration: { kind: "raise" } },
          push(100),
          { type: "chip_add", chips: [100] },
        ],
        CONFIG,
      ),
    );
    expect(outline(added).slice(0, 4)).toEqual([
      "PLAYER_DECLARED hero",
      "PHYSICAL_CHIP_ACTION hero",
      "PHYSICAL_CHIP_ACTION hero",
      "DEALER_RULING hero operations action raise",
    ]);
    expect(added[0]).toMatchObject({ declaration: { kind: "raise" } });
    expect(added[2]).toMatchObject({ motion: "chip_add", chips: [100] });
    expect(log.state.operations).toEqual([]);
  });

  it("相手の Bet があるときの Check の宣言は、裁定（no_action）だけを残し、Hero の手番のまま", () => {
    const log = facingBet100();
    const before = log.state;
    const added = append(
      log,
      applyPhysicalActions(
        log.state,
        "hero",
        [{ type: "declare", declaration: { kind: "check" } }],
        CONFIG,
      ),
    );
    expect(outline(added)).toEqual([
      "PLAYER_DECLARED hero",
      "DEALER_RULING hero operations no_action",
    ]);
    expect(added[1]).toMatchObject({
      action: null,
      notes: ["check_facing_bet"],
    });
    expect(getLegalActions(log.state)).toEqual(getLegalActions(before));
    expect(log.state.operations).toEqual([]);
    expect(log.state.pendingOutOfTurn).toBeNull();
    // Hero は選び直せる。
    append(log, applyAction(log.state, "hero", { type: "call" }));
    expect(foldHandEvents(log.events)).toEqual(log.state);
  });

  it("入力の誤り（額面に無い Chip）は Event を作らずに拒否する", () => {
    const { state } = facingBet100();
    const r = applyPhysicalActions(state, "hero", [push(7)], CONFIG);
    expect(r.ok ? null : r.error.kind).toBe("invalid_input");
  });

  it("入力の配列を Event に共有させない（後で書き換えても Event が変わらない）", () => {
    const { state } = facingBet100();
    const chips = [100];
    const r = applyPhysicalActions(
      state,
      "hero",
      [{ type: "chip_push", chips }],
      CONFIG,
    );
    if (!r.ok) throw new Error(r.error.message);
    chips.push(500);
    expect(r.value.events[0]).toMatchObject({ chips: [100] });
  });
});

describe("Out-of-Turn の保留と拘束・撤回（Event の並びで復元できる。D91）", () => {
  it("手番でない操作は保留し、間が Check だけなら Hero の手番で拘束する", () => {
    const log = flop3();
    const total = initialChipTotal(THREE);
    const oot = append(
      log,
      applyPhysicalActions(log.state, "hero", [push(100)], CONFIG),
    );
    expect(outline(oot)).toEqual([
      "PHYSICAL_CHIP_ACTION hero",
      "DEALER_RULING hero operations out_of_turn",
    ]);
    expect(oot[1]).toMatchObject({ action: null, notes: ["out_of_turn"] });
    expect(log.state.pendingOutOfTurn).toEqual({
      playerId: "hero",
      street: "flop",
      currentBet: 0,
      actions: [push(100)],
    });
    // 手番は sb のまま（Chip も動かない）。
    expect(getLegalActions(log.state)?.playerId).toBe("sb");

    // 保留中の 2 回目の操作と、Canonical Action での上書きは受け付けない。
    const again = applyPhysicalActions(log.state, "hero", [push(25)], CONFIG);
    expect(again.ok ? null : again.error.kind).toBe("not_actor");
    // 手番が来る前の裁定も受け付けない。
    const early = resolvePendingOutOfTurn(log.state, CONFIG);
    expect(early.ok ? null : early.error.kind).toBe("not_actor");

    append(log, applyAction(log.state, "sb", { type: "check" }));
    const skipped = applyAction(log.state, "hero", { type: "check" });
    expect(skipped.ok ? null : skipped.error.kind).toBe("not_actor");

    const resolved = append(log, resolvePendingOutOfTurn(log.state, CONFIG));
    expect(outline(resolved).slice(0, 2)).toEqual([
      "DEALER_RULING hero pending_out_of_turn action bet",
      "ACTION_TAKEN hero bet 100",
    ]);
    expect(resolved[0]).toMatchObject({
      visibility: { type: "public" },
      action: { type: "bet", amount: 100 },
      notes: ["out_of_turn_binding"],
    });
    expect(log.state.pendingOutOfTurn).toBeNull();
    expect(checkInvariants(log.state, total)).toEqual([]);

    // 保留 → 間の Action → 拘束 の並びが、Event Log の畳み込みだけで復元できる（Replay の前提）。
    expect(outline(log.events.slice(-5))).toEqual([
      "PHYSICAL_CHIP_ACTION hero",
      "DEALER_RULING hero operations out_of_turn",
      "ACTION_TAKEN sb check 0",
      "DEALER_RULING hero pending_out_of_turn action bet",
      "ACTION_TAKEN hero bet 100",
    ]);
    expect(foldHandEvents(log.events)).toEqual(log.state);
    const atWarning = log.events.findIndex(
      (e) => e.type === "DEALER_RULING" && e.outcome === "out_of_turn",
    );
    expect(
      foldHandEvents(log.events.slice(0, atWarning + 1)).pendingOutOfTurn,
    ).toMatchObject({ playerId: "hero", actions: [push(100)] });
  });

  it("間の Player が Bet したら撤回し（no_action）、Hero が選び直す", () => {
    const log = flop3();
    append(
      log,
      applyPhysicalActions(
        log.state,
        "hero",
        [{ type: "declare", declaration: { kind: "check" } }],
        CONFIG,
      ),
    );
    append(log, applyAction(log.state, "sb", { type: "bet", amount: 50 }));
    const resolved = append(log, resolvePendingOutOfTurn(log.state, CONFIG));
    expect(outline(resolved)).toEqual([
      "DEALER_RULING hero pending_out_of_turn no_action",
    ]);
    expect(resolved[0]).toMatchObject({ notes: ["out_of_turn_released"] });
    expect(log.state.pendingOutOfTurn).toBeNull();
    expect(getLegalActions(log.state)?.playerId).toBe("hero");
    append(log, applyAction(log.state, "hero", { type: "call" }));
    expect(foldHandEvents(log.events)).toEqual(log.state);
  });

  it("保留が無いときの裁定は invalid_input", () => {
    const { state } = flop3();
    const r = resolvePendingOutOfTurn(state, CONFIG);
    expect(r.ok ? null : r.error.kind).toBe("invalid_input");
  });
});

describe("Projection（Hero View・KnowledgeState）", () => {
  it("CPU の KnowledgeState には公開の裁定の記録だけが入り、保留 → 拘束を時系列で読める", () => {
    const log = flop3();
    append(log, applyPhysicalActions(log.state, "hero", [push(100)], CONFIG));
    const warned = projectKnowledgeState(log.events, "btn");
    expect(warned.rulingHistory).toEqual([
      {
        playerId: "hero",
        street: "flop",
        basis: "operations",
        operations: [push(100)],
        outcome: "out_of_turn",
        action: null,
        notes: ["out_of_turn"],
      },
    ]);
    append(log, applyAction(log.state, "sb", { type: "check" }));
    append(log, resolvePendingOutOfTurn(log.state, CONFIG));

    const ks = projectKnowledgeState(log.events, "btn");
    expect(ks.rulingHistory?.at(-1)).toEqual({
      playerId: "hero",
      street: "flop",
      basis: "pending_out_of_turn",
      operations: [push(100)],
      outcome: "action",
      action: { type: "bet", amount: 100 },
      notes: ["out_of_turn_binding"],
    });
    expect(ks.actionHistory.at(-1)).toMatchObject({
      playerId: "hero",
      action: "bet",
      toAmount: 100,
    });
    // 他者の札・Deck・seed・system の記録は入らない（INV-TEST-007）。
    expect(leakedCards(ks, log.state, "btn")).toEqual([]);
    expect(hiddenMarkers(ks)).toEqual([]);
  });

  it("裁定の無い Hand の KnowledgeState は rulingHistory を持たない（CPU への入力を変えない）", () => {
    const { events } = flop3();
    expect(projectKnowledgeState(events, "sb")).not.toHaveProperty(
      "rulingHistory",
    );
  });

  it("Hero View の log に操作と裁定が入る", () => {
    const log = facingBet100();
    append(log, applyPhysicalActions(log.state, "hero", [push(500)], CONFIG));
    const view = projectHeroView(log.events, "hero");
    expect(view.log.map((e) => e.type)).toContain("DEALER_RULING");
    expect(view.log.map((e) => e.type)).toContain("PHYSICAL_CHIP_ACTION");
    // CPU 側の View にも同じ公開の事実が届く。
    expect(projectHeroView(log.events, "cpu").log.map((e) => e.type)).toContain(
      "DEALER_RULING",
    );
  });
});
