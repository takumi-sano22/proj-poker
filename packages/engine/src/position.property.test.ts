// Position Engine の Property テスト（docs/09 §9・poker-engine-testing §5）。
// fast-check の seed は実行ごとに変わる。失敗時は fast-check が seed と縮小済みの反例を出すので、position.test.ts の
// Scenario へ昇格させる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { startHand } from "./hand-engine.js";
import { nextHandSeating, type PreviousHandResult } from "./position.js";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PHASE1_CASH_PRESET,
} from "./table-config.js";

const config = PHASE1_CASH_PRESET;

/** 2〜8 人の Stack 列と前 Hand の Button の位置。zeroAllowed なら Bust（Stack 0）を混ぜる。 */
const table = (zeroAllowed: boolean) =>
  fc
    .array(fc.integer({ min: zeroAllowed ? 0 : 1, max: 1000 }), {
      minLength: MIN_PLAYERS,
      maxLength: MAX_PLAYERS,
    })
    .chain((stacks) =>
      fc.record({
        stacks: fc.constant(stacks),
        button: fc.integer({ min: 0, max: stacks.length - 1 }),
      }),
    );

function previousOf(stacks: readonly number[], button: number) {
  const seatOrder = stacks.map((_, i) => `p${i}`);
  return {
    seatOrder,
    stacks: stacks.map((amount, i) => ({ playerId: `p${i}`, amount })),
    buttonPlayerId: seatOrder[button] as string,
  } satisfies PreviousHandResult;
}

describe("Property: nextHandSeating", () => {
  it("誰も Bust しなければ、人数分の Hand で全員が 1 回ずつ Button になり、元の Button へ戻る", () => {
    fc.assert(
      fc.property(table(false), ({ stacks, button }) => {
        let prev = previousOf(stacks, button);
        const buttons: string[] = [];
        for (let i = 0; i < stacks.length; i++) {
          const result = nextHandSeating(prev, config);
          if (!result.ok || result.value.kind !== "next_hand") {
            throw new Error("次 Hand が始まらない");
          }
          const { seats, buttonPlayerId } = result.value;
          buttons.push(buttonPlayerId);
          prev = {
            seatOrder: seats.map((s) => s.playerId),
            stacks: seats.map((s) => ({
              playerId: s.playerId,
              amount: s.stack,
            })),
            buttonPlayerId,
          };
        }
        expect([...buttons].sort()).toEqual([...prev.seatOrder].sort());
        expect(buttons.at(-1)).toBe(`p${button}`);
      }),
    );
  });

  it("Bust を含んでも、席順を保って Stack 0 だけを外し、Button は前 Button から時計回りで最初の生存席になる", () => {
    fc.assert(
      fc.property(table(true), ({ stacks, button }) => {
        const prev = previousOf(stacks, button);
        const result = nextHandSeating(prev, config);
        if (!result.ok) throw new Error(result.error.message);
        const alive = stacks.flatMap((stack, i) =>
          stack > 0 ? [{ playerId: `p${i}`, stack }] : [],
        );
        if (alive.length < MIN_PLAYERS) {
          expect(result.value).toEqual({
            kind: "no_next_hand",
            remaining: alive,
          });
          return;
        }
        if (result.value.kind !== "next_hand") {
          throw new Error("2 人以上残っているのに次 Hand が無い");
        }
        const { seats, buttonPlayerId } = result.value;
        // 席順を保ち、Stack（Chip 総量）を変えない。
        expect(seats).toEqual(alive);
        // 前 Button の次の席から時計回りに並べ、最初に Stack が残っている Player。
        const clockwise = stacks.map(
          (_, k) => (button + 1 + k) % stacks.length,
        );
        const expected = clockwise.find((i) => (stacks[i] as number) > 0);
        expect(buttonPlayerId).toBe(`p${expected}`);

        // 結果はそのまま startHand に渡せる。Heads-Up なら Button = SB（docs/02 §7）、3 人以上なら Button の左が SB。
        const started = startHand({
          handId: "next",
          seats,
          buttonPlayerId,
          config,
          deal: { seed: 1 },
        });
        if (!started.ok) throw new Error(started.error.message);
        const sb = started.value.events.find(
          (e) => e.type === "BLIND_POSTED" && e.blind === "small",
        );
        const b = seats.findIndex((s) => s.playerId === buttonPlayerId);
        const expectedSb =
          seats.length === 2
            ? buttonPlayerId
            : seats[(b + 1) % seats.length]?.playerId;
        expect(sb?.type === "BLIND_POSTED" ? sb.playerId : null).toBe(
          expectedSb,
        );
      }),
    );
  });
});
