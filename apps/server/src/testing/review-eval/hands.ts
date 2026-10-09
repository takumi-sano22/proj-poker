// Review Eval の固定 Hand（docs/09 §6「Human-reviewed Hand を Regression Case にする」の最小形）と、Review のテストで使う Hand。
// 積んだ Deck と決めた Action の列で、Hand を最後（HAND_FINISHED）まで Engine で進める。Review の入力は本番と同じく
// Event Log から heroInformationSets で作る（判断時点の Information Set を手で組み立てない）。
import {
  PHASE1_CASH_PRESET,
  TOURNAMENT_PRESETS,
  applyAction,
  cardToString,
  createDeck,
  parseCards,
  recordSessionEvent,
  startHand,
  tableConfigForLevel,
  type Card,
  type HandEvent,
  type PlayerAction,
  type SeatInit,
  type TournamentConfig,
  type TournamentSessionInfo,
} from "@proj-poker/engine";
import { PHASE1_TABLE_SETUP } from "../../config.js";

export interface ScriptedHand {
  /** 録画・集計のキー。変えると録画が使えなくなる。 */
  readonly id: string;
  readonly label: string;
  readonly button: string;
  readonly holes: Readonly<Record<string, string>>;
  readonly board: string;
  /** Hand の終わりまでの Action（席の playerId と Action）。 */
  readonly script: readonly (readonly [string, PlayerAction])[];
  /** Tournament の Hand（#189）だけ。省略は本番の既定の Cash の卓。 */
  readonly tournament?: ScriptedTournament;
}

/** Tournament の Hand の設定（Session の設定の Snapshot・参加人数・この Hand の Level と席）。 */
export interface ScriptedTournament {
  readonly config: TournamentConfig;
  /** 参加人数（Prize Pool = 参加費 × 参加人数）。 */
  readonly entrants: number;
  /** この Hand の Level（1 始まり）と Session の何 Hand 目か。 */
  readonly level: number;
  readonly handNumber: number;
  /** 席順（時計回り）と Hand の開始時の Stack（Bust した Player は座らない）。 */
  readonly seats: readonly SeatInit[];
}

/** Tournament の Hand の Session の情報（Review の Evidence に渡す値。本番は Event Log の SESSION_STARTED から読む）。 */
export function tournamentSessionOf(
  hand: ScriptedHand,
): TournamentSessionInfo | undefined {
  return hand.tournament === undefined
    ? undefined
    : { config: hand.tournament.config, entrants: hand.tournament.entrants };
}

// 本番の既定の卓（6-max・Hero 1 人 + CPU 5 人・100BB。席順は hero → cpu1 → … → cpu5）。額は PHASE1_CASH_PRESET（SB 1 / BB 2）の Chip。
const SETUP = PHASE1_TABLE_SETUP;
const SEATS = SETUP.players.map((p) => ({
  playerId: p.playerId,
  stack: SETUP.startingStack,
}));

const fold = { type: "fold" } as const;
const check = { type: "check" } as const;
const call = { type: "call" } as const;
const raise = (amount: number) => ({ type: "raise", amount }) as const;
const bet = (amount: number) => ({ type: "bet", amount }) as const;

/**
 * Hero が BTN で UTG の Open に Call し、Flop の Bet に Call、Turn は両者 Check、River の大きい Bet に Call する（Showdown で負ける）。
 * Hero の判断: 0 = Preflop の Call・1 = Flop の Call・2 = Turn の Check・3 = River の Call（Pot 31 に 24 の Bet）。
 */
export const BTN_VS_UTG: ScriptedHand = {
  id: "btn_vs_utg",
  label:
    "BTN の Hero が UTG の Open に Call し、River の大きい Bet に Call（AJo・J83 → K）",
  button: "hero",
  holes: { hero: "Ah Jd", cpu3: "Ks Qs" },
  board: "Jc 8s 3d 2h Kc",
  script: [
    ["cpu3", raise(6)],
    ["cpu4", fold],
    ["cpu5", fold],
    ["hero", call],
    ["cpu1", fold],
    ["cpu2", fold],
    // Flop（Pot 15）: UTG が 8 を Bet、Hero が Call。
    ["cpu3", bet(8)],
    ["hero", call],
    // Turn（Pot 31）: 両者 Check。
    ["cpu3", check],
    ["hero", check],
    // River（Pot 31）: UTG が 24 を Bet、Hero が Call。
    ["cpu3", bet(24)],
    ["hero", call],
  ],
};

