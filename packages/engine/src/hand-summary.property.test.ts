// 判断時点の Hero Information Set・Hand Summary・Learning-only Full Reveal の Property テスト
// （#78・docs/05 §7 Pass A・INV-TEST-007 / 008 に相当・poker-engine-testing §5）。
// Hero（p0）は Canonical Action と物理的な操作（Out-of-Turn を含む）を混ぜ、CPU の手番には system の記録（不正な出力・
// Fallback・Emergency Bot）を時々置き、時々 Hand を打ち切る（HAND_ABORTED。D95）。その Event Log の全判断について、
// Information Set に未来の Card・他者の Hidden Cards・system / engine の Event・Learning-only Reveal が入らないことを確かめる。
// fast-check の seed は実行ごとに変わる（POKER_PROPERTY_SEED で固定。testing/property.ts）。失敗時は fast-check が seed と縮小済みの反例を出すので、Scenario へ昇格させる。
// この Property は「任意の入力で不変条件が崩れない」だけを担当する。「River まで進む Hand・Out-of-Turn の拘束・打ち切り等を通したか」の
// 網羅は random の seed に期待せず、固定 Scenario（hand-summary.test.ts。検査は testing/hand-summary-checks.ts を共有）が担当する（#167）。
import fc from "fast-check";
import { describe, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  recordAiEvent,
  recordSessionEvent,
  resolvePendingOutOfTurn,
  startHand,
  type HandProgress,
} from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import type { PhysicalAction } from "./ruling.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { checkHand } from "./testing/hand-summary-checks.js";
import { testMetadata } from "./testing/view-leaks.js";
import { propertyParams } from "./testing/property.js";

const MAX_STEPS = 500;
const HERO = "p0";
const VALUES = PHASE1_CASH_PRESET.chipDenominations.map((d) => d.value);

/** Hero の 1 回の操作（宣言だけ、または Chip を 1〜2 回。出す額は Stack 以下）。 */
function physicalFrom(next: () => number, stack: number): PhysicalAction[] {
  const kinds = ["fold", "check", "call", "all_in", "bet", "raise"] as const;
  if (next() % 2 === 0) {
    const kind = kinds[next() % kinds.length] as (typeof kinds)[number];
    return [{ type: "declare", declaration: { kind } }];
  }
  const actions: PhysicalAction[] = [];
  let rest = stack;
  for (let m = 0; m < 1 + (next() % 2); m++) {
    const value = VALUES[next() % VALUES.length] as number;
    if (value > rest) break;
    rest -= value;
    actions.push({
      type: actions.length === 0 ? "chip_push" : "chip_add",
      chips: [value],
    });
  }
  return actions.length > 0
    ? actions
    : [{ type: "declare", declaration: { kind: "call" } }];
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

/** Hand を最後まで（または打ち切りまで）進めた Event Log を返す。 */
function playHand(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
): HandEvent[] {
  const started = startHand({
    handId: "summary-prop",
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
    // system Visibility の Metadata（#97）も混ぜ、View・KnowledgeState・Hero Information Set に届かないことを一緒に確かめる。
    metadata: testMetadata(seats),
  });
  if (!started.ok) throw new Error(started.error.message);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  let cursor = 0;
  const next = () => choices[cursor++ % choices.length] ?? 0;
  const take = (r: HandProgress) => {
    state = r.state;
    events.push(...r.events);
  };
  take(recordSessionEvent(state, { type: "SESSION_STARTED", sessionId: "s" }));
  // 打ち切る手番（-1 なら打ち切らない）。
  const abortAt = next() % 3 === 0 ? next() % 12 : -1;

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    if (step === abortAt) {
      take(
        recordSessionEvent(state, {
          type: "HAND_ABORTED",
          reason: "ai_outage",
        }),
      );
      take(
        recordSessionEvent(state, {
          type: "SESSION_ENDED",
          sessionId: "s",
          reason: "ai_outage",
        }),
      );
      break;
    }
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const hero = state.players.find((p) => p.playerId === HERO);
    const heroCanAct = hero !== undefined && !hero.folded && !hero.allIn;

    // 手番でない Hero が時々操作する（Out-of-Turn で保留）。
    if (
      legal.playerId !== HERO &&
      heroCanAct &&
      state.pendingOutOfTurn === null &&
      next() % 5 === 0
    ) {
      const r = applyPhysicalActions(
        state,
        HERO,
        physicalFrom(next, hero.stack),
        PHASE1_CASH_PRESET,
      );
      if (!r.ok) throw new Error(r.error.message);
      take(r.value);
    }

    if (legal.playerId === HERO && hero !== undefined) {
      if (state.pendingOutOfTurn !== null) {
        const r = resolvePendingOutOfTurn(state, PHASE1_CASH_PRESET);
        if (!r.ok) throw new Error(r.error.message);
        take(r.value);
        if (r.value.ruling.kind === "action") continue;
      } else if (next() % 2 === 0) {
        const r = applyPhysicalActions(
          state,
          HERO,
          physicalFrom(next, hero.stack),
          PHASE1_CASH_PRESET,
        );
        if (!r.ok) throw new Error(r.error.message);
        take(r.value);
        if (r.value.ruling.kind === "action") continue;
      }
    } else {
      // CPU の手番の system の記録（CPU の出力の値を含む）。
      switch (next() % 4) {
        case 0:
          take(
            recordAiEvent(state, {
              type: "AI_ACTION_INVALID",
              playerId: legal.playerId,
              attempt: 1,
              stage: "schema",
              reason: "teleport",
            }),
          );
          break;
        case 1:
          take(
            recordSessionEvent(state, {
              type: "EMERGENCY_BOT_ENGAGED",
              playerId: legal.playerId,
              cause: "timeout",
            }),
          );
          take(
            recordAiEvent(state, {
              type: "AI_FALLBACK_USED",
              playerId: legal.playerId,
              fallbackKind: "emergency_bot",
              reason: "teleport",
            }),
          );
          break;
        default:
          break;
      }
    }
    const r = applyAction(
      state,
      legal.playerId,
      canonicalFrom(
        legal.actions[next() % legal.actions.length] as LegalAction,
        next(),
      ),
    );
    if (!r.ok) throw new Error(r.error.message);
    take(r.value);
  }
  return events;
}

describe("判断時点の Hero Information Set・Hand Summary（Property）", () => {
  it("どの判断の Information Set にも、未来の Card・他者の Hidden Cards・system の Event・Learning-only Reveal が入らない", () => {
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
          checkHand(playHand(seats, seed, choices), HERO);
        },
      ),
      propertyParams(150),
    );
  });
});
