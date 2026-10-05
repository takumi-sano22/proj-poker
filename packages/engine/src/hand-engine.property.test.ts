// Property テスト（docs/09 §9・poker-engine-testing §5）。Legal Action からランダムに選んで Hand を最後まで進め、
// 各ステップで Invariant・Event の畳み込み・Projection の情報漏れを確かめる。
// fast-check の seed は実行ごとに変わる。失敗時は fast-check が seed と縮小済みの反例を出すので、Scenario へ昇格させる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { projectBotView, projectHeroView } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  checkInvariants,
  checkPotAwards,
  initialChipTotal,
} from "./testing/invariants.js";
import { leakedCards } from "./testing/view-leaks.js";

const MAX_STEPS = 500;

interface PlayedHand {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
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
  // 正しい入力の開始は拒否されない（Stack が Blind に満たなくても Blind で All-in して始まる）。
  if (!started.ok) throw new Error(started.error.message);
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
    // Legal Action から選んだ入力は拒否されない（Side Pot も扱えるので、止まる状態は無い。D78）。
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
    check(state, events);
  }
  return { state, events };
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

const playerCount = fc.integer({ min: 2, max: 8 });
const seed = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const choices = fc.array(fc.nat({ max: 10_000 }), {
  minLength: 1,
  maxLength: 64,
});

describe("Hand 進行: Property", () => {
  it("均等 Stack（Phase 1 Preset）なら Hand は最後まで進み（端数込み）、Chip が保存され、情報が漏れない", () => {
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
        // 同着の端数も配られ、Pot は空になる（D75）。
        expect(played.state.status).toBe("complete");
        expect(played.state.pot).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it("不均等 Stack（Blind に満たない Stack を含む）でも Hand は最後まで進み、Side Pot ごとの配分で Chip が保存され、情報が漏れない", () => {
    const stacks = fc.array(fc.integer({ min: 1, max: 400 }), {
      minLength: 2,
      maxLength: 6,
    });
    fc.assert(
      fc.property(stacks, seed, choices, (ss, s, cs) => {
        const seats = ss.map((stack, i) => ({ playerId: `p${i}`, stack }));
        const total = initialChipTotal(seats);
        const played = playHand(seats, s, cs, checkStep(total));
        expect(played.state.status).toBe("complete");
        expect(played.state.pot).toBe(0);
        expect(checkPotAwards(played.events)).toEqual([]);
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
