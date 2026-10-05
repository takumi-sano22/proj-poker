// 固定 Scenario Regression（docs/09 §4・docs/02 §5。poker-engine-testing §4）。
// Scenario はデータで書き、末尾の汎用ランナーで再生・検証する。期待値はすべて手計算（コメントに計算過程を残す）。
import { describe, expect, it } from "vitest";
import type { HandEvent, HandEventType, SeatInit } from "./hand-events.js";
import { applyAction, startHand, type EngineError } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";
import { checkInvariants, initialChipTotal } from "./testing/invariants.js";
import { stackedDeck } from "./testing/stacked-deck.js";

interface ScenarioStep {
  readonly player: string;
  readonly action: PlayerAction;
  /** 行動前の Legal Action（完全一致）。 */
  readonly legal?: readonly LegalAction[];
  /** 拒否されるべき入力。拒否後の State は変わらない。 */
  readonly reject?: {
    readonly kind: EngineError["kind"];
    readonly reason?: "side_pot" | "odd_chip_split";
  };
}

interface HandScenario {
  readonly id: string;
  readonly title: string;
  /** 根拠（docs の節や D 番号）。 */
  readonly source: string;
  readonly seats: readonly SeatInit[];
  readonly button: string;
  readonly config?: TableConfig;
  /** playerId → Hole Cards。指定しない Player には残りの Card が配られる。 */
  readonly holes: Readonly<Record<string, string>>;
  readonly board: string;
  readonly steps: readonly ScenarioStep[];
  readonly expect: {
    readonly status: "in_progress" | "complete";
    readonly stacks: Readonly<Record<string, number>>;
    readonly pot?: number;
    readonly awards?: Readonly<Record<string, number>>;
    /** 最後の Action 以降に発行された Event 種別（順序どおり）。 */
    readonly tailEvents?: readonly HandEventType[];
    /** 1 度も発行されてはいけない Event 種別。 */
    readonly absentEvents?: readonly HandEventType[];
  };
}

const sixMax = (stack = 200): SeatInit[] =>
  ["btn", "sb", "bb", "utg", "hj", "co"].map((playerId) => ({
    playerId,
    stack,
  }));

const fold = { type: "fold" } as const;
const check = { type: "check" } as const;
const call = { type: "call" } as const;
const allIn = { type: "all_in" } as const;
const bet = (amount: number) => ({ type: "bet", amount }) as const;
const raise = (amount: number) => ({ type: "raise", amount }) as const;

const checkDown = (first: string, second: string): ScenarioStep[] =>
  [1, 2, 3].flatMap(() => [
    { player: first, action: check },
    { player: second, action: check },
  ]);

