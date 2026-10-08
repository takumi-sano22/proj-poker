// Hand Summary Projection・判断時点の Hero Information Set・Important Spot・Learning-only Full Reveal の Scenario テスト
// （#78・docs/05 §7・docs/04 §1・INV-TEST-007 / 008 に相当）。積んだ Deck で Hand を進め、値を固定で確かめる。
import { describe, expect, it } from "vitest";
import { cardToString, parseCards } from "./card.js";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  recordAiEvent,
  recordSessionEvent,
  resolvePendingOutOfTurn,
  startHand,
} from "./hand-engine.js";
import {
  DEFAULT_IMPORTANT_SPOT_RULES,
  heroDecisions,
  heroInformationSets,
  projectHandSummary,
  type HeroInformationSet,
} from "./hand-summary.js";
import type { HandState } from "./hand-state.js";
import { projectLearningReveal } from "./learning-reveal.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import { projectKnowledgeState, visibleEvents } from "./projection.js";
import type { PhysicalAction } from "./ruling.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  checkHand,
  COVERAGE_KINDS,
  type CoverageKind,
} from "./testing/hand-summary-checks.js";
import { collectCards, hiddenMarkers } from "./testing/view-leaks.js";
import { stackedDeck } from "./testing/stacked-deck.js";

const seats: SeatInit[] = ["btn", "sb", "bb", "utg"].map((playerId) => ({
  playerId,
  stack: 200,
}));
const holes = { btn: "2c 2d", sb: "3c 3d", bb: "4c 4d", utg: "Ac Ad" };
const board = "Ks Qs 9h 8h 7d";

interface Hand {
  state: HandState;
  events: HandEvent[];
}

function start(boardCards: string = board): Hand {
  const result = startHand({
    handId: "summary",
    seats,
    buttonPlayerId: "btn",
    config: PHASE1_CASH_PRESET,
    deal: { deck: stackedDeck(seats, "btn", holes, boardCards) },
  });
  if (!result.ok) throw new Error(result.error.message);
  return { state: result.value.state, events: [...result.value.events] };
}

function act(hand: Hand, playerId: string, action: PlayerAction): Hand {
  const result = applyAction(hand.state, playerId, action);
  if (!result.ok) throw new Error(result.error.message);
  return {
    state: result.value.state,
    events: [...hand.events, ...result.value.events],
  };
}

function physical(
  hand: Hand,
  playerId: string,
  actions: PhysicalAction[],
): Hand {
  const result = applyPhysicalActions(
    hand.state,
    playerId,
    actions,
    PHASE1_CASH_PRESET,
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    state: result.value.state,
    events: [...hand.events, ...result.value.events],
  };
}

/** 引数の順に Action を適用する（[Player, Action] の列）。 */
function play(hand: Hand, steps: [string, PlayerAction][]): Hand {
  return steps.reduce((h, [p, a]) => act(h, p, a), hand);
}

const call: PlayerAction = { type: "call" };
const check: PlayerAction = { type: "check" };
const fold: PlayerAction = { type: "fold" };
const cardsIn = (value: unknown) => collectCards(value).map(cardToString);

/** utg（AA）が Preflop に Raise、Flop に Bet、Turn に Check、River に Bet し、btn（22）と Showdown する。 */
function fullHand(boardCards: string = board): Hand {
  return play(start(boardCards), [
    ["utg", { type: "raise", amount: 6 }],
    ["btn", call],
    ["sb", fold],
    ["bb", call],
    // Flop: Ks Qs 9h（Pot 19）
    ["bb", check],
    ["utg", { type: "bet", amount: 10 }],
    ["btn", call],
    ["bb", fold],
    // Turn: 8h（Pot 39）
    ["utg", check],
    ["btn", check],
    // River: 7d
    ["utg", { type: "bet", amount: 30 }],
    ["btn", call],
  ]);
}

