// 代表 Spot が意図した局面になっているか（Spot の定義の誤りで Eval が別の局面を測らないように）。
import { cardToString } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { forbiddenKeys, leakedCards } from "../leaks.js";
import { OPPONENT_EVAL_SPOTS, buildSpot } from "./spots.js";

const byId = (id: string) => {
  const spot = OPPONENT_EVAL_SPOTS.find((s) => s.id === id);
  if (spot === undefined) throw new Error(`Spot が無い: ${id}`);
  return buildSpot(spot);
};

describe("OPPONENT_EVAL_SPOTS", () => {
  it("Issue #53 の 4 局面を持ち、ID は重複しない", () => {
    expect(OPPONENT_EVAL_SPOTS.map((s) => s.id)).toEqual([
      "preflop_open",
      "preflop_facing_3bet",
      "flop_cbet",
      "river_facing_big_bet",
    ]);
  });

  it("どの Spot も、判断する CPU の入力に他者の札・Deck・seed・Persona が入らない（INV-TEST-007）", () => {
    for (const spot of OPPONENT_EVAL_SPOTS) {
      const f = buildSpot(spot);
      const uptoSeq = f.events.at(-1)?.seq ?? -1;
      expect(leakedCards(f.input, f.events, f.actorId, uptoSeq)).toEqual([]);
      expect(forbiddenKeys(f.input)).toEqual([]);
      expect(f.input.knowledge.viewerId).toBe(spot.actorId);
      expect(f.input.knowledge.holeCards?.map(cardToString).join(" ")).toBe(
        spot.holes[spot.actorId],
      );
    }
  });

  it("preflop_open: UTG が最初の Actor で、fold / call 2 / raise 4〜200 / all_in を選べる", () => {
    const f = byId("preflop_open");
    expect(f.input.knowledge.street).toBe("preflop");
    expect(f.input.legal.actions).toEqual([
      { type: "fold" },
      { type: "call", amount: 2 },
      { type: "raise", min: 4, max: 200 },
      { type: "all_in", amount: 200 },
    ]);
  });

  it("preflop_facing_3bet: 6 に Open した UTG が 18 の 3-bet に直面し、call 12 / raise 30〜200 / all_in を選べる", () => {
    const f = byId("preflop_facing_3bet");
    expect(f.input.knowledge.street).toBe("preflop");
    expect(f.input.legal.actions).toEqual([
      { type: "fold" },
      { type: "call", amount: 12 },
      { type: "raise", min: 30, max: 200 },
      { type: "all_in", amount: 200 },
    ]);
  });

  it("flop_cbet: Heads-Up の Flop で BB が Check し、Open した CO が check / bet 2〜194 / all_in を選べる", () => {
    const f = byId("flop_cbet");
    expect(f.input.knowledge.street).toBe("flop");
    expect(f.input.knowledge.board.map(cardToString)).toEqual([
      "Kc",
      "7d",
      "2s",
    ]);
    expect(f.input.knowledge.pot).toBe(13);
    expect(f.input.legal.actions).toEqual([
      { type: "fold" },
      { type: "check" },
      { type: "bet", min: 2, max: 194 },
      { type: "all_in", amount: 194 },
    ]);
  });

  it("river_facing_big_bet: River で Pot 23 に 26 の Bet を受け、call 26 / raise 52〜189 / all_in を選べる", () => {
    const f = byId("river_facing_big_bet");
    expect(f.input.knowledge.street).toBe("river");
    expect(f.input.knowledge.board.map(cardToString)).toEqual([
      "Qh",
      "8c",
      "3d",
      "2s",
      "Kd",
    ]);
    expect(f.input.legal.actions).toEqual([
      { type: "fold" },
      { type: "call", amount: 26 },
      { type: "raise", min: 52, max: 189 },
      { type: "all_in", amount: 189 },
    ]);
  });
});
