// Ruling Engine の Property テスト（poker-engine-testing §5）。Hero の物理的な操作をランダムに作って Hand を最後まで進め、
// 裁定した Canonical Action が必ず合法（applyAction が拒否しない。D40）であることと、各ステップの Invariant
// （INV-TEST-001〜005。Chip 保存を含む）・Event の畳み込みを確かめる。Out-of-Turn も混ぜる。
// 操作と裁定を Event にする経路（applyPhysicalActions / resolvePendingOutOfTurn。D90）でも同じことを確かめる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  resolvePendingOutOfTurn,
  startHand,
} from "./hand-engine.js";
import { foldHandEvents } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import {
  resolveOutOfTurn,
  rulePhysicalActions,
  type Declaration,
  type PendingOutOfTurn,
  type PhysicalAction,
} from "./ruling.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { checkInvariants, initialChipTotal } from "./testing/invariants.js";
import { propertyParams } from "./testing/property.js";

const MAX_STEPS = 500;
const HERO = "p0";
const VALUES = PHASE1_CASH_PRESET.chipDenominations.map((d) => d.value);

/** choices から Hero の 1 回の手番の操作を作る（出す Chip の合計は Stack 以下）。 */
function physicalFrom(next: () => number, stack: number): PhysicalAction[] {
  const actions: PhysicalAction[] = [];
  const declarationAt = next() % 3; // 0: 宣言なし / 1: Chip の前 / 2: Chip の後
  const declaration = declarationFrom(next);
  let rest = stack;
  const motions: PhysicalAction[] = [];
  const motionCount = next() % 4;
  for (let m = 0; m < motionCount; m++) {
    const chips: number[] = [];
    const count = 1 + (next() % 4);
    for (let c = 0; c < count; c++) {
      const value = VALUES[next() % VALUES.length] as number;
      if (value <= rest) {
        chips.push(value);
        rest -= value;
      }
    }
    if (chips.length === 0) break;
    motions.push({
      type: motions.length === 0 ? "chip_push" : "chip_add",
      chips,
    });
  }
  if (declarationAt === 1 || motions.length === 0) {
    actions.push({ type: "declare", declaration });
  }
  actions.push(...motions);
  if (declarationAt === 2 && motions.length > 0) {
    actions.push({ type: "declare", declaration });
  }
  return actions;
}

function declarationFrom(next: () => number): Declaration {
  switch (next() % 6) {
    case 0:
      return { kind: "fold" };
    case 1:
      return { kind: "check" };
    case 2:
      return { kind: "call" };
    case 3:
      return { kind: "all_in" };
    default: {
      const kind = next() % 2 === 0 ? "bet" : "raise";
      return next() % 2 === 0 ? { kind } : { kind, amount: next() % 3000 };
    }
  }
}

function canonicalFrom(option: LegalAction, choice: number): PlayerAction {
  switch (option.type) {
    case "bet":
    case "raise":
      return {
        type: option.type,
        amount: option.min + (choice % (option.max - option.min + 1)),
      };
    case "call":
      return { type: "call" };
    default:
      return { type: option.type };
  }
}

function playWithRuling(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
): void {
  const started = startHand({
    handId: "ruling-prop",
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
  });
  if (!started.ok) throw new Error(started.error.message);
  const total = initialChipTotal(seats);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  let cursor = 0;
  const next = () => choices[cursor++ % choices.length] ?? 0;
  let pending: PendingOutOfTurn | null = null;

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const hero = state.players.find((p) => p.playerId === HERO);
    const heroCanAct = hero !== undefined && !hero.folded && !hero.allIn;

    // 手番でない Hero が時々操作する（Out-of-Turn）。State は変わらず、保留だけが返る。
    if (
      legal.playerId !== HERO &&
      heroCanAct &&
      pending === null &&
      next() % 4 === 0
    ) {
      const r = rulePhysicalActions(
        state,
        HERO,
        physicalFrom(next, hero.stack),
        PHASE1_CASH_PRESET,
      );
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.kind).toBe("out_of_turn");
      if (r.value.kind === "out_of_turn") pending = r.value.pending;
    }

    let action: PlayerAction | null = null;
    if (legal.playerId === HERO && hero !== undefined) {
      const r =
        pending !== null
          ? resolveOutOfTurn(state, pending, PHASE1_CASH_PRESET)
          : rulePhysicalActions(
              state,
              HERO,
              physicalFrom(next, hero.stack),
              PHASE1_CASH_PRESET,
            );
      pending = null;
      if (!r.ok) throw new Error(r.error.message);
      // 手番の操作は Out-of-Turn にならない。
      expect(r.value.kind).not.toBe("out_of_turn");
      if (r.value.kind === "action") action = r.value.action;
    }
    // CPU の手番、または Hero が選び直す（no_action）ときは Legal Action から選ぶ。
    action ??= canonicalFrom(
      legal.actions[next() % legal.actions.length] as LegalAction,
      next(),
    );

    const result = applyAction(state, legal.playerId, action);
    // 裁定した Action も、Legal Action から選んだ Action も拒否されない（D40）。
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);
  }
}

