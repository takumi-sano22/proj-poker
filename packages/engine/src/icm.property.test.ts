// 決定論の ICM Calculator の Property（D109・docs/02 §7・#187）。2〜8 人・Stack 0 や同額を含む任意の Stack と、上位ほど多いか同じ賞金で、
// 合計の保存（Σ Equity = 争う賞金の合計）・Stack についての単調性・人数の対称性（並べ替え）が崩れないこと。
// Equity は倍精度なので、比較は争う賞金の合計に対する相対 1e-9 の許容誤差で行う（docs/02 §7）。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ICM_MAX_PLAYERS,
  ICM_MIN_PLAYERS,
  icmCallAllIn,
  icmEquities,
  icmShove,
  type IcmStack,
} from "./icm.js";
import { propertyParams } from "./testing/property.js";

const RELATIVE_TOLERANCE = 1e-9;

/** 2〜8 人の Stack（0 と同額を出やすくするため小さい値の範囲も混ぜる。合計は 1 以上）。 */
const stacksArb = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 0, max: 1_000_000 }),
    ),
    { minLength: ICM_MIN_PLAYERS, maxLength: ICM_MAX_PLAYERS },
  )
  .filter((amounts) => amounts.some((a) => a > 0))
  .map((amounts) =>
    amounts.map((stack, i): IcmStack => ({ playerId: `p${i}`, stack })),
  );

/** 上位ほど多いか同じ賞金（pt）の列（1〜8 個。1 位は 1 以上）。 */
const payoutsArb = fc
  .array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 })
  .map((amounts) => [...amounts].sort((a, b) => b - a))
  .filter((amounts) => (amounts[0] as number) > 0);

function tolerance(pool: number): number {
  return pool * RELATIVE_TOLERANCE;
}