describe("Hero の判断と判断時点の Information Set", () => {
  it("Hero の ACTION_TAKEN ごとに判断を作り、判断時点は直前に Hero に見えていた Event", () => {
    const { events } = fullHand();
    const decisions = heroDecisions(events, "utg");
    expect(
      decisions.map((d) => `${d.street}:${d.action}:${d.toAmount}`),
    ).toEqual([
      "preflop:raise:6",
      "flop:bet:10",
      "turn:check:0",
      "river:bet:30",
    ]);
    const visible = visibleEvents(events, "utg");
    for (const d of decisions) {
      const i = visible.findIndex((e) => e.seq === d.actionSeq);
      expect(visible[i]).toMatchObject({
        type: "ACTION_TAKEN",
        playerId: "utg",
      });
      // 物理的な操作をしていない判断では、判断時点は ACTION_TAKEN の 1 つ前の見える Event。
      expect(d.decisionPointSeq).toBe(visible[i - 1]?.seq);
      expect(d.rulingNotes).toEqual([]);
    }
  });

  it("判断時点の Information Set には、その時点までに Hero に見えた Event だけが入る（未来の Board・他者の札・結果が無い）", () => {
    const { events } = fullHand();
    const sets = heroInformationSets(events, "utg");
    const boards = sets.map((s) => s.knowledge.board.map(cardToString));
    expect(boards).toEqual([
      [],
      ["Ks", "Qs", "9h"],
      ["Ks", "Qs", "9h", "8h"],
      ["Ks", "Qs", "9h", "8h", "7d"],
    ]);
    for (const set of sets) {
      // 判断時点の卓: Hero が手番で、Legal Action がある。判断した Action はまだ入っていない。
      expect(set.knowledge.actorId).toBe("utg");
      expect(set.knowledge.legalActions?.playerId).toBe("utg");
      expect(set.events.at(-1)?.seq).toBe(set.decision.decisionPointSeq);
      expect(set.events.every((e) => e.seq < set.decision.actionSeq)).toBe(
        true,
      );
      // Hero の札と公開 Board 以外の Card が無い（他者の札・Turn / River の先の Card・Deck）。
      const allowed = new Set([
        ...parseCards(holes.utg).map(cardToString),
        ...set.knowledge.board.map(cardToString),
      ]);
      expect(cardsIn(set).filter((c) => !allowed.has(c))).toEqual([]);
      expect(hiddenMarkers(set)).toEqual([]);
      for (const type of ["CARDS_TABLED", "POT_AWARDED", "HAND_FINISHED"]) {
        expect(set.events.some((e) => e.type === type)).toBe(false);
      }
    }
    // River の判断時点の Pot・Call 額（判断時点の Math）。
    expect(sets[3]?.knowledge.pot).toBe(39);
    expect(sets[3]?.knowledge.math.callAmount).toBe(0);
  });

  it("River の Card だけを入れ替えても、Turn までの判断の Information Set は変わらない（Hindsight を読まない）", () => {
    const original = heroInformationSets(fullHand().events, "utg");
    const swapped = heroInformationSets(
      fullHand("Ks Qs 9h 8h 2s").events,
      "utg",
    );
    expect(swapped.slice(0, 3)).toEqual(original.slice(0, 3));
    expect(swapped[3]?.knowledge.board.map(cardToString).at(-1)).toBe("2s");
  });

  it("判断より後の Event を切り落としても、Information Set は変わらない（Hindsight を読まない）", () => {
    const { events } = fullHand();
    const sets = heroInformationSets(events, "utg");
    for (const set of sets) {
      const upToAction = events.filter((e) => e.seq <= set.decision.actionSeq);
      const truncated = heroInformationSets(upToAction, "utg");
      expect(truncated[set.decision.index]).toEqual(set);
    }
  });

  it("Hero の宣言・Chip の操作・裁定は判断に属し、判断時点の情報には入らない（裁定の理由は判断に残る）", () => {
    // utg が宣言なしで 5 を 1 枚出す → Oversized Chip で Call（D91）。
    let hand = physical(start(), "utg", [{ type: "chip_push", chips: [5] }]);
    // btn は Bet に直面して Check を宣言 → Action を決めない裁定 → 選び直して Call。
    hand = physical(hand, "btn", [
      { type: "declare", declaration: { kind: "check" } },
    ]);
    hand = act(hand, "btn", call);
    const [utgSet] = heroInformationSets(hand.events, "utg");
    const [btnSet] = heroInformationSets(hand.events, "btn");
    expect(utgSet?.decision).toMatchObject({
      action: "call",
      rulingNotes: ["oversized_chip"],
    });
    expect(btnSet?.decision).toMatchObject({
      action: "call",
      rulingNotes: ["check_facing_bet"],
    });
    for (const [set, hero] of [
      [utgSet, "utg"],
      [btnSet, "btn"],
    ] as const) {
      // 判断時点は、自分の最初の操作の前（手番が来た時点）。
      expect(set?.knowledge.actorId).toBe(hero);
      expect(
        set?.events.some(
          (e) =>
            (e.type === "PLAYER_DECLARED" ||
              e.type === "PHYSICAL_CHIP_ACTION" ||
              e.type === "DEALER_RULING") &&
            e.playerId === hero,
        ),
      ).toBe(false);
    }
    // 他者（utg）の操作と裁定は、btn にとって手番より前の公開の出来事なので入る。
    expect(btnSet?.knowledge.rulingHistory?.map((r) => r.playerId)).toEqual([
      "utg",
    ]);
  });

  it("Out-of-Turn で保留した操作は手番より前の出来事として残り、手番での拘束の裁定が判断に属する", () => {
    // utg の手番に btn が Call を宣言（Out-of-Turn で保留）→ utg Call → btn の手番で拘束して Call。
    let hand = physical(start(), "btn", [
      { type: "declare", declaration: { kind: "call" } },
    ]);
    hand = act(hand, "utg", call);
    const resolved = resolvePendingOutOfTurn(hand.state, PHASE1_CASH_PRESET);
    if (!resolved.ok) throw new Error(resolved.error.message);
    hand = {
      state: resolved.value.state,
      events: [...hand.events, ...resolved.value.events],
    };
    const [set] = heroInformationSets(hand.events, "btn");
    expect(set?.decision.rulingNotes).toContain("out_of_turn_binding");
    // 判断時点は utg の Call の直後（btn の手番が来た時点）。
    const utgCall = hand.events.find(
      (e) => e.type === "ACTION_TAKEN" && e.playerId === "utg",
    );
    expect(set?.decision.decisionPointSeq).toBe(utgCall?.seq);
    expect(set?.knowledge.rulingHistory?.map((r) => r.outcome)).toEqual([
      "out_of_turn",
    ]);
  });
});

