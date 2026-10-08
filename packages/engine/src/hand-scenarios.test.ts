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
import {
  resolveOutOfTurn,
  rulePhysicalActions,
  type Declaration,
  type PendingOutOfTurn,
  type PhysicalAction,
  type RulingCode,
  type RulingResult,
} from "./ruling.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";
import {
  checkHandFinished,
  checkInvariants,
  checkPotAwards,
  initialChipTotal,
} from "./testing/invariants.js";
import { stackedDeck } from "./testing/stacked-deck.js";

/** Canonical Action の入力（CPU の Action・Hero が選び直した Action）。 */
interface CanonicalStep {
  readonly player: string;
  readonly action: PlayerAction;
  /** 行動前の Legal Action（完全一致）。 */
  readonly legal?: readonly LegalAction[];
  /** 拒否されるべき入力。拒否後の State は変わらない。 */
  readonly reject?: { readonly kind: EngineError["kind"] };
}

/**
 * Hero の物理的な操作（Ruling。docs/02 §4・D91）。Ruling Engine の裁定が ruling と一致することを確かめ、
 * Canonical Action に決まったらそれを Engine に適用する。Out-of-Turn なら保留し（State は変えない）、
 * 同じ Player の resolveOutOfTurn の Step で裁定する。
 */
interface PhysicalStep {
  readonly player: string;
  readonly physical: readonly PhysicalAction[];
  readonly ruling: ExpectedRuling;
}

/** 保留した Out-of-Turn の操作を、その Player の手番で裁定する。 */
interface ResolveOutOfTurnStep {
  readonly player: string;
  readonly resolveOutOfTurn: true;
  readonly ruling: ExpectedRuling;
}

type ScenarioStep = CanonicalStep | PhysicalStep | ResolveOutOfTurnStep;

/** 裁定の期待値（out_of_turn の保留の中身は比べない）。 */
type ExpectedRuling =
  | {
      readonly kind: "action";
      readonly action: PlayerAction;
      readonly notes: readonly RulingCode[];
    }
  | {
      readonly kind: "out_of_turn" | "no_action";
      readonly notes: readonly RulingCode[];
    };

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
    /** POT_AWARDED を発行順（Main Pot → Side Pot）に。potIndex は 0 からの連番であることも確かめる。 */
    readonly pots?: readonly ExpectedPot[];
    /** 最後の Action 以降に発行された Event 種別（順序どおり）。 */
    readonly tailEvents?: readonly HandEventType[];
    /** 1 度も発行されてはいけない Event 種別。 */
    readonly absentEvents?: readonly HandEventType[];
    /** ANTE_POSTED を発行順に [playerId, 額]（D128）。 */
    readonly antes?: readonly (readonly [string, number])[];
  };
}