/**
 * Hero が SB で BTN の Open に Call し、Heads-Up で OOP。Flop は両者 Check、Turn で Straight になって最初に Bet（Solver の Root の判断）、
 * River は Check して BTN の Bet に Call。Hero の判断: 0 = Preflop の Call・1 = Flop の Check・2 = Turn の Bet・3 = River の Check・
 * 4 = River の Call。
 */
export const SB_VS_BTN: ScriptedHand = {
  id: "sb_vs_btn",
  label:
    "SB の Hero が BTN の Open に Call し、Turn で最初に Bet（98s・T72 → 6 で Straight）",
  button: "cpu5",
  holes: { hero: "9h 8h", cpu5: "Ac Td" },
  board: "Th 7c 2s 6d Kd",
  script: [
    ["cpu2", fold],
    ["cpu3", fold],
    ["cpu4", fold],
    ["cpu5", raise(6)],
    ["hero", call],
    ["cpu1", fold],
    // Flop（Pot 14）: 両者 Check。
    ["hero", check],
    ["cpu5", check],
    // Turn（Pot 14）: Hero が最初に 7 を Bet、BTN が Call。
    ["hero", bet(7)],
    ["cpu5", call],
    // River（Pot 28）: Hero が Check、BTN が 14 を Bet、Hero が Call。
    ["hero", check],
    ["cpu5", bet(14)],
    ["hero", call],
  ],
};

/**
 * 3 人で Flop へ進む Multiway の Hand（Solver は Unsupported: player_count）。Hero（BTN）は CO の Open に Call し、BB も Call。
 * Flop で CO が Bet、Hero が Call、BB が Fold。Turn・River は両者 Check。Hero の判断: 0 = Preflop の Call・1 = Flop の Call・
 * 2 = Turn の Check・3 = River の Check。
 */
export const MULTIWAY_FLOP: ScriptedHand = {
  id: "multiway_flop",
  label: "3 人の Flop で Bet に Call（KQs・Q95）",
  button: "hero",
  holes: { hero: "Kh Qh", cpu5: "Ad Qc", cpu2: "9c 8c" },
  board: "Qd 9s 5h 3c 2d",
  script: [
    ["cpu3", fold],
    ["cpu4", fold],
    ["cpu5", raise(6)],
    ["hero", call],
    ["cpu1", fold],
    ["cpu2", call],
    // Flop（Pot 19）: BB Check → CO が 10 を Bet → Hero Call → BB Fold。
    ["cpu2", check],
    ["cpu5", bet(10)],
    ["hero", call],
    ["cpu2", fold],
    // Turn・River: 両者 Check。
    ["cpu5", check],
    ["hero", check],
    ["cpu5", check],
    ["hero", check],
  ],
};

/**
 * 標準 6-max STT（D127）。下の Tournament の Hand はどちらも 4 人残り（6 人参加・3 位まで入賞なので Bubble）・
 * Level 5（75 / 150・Big Blind Ante 150）で、Chip の合計は参加人数 × Starting Stack（9,000）。
 */
const STT6 = TOURNAMENT_PRESETS.stt6_hand_count;

/**
 * Tournament の Bubble で、BTN の Hero（1,500 = 10BB）が Preflop で Shove し、SB・BB は Fold する（#189）。
 * Hero の判断: 0 = Shove（Call しうる相手は SB と BB。Hero が Fold した比較点では BB が Pot を取る）。
 */
export const BUBBLE_SHOVE: ScriptedHand = {
  id: "bubble_shove",
  label: "Tournament の Bubble で、BTN の Hero が 10BB で Shove（K9s）",
  button: "hero",
  holes: { hero: "Ks 9s", cpu1: "7d 2c", cpu2: "Jh 4h" },
  board: "Qc 8d 3s Td 2h",
  script: [
    ["cpu3", fold],
    ["hero", { type: "all_in" }],
    ["cpu1", fold],
    ["cpu2", fold],
  ],
  tournament: {
    config: STT6,
    entrants: 6,
    level: 5,
    handNumber: 41,
    seats: [
      { playerId: "hero", stack: 1_500 },
      { playerId: "cpu1", stack: 3_000 },
      { playerId: "cpu2", stack: 2_500 },
      { playerId: "cpu3", stack: 2_000 },
    ],
  },
};