describe("Important Spot", () => {
  it("All-in に直面した判断は all_in（判断時点の Pot が大きければ big_pot も）", () => {
    const hand = play(start(), [
      ["utg", { type: "all_in" }],
      ["btn", fold],
      ["sb", fold],
      ["bb", call],
    ]);
    const summary = projectHandSummary(hand.events, "bb");
    expect(summary.importantSpots).toEqual([
      {
        decisionIndex: 0,
        street: "preflop",
        actionSeq: summary.heroDecisions[0]?.actionSeq,
        decisionPointSeq: summary.heroDecisions[0]?.decisionPointSeq,
        reasons: ["big_pot", "all_in"],
      },
    ]);
    // All-in した側も all_in（Pot はまだ小さい）。
    expect(
      projectHandSummary(hand.events, "utg").importantSpots.map(
        (s) => s.reasons,
      ),
    ).toEqual([["all_in"]]);
  });

  it("River で 3/4 Pot 以上の Bet に直面した判断は river_big_bet、Half Pot の Bet は拾わない", () => {
    const limped: [string, PlayerAction][] = [
      ["utg", call],
      ["btn", call],
      ["sb", call],
      ["bb", check],
      ...(["flop", "turn"] as const).flatMap(() =>
        ["sb", "bb", "utg", "btn"].map((p): [string, PlayerAction] => [
          p,
          check,
        ]),
      ),
      ["sb", check],
      ["bb", check],
    ];
    // Pot 8 に utg が 8（Pot Size）→ btn の Pot Odds 8 / 24 ≒ 0.33。
    const pot = play(start(), [...limped, ["utg", { type: "bet", amount: 8 }]]);
    const potSpots = projectHandSummary(
      act(pot, "btn", call).events,
      "btn",
    ).importantSpots;
    expect(potSpots.map((s) => [s.street, s.reasons])).toEqual([
      ["river", ["river_big_bet"]],
    ]);
    // Pot 8 に utg が 4（Half Pot）→ btn の Pot Odds 4 / 16 = 0.25。
    const half = play(start(), [
      ...limped,
      ["utg", { type: "bet", amount: 4 }],
    ]);
    expect(
      projectHandSummary(act(half, "btn", call).events, "btn").importantSpots,
    ).toEqual([]);
  });

  it("Dealer の裁定が入った判断は ruling", () => {
    const hand = physical(start(), "utg", [{ type: "chip_push", chips: [5] }]);
    expect(
      projectHandSummary(hand.events, "utg").importantSpots.map(
        (s) => s.reasons,
      ),
    ).toEqual([["ruling"]]);
  });

  it("しきい値は規則として渡せ、同じ Event と規則からは同じ結果になる（決定論）", () => {
    const { events } = fullHand();
    // 既定（20BB）では、この Hand の Pot（最大 39）は大きい Pot に届かない。
    expect(projectHandSummary(events, "utg").importantSpots).toEqual([]);
    const rules = { ...DEFAULT_IMPORTANT_SPOT_RULES, bigPotBb: 10 };
    const spots = projectHandSummary(events, "utg", rules).importantSpots;
    expect(spots.map((s) => [s.street, s.reasons])).toEqual([
      ["turn", ["big_pot"]],
      ["river", ["big_pot"]],
    ]);
    expect(projectHandSummary(events, "utg", rules).importantSpots).toEqual(
      spots,
    );
  });
});