interface ExpectedPot {
  readonly total: number;
  /** 争える Player（Button の左から時計回りの順）。 */
  readonly eligible: readonly string[];
  readonly awards: Readonly<Record<string, number>>;
  readonly showdown: boolean;
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

const push = (...chips: number[]): PhysicalAction => ({
  type: "chip_push",
  chips,
});
const add = (...chips: number[]): PhysicalAction => ({
  type: "chip_add",
  chips,
});
const declare = (declaration: Declaration): PhysicalAction => ({
  type: "declare",
  declaration,
});

/** Ruling の Scenario 用の Heads-Up（Stack 1000。500 の Chip を出せる）。cpu が Button（SB）、hero が BB。 */
const headsUpForRuling = (): SeatInit[] => [
  { playerId: "cpu", stack: 1000 },
  { playerId: "hero", stack: 1000 },
];

/** Ruling の Out-of-Turn 用の 3 人（Stack 1000）。btn が Button、sb、hero が BB。Flop 以降は sb → hero → btn。 */
const threeForRuling = (): SeatInit[] => [
  { playerId: "btn", stack: 1000 },
  { playerId: "sb", stack: 1000 },
  { playerId: "hero", stack: 1000 },
];

/** Ante のある卓の設定（D128・#184）。Rule Profile は Cash と共有し、Blind と Ante だけを変える。 */
const withAnte = (
  kind: "per_player" | "big_blind_ante",
  smallBlind: number,
  bigBlind: number,
  amount: number,
): TableConfig => ({
  ...PHASE1_CASH_PRESET,
  smallBlind,
  bigBlind,
  ante: { kind, amount },
});

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
    source: "docs/09 §2 Blind / Fold",
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
      // Fold で決着した Pot は 1 つで、争えるのは BB だけ（札は比べない）。
      pots: [
        { total: 2, eligible: ["bb"], awards: { bb: 2 }, showdown: false },
      ],
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
    id: "SCN-fold-order-001",
    title:
      "Fold 後の Action 順: Fold した Player は飛ばし、Postflop は Button の左で残っている Player から始める",
    source: "docs/02 §5 Fold後のAction順 / INV-TEST-003・006",
    seats: sixMax(),
    button: "btn",
    holes: { bb: "As Ad", hj: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "utg", action: raise(6) },
      { player: "hj", action: call },
      { player: "co", action: fold },
      { player: "btn", action: fold },
      { player: "sb", action: call },
      { player: "bb", action: call },
      // Pot = 6 × 4 = 24。Flop は Button の左で残っている SB から（Fold した BTN・CO には回らない）。
      { player: "bb", action: check, reject: { kind: "not_actor" } },
      { player: "btn", action: check, reject: { kind: "not_actor" } },
      {
        player: "sb",
        action: check,
        legal: [
          { type: "fold" },
          { type: "check" },
          { type: "bet", min: 2, max: 194 },
          { type: "all_in", amount: 194 },
        ],
      },
      { player: "bb", action: bet(10) },
      { player: "utg", action: fold },
      // Preflop で Fold した CO は飛ばして HJ。
      { player: "co", action: fold, reject: { kind: "not_actor" } },
      { player: "hj", action: raise(30) },
      { player: "sb", action: fold },
      // この Street で Fold した UTG には Raise の後も回らない。
      { player: "utg", action: call, reject: { kind: "not_actor" } },
      { player: "bb", action: call },
      // Pot = 24 + 30 + 30 = 84。Turn は Button の左の SB が Fold 済みなので BB から。
      { player: "hj", action: check, reject: { kind: "not_actor" } },
      ...checkDown("bb", "hj").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // BB の AA が勝つ。BB: 200 − 6 − 30 + 84 = 248 / HJ: 200 − 36 = 164 / SB・UTG: 194
      stacks: { btn: 200, sb: 194, bb: 248, utg: 194, hj: 164, co: 200 },
      pot: 0,
      awards: { bb: 84 },
      // 争えるのは Fold していない 2 人（Button の左から BB → HJ）。
      pots: [
        {
          total: 84,
          eligible: ["bb", "hj"],
          awards: { bb: 84 },
          showdown: true,
        },
      ],
      tailEvents: [
        "CARDS_TABLED",
        "CARDS_TABLED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
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
    id: "SCN-min-raise-postflop-001",
    title:
      "Minimum Raise（Postflop）: 最小 Bet は BB、Raise の Increment は Street ごとに BB から数え直す",
    source: "docs/02 §5 Minimum RaiseのTotalとIncrement・§7 Heads-Up",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "bb", stack: 200 },
    ],
    button: "btn",
    holes: { btn: "Ah Kh", bb: "Qs Qc" },
    board: "2d 5c 9h Js 3d",
    steps: [
      { player: "btn", action: call },
      { player: "bb", action: check },
      // Pot = 4。Flop の最小 Bet は BB の 2。1 は拒否。
      { player: "bb", action: bet(1), reject: { kind: "illegal_action" } },
      {
        player: "bb",
        action: bet(10),
        legal: [
          { type: "fold" },
          { type: "check" },
          { type: "bet", min: 2, max: 198 },
          { type: "all_in", amount: 198 },
        ],
      },
      // Bet 10 の増分は 10 → 最小 Raise は 10 + 10 = 20。19 は拒否。
      { player: "btn", action: raise(19), reject: { kind: "illegal_action" } },
      {
        player: "btn",
        action: raise(25),
        legal: [
          { type: "fold" },
          { type: "call", amount: 10 },
          { type: "raise", min: 20, max: 198 },
          { type: "all_in", amount: 198 },
        ],
      },
      {
        // 増分 15 → 25 + 15 = 40。Call は 25 − 10 = 15。
        player: "bb",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 15 },
          { type: "raise", min: 40, max: 198 },
          { type: "all_in", amount: 198 },
        ],
      },
      // Pot = 4 + 25 × 2 = 54。Turn は増分を引き継がず、最小 Bet は再び BB の 2（Stack は各 173）。
      {
        player: "bb",
        action: check,
        legal: [
          { type: "fold" },
          { type: "check" },
          { type: "bet", min: 2, max: 173 },
          { type: "all_in", amount: 173 },
        ],
      },
      { player: "btn", action: bet(2) },
      {
        // 増分 2 → 2 + 2 = 4。
        player: "bb",
        action: raise(4),
        legal: [
          { type: "fold" },
          { type: "call", amount: 2 },
          { type: "raise", min: 4, max: 173 },
          { type: "all_in", amount: 173 },
        ],
      },
      {
        // 増分 2 → 4 + 2 = 6。
        player: "btn",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 2 },
          { type: "raise", min: 6, max: 173 },
          { type: "all_in", amount: 173 },
        ],
      },
      // Pot = 54 + 4 × 2 = 62。River は Check / Check。
      { player: "bb", action: check },
      { player: "btn", action: check },
    ],
    expect: {
      status: "complete",
      // 各 200 − 2 − 25 − 4 = 169。BB の QQ が勝つ → BB: 169 + 62 = 231
      stacks: { btn: 169, bb: 231 },
      pot: 0,
      awards: { bb: 62 },
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
    id: "SCN-odd-chip-2way-001",
    title:
      "2 人の同着で 1 Chip の端数が出る: Button の左に近い方（BB）が端数を受け取る",
    source: "docs/02 §5 Odd Chip Split・D75（first_left_of_button）",
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
      ...checkDown("bb", "btn"),
    ],
    expect: {
      status: "complete",
      // Pot = SB 1 + BTN 2 + BB 2 = 5。Board の Royal Flush で BTN と BB が同着 → 5 / 2 = 2 余り 1。
      // Button の左から時計回りは SB → BB → BTN なので、勝者のうち先頭の BB が端数 1 を受け取り 3、BTN は 2。
      stacks: { btn: 200, sb: 199, bb: 201 },
      pot: 0,
      awards: { bb: 3, btn: 2 },
    },
  },
  {
    id: "SCN-odd-chip-3way-001",
    title: "3 人の同着で端数が 2 Chip 出る: 先頭 2 人に 1 Chip ずつ配る",
    source: "docs/02 §5 Odd Chip Split・D75（first_left_of_button）",
    seats: sixMax(),
    button: "btn",
    holes: { sb: "2c 3d", bb: "4c 5d", utg: "6c 7d", hj: "8c 9d" },
    board: "As Ks Qs Js Ts",
    steps: [
      // Preflop: UTG・HJ・SB が Call（CO・BTN は Fold）、BB は Check → Pot = 2 × 4 = 8
      { player: "utg", action: call },
      { player: "hj", action: call },
      { player: "co", action: fold },
      { player: "btn", action: fold },
      { player: "sb", action: call },
      { player: "bb", action: check },
      // Flop: SB が 2 を Bet、BB は Fold（Preflop の 2 は Pot に残る）、UTG・HJ が Call → Pot = 8 + 6 = 14
      { player: "sb", action: bet(2) },
      { player: "bb", action: fold },
      { player: "utg", action: call },
      { player: "hj", action: call },
      // Turn・River は SB → UTG → HJ の順に Check
      ...[1, 2].flatMap(() =>
        ["sb", "utg", "hj"].map((player) => ({ player, action: check })),
      ),
    ],
    expect: {
      status: "complete",
      // Board の Royal Flush で SB・UTG・HJ が同着 → 14 / 3 = 4 余り 2。
      // Button の左から時計回りは SB → BB → UTG → HJ。勝者のうち先頭の SB と UTG が端数 1 ずつを受け取り 5、HJ は 4。
      // 各 Player の出した額は SB 4・UTG 4・HJ 4・BB 2（Fold）。Stack = 200 − 出した額 + 配分。
      stacks: { btn: 200, sb: 201, bb: 198, utg: 201, hj: 200, co: 200 },
      pot: 0,
      awards: { sb: 5, utg: 5, hj: 4 },
    },
  },
  {
    id: "SCN-odd-chip-order-001",
    title:
      "端数の順序は席番号ではなく Button の左から数える: 席番号の小さい勝者が後回しになる",
    source: "docs/02 §5 Odd Chip Split・D75（first_left_of_button）",
    seats: [
      { playerId: "a", stack: 200 },
      { playerId: "b", stack: 200 },
      { playerId: "c", stack: 200 },
      { playerId: "d", stack: 200 },
    ],
    // Button は b（席 1）。左から時計回りは c → d → a → b。SB は c、BB は d、Preflop の先手は a。
    button: "b",
    holes: { a: "2c 3d", d: "4c 5d" },
    board: "As Ks Qs Js Ts",
    steps: [
      { player: "a", action: call },
      { player: "b", action: fold },
      { player: "c", action: fold },
      { player: "d", action: check },
      ...checkDown("d", "a"),
    ],
    expect: {
      status: "complete",
      // Pot = A 2 + C（SB・Fold）1 + D 2 = 5。Board の Royal Flush で A と D が同着 → 5 / 2 = 2 余り 1。
      // Button の左から時計回りは D → A（席番号では A が先）。先頭の D が端数 1 を受け取り 3、A は 2。
      stacks: { a: 200, b: 200, c: 199, d: 201 },
      pot: 0,
      awards: { d: 3, a: 2 },
    },
  },
  {
    id: "SCN-side-pot-3way-001",
    title:
      "3-way Side Pot: Short Stack の All-in を 2 人が超える → Main は Short Stack、Side は残りの 2 人で争う",
    source: "docs/09 §4 3-way Side Pot・docs/02 §5 Multi Side Pot（D78）",
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
      // UTG の All-in 50 は増分 48 >= 2 → Full Raise。最小 Raise は 50 + 48 = 98。
      { player: "utg", action: allIn },
      {
        player: "btn",
        action: raise(150),
        legal: [
          { type: "fold" },
          { type: "call", amount: 50 },
          { type: "raise", min: 98, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "sb", action: fold },
      { player: "bb", action: call },
      // Flop は Button の左で行動できる BB から（UTG は All-in）。
      { player: "bb", action: check },
      { player: "btn", action: bet(30) },
      { player: "bb", action: call },
      { player: "bb", action: check },
      { player: "btn", action: check },
      { player: "bb", action: check },
      { player: "btn", action: check },
    ],
    expect: {
      status: "complete",
      // Commit: UTG 50 / BTN 180 / SB 1 / BB 180。
      // Main = 50 + 50 + 1 + 50 = 151（SB・BB・UTG・BTN のうち Fold していない BB・UTG・BTN が争う）→ UTG の AA。
      // Side = 130 + 130 = 260（BB・BTN）→ BTN の KK。
      // UTG 151 / BTN 200 − 180 + 260 = 280 / SB 199 / BB 200 − 180 = 20（計 650）
      stacks: { btn: 280, sb: 199, bb: 20, utg: 151 },
      pot: 0,
      awards: { utg: 151, btn: 260 },
      pots: [
        {
          total: 151,
          eligible: ["bb", "utg", "btn"],
          awards: { utg: 151 },
          showdown: true,
        },
        {
          total: 260,
          eligible: ["bb", "btn"],
          awards: { btn: 260 },
          showdown: true,
        },
      ],
      // Showdown は Button の左から公開（BB → UTG → BTN）。Pot は Main から 1 つずつ配る。
      tailEvents: [
        "CARDS_TABLED",
        "CARDS_TABLED",
        "CARDS_TABLED",
        "POT_AWARDED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
      absentEvents: ["UNCALLED_BET_RETURNED"],
    },
  },
  {
    id: "SCN-side-pot-multi-split-001",
    title:
      "Multi Side Pot: 段の違う 2 人の All-in で Pot が 3 つ。Side Pot 内の同着は端数を Button の左から配る",
    source: "docs/02 §5 Multi Side Pot・Odd Chip Split（D75・D78）",
    seats: [
      { playerId: "a", stack: 30 },
      { playerId: "b", stack: 81 },
      { playerId: "c", stack: 200 },
      { playerId: "d", stack: 200 },
    ],
    // Button は d。SB は a、BB は b、Preflop の先手は c。Button の左から時計回りは a → b → c → d。
    button: "d",
    // Board 5c 6d 7h 8s Kc: a は 6〜T の Straight、c と d は 5〜9 の Straight（同着）、b は A のワンペア。
    holes: { a: "9h Ts", b: "Ah Ad", c: "9c 2d", d: "9d 3h" },
    board: "5c 6d 7h 8s Kc",
    steps: [
      { player: "c", action: raise(10) },
      { player: "d", action: call },
      // a の All-in 30 は増分 20 >= 8 → Full Raise。b の All-in 81 は増分 51 >= 20 → Full Raise。
      { player: "a", action: allIn },
      { player: "b", action: allIn },
      {
        player: "c",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 71 },
          { type: "raise", min: 132, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "d", action: call },
      // Flop は Button の左で行動できる c から（a・b は All-in）。
      { player: "c", action: bet(20) },
      { player: "d", action: call },
      { player: "c", action: check },
      { player: "d", action: check },
      { player: "c", action: check },
      { player: "d", action: check },
    ],
    expect: {
      status: "complete",
      // Commit: a 30 / b 81 / c 101 / d 101。
      // Main = 30 × 4 = 120（a・b・c・d）→ a。
      // Side 1 = 51 × 3 = 153（b・c・d）→ c と d が同着。153 / 2 = 76 余り 1 → Button の左に近い c が 77、d が 76。
      // Side 2 = 20 × 2 = 40（c・d）→ 同着で 20 ずつ。
      // a 120 / b 0 / c 200 − 101 + 77 + 20 = 196 / d 200 − 101 + 76 + 20 = 195（計 511）
      stacks: { a: 120, b: 0, c: 196, d: 195 },
      pot: 0,
      awards: { a: 120, c: 97, d: 96 },
      pots: [
        {
          total: 120,
          eligible: ["a", "b", "c", "d"],
          awards: { a: 120 },
          showdown: true,
        },
        {
          total: 153,
          eligible: ["b", "c", "d"],
          awards: { c: 77, d: 76 },
          showdown: true,
        },
        {
          total: 40,
          eligible: ["c", "d"],
          awards: { c: 20, d: 20 },
          showdown: true,
        },
      ],
      absentEvents: ["UNCALLED_BET_RETURNED"],
    },
  },
  {
    id: "SCN-side-pot-dead-money-001",
    title:
      "Side Pot に Fold した Player の Chip が残り、争える Player が 1 人なら札を比べずに渡す",
    source: "docs/02 §5 Multi Side Pot（D78）",
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
      { player: "btn", action: raise(100) },
      { player: "sb", action: fold },
      { player: "bb", action: call },
      // Flop: BB が Check、BTN の Bet に BB が Fold。BTN の 60 は誰も Call していないので返す。
      { player: "bb", action: check },
      { player: "btn", action: bet(60) },
      { player: "bb", action: fold },
    ],
    expect: {
      status: "complete",
      // Commit（返却後）: UTG 50 / BTN 100 / SB 1 / BB 100（BB は Fold）。
      // Main = 50 + 50 + 1 + 50 = 151（UTG・BTN）→ UTG の AA。
      // Side = 50 + 50 = 100（Fold した BB の 50 は死に金として残る。争えるのは BTN だけ）→ BTN、札は比べない。
      // UTG 151 / BTN 200 − 100 + 100 = 200 / SB 199 / BB 100（計 650）
      stacks: { btn: 200, sb: 199, bb: 100, utg: 151 },
      pot: 0,
      awards: { utg: 151, btn: 100 },
      pots: [
        {
          total: 151,
          eligible: ["utg", "btn"],
          awards: { utg: 151 },
          showdown: true,
        },
        {
          total: 100,
          eligible: ["btn"],
          awards: { btn: 100 },
          showdown: false,
        },
      ],
      // Uncalled Bet を返してから、残った全員の札を公開して Board を配りきる。
      tailEvents: [
        "UNCALLED_BET_RETURNED",
        "CARDS_TABLED",
        "CARDS_TABLED",
        "BOARD_DEALT",
        "BOARD_DEALT",
        "POT_AWARDED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
    },
  },
  {
    id: "SCN-uncalled-over-short-allin-001",
    title:
      "Short Stack の All-in Call を超えた Raise は、誰も Call できないので Showdown 前に返す",
    source: "docs/02 §5 All-in Showdown・docs/04 §3 UNCALLED_BET_RETURNED",
    seats: [
      { playerId: "a", stack: 1000 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 100 },
    ],
    // a = Button、b = SB、c = BB。
    button: "a",
    holes: { c: "Ah Ad", a: "Kh Kd", b: "Qh Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "a", action: raise(300) },
      { player: "b", action: fold },
      {
        // c は Call 298 に届かない。Stack 98 の Call（All-in）か All-in だけ。
        player: "c",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 98 },
          { type: "all_in", amount: 100 },
        ],
      },
    ],
    expect: {
      status: "complete",
      // a の 300 のうち c の 100 を超える 200 は返す。Pot = a 100 + b 1 + c 100 = 201 → c の AA。
      stacks: { a: 900, b: 999, c: 201 },
      pot: 0,
      awards: { c: 201 },
      pots: [
        {
          total: 201,
          eligible: ["c", "a"],
          awards: { c: 201 },
          showdown: true,
        },
      ],
      tailEvents: [
        "UNCALLED_BET_RETURNED",
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
    id: "SCN-blind-allin-sb-001",
    title:
      "Stack が SB に満たない Player は Blind で All-in。Main Pot だけを争い、上の段は残りの Player の Side Pot",
    source: "docs/02 §5 Blind / Multi Side Pot（D78）",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "sb", stack: 1 },
      { playerId: "bb", stack: 200 },
    ],
    button: "btn",
    holes: { sb: "Ah Ad", btn: "Kh Kd", bb: "Qh Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // SB は 1 で All-in。Preflop の先手は BTN で、Call 額は BB の 2。
        player: "btn",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 2 },
          { type: "raise", min: 4, max: 200 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "bb", action: check },
      ...checkDown("bb", "btn"),
    ],
    expect: {
      status: "complete",
      // Commit: BTN 2 / SB 1 / BB 2。Main = 1 × 3 = 3（SB・BB・BTN）→ SB の AA。
      // Side = 1 + 1 = 2（BB・BTN）→ BTN の KK。BTN 200 − 2 + 2 = 200 / SB 3 / BB 198（計 401）
      stacks: { btn: 200, sb: 3, bb: 198 },
      pot: 0,
      awards: { sb: 3, btn: 2 },
      pots: [
        {
          total: 3,
          eligible: ["sb", "bb", "btn"],
          awards: { sb: 3 },
          showdown: true,
        },
        {
          total: 2,
          eligible: ["bb", "btn"],
          awards: { btn: 2 },
          showdown: true,
        },
      ],
      absentEvents: ["UNCALLED_BET_RETURNED"],
    },
  },
  {
    id: "SCN-blind-allin-bb-hu-001",
    title:
      "Heads-Up で BB が Stack 不足の All-in: Call 額は BB の全額、BB を超えた分は返す",
    source: "docs/02 §5 Blind・§7 Heads-Up（D78）",
    seats: [
      { playerId: "a", stack: 200 },
      { playerId: "b", stack: 1 },
    ],
    // Heads-Up は Button = SB。a が SB 1、b が BB で Stack 1 の All-in。
    button: "a",
    holes: { a: "Kh Kd", b: "Ah Ad" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // 相手は All-in なので Raise はできない。Call 額は BB の 2 − 1 = 1。
        player: "a",
        action: call,
        legal: [{ type: "fold" }, { type: "call", amount: 1 }],
      },
    ],
    expect: {
      status: "complete",
      // a は 2 を出し、b は 1。超過の 1 を a へ返して Pot = 2 → b の AA。a 199 / b 2（計 201）
      stacks: { a: 199, b: 2 },
      pot: 0,
      awards: { b: 2 },
      pots: [
        {
          total: 2,
          eligible: ["b", "a"],
          awards: { b: 2 },
          showdown: true,
        },
      ],
      tailEvents: [
        "UNCALLED_BET_RETURNED",
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
    id: "SCN-short-allin-no-reopen-001",
    title: "Short All-in では行動済みの Player に Raise が再開しない",
    source: "docs/02 §5 Short All-in / Action Reopening（D79）",
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
  {
    id: "SCN-cumulative-short-allin-reopen-001",
    title:
      "累積 Short All-in: 2 つの Short All-in の合計が Full Raise に達すると、行動済みの Player に Raise が再開する（Side Pot あり）",
    source:
      "docs/02 §5 累積 Short All-in / Action Reopening / Multi Side Pot（D79・OI-008 の暫定値・D78）",
    seats: [
      { playerId: "a", stack: 150 },
      { playerId: "b", stack: 200 },
      { playerId: "c", stack: 1000 },
      { playerId: "d", stack: 1000 },
    ],
    // a = Button、b = SB、c = BB、d = UTG。Preflop は d → a → b → c。
    button: "a",
    holes: { a: "Ah Ad", b: "Kh Kd", c: "Qh Qd", d: "Th Td" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      // d の Raise 増分 98 が Full Raise 幅になる。
      { player: "d", action: raise(100) },
      // a の All-in 150 は増分 50 < 98 → Short All-in。
      { player: "a", action: allIn },
      {
        // b は未行動なので Raise してよいが、最小 Raise 150 + 98 = 248 に Stack 200 が届かない。
        // All-in 200 は増分 50 < 98 → 2 つ目の Short All-in。
        player: "b",
        action: allIn,
        legal: [
          { type: "fold" },
          { type: "call", amount: 149 },
          { type: "all_in", amount: 200 },
        ],
      },
      { player: "c", action: call },
      {
        // d が最後に行動した時点の最高額 100 からの上乗せは 50 + 50 = 100 >= 98 → 再開する。
        // 最小 Raise は 200 + 98（直近の Full Raise 幅。Short All-in では変わらない）= 298。
        player: "d",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 100 },
          { type: "raise", min: 298, max: 1000 },
          { type: "all_in", amount: 1000 },
        ],
      },
      // Flop 以降は Button の左で行動できる c → d。
      ...checkDown("c", "d"),
    ],
    expect: {
      status: "complete",
      // Commit: a 150 / b 200 / c 200 / d 200。
      // Main = 150 × 4 = 600（全員）→ a の AA。Side = 50 × 3 = 150（b・c・d）→ b の KK。
      // a 600 / b 150 / c 800 / d 800（計 2350）
      stacks: { a: 600, b: 150, c: 800, d: 800 },
      pot: 0,
      awards: { a: 600, b: 150 },
      pots: [
        {
          total: 600,
          eligible: ["b", "c", "d", "a"],
          awards: { a: 600 },
          showdown: true,
        },
        {
          total: 150,
          eligible: ["b", "c", "d"],
          awards: { b: 150 },
          showdown: true,
        },
      ],
      absentEvents: ["UNCALLED_BET_RETURNED"],
    },
  },
  {
    id: "SCN-cumulative-short-allin-no-reopen-001",
    title:
      "累積 Short All-in: 2 つの Short All-in の合計が Full Raise に届かなければ、行動済みの Player に Raise は再開しない",
    source:
      "docs/02 §5 累積 Short All-in / Action Reopening（D79・OI-008 の暫定値）",
    seats: [
      { playerId: "a", stack: 150 },
      { playerId: "b", stack: 180 },
      { playerId: "c", stack: 1000 },
      { playerId: "d", stack: 1000 },
    ],
    button: "a",
    holes: { a: "Ah Ad", b: "Kh Kd", c: "Qh Qd", d: "Th Td" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "d", action: raise(100) },
      // 増分 50 → Short All-in。
      { player: "a", action: allIn },
      // 増分 30 → Short All-in。
      { player: "b", action: allIn },
      { player: "c", action: call },
      // d から見た上乗せは 50 + 30 = 80 < 98 → 再開しない（Call か Fold だけ）。
      { player: "d", action: raise(400), reject: { kind: "illegal_action" } },
      { player: "d", action: allIn, reject: { kind: "illegal_action" } },
      {
        player: "d",
        action: call,
        legal: [{ type: "fold" }, { type: "call", amount: 80 }],
      },
      ...checkDown("c", "d"),
    ],
    expect: {
      status: "complete",
      // Commit: a 150 / b 180 / c 180 / d 180。
      // Main = 150 × 4 = 600 → a の AA。Side = 30 × 3 = 90（b・c・d）→ b の KK。
      // a 600 / b 90 / c 820 / d 820（計 2330）
      stacks: { a: 600, b: 90, c: 820, d: 820 },
      pot: 0,
      awards: { a: 600, b: 90 },
    },
  },
  {
    id: "SCN-cumulative-reopen-per-player-001",
    title:
      "累積は Player ごとに最後の行動から数える: 先に行動した Player には再開し、途中で Call した Player には再開しない",
    source:
      "docs/02 §5 累積 Short All-in / Action Reopening（D79・OI-008 の暫定値）",
    seats: [
      { playerId: "a", stack: 150 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 200 },
      { playerId: "d", stack: 1000 },
    ],
    button: "a",
    holes: { a: "Ah Ad", b: "Kh Kd", c: "Qh Qd", d: "Th Td" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "d", action: raise(100) },
      // 増分 50 → Short All-in。
      { player: "a", action: allIn },
      // b は最高額 150 の時点で行動した。
      { player: "b", action: call },
      {
        // 最小 Raise 248 に Stack 200 が届かない。All-in 200 は増分 50 → Short All-in。
        player: "c",
        action: allIn,
        legal: [
          { type: "fold" },
          { type: "call", amount: 148 },
          { type: "all_in", amount: 200 },
        ],
      },
      {
        // d から見た上乗せは 200 − 100 = 100 >= 98 → 再開する。
        player: "d",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 100 },
          { type: "raise", min: 298, max: 1000 },
          { type: "all_in", amount: 1000 },
        ],
      },
      // b から見た上乗せは 200 − 150 = 50 < 98 → 再開しない。
      { player: "b", action: raise(300), reject: { kind: "illegal_action" } },
      {
        player: "b",
        action: call,
        legal: [{ type: "fold" }, { type: "call", amount: 50 }],
      },
      // Flop 以降は Button の左で行動できる b → d（c は All-in）。
      ...checkDown("b", "d"),
    ],
    expect: {
      status: "complete",
      // Commit: a 150 / b 200 / c 200 / d 200。
      // Main = 150 × 4 = 600 → a の AA。Side = 50 × 3 = 150（b・c・d）→ b の KK。
      // a 600 / b 1000 − 200 + 150 = 950 / c 0 / d 800（計 2350）
      stacks: { a: 600, b: 950, c: 0, d: 800 },
      pot: 0,
      awards: { a: 600, b: 150 },
    },
  },
  // ---- Ruling（Hero の物理的な操作。docs/02 §4・§5、docs/09 §4、D91・OI-008 の暫定値。Rule Profile phase4_provisional_v1）----
  {
    id: "SCN-ruling-oversized-001",
    title:
      "Oversized Chip: 相手の Bet 100 に、宣言なしで 500 を 1 枚 → Call 100",
    source:
      "docs/02 §4・§5 Oversized Chip / docs/09 §4 / D91（call_unless_raise_declared）",
    seats: headsUpForRuling(),
    button: "cpu",
    holes: { hero: "As Ad", cpu: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "cpu", action: call },
      { player: "hero", action: check },
      // Pot 4。Flop は hero（BB）から。
      { player: "hero", action: check },
      { player: "cpu", action: bet(100) },
      {
        player: "hero",
        physical: [push(500)],
        ruling: {
          kind: "action",
          action: call,
          notes: ["oversized_chip"],
        },
      },
      // Pot 4 + 100 + 100 = 204。
      ...checkDown("hero", "cpu").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // hero が AA で 204 を取る: hero 1000 − 2 − 100 + 204 = 1102 / cpu 1000 − 2 − 100 = 898
      stacks: { hero: 1102, cpu: 898 },
      pot: 0,
      awards: { hero: 204 },
      tailEvents: [
        "CARDS_TABLED",
        "CARDS_TABLED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
    },
  },
  {
    id: "SCN-ruling-oversized-002",
    title:
      "Oversized Chip: Raise を先に宣言して 500 を 1 枚 → Raise to 500（同じ Chip でも宣言で裁定が変わる）",
    source:
      "docs/02 §4 Oversized Chip / D91（call_unless_raise_declared）・宣言（declaration_first_nearest_legal）",
    seats: headsUpForRuling(),
    button: "cpu",
    holes: { hero: "As Ad", cpu: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "cpu", action: call },
      { player: "hero", action: check },
      { player: "hero", action: check },
      { player: "cpu", action: bet(100) },
      {
        player: "hero",
        physical: [declare({ kind: "raise" }), push(500)],
        ruling: { kind: "action", action: raise(500), notes: [] },
      },
      { player: "cpu", action: fold },
    ],
    expect: {
      status: "complete",
      // Uncalled 500 − 100 = 400 を hero へ返し、Pot 4 + 100 + 100 = 204 を hero へ。
      // hero 1000 − 2 − 500 + 400 + 204 = 1102 / cpu 898
      stacks: { hero: 1102, cpu: 898 },
      pot: 0,
      awards: { hero: 204 },
      tailEvents: ["UNCALLED_BET_RETURNED", "POT_AWARDED", "HAND_FINISHED"],
      absentEvents: ["CARDS_TABLED"],
    },
  },
  {
    id: "SCN-ruling-oversized-003",
    title: "Oversized Chip: 相手の Bet が無いときに 100 を 1 枚 → Bet 100",
    source:
      "docs/02 §4 Oversized Chip / D91（相手の Bet が無ければその額の Bet）",
    seats: headsUpForRuling(),
    button: "cpu",
    holes: { hero: "As Ad", cpu: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "cpu", action: call },
      { player: "hero", action: check },
      {
        player: "hero",
        physical: [push(100)],
        ruling: { kind: "action", action: bet(100), notes: [] },
      },
      { player: "cpu", action: call },
      ...checkDown("hero", "cpu").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // Pot 4 + 100 + 100 = 204 → hero。hero 1102 / cpu 898
      stacks: { hero: 1102, cpu: 898 },
      pot: 0,
      awards: { hero: 204 },
    },
  },
  {
    id: "SCN-ruling-string-001",
    title:
      "String Raise: 相手の Bet 100 に、宣言なしで 100 を出してから 300 を足す → 最初の 100 で Call",
    source:
      "docs/02 §5 String Bet / Raise / docs/09 §4 String Raise / D91（first_motion_only）",
    seats: headsUpForRuling(),
    button: "cpu",
    holes: { hero: "As Ad", cpu: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "cpu", action: call },
      { player: "hero", action: check },
      { player: "hero", action: check },
      { player: "cpu", action: bet(100) },
      {
        player: "hero",
        physical: [push(100), add(100, 100, 100)],
        ruling: { kind: "action", action: call, notes: ["string_bet"] },
      },
      ...checkDown("hero", "cpu").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // 足した 300 は返す。Pot 4 + 100 + 100 = 204 → hero。hero 1102 / cpu 898
      stacks: { hero: 1102, cpu: 898 },
      pot: 0,
      awards: { hero: 204 },
    },
  },
  {
    id: "SCN-ruling-string-002",
    title:
      "String Raise の対照: Raise を先に宣言して Call 額 100 → 続けて 100 → Raise to 200",
    source:
      "docs/02 §5 String Bet / Raise / TDA の Raise の方法（宣言してから Call 額 + 1 回）",
    seats: headsUpForRuling(),
    button: "cpu",
    holes: { hero: "As Ad", cpu: "Kh Kd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "cpu", action: call },
      { player: "hero", action: check },
      { player: "hero", action: check },
      { player: "cpu", action: bet(100) },
      {
        player: "hero",
        physical: [declare({ kind: "raise" }), push(100), add(100)],
        ruling: { kind: "action", action: raise(200), notes: [] },
      },
      { player: "cpu", action: call },
      ...checkDown("hero", "cpu").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // Pot 4 + 200 + 200 = 404 → hero。hero 1000 − 2 − 200 + 404 = 1202 / cpu 1000 − 2 − 200 = 798
      stacks: { hero: 1202, cpu: 798 },
      pot: 0,
      awards: { hero: 404 },
    },
  },
  {
    id: "SCN-ruling-oot-001",
    title:
      "Representative Out-of-Turn: 手番の前に Bet 100 → 手番を戻し、間が Check なので Bet 100 を拘束",
    source:
      "docs/02 §5 Representative Out-of-Turn / docs/09 §4 / D91（bind_unless_action_changes）",
    seats: threeForRuling(),
    button: "btn",
    holes: { hero: "As Ad", sb: "Kh Kd", btn: "Qh Qd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "btn", action: call },
      { player: "sb", action: call },
      { player: "hero", action: check },
      // Pot 6。Flop は sb から。Canonical Action の手番違いは拒否される（INV-TEST-006）。
      { player: "hero", action: bet(100), reject: { kind: "not_actor" } },
      // 物理的な操作は裁定される: 手番を sb へ戻して警告し、保留する（State は変えない）。
      {
        player: "hero",
        physical: [push(100)],
        ruling: { kind: "out_of_turn", notes: ["out_of_turn"] },
      },
      // Check は状況を変えない。
      { player: "sb", action: check },
      {
        player: "hero",
        resolveOutOfTurn: true,
        ruling: {
          kind: "action",
          action: bet(100),
          notes: ["out_of_turn_binding"],
        },
      },
      { player: "btn", action: fold },
      { player: "sb", action: call },
      // Pot 6 + 100 + 100 = 206。Turn・River は sb → hero。
      ...checkDown("sb", "hero").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // hero が AA で 206: hero 1000 − 2 − 100 + 206 = 1104 / sb 1000 − 2 − 100 = 898 / btn 998
      stacks: { btn: 998, sb: 898, hero: 1104 },
      pot: 0,
      awards: { hero: 206 },
    },
  },
  {
    id: "SCN-ruling-oot-002",
    title:
      "Representative Out-of-Turn: 手番の前に Bet 100 → 間の Player が Bet したので撤回し、Hero が選び直す",
    source: "docs/02 §5 Representative Out-of-Turn / D91（変われば撤回できる）",
    seats: threeForRuling(),
    button: "btn",
    holes: { hero: "As Ad", sb: "Kh Kd", btn: "Qh Qd" },
    board: "2c 7d 9s Jh 3c",
    steps: [
      { player: "btn", action: call },
      { player: "sb", action: call },
      { player: "hero", action: check },
      {
        player: "hero",
        physical: [push(100)],
        ruling: { kind: "out_of_turn", notes: ["out_of_turn"] },
      },
      // Bet は状況を変える（最高額 0 → 50）。
      { player: "sb", action: bet(50) },
      {
        player: "hero",
        resolveOutOfTurn: true,
        ruling: { kind: "no_action", notes: ["out_of_turn_released"] },
      },
      // 撤回したので、Hero は全部の選択肢から選び直す。
      {
        player: "hero",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 50 },
          { type: "raise", min: 100, max: 998 },
          { type: "all_in", amount: 998 },
        ],
      },
      { player: "btn", action: fold },
      ...checkDown("sb", "hero").slice(0, 4),
    ],
    expect: {
      status: "complete",
      // Pot 6 + 50 + 50 = 106 → hero。hero 1000 − 2 − 50 + 106 = 1054 / sb 948 / btn 998
      stacks: { btn: 998, sb: 948, hero: 1054 },
      pot: 0,
      awards: { hero: 106 },
    },
  },
  {
    id: "SCN-ante-bba-fold-to-bb-001",
    title:
      "Big Blind Ante: BB が Blind と Ante を払い、全員 Fold。Call 額と Uncalled の返却に Ante を数えない",
    source: "docs/02 §7 Ante の Pot での扱い（D128）/ #184",
    seats: sixMax(1_500),
    button: "btn",
    config: withAnte("big_blind_ante", 10, 20, 20),
    holes: {},
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // Call 額は BB の 20（Ante の 20 は数えない）。Minimum Raise は 20 + 20 = 40。
        player: "utg",
        action: fold,
        legal: [
          { type: "fold" },
          { type: "call", amount: 20 },
          { type: "raise", min: 40, max: 1_500 },
          { type: "all_in", amount: 1_500 },
        ],
      },
      { player: "hj", action: fold },
      { player: "co", action: fold },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
    ],
    expect: {
      status: "complete",
      // Uncalled は Blind だけで数える: BB 20 − SB 10 = 10 を返す（Ante を数えると 30 になる）。
      // Pot = SB 10 + BB 10 + Ante 20（Main Pot の Dead Money）= 40 → BB。
      // BB 1500 − 20 − 20 + 10 + 40 = 1510 / SB 1490（計 9000）
      stacks: {
        btn: 1_500,
        sb: 1_490,
        bb: 1_510,
        utg: 1_500,
        hj: 1_500,
        co: 1_500,
      },
      pot: 0,
      awards: { bb: 40 },
      pots: [
        { total: 40, eligible: ["bb"], awards: { bb: 40 }, showdown: false },
      ],
      antes: [["bb", 20]],
      tailEvents: ["UNCALLED_BET_RETURNED", "POT_AWARDED", "HAND_FINISHED"],
    },
  },
  {
    id: "SCN-ante-bba-hu-001",
    title:
      "Big Blind Ante の Heads-Up: Button = SB、BB の席が Blind の後に Ante を払う",
    source: "docs/02 §7 Heads-Up・Ante の Pot での扱い（D128）/ #184",
    seats: [
      { playerId: "btn", stack: 1_000 },
      { playerId: "bb", stack: 1_000 },
    ],
    button: "btn",
    config: withAnte("big_blind_ante", 10, 20, 20),
    holes: {},
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // Button（SB 10 を投入済み）の Call は 20 − 10 = 10。
        player: "btn",
        action: fold,
        legal: [
          { type: "fold" },
          { type: "call", amount: 10 },
          { type: "raise", min: 40, max: 1_000 },
          { type: "all_in", amount: 1_000 },
        ],
      },
    ],
    expect: {
      status: "complete",
      // BB へ 20 − 10 = 10 を返し、Pot = 10 + 10 + Ante 20 = 40 → BB。BB 1000 − 40 + 10 + 40 = 1010 / btn 990
      stacks: { btn: 990, bb: 1_010 },
      pot: 0,
      awards: { bb: 40 },
      antes: [["bb", 20]],
    },
  },
  {
    id: "SCN-ante-bba-short-bb-001",
    title:
      "Big Blind Ante で BB の Stack が足りない: Blind を先に払い、残りで Ante（減る）。Ante は Main Pot に入る",
    source: "docs/02 §7 Ante の Pot での扱い（D128・TDA）/ #184",
    seats: [
      { playerId: "btn", stack: 1_000 },
      { playerId: "sb", stack: 1_000 },
      { playerId: "bb", stack: 30 },
    ],
    button: "btn",
    config: withAnte("big_blind_ante", 10, 20, 20),
    holes: { bb: "As Ad", btn: "Ks Kd", sb: "Qs Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // BB は Blind 20 の後の残り 10 で Ante を払って All-in。Call 額は Blind の 20 だけ。
        player: "btn",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 20 },
          { type: "raise", min: 40, max: 1_000 },
          { type: "all_in", amount: 1_000 },
        ],
      },
      { player: "sb", action: call },
      // Flop 以降は All-in の BB を飛ばして SB → Button。
      { player: "sb", action: check },
      { player: "btn", action: bet(100) },
      { player: "sb", action: call },
      { player: "sb", action: check },
      { player: "btn", action: check },
      { player: "sb", action: check },
      { player: "btn", action: check },
    ],
    expect: {
      status: "complete",
      // Main Pot = 20 × 3 + Ante 10 = 70（3 人が争える）→ BB の AA。Side Pot = 100 × 2 = 200（SB・Button）→ Button の KK。
      // BB 70 / Button 1000 − 120 + 200 = 1080 / SB 1000 − 120 = 880（計 2030）
      stacks: { btn: 1_080, sb: 880, bb: 70 },
      pot: 0,
      awards: { bb: 70, btn: 200 },
      pots: [
        {
          total: 70,
          eligible: ["sb", "bb", "btn"],
          awards: { bb: 70 },
          showdown: true,
        },
        {
          total: 200,
          eligible: ["sb", "btn"],
          awards: { btn: 200 },
          showdown: true,
        },
      ],
      antes: [["bb", 10]],
    },
  },
  {
    id: "SCN-ante-bba-bb-allin-by-blind-001",
    title:
      "Big Blind Ante で BB が Blind だけで All-in: Ante は払えないので置かない",
    source: "docs/02 §7 Ante の Pot での扱い（D128・TDA）/ #184",
    seats: [
      { playerId: "btn", stack: 1_000 },
      { playerId: "sb", stack: 1_000 },
      { playerId: "bb", stack: 20 },
    ],
    button: "btn",
    config: withAnte("big_blind_ante", 10, 20, 20),
    holes: { bb: "As Ad", sb: "Ks Kd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "btn", action: fold },
      // 残りで行動できるのは SB だけなので、Call の後は Board を配り切って Showdown。
      { player: "sb", action: call },
    ],
    expect: {
      status: "complete",
      // Pot = 20 + 20 = 40 → BB の AA。BB 40 / SB 980 / Button 1000（計 2020）
      stacks: { btn: 1_000, sb: 980, bb: 40 },
      pot: 0,
      awards: { bb: 40 },
      antes: [],
      absentEvents: ["ANTE_POSTED"],
    },
  },
  {
    id: "SCN-ante-bba-short-allin-wins-main-001",
    title:
      "Big Blind Ante は全額 Main Pot: BB の Blind より短い All-in でも Ante の全額を取れる",
    source: "docs/02 §7 Ante の Pot での扱い（D128・TDA）/ #184",
    seats: [
      { playerId: "btn", stack: 1_000 },
      { playerId: "sb", stack: 1_000 },
      { playerId: "bb", stack: 1_000 },
      { playerId: "utg", stack: 15 },
    ],
    button: "btn",
    config: withAnte("big_blind_ante", 10, 20, 20),
    holes: { utg: "As Ad", bb: "Ks Kd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      { player: "utg", action: allIn },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
      // BB は行動できる相手がいないので Option は無く、Board を配り切る。
    ],
    expect: {
      status: "complete",
      // BB の Blind 20 は UTG の 15 を 5 超えるので返す。Pot = UTG 15 + BB 15 + SB 10 + Ante 20 = 60（UTG・BB が争える）→ UTG の AA。
      // Ante を BB の段に入れると UTG が取れるのは 15 × 2 + 10 = 40 になる（D128 は Main Pot）。
      // UTG 60 / BB 1000 − 20 − 20 + 5 = 965 / SB 990 / Button 1000（計 3015）
      stacks: { btn: 1_000, sb: 990, bb: 965, utg: 60 },
      pot: 0,
      awards: { utg: 60 },
      pots: [
        {
          total: 60,
          eligible: ["bb", "utg"],
          awards: { utg: 60 },
          showdown: true,
        },
      ],
      antes: [["bb", 20]],
    },
  },
  {
    id: "SCN-ante-per-player-001",
    title:
      "per_player の Ante: 全員が Blind より先に払い、Call 額と Uncalled の返却に数えない",
    source: "docs/02 §7 Ante の Pot での扱い（D128）/ #184",
    seats: [
      { playerId: "btn", stack: 200 },
      { playerId: "sb", stack: 200 },
      { playerId: "bb", stack: 200 },
      { playerId: "utg", stack: 200 },
    ],
    button: "btn",
    config: withAnte("per_player", 1, 2, 1),
    holes: {},
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // Call 額は BB の 2（Ante の 1 は数えない）。Raise の上限は Ante を払った後の Stack 199。
        player: "utg",
        action: raise(6),
        legal: [
          { type: "fold" },
          { type: "call", amount: 2 },
          { type: "raise", min: 4, max: 199 },
          { type: "all_in", amount: 199 },
        ],
      },
      { player: "btn", action: fold },
      { player: "sb", action: fold },
      { player: "bb", action: call },
      { player: "bb", action: check },
      { player: "utg", action: bet(10) },
      { player: "bb", action: fold },
    ],
    expect: {
      status: "complete",
      // Flop の Bet 10 は誰も Call しないので返す（Ante は関係しない）。
      // Pot = Ante 4 + SB 1 + BB 6 + UTG 6 = 17 → UTG。UTG 200 − 1 − 6 + 17 = 210 / BB 193 / SB 198 / Button 199（計 800）
      stacks: { btn: 199, sb: 198, bb: 193, utg: 210 },
      pot: 0,
      awards: { utg: 17 },
      pots: [
        { total: 17, eligible: ["utg"], awards: { utg: 17 }, showdown: false },
      ],
      // Button の左から（SB → BB → UTG → Button）。
      antes: [
        ["sb", 1],
        ["bb", 1],
        ["utg", 1],
        ["btn", 1],
      ],
      tailEvents: ["UNCALLED_BET_RETURNED", "POT_AWARDED", "HAND_FINISHED"],
    },
  },
  {
    id: "SCN-ante-per-player-short-bb-all-fold-001",
    title:
      "per_player の Ante で BB が Ante だけで All-in し相手が Fold: Fold した Player の Ante は返さず、残った BB が取る",
    // Property（Ante・不均等 Stack）の縮小済みの反例を昇格した（poker-engine-testing §5）。
    source: "docs/02 §7 Ante の Pot での扱い（D128）/ #184",
    seats: [
      { playerId: "bb", stack: 1 },
      { playerId: "btn", stack: 4 },
    ],
    // Heads-Up は Button = SB。Ante は Button の左（BB）から: BB 1（All-in）・Button 2。Blind は SB 1・BB 0。
    button: "btn",
    config: withAnte("per_player", 1, 2, 2),
    holes: {},
    board: "2c 7s 9d Jc 3h",
    steps: [
      {
        // BB は All-in なので Raise はできない。Call 額は BB の全額 2 − SB 1 = 1（Ante は数えない）で、残りの Stack 1 と同じ。
        player: "btn",
        action: fold,
        legal: [
          { type: "fold" },
          { type: "call", amount: 1 },
          { type: "all_in", amount: 2 },
        ],
      },
    ],
    expect: {
      status: "complete",
      // SB の 1 は BB の Blind（0）を超えるので返す。Ante（Dead Money）は返さない（D128）ので、Pot = BB 1 + Button の Ante 2 = 3 → BB。
      // BB 3 / Button 4 − 2 − 1 + 1 = 2（計 5）
      stacks: { bb: 3, btn: 2 },
      pot: 0,
      awards: { bb: 3 },
      pots: [
        { total: 3, eligible: ["bb"], awards: { bb: 3 }, showdown: false },
      ],
      antes: [
        ["bb", 1],
        ["btn", 2],
      ],
    },
  },
  {
    id: "SCN-ante-per-player-side-pot-001",
    title:
      "per_player の Ante で Short Stack が Ante だけで All-in: Ante が先で Blind は払えず、各自の Ante は Pot の段に入る",
    source: "docs/02 §7 Ante の Pot での扱い（D128）・§5 Side Pot / #184",
    seats: [
      { playerId: "btn", stack: 100 },
      { playerId: "sb", stack: 5 },
      { playerId: "bb", stack: 100 },
    ],
    button: "btn",
    config: withAnte("per_player", 10, 20, 10),
    holes: { sb: "As Ad", btn: "Ks Kd", bb: "Qs Qd" },
    board: "2c 7s 9d Jc 3h",
    steps: [
      // SB は Ante 5 で All-in（Blind は 0）。BB は Ante 10 と Blind 20。Call 額は 20。
      {
        player: "btn",
        action: call,
        legal: [
          { type: "fold" },
          { type: "call", amount: 20 },
          { type: "raise", min: 40, max: 90 },
          { type: "all_in", amount: 90 },
        ],
      },
      { player: "bb", action: check },
      ...checkDown("bb", "btn"),
    ],
    expect: {
      status: "complete",
      // Commit: SB 5 / BB 10 + 20 = 30 / Button 10 + 20 = 30。
      // Main Pot = 5 × 3 = 15（3 人）→ SB の AA。Side Pot = 25 × 2 = 50（BB・Button）→ Button の KK。
      // SB 15 / Button 100 − 30 + 50 = 120 / BB 70（計 205）
      stacks: { btn: 120, sb: 15, bb: 70 },
      pot: 0,
      awards: { sb: 15, btn: 50 },
      pots: [
        {
          total: 15,
          eligible: ["sb", "bb", "btn"],
          awards: { sb: 15 },
          showdown: true,
        },
        {
          total: 50,
          eligible: ["bb", "btn"],
          awards: { btn: 50 },
          showdown: true,
        },
      ],
      antes: [
        ["sb", 5],
        ["bb", 10],
        ["btn", 10],
      ],
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

  // Out-of-Turn で保留した操作（Player ごと）。
  const pending = new Map<string, PendingOutOfTurn>();

  for (const [i, step] of s.steps.entries()) {
    const where = `${s.id} step ${i}（${step.player} ${describeStep(step)}）`;
    let action: PlayerAction;
    if ("action" in step) {
      if (step.legal !== undefined) {
        expect(getLegalActions(state)?.actions, where).toEqual(step.legal);
      }
      action = step.action;
    } else {
      // Ruling: 裁定を確かめ、Canonical Action に決まったときだけ Engine に適用する。
      const held = pending.get(step.player);
      if ("resolveOutOfTurn" in step && held === undefined) {
        throw new Error(`${where}: 保留した Out-of-Turn が無い`);
      }
      const ruled =
        "physical" in step
          ? rulePhysicalActions(state, step.player, step.physical, config)
          : resolveOutOfTurn(state, held as PendingOutOfTurn, config);
      if (!ruled.ok) throw new Error(`${where}: ${ruled.error.message}`);
      expect(summarizeRuling(ruled.value), where).toEqual(step.ruling);
      if ("resolveOutOfTurn" in step) pending.delete(step.player);
      if (ruled.value.kind === "out_of_turn") {
        pending.set(step.player, ruled.value.pending);
      }
      if (ruled.value.kind !== "action") continue;
      action = ruled.value.action;
    }
    const result = applyAction(state, step.player, action);
    if ("reject" in step && step.reject !== undefined) {
      expect(result.ok, where).toBe(false);
      if (!result.ok) {
        expect(result.error.kind, where).toBe(step.reject.kind);
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
  expect(checkPotAwards(events)).toEqual([]);
  if (state.status === "complete") {
    expect(checkHandFinished(events, total)).toEqual([]);
  }
  expect(
    Object.fromEntries(state.players.map((p) => [p.playerId, p.stack])),
  ).toEqual(s.expect.stacks);
  if (s.expect.pot !== undefined) expect(state.pot).toBe(s.expect.pot);
  if (s.expect.awards !== undefined) {
    expect(
      Object.fromEntries(state.awards.map((a) => [a.playerId, a.amount])),
    ).toEqual(s.expect.awards);
  }
  if (s.expect.pots !== undefined) {
    const awarded = events.flatMap((e) =>
      e.type === "POT_AWARDED" ? [e] : [],
    );
    expect(awarded.map((e) => e.potIndex)).toEqual(awarded.map((_, i) => i));
    expect(
      awarded.map((e) => ({
        total: e.potTotal,
        eligible: e.eligible,
        awards: Object.fromEntries(e.awards.map((a) => [a.playerId, a.amount])),
        showdown: e.showdown,
      })),
    ).toEqual(s.expect.pots);
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
  if (s.expect.antes !== undefined) {
    expect(
      events.flatMap((e) =>
        e.type === "ANTE_POSTED" ? [[e.playerId, e.amount]] : [],
      ),
    ).toEqual(s.expect.antes);
  }
}

function describeStep(step: ScenarioStep): string {
  if ("action" in step) return step.action.type;
  if ("physical" in step) {
    return step.physical.map((a) => a.type).join("+");
  }
  return "resolve_out_of_turn";
}

/** 比べる形にそろえる（out_of_turn の保留の中身は Unit Test で見るので、ここでは種類と理由だけ）。 */
function summarizeRuling(r: RulingResult): ExpectedRuling {
  return r.kind === "action"
    ? { kind: r.kind, action: r.action, notes: r.notes }
    : { kind: r.kind, notes: r.notes };
}
