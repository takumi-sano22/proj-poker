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
import {
  checkHandFinished,
  checkInvariants,
  checkPotAwards,
  initialChipTotal,
} from "./testing/invariants.js";
import { stackedDeck } from "./testing/stacked-deck.js";

interface ScenarioStep {
  readonly player: string;
  readonly action: PlayerAction;
  /** 行動前の Legal Action（完全一致）。 */
  readonly legal?: readonly LegalAction[];
  /** 拒否されるべき入力。拒否後の State は変わらない。 */
  readonly reject?: { readonly kind: EngineError["kind"] };
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
    /** POT_AWARDED を発行順（Main Pot → Side Pot）に。potIndex は 0 からの連番であることも確かめる。 */
    readonly pots?: readonly ExpectedPot[];
    /** 最後の Action 以降に発行された Event 種別（順序どおり）。 */
    readonly tailEvents?: readonly HandEventType[];
    /** 1 度も発行されてはいけない Event 種別。 */
    readonly absentEvents?: readonly HandEventType[];
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
}