const SCENARIOS: readonly HandScenario[] = [
  {
    id: "SCN-6max-standard-001",
    title:
      "Standard 6-max: Preflop Raise → Flop Raise → Turn Check → River Bet / Call → Showdown",
    source: "docs/09 §4 Standard 6-max / INV-TEST-003・006",
    seats: sixMax(),
    button: "btn",
    holes: { utg: "As Ad", co: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      // Preflop は BB の左（UTG）から。手番でない CO の Action は拒否（INV-TEST-006）。
      { player: "co", action: call, reject: { kind: "not_actor" } },
      // Minimum Raise は 2 + 2 = 4 まで。3 は拒否。
      { player: "utg", action: raise(3), reject: { kind: "illegal_action" } },
      {
        player: "utg",
        action: raise(6),
        legal: [
          { type: "fold" },
          { type: "call", amount: 2 },
          { type: "raise", min: 4, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "hj", action: fold },
      { player: "co", action: call },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
      {
        // BB: Call は 6 − 2 = 4。Minimum Raise は 6 + 4（直前の Raise 幅）= 10。
        player: "bb",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 4 },
          { type: "raise", min: 10, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      // Pot = SB 1 + BB 6 + UTG 6 + CO 6 = 19。Flop は Button の左で残っている BB から。
      {
        player: "bb",
        action: check,
        legal: [
          { type: "fold" },
          { type: "check" },
          { type: "bet", min: 2, max: 194 },
          { type: "all_in", amount: 194 },
        ],
      },
      { player: "utg", action: bet(10) },
      { player: "co", action: raise(30) },
      { player: "bb", action: fold },
      // Fold した BB へ再び手番は来ない（INV-TEST-003）。
      { player: "bb", action: check, reject: { kind: "not_actor" } },
      { player: "utg", action: call },
      // Pot = 19 + 30 + 30 = 79。Turn は UTG → CO。
      { player: "utg", action: check },
      { player: "co", action: check },
      // River: UTG 40 / CO Call → Pot = 79 + 80 = 159。
      { player: "utg", action: bet(40) },
      { player: "co", action: call },
    ],
    expect: {
      status: "complete",
      // UTG: 200 − 6 − 30 − 40 + 159 = 283 / CO: 200 − 76 = 124 / BB: 200 − 6 = 194 / SB: 199
      stacks: { btn: 200, sb: 199, bb: 194, utg: 283, hj: 200, co: 124 },
      pot: 0,
      awards: { utg: 159 },
      // Showdown は Button の左から公開（UTG → CO）。
      tailEvents: [
        "CARDS_TABLED",
        "CARDS_TABLED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
      absentEvents: ["UNCALLED_BET_RETURNED"],
    },
  },
  {
    id: "SCN-hu-standard-001",
    title: "Standard Heads-Up: Button = SB が Preflop 先手・Postflop 後手",
    source: "docs/09 §4 Standard Heads-Up / docs/02 §7 Heads-Up Invariant",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "bb", stack: 200 },
    ],
    button: "btn",
    holes: { btn: "Ah Kh", bb: "Qs Qc" },
    board: "2d 5c 9h Js 3d",
    steps: [
      { player: "bb", action: check, reject: { kind: "not_actor" } },
      {
        // Button は SB（1 を投入済み）。Call は 1。
        player: "btn",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 1 },
          { type: "raise", min: 4, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "bb", action: check },
      // Postflop は BB が先手。
      { player: "btn", action: check, reject: { kind: "not_actor" } },
      { player: "bb", action: check },
      { player: "btn", action: bet(4) },
      { player: "bb", action: call },
      ...checkDown("bb", "btn").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // Pot = 2 + 2 + 4 + 4 = 12。BB の QQ が A-high に勝つ。BTN: 200 − 6 = 194 / BB: 194 + 12 = 206
      stacks: { btn: 194, bb: 206 },
      pot: 0,
      awards: { bb: 12 },
    },
  },
  {
    id: "SCN-fold-to-bb-001",
    title: "全員 Fold で BB が勝ち、Call されなかった 1 が返る",
    source: "docs/09 §2 Blind / Fold・D70 単一 Pot",
    seats: sixMax(),
    button: "btn",
    holes: {},
    board: "",
    steps: [
      { player: "utg", action: fold },
      { player: "hj", action: fold },
      { player: "co", action: fold },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
    ],
    expect: {
      status: "complete",
      // BB 2 のうち SB 1 を超える 1 は Uncalled で返却。Pot = SB 1 + BB 1 = 2 → BB: 200 − 1 + 2 = 201
      stacks: { btn: 200, sb: 199, bb: 201, utg: 200, hj: 200, co: 200 },
      pot: 0,
      awards: { bb: 2 },
      tailEvents: [
        "ACTION_TAKEN",
        "UNCALLED_BET_RETURNED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
      absentEvents: ["BOARD_DEALT", "CARDS_TABLED"],
    },
  },
  {
    id: "SCN-min-raise-001",
    title: "Minimum Raise の Total と Increment（直前の Raise 幅を引き継ぐ）",
    source: "docs/02 §5 Minimum RaiseのTotalとIncrement",
    seats: sixMax(),
    button: "btn",
    holes: {},
    board: "",
    steps: [
      { player: "utg", action: raise(6) },
      // 直前の増分 4 → HJ の最小は 6 + 4 = 10。9 は拒否。
      { player: "hj", action: raise(9), reject: { kind: "illegal_action" } },
      {
        player: "hj",
        action: raise(10),
        legal: [
          { type: "fold" },
          { type: "call", amount: 6 },
          { type: "raise", min: 10, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      {
        // 増分 4 のまま → 10 + 4 = 14。
        player: "co",
        action: raise(30),
        legal: [
          { type: "fold" },
          { type: "call", amount: 10 },
          { type: "raise", min: 14, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      {
        // CO の増分 20 → 30 + 20 = 50。
        player: "btn",
        action: fold,
        legal: [
          { type: "fold" },
          { type: "call", amount: 30 },
          { type: "raise", min: 50, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "sb", action: fold },
      { player: "bb", action: fold },
      { player: "utg", action: fold },
      { player: "hj", action: fold },
    ],
    expect: {
      status: "complete",
      // CO 30 のうち HJ 10 を超える 20 を返却。Pot = 1 + 2 + 6 + 10 + 10 = 29 → CO: 200 − 10 + 29 = 219
      stacks: { btn: 200, sb: 199, bb: 198, utg: 194, hj: 190, co: 219 },
      pot: 0,
      awards: { co: 29 },
    },
  },
  {
    id: "SCN-allin-showdown-001",
    title:
      "All-in Showdown: 均等 Stack の All-in と Call → 札を公開してから Board を最後まで配る",
    source: "docs/02 §5 All-in Showdown・D70",
    seats: sixMax(),
    button: "btn",
    holes: { utg: "Ks Kd", bb: "Ac 7c" },
    board: "2h 8s 9d Jc 4h",
    steps: [
      { player: "utg", action: allIn },
      { player: "hj", action: fold },
      { player: "co", action: fold },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
      {
        // 相手が全員 All-in か Fold なので Raise は出さない。Call 198 で BB も All-in。
        player: "bb",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 198 },
          { type: "all_in", amount: 200 },
        ],
      },
    ],
    expect: {
      status: "complete",
      // Pot = SB 1 + UTG 200 + BB 200 = 401 → UTG の KK が勝つ
      stacks: { btn: 200, sb: 199, bb: 0, utg: 401, hj: 200, co: 200 },
      pot: 0,
      awards: { utg: 401 },
      tailEvents: [
        "CARDS_TABLED",
        "CARDS_TABLED",
        "BOARD_DEALT",
        "BOARD_DEALT",
        "BOARD_DEALT",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
    },
  },
  {
    id: "SCN-split-even-001",
    title: "Split Pot（等分できる）: Board の Royal Flush で 2 人が分ける",
    source: "docs/09 §2 Split Pot",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "bb", stack: 200 },
    ],
    button: "btn",
    holes: { btn: "2c 3d", bb: "4h 5h" },
    board: "As Ks Qs Js Ts",
    steps: [
      { player: "btn", action: call },
      { player: "bb", action: check },
      ...checkDown("bb", "btn"),
    ],
    expect: {
      status: "complete",
      // Pot 4 を 2 人で 2 ずつ
      stacks: { btn: 200, bb: 200 },
      pot: 0,
      awards: { btn: 2, bb: 2 },
    },
  },
  {
    id: "SCN-odd-chip-unsupported-001",
    title: "端数の出る Split Pot は Phase 1 では明示エラー（D70）",
    source: "D70・docs/02 §5 Odd Chip Split（Phase 2 で実装）",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "sb", stack: 200 },
      { playerId: "bb", stack: 200 },
    ],
    button: "btn",
    holes: { btn: "2c 3d", sb: "4c 5d", bb: "6c 7d" },
    board: "As Ks Qs Js Ts",
    steps: [
      { player: "btn", action: call },
      { player: "sb", action: fold },
      { player: "bb", action: check },
      // Pot = 1 + 2 + 2 = 5 を BTN と BB で分ける → 2.5 ずつにはできない
      ...checkDown("bb", "btn").slice(0, 5),
      {
        player: "btn",
        action: check,
        reject: { kind: "unsupported_state", reason: "odd_chip_split" },
      },
    ],
    expect: {
      // 拒否された River の Check は適用されず、手番は BTN のまま
      status: "in_progress",
      stacks: { btn: 198, sb: 199, bb: 198 },
      pot: 5,
    },
  },
  {
    id: "SCN-side-pot-unsupported-001",
    title:
      "All-in を超える Commit（Side Pot が要る）は Phase 1 では明示エラー（D70）",
    source: "D70・docs/09 §4 3-way Side Pot（Phase 2 で実装）",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "sb", stack: 200 },
      { playerId: "bb", stack: 200 },
      { playerId: "utg", stack: 50 },
    ],
    button: "btn",
    holes: { utg: "Ah Ad", btn: "Kh Kd", bb: "Qh Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "utg", action: allIn },
      // UTG の 50 を超えると Side Pot が要る
      {
        player: "btn",
        action: raise(150),
        reject: { kind: "unsupported_state", reason: "side_pot" },
      },
      { player: "btn", action: call },
      { player: "sb", action: fold },
      { player: "bb", action: call },
      {
        player: "bb",
        action: bet(2),
        reject: { kind: "unsupported_state", reason: "side_pot" },
      },
      ...checkDown("bb", "btn"),
    ],
    expect: {
      status: "complete",
      // Pot = UTG 50 + BTN 50 + SB 1 + BB 50 = 151 → UTG の AA が勝つ
      stacks: { btn: 150, sb: 199, bb: 150, utg: 151 },
      pot: 0,
      awards: { utg: 151 },
    },
  },
  {
    id: "SCN-short-allin-no-reopen-001",
    title: "Short All-in では行動済みの Player に Raise が再開しない",
    source:
      "docs/02 §5 Short All-in / Action Reopening（累積 Short All-in は Phase 2・D70）",
    seats: [
      { playerId: "a", stack: 1000 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 150 },
    ],
    button: "a",
    holes: { c: "Ah Ad", a: "Kh Kd", b: "Qh Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      // 3 人卓: a = Button、b = SB、c = BB。a の Raise 増分 98 が最小 Raise 幅になる。
      { player: "a", action: raise(100) },
      { player: "b", action: call },
      // c の All-in 150 は増分 50 < 98 → Full Raise ではない
      { player: "c", action: allIn },
      { player: "a", action: raise(300), reject: { kind: "illegal_action" } },
      {
        player: "a",
        action: call,
        legal: [{ type: "fold" }, { type: "call", amount: 50 }],
      },
      {
        player: "b",
        action: call,
        legal: [{ type: "fold" }, { type: "call", amount: 50 }],
      },
      ...checkDown("b", "a"),
    ],
    expect: {
      status: "complete",
      // Pot = 150 × 3 = 450 → c の AA が勝つ
      stacks: { a: 850, b: 850, c: 450 },
      pot: 0,
      awards: { c: 450 },
    },
  },
  {
    id: "SCN-full-allin-reopens-001",
    title: "Full Raise 相当の All-in なら行動済みの Player に Raise が再開する",
    source: "docs/02 §5 Action Reopening",
    seats: [
      { playerId: "a", stack: 1000 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 300 },
    ],
    button: "a",
    holes: { c: "Ah Ad", a: "Kh Kd", b: "Qh Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "a", action: raise(100) },
      { player: "b", action: call },
      // 増分 200 >= 98 → Full Raise。最小 Raise は 300 + 200 = 500
      { player: "c", action: allIn },
      {
        player: "a",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 200 },
          { type: "raise", min: 500, max: 1000 },
          { type: "all_in", amount: 1000 },
        ],
      },
      { player: "b", action: call },
      ...checkDown("b", "a"),
    ],
    expect: {
      status: "complete",
      // Pot = 300 × 3 = 900 → c の AA が勝つ
      stacks: { a: 700, b: 700, c: 900 },
      pot: 0,
      awards: { c: 900 },
    },
  },
];

describe("Scenario Regression", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, () => {
      runScenario(scenario);
    });
  }
});

