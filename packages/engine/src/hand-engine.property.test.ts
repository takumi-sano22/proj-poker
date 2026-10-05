// Property テスト（docs/09 §9・poker-engine-testing §5）。Legal Action からランダムに選んで Hand を最後まで進め、
// 各ステップで Invariant・Event の畳み込み・Projection の情報漏れを確かめる。
// fast-check の seed は実行ごとに変わる。失敗時は fast-check が seed と縮小済みの反例を出すので、Scenario へ昇格させる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand, type EngineError } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { projectBotView, projectHeroView } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { checkInvariants, initialChipTotal } from "./testing/invariants.js";
import { leakedCards } from "./testing/view-leaks.js";

const MAX_STEPS = 500;

interface PlayedHand {
  /** 開始自体が拒否されたら null。 */
  readonly state: HandState | null;
  readonly events: readonly HandEvent[];
  /** 途中で止まった理由（Phase 1 が扱えない状態）。最後まで進めば null。 */
  readonly stoppedBy: EngineError | null;
}

/** choices を順に使って Legal Action と額を選ぶ。各ステップで check を呼ぶ。 */
function playHand(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
  check: (state: HandState, events: readonly HandEvent[]) => void,
): PlayedHand {
  const started = startHand({
    handId: "prop",
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
  });
  if (!started.ok) {
    // 開始時に拒否されうるのは、Blind で All-in になり Side Pot が要る場合だけ（Stack < Blind）。
    expect(started.error.kind).toBe("unsupported_state");
    return { state: null, events: [], stoppedBy: started.error };
  }
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  check(state, events);

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const pick = (k: number) => choices[(step * 2 + k) % choices.length] ?? 0;
    const option = legal.actions[pick(0) % legal.actions.length] as LegalAction;
    const result = applyAction(
      state,
      legal.playerId,
      toAction(option, pick(1)),
    );
    if (!result.ok) {
      // Legal Action から選んだ入力が「合法でない」と拒否されることはない。拒否は Phase 1 の未対応状態だけ。
      expect(result.error.kind).toBe("unsupported_state");
      return { state, events, stoppedBy: result.error };
    }
    state = result.value.state;
    events.push(...result.value.events);
    check(state, events);
  }
  return { state, events, stoppedBy: null };
}

function toAction(option: LegalAction, choice: number): PlayerAction {
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

/** Invariant・畳み込み・INV-TEST-006・Projection の漏れを 1 ステップ分まとめて確かめる。 */
function checkStep(total: number) {
  return (state: HandState, events: readonly HandEvent[]) => {
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);

    // INV-TEST-006: 手番でない Player の Action は拒否され、State は変わらない。
    const actorId = getLegalActions(state)?.playerId;
    for (const p of state.players) {
      if (p.playerId === actorId) continue;
      const r = applyAction(state, p.playerId, { type: "fold" });
      expect(r.ok).toBe(false);
    }

    // INV-TEST-007（Engine 側）: どの Player の View にも、知ってはいけない Card が無い。
    for (const p of state.players) {
      const hero = projectHeroView(events, p.playerId);
      const bot = projectBotView(events, p.playerId);
      expect(leakedCards(hero, state, p.playerId)).toEqual([]);
      expect(leakedCards(bot, state, p.playerId)).toEqual([]);
      // 見える Event だけから計算した Legal Action が、全情報の State と一致する。
      const legal = getLegalActions(state);
      expect(bot.legalActions).toEqual(
        legal?.playerId === p.playerId ? legal : null,
      );
      expect(bot.pot).toBe(state.pot);
    }
  };
}

const playerCount = fc.integer({ min: 2, max: 6 });
const seed = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const choices = fc.array(fc.nat({ max: 10_000 }), {
  minLength: 1,
  maxLength: 64,
});

describe("Hand 進行: Property", () => {
  it("均等 Stack（Phase 1 Preset）なら Side Pot は起きず、Chip が保存され、情報が漏れない", () => {
    fc.assert(
      fc.property(playerCount, seed, choices, (n, s, cs) => {
        const seats = Array.from({ length: n }, (_, i) => ({
          playerId: `p${i}`,
          stack: PHASE1_CASH_PRESET.startingStack,
        }));
        const played = playHand(
          seats,
          s,
          cs,
          checkStep(initialChipTotal(seats)),
        );
        // 均等 Stack で止まりうるのは端数の出る Split だけ（D70）。
        if (played.stoppedBy !== null) {
          expect(played.stoppedBy).toMatchObject({ reason: "odd_chip_split" });
        } else {
          expect(played.state?.status).toBe("complete");
          expect(played.state?.pot).toBe(0);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("不均等 Stack でも、合法な入力は Phase 1 の未対応状態以外で拒否されず、Chip が保存される", () => {
    const stacks = fc.array(fc.integer({ min: 1, max: 400 }), {
      minLength: 2,
      maxLength: 6,
    });
    fc.assert(
      fc.property(stacks, seed, choices, (ss, s, cs) => {
        const seats = ss.map((stack, i) => ({ playerId: `p${i}`, stack }));
        const total = initialChipTotal(seats);
        const played = playHand(seats, s, cs, (state) => {
          expect(checkInvariants(state, total)).toEqual([]);
        });
        if (played.stoppedBy !== null) {
          expect(played.stoppedBy.kind).toBe("unsupported_state");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("同じ seed と同じ Action 列からは同じ Event 列と State ができる（再現性）", () => {
    fc.assert(
      fc.property(playerCount, seed, choices, (n, s, cs) => {
        const seats = Array.from({ length: n }, (_, i) => ({
          playerId: `p${i}`,
          stack: 200,
        }));
        const first = playHand(seats, s, cs, () => {});
        const second = playHand(seats, s, cs, () => {});
        expect(second.events).toEqual(first.events);
        expect(second.state).toEqual(first.state);
      }),
      { numRuns: 50 },
    );
  });
});
