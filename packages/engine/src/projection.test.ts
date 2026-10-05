// Projection の情報境界テスト（INV-TEST-007 の Engine 側・docs/02 §2 INV-INFO-001・D28）。
// 他者の Hole Cards と未配布の Board に「マーカー」の Card を積み、View を丸ごと走査して出てこないことを確かめる。
import { describe, expect, it } from "vitest";
import { cardToString, parseCards } from "./card.js";
import { isVisibleTo, type HandEvent, type SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import {
  projectBotView,
  projectHeroView,
  visibleEvents,
} from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { collectCards } from "./testing/view-leaks.js";
import { stackedDeck } from "./testing/stacked-deck.js";

const seats: SeatInit[] = ["btn", "sb", "bb", "utg"].map((playerId) => ({
  playerId,
  stack: 200,
}));
const holes = { btn: "2c 2d", sb: "3c 3d", bb: "4c 4d", utg: "Ac Ad" };
const board = "Ks Qs 9h 8h 7d";

function start() {
  const result = startHand({
    handId: "proj",
    seats,
    buttonPlayerId: "btn",
    config: PHASE1_CASH_PRESET,
    deal: { deck: stackedDeck(seats, "btn", holes, board) },
  });
  if (!result.ok) throw new Error(result.error.message);
  return { state: result.value.state, events: [...result.value.events] };
}

function act(
  hand: { state: HandState; events: HandEvent[] },
  playerId: string,
  action: PlayerAction,
) {
  const result = applyAction(hand.state, playerId, action);
  if (!result.ok) throw new Error(result.error.message);
  return {
    state: result.value.state,
    events: [...hand.events, ...result.value.events],
  };
}

const cardsIn = (view: unknown) => collectCards(view).map(cardToString);

describe("Projection", () => {
  it("開始直後: 自分の札だけが見え、他者の札と未配布の Board と Deck は含まれない", () => {
    const { events } = start();
    for (const viewer of seats.map((s) => s.playerId)) {
      for (const view of [
        projectHeroView(events, viewer),
        projectBotView(events, viewer),
      ]) {
        const own = parseCards(holes[viewer as keyof typeof holes]).map(
          cardToString,
        );
        expect(new Set(cardsIn(view))).toEqual(new Set(own));
        expect(view.board).toEqual([]);
        expect(JSON.stringify(view)).not.toContain('"deck"');
        for (const seat of view.seats) {
          expect(seat.holeCards === null).toBe(seat.playerId !== viewer);
        }
      }
    }
  });

  it("Hero のログに engine の Event と他者宛ての private Event が入らない", () => {
    const { events } = start();
    const log = projectHeroView(events, "sb").log;
    expect(log.some((e) => e.type === "DECK_SHUFFLED")).toBe(false);
    expect(
      log.filter((e) => e.type === "HOLE_CARD_DEALT").map((e) => e.playerId),
    ).toEqual(["sb"]);
    expect(visibleEvents(events, "sb")).toEqual(log);
    expect(
      events.every(
        (e) => e.visibility.type !== "engine" || !isVisibleTo(e, "sb"),
      ),
    ).toBe(true);
  });

  it("Flop 後: 配られた 3 枚だけが Board に見え、Turn / River は含まれない", () => {
    let hand = start();
    hand = act(hand, "utg", { type: "call" });
    hand = act(hand, "btn", { type: "call" });
    hand = act(hand, "sb", { type: "call" });
    hand = act(hand, "bb", { type: "check" });
    const view = projectBotView(hand.events, "bb");
    expect(view.board.map(cardToString)).toEqual(["Ks", "Qs", "9h"]);
    expect(cardsIn(view)).not.toContain("8h");
    expect(cardsIn(view)).not.toContain("7d");
    // Bot の判断材料: Public Action の履歴と、手番のときだけ Legal Action（全情報の State と一致）
    expect(view.actionHistory.map((a) => `${a.playerId}:${a.action}`)).toEqual([
      "utg:call",
      "btn:call",
      "sb:call",
      "bb:check",
    ]);
    expect(view.actorId).toBe("sb");
    expect(view.legalActions).toBeNull();
    expect(projectBotView(hand.events, "sb").legalActions).toEqual(
      getLegalActions(hand.state),
    );
  });

  it("Showdown: 公開された札は全員に見え、Fold した Player の札は誰にも見えない", () => {
    let hand = start();
    hand = act(hand, "utg", { type: "all_in" });
    hand = act(hand, "btn", { type: "fold" });
    hand = act(hand, "sb", { type: "fold" });
    hand = act(hand, "bb", { type: "call" });
    expect(hand.state.status).toBe("complete");
    for (const viewer of seats.map((s) => s.playerId)) {
      const view = projectHeroView(hand.events, viewer);
      const seen = cardsIn(view);
      // UTG と BB は All-in で公開済み。Board は 5 枚とも配られた。
      for (const c of ["Ac", "Ad", "4c", "4d", "Ks", "Qs", "9h", "8h", "7d"]) {
        expect(seen).toContain(c);
      }
      // Fold した BTN / SB の札は、本人以外に見えない。
      for (const [owner, cards] of [
        ["btn", "2c 2d"],
        ["sb", "3c 3d"],
      ] as const) {
        for (const c of cards.split(" ")) {
          expect(seen.includes(c)).toBe(viewer === owner);
        }
      }
      expect(view.awards).toEqual([{ playerId: "utg", amount: 401 }]);
    }
  });

  it("卓にいない Player の Projection は作らない", () => {
    const { events } = start();
    expect(() => projectHeroView(events, "stranger")).toThrow(RangeError);
    expect(() => projectBotView(events, "stranger")).toThrow(RangeError);
  });
});