describe("Hand Summary Projection", () => {
  it("結果・Pot・Showdown・Hero の判断の一覧を Hero に見える Event から作る", () => {
    const { events } = fullHand();
    const summary = projectHandSummary(events, "utg");
    expect(summary).toMatchObject({
      handId: "summary",
      heroId: "utg",
      bigBlind: 2,
      buttonPlayerId: "btn",
      outcome: "complete",
      totalPot: 99,
      // utg は 6 + 10 + 30 = 46 を出し、99 を受け取る。
      heroNet: 53,
    });
    expect(summary.board.map(cardToString)).toEqual(board.split(" "));
    expect(summary.pots).toEqual([
      {
        potIndex: 0,
        potTotal: 99,
        eligible: ["utg", "btn"],
        awards: [{ playerId: "utg", amount: 99 }],
        showdown: true,
      },
    ]);
    expect(summary.showdown.map((s) => s.playerId)).toContain("utg");
    expect(summary.heroDecisions).toHaveLength(4);
    const total = (stacks: readonly { amount: number }[]) =>
      stacks.reduce((a, s) => a + s.amount, 0);
    expect(total(summary.finalStacks ?? [])).toBe(800);
    // 公開されなかった札（Fold した sb・bb の札）は Summary に入らない。
    for (const c of [...parseCards(holes.sb), ...parseCards(holes.bb)]) {
      expect(cardsIn(summary)).not.toContain(cardToString(c));
    }
    expect(hiddenMarkers(summary)).toEqual([]);
  });

  it("system の Event（CPU の判断の経緯・Session の記録）があっても Summary と Information Set に入らない", () => {
    let hand = start();
    const session = recordSessionEvent(hand.state, {
      type: "SESSION_STARTED",
      sessionId: "s1",
    });
    hand = {
      state: session.state,
      events: [...hand.events, ...session.events],
    };
    const invalid = recordAiEvent(hand.state, {
      type: "AI_ACTION_INVALID",
      playerId: "utg",
      attempt: 1,
      stage: "schema",
      reason: "teleport",
    });
    hand = {
      state: invalid.state,
      events: [...hand.events, ...invalid.events],
    };
    hand = play(hand, [
      ["utg", call],
      ["btn", call],
    ]);
    const summary = projectHandSummary(hand.events, "btn");
    const sets = heroInformationSets(hand.events, "btn");
    for (const value of [summary, sets]) {
      expect(hiddenMarkers(value)).toEqual([]);
      expect(JSON.stringify(value)).not.toContain("teleport");
    }
  });

  it("打ち切った Hand（HAND_ABORTED。D95）は aborted で、Pot の配分と収支は無く、打ち切りまでの判断は残る", () => {
    let hand = play(start(), [
      ["utg", call],
      ["btn", { type: "raise", amount: 8 }],
    ]);
    const aborted = recordSessionEvent(hand.state, {
      type: "HAND_ABORTED",
      reason: "ai_outage",
    });
    hand = {
      state: aborted.state,
      events: [...hand.events, ...aborted.events],
    };
    const ended = recordSessionEvent(hand.state, {
      type: "SESSION_ENDED",
      sessionId: "s1",
      reason: "ai_outage",
    });
    hand = { state: ended.state, events: [...hand.events, ...ended.events] };

    const summary = projectHandSummary(hand.events, "utg");
    expect(summary).toMatchObject({
      outcome: "aborted",
      pots: [],
      totalPot: 0,
      showdown: [],
      finalStacks: null,
      heroNet: null,
    });
    expect(summary.heroDecisions.map((d) => d.action)).toEqual(["call"]);
    expect(hiddenMarkers(summary)).toEqual([]);
    // 打ち切りの後は Hand が終わっているので、Learning-only Full Reveal を出せる。
    expect(projectLearningReveal(hand.events)?.holeCards).toHaveLength(4);
  });

  it("進行中の Hand は in_progress", () => {
    const hand = play(start(), [["utg", call]]);
    expect(projectHandSummary(hand.events, "utg")).toMatchObject({
      outcome: "in_progress",
      finalStacks: null,
      heroNet: null,
    });
  });

  it("卓にいない Player の Summary は作らない", () => {
    expect(() => projectHandSummary(start().events, "nobody")).toThrow(
      RangeError,
    );
  });
});

