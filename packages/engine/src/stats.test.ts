// Stats Projection の固定 Scenario テスト（#112・docs/07 §3・D103・D116）。
// 積んだ Deck で 3 人卓の Hand を進め、指標ごとの Numerator / Denominator / Opportunity Count を手計算の期待値と比べる。
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  recordAiEvent,
  recordSessionEvent,
  startHand,
} from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import type { PlayerAction } from "./legal-actions.js";
import {
  STAT_DEFINITIONS,
  STATS_DEFINITION_VERSION,
  projectPlayerStats,
  toStatsHand,
  type PlayerStats,
  type StatValue,
} from "./stats.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { stackedDeck } from "./testing/stacked-deck.js";
import {
  collectCards,
  hiddenMarkers,
  tamperHiddenEvents,
} from "./testing/view-leaks.js";

// 3 人卓（席順 btn → sb → bb）。SB 1・BB 2（PHASE1_CASH_PRESET）。Preflop は btn から、Postflop は sb から。
const three: SeatInit[] = ["btn", "sb", "bb"].map((playerId) => ({
  playerId,
  stack: 200,
}));
const holes = { btn: "As Ad", sb: "Kc Kd", bb: "Qh Qs" };
const board = "2c 7d 9s Jh 3c";

interface Hand {
  state: HandState;
  events: HandEvent[];
}