/**
 * Tournament の Bubble で、BB の Hero（3,000）が BTN の Shove（2,500）に Call する（#189）。
 * Hero の判断: 0 = All-in への Call（相手は BTN。Hero が Fold したら BTN が Pot を取る）。
 */
export const BUBBLE_CALL: ScriptedHand = {
  id: "bubble_call",
  label: "Tournament の Bubble で、BB の Hero が BTN の Shove に Call（AQo）",
  button: "cpu2",
  holes: { hero: "Ah Qd", cpu2: "Kc Kd", cpu1: "8s 5c" },
  board: "9c 7h 2d 4s 3h",
  script: [
    ["cpu1", fold],
    ["cpu2", { type: "all_in" }],
    ["cpu3", fold],
    ["hero", call],
  ],
  tournament: {
    config: STT6,
    entrants: 6,
    level: 5,
    handNumber: 42,
    seats: [
      { playerId: "hero", stack: 3_000 },
      { playerId: "cpu1", stack: 1_500 },
      { playerId: "cpu2", stack: 2_500 },
      { playerId: "cpu3", stack: 2_000 },
    ],
  },
};

/**
 * Tournament の In the Money（3 人残り・3 位まで入賞・2 位と 3 位の賞金に差がある Pay Jump）で、BB の Short Stack の Hero（1,200 = 8BB）が
 * BTN の Chip Leader（4,500）の Shove に Call する（#202）。Hero の判断: 0 = All-in への Call（相手は BTN）。
 */
export const ITM_SHORT_CALL: ScriptedHand = {
  id: "itm_short_call",
  label:
    "Tournament の In the Money（Pay Jump）で、BB の Short Stack の Hero が BTN の Shove に Call（K7o）",
  button: "cpu1",
  holes: { hero: "Kd 7c", cpu1: "Ah 4d", cpu2: "8s 6s" },
  board: "9s 5h 2c Jd 3s",
  script: [
    ["cpu1", { type: "all_in" }],
    ["cpu2", fold],
    ["hero", call],
  ],
  tournament: {
    config: STT6,
    entrants: 6,
    level: 5,
    handNumber: 47,
    seats: [
      { playerId: "hero", stack: 1_200 },
      { playerId: "cpu1", stack: 4_500 },
      { playerId: "cpu2", stack: 3_300 },
    ],
  },
};

/**
 * Tournament の Bubble の前（5 人残り・Level 3 の 25 / 50・Big Blind Ante 50）で、All-in の関わらない Postflop の判断（#202）。
 * SB の Hero が BTN の Open に Call し、Flop は両者 Check、Turn で Straight になって最初に Bet、River は Check して BTN の Bet に Call。
 * Heads-Up の Turn の Root の判断だが、Tournament では Solver の Capability Gate が mode で Unsupported になる（ICM を扱わない。#189）。
 * Hero の判断: 0 = Preflop の Call・1 = Flop の Check・2 = Turn の Bet・3 = River の Check・4 = River の Call。
 */
export const TOURNAMENT_TURN_BET: ScriptedHand = {
  id: "tournament_turn_bet",
  label:
    "Tournament の Bubble の前で、SB の Hero が Turn で最初に Bet（98s・T72 → 6 で Straight。All-in なし）",
  button: "cpu5",
  holes: { hero: "9h 8h", cpu5: "Ac Td" },
  board: "Th 7c 2s 6d Kd",
  script: [
    ["cpu2", fold],
    ["cpu3", fold],
    ["cpu5", raise(125)],
    ["hero", call],
    ["cpu1", fold],
    // Flop（Pot 350）: 両者 Check。
    ["hero", check],
    ["cpu5", check],
    // Turn（Pot 350）: Hero が最初に 175 を Bet、BTN が Call。
    ["hero", bet(175)],
    ["cpu5", call],
    // River（Pot 700）: Hero が Check、BTN が 350 を Bet、Hero が Call。
    ["hero", check],
    ["cpu5", bet(350)],
    ["hero", call],
  ],
  tournament: {
    config: STT6,
    entrants: 6,
    level: 3,
    handNumber: 25,
    // 席順: hero（SB）→ cpu1（BB）→ cpu2（UTG）→ cpu3（CO）→ cpu5（BTN）。
    seats: [
      { playerId: "hero", stack: 2_000 },
      { playerId: "cpu1", stack: 1_800 },
      { playerId: "cpu2", stack: 1_700 },
      { playerId: "cpu3", stack: 1_500 },
      { playerId: "cpu5", stack: 2_000 },
    ],
  },
};

