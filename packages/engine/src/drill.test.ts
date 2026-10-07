// Targeted Drill の Spot（#117・docs/07 §7・D105・D110・D116）の Scenario テスト。積んだ Deck で元の Hand を進め、
// 判断時点の Hero Information Set から作った Spot を Engine で検証する。
// - 同じ元の判断・同じ変形・同じ seed からは同じ Spot（決定論）
// - Spot は Hero に見えた情報だけから作る（元の Hand の他者の札・判断より後の Board を変えても Spot は変わらない。INV-TEST-007 に相当）
// - Engine の Validation（合法な Action・Chip の保存・Hero の手番に戻る）を通らない Spot は出さない
import { describe, expect, it } from "vitest";
import { cardToString, parseCards } from "./card.js";
import { buildDrillSpot, startDrillHand, type DrillSpot } from "./drill.js";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import {
  heroInformationSets,
  type HeroInformationSet,
} from "./hand-summary.js";
import type { HandState } from "./hand-state.js";
import type { PlayerAction } from "./legal-actions.js";
import { projectHeroView } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { stackedDeck } from "./testing/stacked-deck.js";

const seats: SeatInit[] = ["btn", "sb", "bb", "hero"].map((playerId) => ({
  playerId,
  stack: 200,
}));
const HERO = "hero";

interface Hand {
  state: HandState;
  events: HandEvent[];
}

/**
 * 元の Hand: Preflop は hero（UTG）が 6 に Raise、btn・sb が Fold、bb が Call（Pot 13）。
 * Flop で bb が 8 を Bet し、hero が Call（hero の判断 1）。Turn は 2 人とも Check（hero の判断 2）。
 */
function original(
  holes: Readonly<Record<string, string>>,
  board: string,
): HandEvent[] {
  const started = startHand({
    handId: "source",
    seats,
    buttonPlayerId: "btn",
    config: PHASE1_CASH_PRESET,
    deal: { deck: stackedDeck(seats, "btn", holes, board) },
  });
  if (!started.ok) throw new Error(started.error.message);
  let hand: Hand = {
    state: started.value.state,
    events: [...started.value.events],
  };
  const act = (playerId: string, action: PlayerAction) => {
    const result = applyAction(hand.state, playerId, action);
    if (!result.ok) throw new Error(result.error.message);
    hand = {
      state: result.value.state,
      events: [...hand.events, ...result.value.events],
    };
  };
  act("hero", { type: "raise", amount: 6 });
  act("btn", { type: "fold" });
  act("sb", { type: "fold" });
  act("bb", { type: "call" });
  act("bb", { type: "bet", amount: 8 });
  act("hero", { type: "call" });
  act("bb", { type: "check" });
  act("hero", { type: "check" });
  return hand.events;
}

const HOLES = { btn: "2c 2d", sb: "3c 3d", bb: "Kh Kd", hero: "Ac Qc" };
const BOARD = "Qs 9h 4d 8s 2h";

function infoSet(
  events: readonly HandEvent[],
  index: number,
): HeroInformationSet {
  const set = heroInformationSets(events, HERO)[index];
  if (set === undefined) throw new Error(`判断 ${index} が無い`);
  return set;
}