describe("Learning-only Full Reveal", () => {
  /** sb・bb が Fold し、utg と btn が Showdown する Hand。sb・bb の札は Showdown では公開されない。 */
  const hand = fullHand();
  const revealOnly = [...parseCards(holes.sb), ...parseCards(holes.bb)].map(
    cardToString,
  );

  it("Hand が終わった後だけ、Fold した Player を含む全員の札を返す。進行中は null", () => {
    expect(projectLearningReveal(start().events)).toBeNull();
    const reveal = projectLearningReveal(hand.events);
    expect(reveal?.visibility).toBe("learning_only");
    expect(reveal?.holeCards.map((h) => h.playerId).sort()).toEqual([
      "bb",
      "btn",
      "sb",
      "utg",
    ]);
    expect(cardsIn(reveal)).toEqual(expect.arrayContaining(revealOnly));
    // Deck の残り（配られなかった Card）は含まない。
    expect(cardsIn(reveal)).toHaveLength(8);
  });

  it("Pass A の入力（判断時点の Information Set）にも、CPU の KnowledgeState にも入らない（INV-TEST-008 に相当）", () => {
    const sets: HeroInformationSet[] = heroInformationSets(hand.events, "utg");
    for (const value of [sets, projectHandSummary(hand.events, "utg")]) {
      for (const c of revealOnly) expect(cardsIn(value)).not.toContain(c);
      expect(hiddenMarkers(value)).toEqual([]);
    }
    // CPU（utg 以外の全員）の KnowledgeState を、Hand の全 prefix と Hand 後で確かめる。
    for (let n = 1; n <= hand.events.length; n++) {
      const prefix = hand.events.slice(0, n);
      for (const cpu of ["btn", "sb", "bb"]) {
        const knowledge = projectKnowledgeState(prefix, cpu);
        const own = parseCards(holes[cpu as keyof typeof holes]).map(
          cardToString,
        );
        for (const c of revealOnly) {
          if (!own.includes(c)) expect(cardsIn(knowledge)).not.toContain(c);
        }
        expect(hiddenMarkers(knowledge)).toEqual([]);
      }
    }
  });
});