export const SCRIPTED_HANDS: readonly ScriptedHand[] = [
  BTN_VS_UTG,
  SB_VS_BTN,
  MULTIWAY_FLOP,
];

/**
 * Hand を最後まで Engine で進めた Event Log。途中で拒否された・終わらなかったら例外（Hand の定義の誤り）。
 * options.sessionId を渡したときだけ、本番の Session の最初の Hand と同じく開始の Event の直後に SESSION_STARTED を置く
 * （Tournament の Hand は設定の Snapshot を残す。D129。Review Eval の Hand は置かない＝録画の指紋を変えない）。
 */
export function playScriptedHand(
  hand: ScriptedHand,
  options: { readonly sessionId?: string } = {},
): HandEvent[] {
  const t = hand.tournament;
  const seats = t?.seats ?? SEATS;
  const level = t === undefined ? undefined : t.config.levels[t.level - 1];
  if (t !== undefined && level === undefined) {
    throw new Error(`${hand.id}: Level ${t.level} が設定に無い`);
  }
  const started = startHand({
    handId: `review-${hand.id}`,
    seats,
    buttonPlayerId: hand.button,
    // 本番と同じ Preset（Rule Profile の ID も同じ）。ID は Prompt の引数（録画の指紋）に入るので、変えたら録画を取り直す。
    // Tournament の Hand は本番と同じく、その Level の Blind・Ante にした卓（tableConfigForLevel）で始める。
    config:
      t === undefined || level === undefined
        ? PHASE1_CASH_PRESET
        : tableConfigForLevel(PHASE1_CASH_PRESET, level, t.config.anteKind),
    deal: { deck: stackedDeck(seats, hand.button, hand.holes, hand.board) },
    ...(t === undefined
      ? {}
      : {
          tournament: {
            level: t.level,
            handNumber: t.handNumber,
            playTimeMs: 0,
          },
        }),
  });
  if (!started.ok) throw new Error(`${hand.id}: ${started.error.kind}`);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  if (options.sessionId !== undefined) {
    const session = recordSessionEvent(state, {
      type: "SESSION_STARTED",
      sessionId: options.sessionId,
      ...(t === undefined ? {} : { tournament: t.config }),
    });
    state = session.state;
    events.push(...session.events);
  }
  for (const [playerId, action] of hand.script) {
    const applied = applyAction(state, playerId, action);
    if (!applied.ok) {
      throw new Error(
        `${hand.id}: ${playerId} の ${action.type} が拒否された（${applied.error.kind}）`,
      );
    }
    state = applied.value.state;
    events.push(...applied.value.events);
  }
  if (events.at(-1)?.type !== "HAND_FINISHED") {
    throw new Error(`${hand.id}: Hand が終わっていない`);
  }
  return events;
}

/**
 * 指定した Hole Cards と Board が配布順の位置に来るように 52 枚を並べる（Engine の testing/stacked-deck.ts と同じ配布順。
 * Engine の package は testing を公開しないので、Runtime 側のテスト補助として持つ。opponent-eval/spots.ts と同じ）。
 */
function stackedDeck(
  seats: readonly SeatInit[],
  button: string,
  holes: Readonly<Record<string, string>>,
  board: string,
): Card[] {
  const n = seats.length;
  const buttonIndex = seats.findIndex((s) => s.playerId === button);
  const slots: (Card | undefined)[] = Array.from(
    { length: 52 },
    () => undefined,
  );
  for (let k = 0; k < n; k++) {
    const seat = seats[(buttonIndex + 1 + k) % n];
    const hole = seat === undefined ? undefined : holes[seat.playerId];
    if (hole === undefined) continue;
    const [first, second] = parseCards(hole);
    slots[k] = first;
    slots[n + k] = second;
  }
  parseCards(board).forEach((card, i) => {
    slots[2 * n + i] = card;
  });
  const used = new Set(
    slots.filter((c): c is Card => c !== undefined).map(cardToString),
  );
  const rest = createDeck().filter((c) => !used.has(cardToString(c)));
  return slots.map((c) => c ?? (rest.shift() as Card));
}