function spotOf(
  change: Parameters<typeof buildDrillSpot>[1],
  seed = 7,
  events: readonly HandEvent[] = original(HOLES, BOARD),
  index = 1,
): DrillSpot {
  const built = buildDrillSpot(infoSet(events, index), change, seed);
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

function start(spot: DrillSpot) {
  return startDrillHand({
    handId: "drill",
    sessionId: "drill-session",
    spot,
    config: PHASE1_CASH_PRESET,
  });
}

describe("buildDrillSpot / startDrillHand", () => {
  it("unchanged: Hero の札と判断時点の Board は元のまま、Script の後に同じ Street の Hero の手番になる", () => {
    const spot = spotOf({ kind: "unchanged" });
    const result = start(spot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = projectHeroView(result.value.events, HERO);
    expect(view.street).toBe("flop");
    expect(view.actorId).toBe(HERO);
    expect(view.board.map(cardToString)).toEqual(["Qs", "9h", "4d"]);
    expect(
      view.seats.find((s) => s.playerId === HERO)?.holeCards?.map(cardToString),
    ).toEqual(["Ac", "Qc"]);
    // 練習する判断は元の判断と同じ番号（Script の Hero の Action は 1 つ）。
    expect(spot.decisionIndex).toBe(1);
    // 通常の Hand と同じ Event の形で、専用の Session の開始を持つ。
    expect(
      result.value.events.some(
        (e) => e.type === "SESSION_STARTED" && e.sessionId === "drill-session",
      ),
    ).toBe(true);
    // Chip の保存（Stack と Pot の合計は開始時の合計のまま）。
    const total = result.value.state.players.reduce((s, p) => s + p.stack, 0);
    expect(total + result.value.state.pot).toBe(800);
  });

  it("同じ元の判断・同じ変形・同じ seed からは同じ Spot、seed を変えると相手の札と残りの Board だけが変わる", () => {
    const a = spotOf({ kind: "effective_stack", factor: 0.5 }, 11);
    const b = spotOf({ kind: "effective_stack", factor: 0.5 }, 11);
    expect(b).toEqual(a);
    const c = spotOf({ kind: "effective_stack", factor: 0.5 }, 12);
    expect(c.deck.map(cardToString)).not.toEqual(a.deck.map(cardToString));
    // Hero の札（配布順 sb・bb・hero・btn の 3 番目 = 位置 2 と 6）と Flop（位置 8〜10）は seed に依らない。
    for (const i of [2, 6, 8, 9, 10]) {
      expect(cardToString(c.deck[i] as never)).toBe(
        cardToString(a.deck[i] as never),
      );
    }
  });

  it("元の Hand の他者の札・判断より後の Board を変えても Spot は変わらない（Hero に見えた情報だけから作る）", () => {
    const other = original(
      { btn: "7c 7d", sb: "6c 6d", bb: "Jh Td", hero: "Ac Qc" },
      "Qs 9h 4d Ks Ad",
    );
    const a = spotOf({ kind: "unchanged" }, 3);
    const b = spotOf({ kind: "unchanged" }, 3, other);
    expect(b).toEqual(a);
    // 元の相手の札は Deck の残りとして seed で配り直すだけで、元の位置には置かない（偶然の一致は除く）。
    const bbOriginal = parseCards("Kh Kd").map(cardToString);
    const bbOrder = 1; // 配布は btn の左から sb(0)・bb(1)・hero(2)・btn(3)
    expect([
      cardToString(a.deck[bbOrder] as never),
      cardToString(a.deck[4 + bbOrder] as never),
    ]).not.toEqual(bbOriginal);
  });

  it("effective_stack: 開始時の全員の Stack を倍率で変え、Script はそのまま通る", () => {
    const spot = spotOf({ kind: "effective_stack", factor: 0.5 });
    expect(spot.seats.map((s) => s.stack)).toEqual([100, 100, 100, 100]);
    expect(spot.delta).toEqual({
      kind: "effective_stack",
      factor: 0.5,
      heroStackFrom: 200,
      heroStackTo: 100,
    });
    const result = start(spot);
    expect(result.ok).toBe(true);
  });

  it("effective_stack: Script の Action が Stack を超えて合法でなくなる Spot は Engine が通さない", () => {
    // Stack 4 では hero の 6 への Raise が出せない。
    const spot = spotOf({ kind: "effective_stack", factor: 0.02 });
    const result = start(spot);
    expect(result.ok).toBe(false);
  });

  it("bet_size: Hero が直面した最初の Bet の額を Pot の割合で変える", () => {
    const spot = spotOf({ kind: "bet_size", potFraction: 1.5 });
    // Bet の直前の Pot は 13（hero 6・bb 6・sb 1）。1.5 倍で 19.5 → 20。
    expect(spot.delta).toEqual({
      kind: "bet_size",
      potFraction: 1.5,
      bettorId: "bb",
      betFrom: 8,
      betTo: 20,
    });
    const result = start(spot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = projectHeroView(result.value.events, HERO);
    expect(view.actorId).toBe(HERO);
    expect(view.legalActions?.toCall).toBe(20);
  });

  it("bet_size: Bet に直面していない判断（Preflop・Check で回った Street）には当てない", () => {
    const events = original(HOLES, BOARD);
    expect(
      buildDrillSpot(
        infoSet(events, 0),
        { kind: "bet_size", potFraction: 0.75 },
        1,
      ).ok,
    ).toBe(false);
    expect(
      buildDrillSpot(
        infoSet(events, 2),
        { kind: "bet_size", potFraction: 0.75 },
        1,
      ).ok,
    ).toBe(false);
  });

  it("Rule Profile が今の卓と違う元の Hand からは始めない", () => {
    const spot = spotOf({ kind: "unchanged" });
    const result = startDrillHand({
      handId: "drill",
      sessionId: "s",
      spot,
      config: { ...PHASE1_CASH_PRESET, ruleProfile: "other_profile" },
    });
    expect(result.ok).toBe(false);
  });
});