/** 手番の Player が Check できれば Check、できなければ Call で、Hand を最後まで進める（Showdown まで）。 */
function checkDown(hand: Hand): Hand {
  let current = hand;
  while (current.state.status === "in_progress") {
    const legal = getLegalActions(current.state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const canCheck = legal.actions.some((a) => a.type === "check");
    current = act(current, legal.playerId, canCheck ? check : call);
  }
  return current;
}

/** Hand を打ち切る（HAND_ABORTED → SESSION_ENDED。D95）。 */
function abort(hand: Hand): Hand {
  const aborted = recordSessionEvent(hand.state, {
    type: "HAND_ABORTED",
    reason: "ai_outage",
  });
  const ended = recordSessionEvent(aborted.state, {
    type: "SESSION_ENDED",
    sessionId: "s1",
    reason: "ai_outage",
  });
  return {
    state: ended.state,
    events: [...hand.events, ...aborted.events, ...ended.events],
  };
}

// Property（hand-summary.property.test.ts）は任意の入力で不変条件が崩れないことを担当し、「その種類の Hand を通したか」の網羅は
// random の seed に期待せず、ここの固定 Scenario が担当する（#167。seed によって River まで進む Hand が 1 つも出ず CI が赤くなった）。
// Property と同じ検査（checkHand）を、各種類の Hand に決定論で通す。
describe("Property の検査を通す Hand の網羅（固定 Scenario。#167）", () => {
  const scenarios: {
    title: string;
    hero: string;
    kinds: CoverageKind[];
    build: () => Hand;
  }[] = [
    {
      title:
        "River まで進み Showdown する Hand（Preflop → River の全 Street に Hero の判断がある）",
      hero: "utg",
      kinds: ["river"],
      build: fullHand,
    },
    {
      title: "All-in に直面した判断のある Hand（Important Spot が出る）",
      hero: "bb",
      kinds: ["spot"],
      build: () =>
        play(start(), [
          ["utg", { type: "all_in" }],
          ["btn", fold],
          ["sb", fold],
          ["bb", call],
        ]),
    },
    {
      title: "Dealer の裁定（Oversized Chip）が Hero の判断に入る Hand",
      hero: "utg",
      kinds: ["ruling"],
      build: () =>
        checkDown(
          physical(start(), "utg", [{ type: "chip_push", chips: [5] }]),
        ),
    },
    {
      title: "Out-of-Turn の操作を手番で拘束する Hand",
      hero: "btn",
      kinds: ["oot"],
      build: () => {
        let hand = physical(start(), "btn", [
          { type: "declare", declaration: { kind: "call" } },
        ]);
        hand = act(hand, "utg", call);
        const resolved = resolvePendingOutOfTurn(
          hand.state,
          PHASE1_CASH_PRESET,
        );
        if (!resolved.ok) throw new Error(resolved.error.message);
        return checkDown({
          state: resolved.value.state,
          events: [...hand.events, ...resolved.value.events],
        });
      },
    },
    {
      title:
        "CPU（utg）の system の記録（Emergency Bot）があり、途中で打ち切った Hand",
      hero: "btn",
      kinds: ["aborted", "system"],
      build: () => {
        // Session の開始 → Emergency Bot の記録（system の Event）→ 通常どおり進めて打ち切る。
        const started = start();
        const session = recordSessionEvent(started.state, {
          type: "SESSION_STARTED",
          sessionId: "s1",
        });
        const bot = recordSessionEvent(session.state, {
          type: "EMERGENCY_BOT_ENGAGED",
          playerId: "utg",
          cause: "timeout",
        });
        const hand = play(
          {
            state: bot.state,
            events: [...started.events, ...session.events, ...bot.events],
          },
          [
            ["utg", call],
            ["btn", { type: "raise", amount: 8 }],
          ],
        );
        return abort(hand);
      },
    },
  ];

  const covered = new Set<CoverageKind>();
  for (const { title, hero, kinds, build } of scenarios) {
    it(title, () => {
      const seen = new Set<CoverageKind>();
      checkHand(build().events, hero, seen);
      // その Hand が狙いの種類を通している（検査が空振りしていない）。
      for (const kind of kinds) expect(seen.has(kind)).toBe(true);
      for (const k of seen) covered.add(k);
    });
  }

  it("上の Scenario で、Property の検査が見る全ての種類（River・Out-of-Turn・裁定・打ち切り・system・Important Spot）を通している", () => {
    expect([...covered].sort()).toEqual([...COVERAGE_KINDS].sort());
  });
});