describe("icmEquities: Property", () => {
  it("Σ Equity = 争う賞金の合計（1〜n 位の賞金）。各 Equity は 0 以上・1 位の賞金以下、% の合計は 100", () => {
    fc.assert(
      fc.property(stacksArb, payoutsArb, (stacks, payouts) => {
        const result = icmEquities(stacks, payouts);
        const contested = stacks
          .map((_, place) => payouts[place] ?? 0)
          .reduce((sum, a) => sum + a, 0);
        expect(result.prizePool).toBe(contested);
        const eps = tolerance(contested);
        const sum = result.players.reduce((s, p) => s + p.equity, 0);
        expect(Math.abs(sum - contested)).toBeLessThanOrEqual(eps);
        const percent = result.players.reduce((s, p) => s + p.equityPercent, 0);
        expect(Math.abs(percent - 100)).toBeLessThanOrEqual(
          100 * RELATIVE_TOLERANCE,
        );
        for (const p of result.players) {
          expect(p.equity).toBeGreaterThanOrEqual(-eps);
          expect(p.equity).toBeLessThanOrEqual((payouts[0] as number) + eps);
        }
      }),
      propertyParams(),
    );
  });

  it("Stack が多い Player ほど Equity が多いか同じ。同額の Stack は同じ Equity", () => {
    fc.assert(
      fc.property(stacksArb, payoutsArb, (stacks, payouts) => {
        const result = icmEquities(stacks, payouts);
        const eps = tolerance(result.prizePool);
        for (const a of result.players) {
          for (const b of result.players) {
            if (a.stack > b.stack) {
              expect(a.equity).toBeGreaterThanOrEqual(b.equity - eps);
            } else if (a.stack === b.stack) {
              expect(Math.abs(a.equity - b.equity)).toBeLessThanOrEqual(eps);
            }
          }
        }
      }),
      propertyParams(),
    );
  });

  it("ほかの Player から Chip を受け取ると、自分の Equity は減らない", () => {
    fc.assert(
      fc.property(
        stacksArb,
        payoutsArb,
        fc.nat(),
        fc.nat(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (stacks, payouts, from, to, ratio) => {
          const giver = from % stacks.length;
          const taker = to % stacks.length;
          fc.pre(giver !== taker);
          const moved = Math.floor((stacks[giver]?.stack as number) * ratio);
          const after = stacks.map((s, i) =>
            i === giver
              ? { ...s, stack: s.stack - moved }
              : i === taker
                ? { ...s, stack: s.stack + moved }
                : s,
          );
          const before = icmEquities(stacks, payouts);
          const eps = tolerance(before.prizePool);
          expect(
            icmEquities(after, payouts).players[taker]?.equity as number,
          ).toBeGreaterThanOrEqual(
            (before.players[taker]?.equity as number) - eps,
          );
        },
      ),
      propertyParams(),
    );
  });

  it("並べ替えても各 Player の Equity は変わらない（人数の対称性）", () => {
    fc.assert(
      fc.property(
        stacksArb,
        payoutsArb,
        fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
        (stacks, payouts, keys) => {
          const shuffled = stacks
            .map((s, i) => ({ s, key: keys[i] as number, i }))
            .sort((a, b) => a.key - b.key || a.i - b.i)
            .map(({ s }) => s);
          const original = icmEquities(stacks, payouts);
          const permuted = icmEquities(shuffled, payouts);
          const eps = tolerance(original.prizePool);
          for (const p of original.players) {
            const q = permuted.players.find((x) => x.playerId === p.playerId);
            expect(
              Math.abs((q?.equity as number) - p.equity),
            ).toBeLessThanOrEqual(eps);
          }
        },
      ),
      propertyParams(),
    );
  });
});

describe("All-in の必要 Equity: Property", () => {
  /** 3〜8 人の Spot（Hero = p0、相手 = p1、ほかはまだ Action していない Player）。Chip は D74 の整数。 */
  const spotArb = fc.record({
    behind: fc.array(fc.integer({ min: 1, max: 10_000 }), {
      minLength: 3,
      maxLength: ICM_MAX_PLAYERS,
    }),
    blind: fc.integer({ min: 0, max: 50 }),
    payouts: payoutsArb,
  });

  it("Hero の Chip は 負け ≤ Fold ≤ 勝ち ≤ 全員の Chip で、Chip EV の必要 Equity は 0〜1。前提は常に明示される", () => {
    fc.assert(
      fc.property(spotArb, ({ behind, blind, payouts }) => {
        // 最後の席が Blind を出して Fold 済み（Dead Money）。Dead Money がまだ争う Player の額を超える（その超過が負けても
        // Hero に戻り、必要 Equity が 0〜1 の外になる）Spot は、この Property の対象外にする。
        fc.pre(behind.slice(0, -1).every((b) => b >= blind));
        const seats = behind.map((stack, i) => ({
          playerId: `p${i}`,
          stack,
          committed: i === behind.length - 1 ? blind : 0,
          folded: i === behind.length - 1,
        }));
        const total = seats.reduce((s, x) => s + x.stack + x.committed, 0);
        const shove = icmShove({ seats, payouts, heroId: "p0" }, "p1");
        // 相手の Shove（p1 の All-in）への Call。
        const callSeats = seats.map((s) =>
          s.playerId === "p1"
            ? { ...s, stack: 0, committed: s.stack + s.committed }
            : s,
        );
        const call = icmCallAllIn(
          { seats: callSeats, payouts, heroId: "p0" },
          "p1",
        );
        for (const analysis of [shove, call]) {
          expect(analysis.assumptions.othersFold).toBe(true);
          expect(analysis.assumptions.foldEquityIncluded).toBe(false);
          expect(analysis.assumptions.callFrequencyIncluded).toBe(false);
          for (const req of analysis.requirements) {
            expect(req.heroStack.lose).toBeLessThanOrEqual(req.heroStack.fold);
            expect(req.heroStack.fold).toBeLessThanOrEqual(req.heroStack.win);
            expect(req.chipEvRequiredEquity).toBeGreaterThanOrEqual(0);
            expect(req.chipEvRequiredEquity).toBeLessThanOrEqual(1);
            expect(req.heroStack.win).toBeLessThanOrEqual(total);
          }
        }
        // Shove は Hero 以外のまだ Fold していない相手ごと。
        expect(shove.requirements.map((r) => r.villainId)).toEqual(
          seats.slice(1, -1).map((s) => s.playerId),
        );
      }),
      propertyParams(),
    );
  });
});
