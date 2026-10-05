// Projection の情報境界テスト（INV-TEST-007 の Engine 側・docs/02 §2 INV-INFO-001・D28）。
// 他者の Hole Cards と未配布の Board に「マーカー」の Card を積み、View を丸ごと走査して出てこないことを確かめる。
import { describe, expect, it } from "vitest";
import { cardToString, parseCards } from "./card.js";
import { isVisibleTo, type HandEvent, type SeatInit } from "./hand-events.js";
import { applyAction, recordAiEvent, startHand } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import {
  projectKnowledgeState,
  projectHeroView,
  visibleEvents,
} from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { collectCards, hiddenMarkers } from "./testing/view-leaks.js";
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
        projectKnowledgeState(events, viewer),
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
    const view = projectKnowledgeState(hand.events, "bb");
    expect(view.board.map(cardToString)).toEqual(["Ks", "Qs", "9h"]);
    expect(cardsIn(view)).not.toContain("8h");
    expect(cardsIn(view)).not.toContain("7d");
    // CPU の判断材料: Public Action の履歴と、手番のときだけ Legal Action（全情報の State と一致）
    expect(view.actionHistory.map((a) => `${a.playerId}:${a.action}`)).toEqual([
      "utg:call",
      "btn:call",
      "sb:call",
      "bb:check",
    ]);
    expect(view.actorId).toBe("sb");
    expect(view.legalActions).toBeNull();
    expect(projectKnowledgeState(hand.events, "sb").legalActions).toEqual(
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

  it("KnowledgeState: 自分の札・Position・決定論の Math を持つ（開始直後）", () => {
    const { events } = start();
    // UTG（手番）: BB の 2 を Call する。Pot は Blind の 3。
    const utg = projectKnowledgeState(events, "utg");
    expect(utg.holeCards?.map(cardToString)).toEqual(["Ac", "Ad"]);
    expect(utg.position).toEqual({ buttonOffset: 3, playerCount: 4 });
    expect(utg.math).toEqual({
      callAmount: 2,
      potOdds: 2 / 5,
      effectiveStack: 200,
      spr: 200 / 3,
    });
    // BB（手番ではない）: もう BB を出しているので Call 額は 0。有効 Stack は自分の残り 198 で頭打ち。
    const bb = projectKnowledgeState(events, "bb");
    expect(bb.position).toEqual({ buttonOffset: 2, playerCount: 4 });
    expect(bb.legalActions).toBeNull();
    expect(bb.math).toEqual({
      callAmount: 0,
      potOdds: null,
      effectiveStack: 198,
      spr: 198 / 3,
    });
  });

  it("KnowledgeState: Call 額は Stack で頭打ちになり、有効 Stack は Fold していない他者の残りで決まる", () => {
    let hand = start();
    hand = act(hand, "utg", { type: "all_in" });
    hand = act(hand, "btn", { type: "fold" });
    // SB の残りは 199。UTG の 200 には届かないので Call 額は 199（All-in の Call）。
    const sb = projectKnowledgeState(hand.events, "sb");
    expect(sb.math.callAmount).toBe(199);
    expect(sb.math.potOdds).toBe(199 / (203 + 199));
    // Fold した BTN（200）は数えず、残りが 0 の UTG と BB（198）のうち大きい方と自分の 199 の小さい方。
    expect(sb.math.effectiveStack).toBe(198);
    expect(sb.math.spr).toBe(198 / 203);
    expect(sb.legalActions?.actions.find((a) => a.type === "call")).toEqual({
      type: "call",
      amount: 199,
    });
  });

  describe("CPU の判断の経緯（AI_ACTION_INVALID / AI_FALLBACK_USED。D83）", () => {
    /** UTG（最初の手番）の不正な出力 2 回と自動 Fallback を記録し、Fallback の Action まで進める。 */
    function withAiRecords() {
      const hand = start();
      const reason =
        'action は fold / check / call / bet / raise / all_in のどれか: "secret-raw-output"';
      const first = recordAiEvent(hand.state, {
        type: "AI_ACTION_INVALID",
        playerId: "utg",
        attempt: 1,
        stage: "schema",
        reason,
      });
      const second = recordAiEvent(first.state, {
        type: "AI_ACTION_INVALID",
        playerId: "utg",
        attempt: 2,
        stage: "schema",
        reason,
      });
      const used = recordAiEvent(second.state, {
        type: "AI_FALLBACK_USED",
        playerId: "utg",
        fallbackKind: "automatic",
        reason: `schema: ${reason}`,
      });
      const recorded = {
        state: used.state,
        events: [
          ...hand.events,
          ...first.events,
          ...second.events,
          ...used.events,
        ],
      };
      return {
        before: hand,
        recorded,
        after: act(recorded, "utg", { type: "fold" }),
      };
    }

    it("記録は system Visibility で seq だけを進め、卓の State（Chip・手番・Legal Action）は変えない", () => {
      const { before, recorded, after } = withAiRecords();
      const ai = recorded.events.slice(before.events.length);
      expect(ai.map((e) => [e.type, e.seq])).toEqual([
        ["AI_ACTION_INVALID", before.events.length],
        ["AI_ACTION_INVALID", before.events.length + 1],
        ["AI_FALLBACK_USED", before.events.length + 2],
      ]);
      expect(ai.every((e) => e.visibility.type === "system")).toBe(true);
      expect({ ...recorded.state, nextSeq: 0 }).toEqual({
        ...before.state,
        nextSeq: 0,
      });
      expect(recorded.state.nextSeq).toBe(before.state.nextSeq + 3);
      expect(getLegalActions(recorded.state)).toEqual(
        getLegalActions(before.state),
      );
      // 畳み込みでも同じ State になり、Fallback の Action は記録の直後の seq に入る。
      expect(foldHandEvents(recorded.events)).toEqual(recorded.state);
      expect(after.events[recorded.events.length]).toMatchObject({
        type: "ACTION_TAKEN",
        playerId: "utg",
        seq: before.events.length + 3,
      });
    });

    it("記録は Hero のログと全員（記録された CPU 本人を含む）の Projection に入らず、中身を変えても Projection は同じ", () => {
      const { before, after } = withAiRecords();
      // 記録を除いて同じ Action を適用した Log（seq だけが違う）。
      const plain = act(before, "utg", { type: "fold" });
      for (const viewer of seats.map((s) => s.playerId)) {
        const hero = projectHeroView(after.events, viewer);
        const knowledge = projectKnowledgeState(after.events, viewer);
        expect(hero.log.some((e) => e.visibility.type === "system")).toBe(
          false,
        );
        for (const view of [hero, knowledge]) {
          expect(hiddenMarkers(view)).toEqual([]);
          expect(JSON.stringify(view)).not.toContain("secret-raw-output");
        }
        expect(knowledge).toEqual(projectKnowledgeState(plain.events, viewer));
        const tampered = after.events.map((e) =>
          e.type === "AI_ACTION_INVALID" || e.type === "AI_FALLBACK_USED"
            ? { ...e, reason: "別の理由", stage: "amount_range" as const }
            : e,
        );
        expect(projectKnowledgeState(tampered, viewer)).toEqual(knowledge);
        expect(projectHeroView(tampered, viewer)).toEqual(hero);
        expect(
          isVisibleTo(after.events[before.events.length] as HandEvent, viewer),
        ).toBe(false);
      }
    });

    it("手番でない Player・終わった Hand の記録は呼び出し側の誤りとして投げる", () => {
      const hand = start();
      expect(() =>
        recordAiEvent(hand.state, {
          type: "AI_FALLBACK_USED",
          playerId: "btn",
          fallbackKind: "automatic",
          reason: "x",
        }),
      ).toThrow(RangeError);
      let done = act(hand, "utg", { type: "fold" });
      done = act(done, "btn", { type: "fold" });
      done = act(done, "sb", { type: "fold" });
      expect(done.state.status).toBe("complete");
      expect(() =>
        recordAiEvent(done.state, {
          type: "AI_ACTION_INVALID",
          playerId: "bb",
          attempt: 1,
          stage: "schema",
          reason: "x",
        }),
      ).toThrow(RangeError);
    });
  });

  it("卓にいない Player の Projection は作らない", () => {
    const { events } = start();
    expect(() => projectHeroView(events, "stranger")).toThrow(RangeError);
    expect(() => projectKnowledgeState(events, "stranger")).toThrow(RangeError);
  });
});