/** Scenario を再生し、各 Step で Invariant と「Event の畳み込み = State」を確かめる。 */
function runScenario(s: HandScenario): void {
  const config = s.config ?? PHASE1_CASH_PRESET;
  const started = startHand({
    handId: s.id,
    seats: s.seats,
    buttonPlayerId: s.button,
    config,
    deal: { deck: stackedDeck(s.seats, s.button, s.holes, s.board) },
  });
  if (!started.ok) throw new Error(started.error.message);
  const total = initialChipTotal(s.seats);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  let tailFrom = events.length;
  expect(checkInvariants(state, total)).toEqual([]);

  for (const [i, step] of s.steps.entries()) {
    const where = `${s.id} step ${i}（${step.player} ${step.action.type}）`;
    if (step.legal !== undefined) {
      expect(getLegalActions(state)?.actions, where).toEqual(step.legal);
    }
    const result = applyAction(state, step.player, step.action);
    if (step.reject !== undefined) {
      expect(result.ok, where).toBe(false);
      if (!result.ok) {
        expect(result.error.kind, where).toBe(step.reject.kind);
        if (step.reject.reason !== undefined && "reason" in result.error) {
          expect(result.error.reason, where).toBe(step.reject.reason);
        }
      }
      continue;
    }
    if (!result.ok) throw new Error(`${where}: ${result.error.message}`);
    state = result.value.state;
    tailFrom = events.length;
    events.push(...result.value.events);
    expect(checkInvariants(state, total), where).toEqual([]);
    expect(foldHandEvents(events), where).toEqual(state);
  }

  expect(state.status).toBe(s.expect.status);
  expect(
    Object.fromEntries(state.players.map((p) => [p.playerId, p.stack])),
  ).toEqual(s.expect.stacks);
  if (s.expect.pot !== undefined) expect(state.pot).toBe(s.expect.pot);
  if (s.expect.awards !== undefined) {
    expect(
      Object.fromEntries(state.awards.map((a) => [a.playerId, a.amount])),
    ).toEqual(s.expect.awards);
  }
  if (s.expect.tailEvents !== undefined) {
    const tail = events.slice(tailFrom).map((e) => e.type);
    expect(tail.slice(-s.expect.tailEvents.length)).toEqual(
      s.expect.tailEvents,
    );
  }
  for (const absent of s.expect.absentEvents ?? []) {
    expect(events.some((e) => e.type === absent)).toBe(false);
  }
}