/**
 * playWithRuling と同じ進め方を、操作と裁定を Event にする経路で行う。保留は State（pendingOutOfTurn）だけが持ち、
 * 呼び出し側は覚えない（Event の並びだけで保留 → 拘束 / 撤回を復元できることを確かめる）。
 */
function playWithEvents(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
): void {
  const started = startHand({
    handId: "ruling-events-prop",
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
  });
  if (!started.ok) throw new Error(started.error.message);
  const total = initialChipTotal(seats);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  let cursor = 0;
  const next = () => choices[cursor++ % choices.length] ?? 0;
  const take = (r: ReturnType<typeof applyAction>) => {
    if (!r.ok) throw new Error(r.error.message);
    state = r.value.state;
    events.push(...r.value.events);
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);
  };

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const hero = state.players.find((p) => p.playerId === HERO);
    const heroCanAct = hero !== undefined && !hero.folded && !hero.allIn;

    if (
      legal.playerId !== HERO &&
      heroCanAct &&
      state.pendingOutOfTurn === null &&
      next() % 4 === 0
    ) {
      const r = applyPhysicalActions(
        state,
        HERO,
        physicalFrom(next, hero.stack),
        PHASE1_CASH_PRESET,
      );
      take(r);
      // 手番でない操作は保留だけが残り、手番は変わらない。
      expect(r.ok && r.value.ruling.kind).toBe("out_of_turn");
      // （state は take の中で更新するので、Event の畳み込みから読む。）
      expect(foldHandEvents(events).pendingOutOfTurn?.playerId).toBe(HERO);
      expect(getLegalActions(state)).toEqual(legal);
    }

    if (legal.playerId === HERO && hero !== undefined) {
      const r =
        state.pendingOutOfTurn !== null
          ? resolvePendingOutOfTurn(state, PHASE1_CASH_PRESET)
          : applyPhysicalActions(
              state,
              HERO,
              physicalFrom(next, hero.stack),
              PHASE1_CASH_PRESET,
            );
      take(r);
      expect(state.pendingOutOfTurn).toBeNull();
      if (r.ok && r.value.ruling.kind === "action") continue;
    }
    // CPU の手番、または Hero が選び直す（no_action）ときは Legal Action から選ぶ。
    take(
      applyAction(
        state,
        legal.playerId,
        canonicalFrom(
          legal.actions[next() % legal.actions.length] as LegalAction,
          next(),
        ),
      ),
    );
  }

  // 操作・裁定は public で、Action に決まった裁定の直後は同じ Player の ACTION_TAKEN。
  events.forEach((e, i) => {
    if (
      e.type !== "PLAYER_DECLARED" &&
      e.type !== "PHYSICAL_CHIP_ACTION" &&
      e.type !== "DEALER_RULING"
    ) {
      return;
    }
    expect(e.visibility).toEqual({ type: "public" });
    expect(e.playerId).toBe(HERO);
    if (e.type === "DEALER_RULING" && e.outcome === "action") {
      expect(events[i + 1]).toMatchObject({
        type: "ACTION_TAKEN",
        playerId: HERO,
      });
    }
  });
}

describe("Ruling Engine（Property）", () => {
  it("裁定した Canonical Action は常に合法で、Invariant を壊さない", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.integer({ min: 20, max: 2000 }), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }),
        (n, stacks, seed, choices) => {
          const seats = stacks
            .slice(0, n)
            .map((stack, i) => ({ playerId: `p${i}`, stack }));
          playWithRuling(seats, seed, choices);
        },
      ),
      propertyParams(300),
    );
  });

  it("操作と裁定を Event にしても、裁定した Action は常に合法で、Invariant と Event の畳み込みを保つ（D90）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.integer({ min: 20, max: 2000 }), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }),
        (n, stacks, seed, choices) => {
          const seats = stacks
            .slice(0, n)
            .map((stack, i) => ({ playerId: `p${i}`, stack }));
          playWithEvents(seats, seed, choices);
        },
      ),
      propertyParams(300),
    );
  });
});