function start(handId: string, seats: SeatInit[] = three): Hand {
  const button = (seats[0] as SeatInit).playerId;
  const result = startHand({
    handId,
    seats,
    buttonPlayerId: button,
    config: PHASE1_CASH_PRESET,
    deal: {
      deck: stackedDeck(seats, button, seats === three ? holes : {}, board),
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return { state: result.value.state, events: [...result.value.events] };
}

function play(
  handId: string,
  steps: readonly [string, PlayerAction][],
  seats: SeatInit[] = three,
): HandEvent[] {
  let hand = start(handId, seats);
  for (const [playerId, action] of steps) {
    const result = applyAction(hand.state, playerId, action);
    if (!result.ok) throw new Error(`${playerId}: ${result.error.message}`);
    hand = {
      state: result.value.state,
      events: [...hand.events, ...result.value.events],
    };
  }
  return hand.events;
}

const fold: PlayerAction = { type: "fold" };
const check: PlayerAction = { type: "check" };
const call: PlayerAction = { type: "call" };
const raise = (amount: number): PlayerAction => ({ type: "raise", amount });
const bet = (amount: number): PlayerAction => ({ type: "bet", amount });

// H1: btn Open → sb Fold → bb 3-bet → btn Fold（Preflop で決着）。
const threeBetFold = () =>
  play("h1", [
    ["btn", raise(6)],
    ["sb", fold],
    ["bb", raise(18)],
    ["btn", fold],
  ]);
// H2: btn Open → sb Fold → bb Call。Flop: bb Check → btn Continuation Bet → bb Fold。
const cbetFold = () =>
  play("h2", [
    ["btn", raise(6)],
    ["sb", fold],
    ["bb", call],
    ["bb", check],
    ["btn", bet(6)],
    ["bb", fold],
  ]);
// H3: Walk（btn・sb が Fold し、bb は Action しないまま勝つ）。
const walk = () =>
  play("h3", [
    ["btn", fold],
    ["sb", fold],
  ]);
// H4: Limp の Pot。Flop: sb Bet → bb Call → btn Raise → sb Fold → bb Call。Turn: 両者 Check。River: bb Bet → btn Call（Showdown）。
const limpedShowdown = () =>
  play("h4", [
    ["btn", call],
    ["sb", call],
    ["bb", check],
    ["sb", bet(2)],
    ["bb", call],
    ["btn", raise(8)],
    ["sb", fold],
    ["bb", call],
    ["bb", check],
    ["btn", check],
    ["bb", bet(4)],
    ["btn", call],
  ]);

const v = (
  numerator: number,
  denominator: number,
  opportunities = denominator,
): StatValue => ({ numerator, denominator, opportunities });
const none = v(0, 0);

function player(
  stats: ReturnType<typeof projectPlayerStats>,
  id: string,
): PlayerStats {
  const p = stats.players.find((s) => s.playerId === id);
  if (p === undefined) throw new Error(`${id} の Stats が無い`);
  return p;
}

describe("projectPlayerStats（固定 Scenario・手計算の期待値）", () => {
  const all = () => [threeBetFold(), cbetFold(), walk(), limpedShowdown()];

  it("4 Hand の btn の指標（Open・Fold to 3-bet・Continuation Bet・Postflop の Aggression）", () => {
    const btn = player(projectPlayerStats(all()), "btn");
    expect(btn.hands).toBe(4);
    expect(btn.overall).toEqual({
      // H1・H2 で Raise、H4 で Limp（Call）、H3 で Fold → 3/4。Raise は H1・H2 → 2/4。
      vpip: v(3, 4),
      pfr: v(2, 4),
      // btn は H1・H2 の Open した本人で、H3・H4 には Open が無い → 機会なし。
      three_bet: none,
      // H1 で 3-bet に直面して Fold。
      fold_to_three_bet: v(1, 1),
      // H2 の Preflop Aggressor で、Flop で誰も Bet していない時点で Bet。
      cbet_flop: v(1, 1),
      fold_to_cbet_flop: none,
      // H2 Flop Bet・H4 Flop Raise・H4 River Call（Check は数えない）→ 2/3。
      aggression_frequency: v(2, 3),
      // Bet / Raise 2 回・Call 1 回。機会は 3。
      aggression_factor: v(2, 1, 3),
    });
    // Street 別: Flop は Bet・Raise の 2/2、River は Call の 0/1。Preflop の指標は Preflop に入る。
    expect(btn.byStreet.flop.aggression_frequency).toEqual(v(2, 2));
    expect(btn.byStreet.river.aggression_frequency).toEqual(v(0, 1));
    expect(btn.byStreet.turn.aggression_frequency).toEqual(none);
    expect(btn.byStreet.preflop.vpip).toEqual(v(3, 4));
    expect(btn.byStreet.flop.vpip).toEqual(none);
    // Position 別: btn は常に BTN。
    expect(btn.byPosition.BTN).toEqual(btn.overall);
    expect(btn.byPosition.SB.vpip).toEqual(none);
  });

  it("4 Hand の sb・bb の指標（3-bet の機会・Walk を VPIP の機会に入れない・Fold to Continuation Bet）", () => {
    const stats = projectPlayerStats(all());
    const sb = player(stats, "sb");
    expect(sb.hands).toBe(4);
    expect(sb.overall).toEqual({
      // H4 の Complete（Call）だけ。
      vpip: v(1, 4),
      pfr: v(0, 4),
      // H1・H2 で btn の Open に直面して Fold。H3・H4 は Open が無い。
      three_bet: v(0, 2),
      fold_to_three_bet: none,
      cbet_flop: none,
      fold_to_cbet_flop: none,
      // H4 Flop の Bet と Fold → 1/2。
      aggression_frequency: v(1, 2),
      // Fold は Aggression Factor に数えない。
      aggression_factor: v(1, 0, 1),
    });
    expect(sb.byPosition.SB).toEqual(sb.overall);

    const bb = player(stats, "bb");
    expect(bb.hands).toBe(4);
    expect(bb.overall).toEqual({
      // H3 は Walk で Action していないので機会に入れない。H1 3-bet・H2 Call → 2/3。H4 は Check だけ。
      vpip: v(2, 3),
      pfr: v(1, 3),
      // H1 で 3-bet、H2 で Call → 1/2。
      three_bet: v(1, 2),
      fold_to_three_bet: none,
      cbet_flop: none,
      // H2 で btn の Continuation Bet に Fold（その前の Check は機会ではない）。
      fold_to_cbet_flop: v(1, 1),
      // H2 Flop Fold・H4 Flop Call 2 回・River Bet → 1/4。
      aggression_frequency: v(1, 4),
      // H4 の River Bet 1 回・Flop Call 2 回。
      aggression_factor: v(1, 2, 3),
    });
  });

  it("全体の版と Hand 数を返し、Player は playerId の昇順", () => {
    const stats = projectPlayerStats(all());
    expect(stats.version).toBe(STATS_DEFINITION_VERSION);
    expect(stats.handCount).toBe(4);
    expect(stats.players.map((p) => p.playerId)).toEqual(["bb", "btn", "sb"]);
  });

  it("6 人卓の Position（UTG・HJ・CO・BTN・SB・BB）で集計する", () => {
    const six: SeatInit[] = ["b", "s", "bb", "u", "h", "c"].map((playerId) => ({
      playerId,
      stack: 200,
    }));
    // Button は b。u が Open し、全員 Fold。
    const events = play(
      "six",
      [
        ["u", raise(6)],
        ["h", fold],
        ["c", raise(18)],
        ["b", fold],
        ["s", fold],
        ["bb", fold],
        ["u", fold],
      ],
      six,
    );
    const stats = projectPlayerStats([events]);
    expect(player(stats, "u").byPosition.UTG.pfr).toEqual(v(1, 1));
    expect(player(stats, "u").byPosition.UTG.fold_to_three_bet).toEqual(
      v(1, 1),
    );
    expect(player(stats, "h").byPosition.HJ.three_bet).toEqual(v(0, 1));
    expect(player(stats, "c").byPosition.CO.three_bet).toEqual(v(1, 1));
    // c の 3-bet の後の b・s・bb は Raise 2 回に直面しているので 3-bet の機会ではない。
    expect(player(stats, "b").byPosition.BTN.three_bet).toEqual(none);
    expect(player(stats, "s").byPosition.SB.vpip).toEqual(v(0, 1));
    expect(player(stats, "bb").byPosition.BB.vpip).toEqual(v(0, 1));
  });

  it("除外する handId（D116: Drill の Hand）を集計に入れない", () => {
    const stats = projectPlayerStats(all(), {
      excludeHandIds: new Set(["h1"]),
    });
    expect(stats.handCount).toBe(3);
    const btn = player(stats, "btn");
    expect(btn.hands).toBe(3);
    expect(btn.overall.fold_to_three_bet).toEqual(none);
    expect(btn.overall.vpip).toEqual(v(2, 3));
    // 除外は Hand を渡さないのと同じ結果になる。
    expect(stats).toEqual(
      projectPlayerStats([cbetFold(), walk(), limpedShowdown()]),
    );
  });

  it("HAND_FINISHED まで済んでいない Hand（進行中・打ち切り）は集計に入れない", () => {
    const inProgress = play("p1", [["btn", raise(6)]]);
    const aborting = start("p2");
    const aborted = recordSessionEvent(aborting.state, {
      type: "HAND_ABORTED",
      reason: "ai_outage",
    });
    expect(toStatsHand(inProgress)).toBeNull();
    expect(toStatsHand([...aborting.events, ...aborted.events])).toBeNull();
    const stats = projectPlayerStats([
      inProgress,
      [...aborting.events, ...aborted.events],
    ]);
    expect(stats.handCount).toBe(0);
    expect(stats.players).toEqual([]);
  });

  it("HAND_STARTED の無い終わった Hand は読み飛ばさずに失敗する", () => {
    const events = walk().filter((e) => e.type !== "HAND_STARTED");
    expect(() => projectPlayerStats([events])).toThrow(RangeError);
  });

  it("全指標の定義が 1 か所にあり、id が重複しない", () => {
    const ids = STAT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const btn = player(projectPlayerStats([walk()]), "btn");
    expect(Object.keys(btn.overall).sort()).toEqual([...ids].sort());
  });
});

describe("projectPlayerStats の情報境界（INV-TEST-007 に相当）", () => {
  it("Hole Cards・Deck・system の Event を差し替えても結果が変わらず、Card も hidden の印も出ない", () => {
    // H4 に CPU の判断の経緯（system）を足した Hand。
    let hand = start("leak");
    const add = (r: { state: HandState; events: readonly HandEvent[] }) => {
      hand = { state: r.state, events: [...hand.events, ...r.events] };
    };
    add(
      recordSessionEvent(hand.state, {
        type: "SESSION_STARTED",
        sessionId: "s",
      }),
    );
    add(
      recordAiEvent(hand.state, {
        type: "AI_ACTION_INVALID",
        playerId: "btn",
        attempt: 1,
        stage: "schema",
        reason: "As Ad を持っている",
      }),
    );
    for (const [playerId, action] of [
      ["btn", raise(6)],
      ["sb", fold],
      ["bb", call],
      ["bb", check],
      ["btn", bet(6)],
      ["bb", fold],
    ] as const) {
      const r = applyAction(hand.state, playerId, action);
      if (!r.ok) throw new Error(r.error.message);
      add(r.value);
    }
    const original = projectPlayerStats([hand.events]);
    // どの viewer にも見えない（public でない）Event の中身を全部差し替える。
    const tampered = tamperHiddenEvents(hand.events, "__no_viewer__");
    expect(tampered).not.toEqual(hand.events);
    expect(projectPlayerStats([tampered])).toEqual(original);
    expect(collectCards(original)).toEqual([]);
    expect(hiddenMarkers(original)).toEqual([]);
  });
});
