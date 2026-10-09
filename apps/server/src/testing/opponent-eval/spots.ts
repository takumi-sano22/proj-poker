// AI Opponent Eval の代表 Spot（docs/09 §5「代表 Spot を固定 Regression Case として持つ」）。
// E2E（Hand を頭から CPU 同士で進める）にすると前の判断のブレで局面が揃わないので、
// 積んだ Deck と決めた Action の列で「判断する直前」まで Engine で進めた単発の局面にする（llm-quality-improvement の harness 1）。
// 入力は本番と同じく projectKnowledgeState と getLegalActions から作る（KnowledgeState を手で組み立てない。D28）。
import {
  PHASE1_CASH_PRESET,
  applyAction,
  cardToString,
  createDeck,
  getLegalActions,
  parseCards,
  projectKnowledgeState,
  startHand,
  tableConfigForLevel,
  type Card,
  type HandEvent,
  type HandState,
  type PlayerAction,
  type SeatInit,
  type TournamentConfig,
} from "@proj-poker/engine";
import { PHASE1_TABLE_SETUP } from "../../config.js";
import type { OpponentInput } from "../../opponents/opponent-agent.js";

/** 判断の直前まで進めた局面。input はその CPU に渡す入力そのもの（本番の cpuTurn と同じ作り方）。 */
export interface SpotFixture {
  readonly actorId: string;
  /** 判断の直前までの Event Log（漏れ検査で「その時点で知ってよい Card」を出すのに使う）。 */
  readonly events: readonly HandEvent[];
  readonly state: HandState;
  readonly input: OpponentInput;
}

export interface EvalSpot {
  /** 録画・集計のキー。変えると録画が使えなくなる。 */
  readonly id: string;
  readonly label: string;
  /** 判断する CPU と、その手札・Board（積む札）。 */
  readonly actorId: string;
  readonly holes: Readonly<Record<string, string>>;
  readonly board: string;
  /** 判断の直前までの Action（席の playerId と Action）。 */
  readonly script: readonly (readonly [string, PlayerAction])[];
  /**
   * 元にした代表 Spot の id（#155。Memory 等の層を足した Spot で使う）。Hand の ID はこちらから作り、層の有無の他は
   * 元の Spot と同じ Prompt にする（Hand の ID は KnowledgeState に入り、Prompt の引数になる）。
   */
  readonly baseSpotId?: string;
  /** 本番の入力に層（Memory・Tilt・Table Tendency）を足す（#155。本番の Orchestrator と同じく KnowledgeState に入れる）。 */
  readonly withLayers?: (input: OpponentInput) => OpponentInput;
  /** Tournament の Hand（#202）だけ。省略は本番の既定の Cash の卓。 */
  readonly tournament?: EvalTournament;
}

/** Tournament の Hand の局面（#202。review-eval の ScriptedTournament と同じ値に、Button と Context の有無を足したもの）。 */
export interface EvalTournament {
  /** Session の設定の Snapshot（D129）。 */
  readonly config: TournamentConfig;
  /** 参加人数（Prize Pool = 参加費 × 参加人数）。 */
  readonly entrants: number;
  /** この Hand の Level（1 始まり）と Session の何 Hand 目か。 */
  readonly level: number;
  readonly handNumber: number;
  readonly button: string;
  /** 席順（時計回り）と Hand の開始時の Stack（Bust した Player は座らない）。 */
  readonly seats: readonly SeatInit[];
  /**
   * Public Tournament Context を KnowledgeState に入れるか（本番の Tournament の Hand は true）。false は対照で、同じ札・Stack・Blind の
   * Hand から Context だけを外す（Prompt は Cash と同じ節の組み立てになる）。
   */
  readonly context: boolean;
}

// 本番の既定の卓（6-max・Hero 1 人 + CPU 5 人・100BB。席順は Hero → cpu1 → … → cpu5）。最初の Hand は Hero が Button なので、
// cpu1 = SB、cpu2 = BB、cpu3 = UTG、cpu4 = HJ、cpu5 = CO。playerId も本番と同じにし、CPU に見える入力の形を本番に揃える。
const SETUP = PHASE1_TABLE_SETUP;
const SEATS = SETUP.players.map((p) => ({
  playerId: p.playerId,
  stack: SETUP.startingStack,
}));
const BUTTON = SETUP.players[0]?.playerId ?? "hero";

const fold = { type: "fold" } as const;
const check = { type: "check" } as const;
const call = { type: "call" } as const;
const raise = (amount: number) => ({ type: "raise", amount }) as const;
const bet = (amount: number) => ({ type: "bet", amount }) as const;

/** CO が Open し、BB だけが Call した Heads-Up の Flop までの Action（Spot 3・4 の共通部分）。 */
const CO_OPEN_BB_CALL: readonly (readonly [string, PlayerAction])[] = [
  ["cpu3", fold],
  ["cpu4", fold],
  ["cpu5", raise(6)],
  ["hero", fold],
  ["cpu1", fold],
  ["cpu2", call],
];

/**
 * 代表 Spot（Issue #53）。手札は Persona で判断が分かれやすい境目の手にする（全員が同じ答えになる手では Persona の差が測れない）。
 * 額は PHASE1_CASH_PRESET（SB 1 / BB 2・Stack 200）の Chip。
 */
export const OPPONENT_EVAL_SPOTS: readonly EvalSpot[] = [
  {
    id: "preflop_open",
    label: "Preflop: UTG で最初に Open するか（KTo）",
    actorId: "cpu3",
    holes: { cpu3: "Kh Ts" },
    board: "",
    script: [],
  },
  {
    id: "preflop_facing_3bet",
    label: "Preflop: UTG の Open に BTN が 3-bet（AQo）",
    actorId: "cpu3",
    holes: { cpu3: "Ah Qd" },
    board: "",
    script: [
      ["cpu3", raise(6)],
      ["cpu4", fold],
      ["cpu5", fold],
      ["hero", raise(18)],
      ["cpu1", fold],
      ["cpu2", fold],
    ],
  },
  {
    id: "flop_cbet",
    label:
      "Flop: CO の Open に BB が Call、BB が Check して C-bet するか（AJo・K72r）",
    actorId: "cpu5",
    holes: { cpu5: "As Jh", cpu2: "9c 9d" },
    board: "Kc 7d 2s",
    script: [...CO_OPEN_BB_CALL, ["cpu2", check]],
  },
  {
    id: "river_facing_big_bet",
    label:
      "River: Board が K で、Pot を超える Bet に直面（QJs のトップペアだった手）",
    actorId: "cpu5",
    holes: { cpu5: "Qs Js", cpu2: "Ad 5d" },
    board: "Qh 8c 3d 2s Kd",
    script: [
      ...CO_OPEN_BB_CALL,
      // Flop: BB Check → CO が Bet 5 → BB Call（Pot 23）。Turn は両者 Check。River で BB が 26 の Overbet。
      ["cpu2", check],
      ["cpu5", bet(5)],
      ["cpu2", call],
      ["cpu2", check],
      ["cpu5", check],
      ["cpu2", bet(26)],
    ],
  },
];

/** Spot を Engine で判断の直前まで進める。手番が想定と違えば例外（Spot の定義の誤り）。 */
export function buildSpot(spot: EvalSpot): SpotFixture {
  const t = spot.tournament;
  const seats = t?.seats ?? SEATS;
  const button = t?.button ?? BUTTON;
  const level = t === undefined ? undefined : t.config.levels[t.level - 1];
  if (t !== undefined && level === undefined) {
    throw new Error(`${spot.id}: Level ${t.level} が設定に無い`);
  }
  const started = startHand({
    handId: `eval-${spot.baseSpotId ?? spot.id}`,
    seats,
    buttonPlayerId: button,
    // 本番と同じ Preset（Rule Profile の ID も同じ）。ID は Prompt の引数（録画の指紋）に入るので、変えたら録画を取り直す。
    // Tournament の Hand は本番と同じく、その Level の Blind・Ante にした卓（tableConfigForLevel）で始める（#202）。
    config:
      t === undefined || level === undefined
        ? PHASE1_CASH_PRESET
        : tableConfigForLevel(PHASE1_CASH_PRESET, level, t.config.anteKind),
    deal: { deck: stackedDeck(seats, button, spot.holes, spot.board) },
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
  if (!started.ok) throw new Error(`${spot.id}: ${started.error.kind}`);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  for (const [playerId, action] of spot.script) {
    const applied = applyAction(state, playerId, action);
    if (!applied.ok) {
      throw new Error(
        `${spot.id}: ${playerId} の ${action.type} が拒否された（${applied.error.kind}）`,
      );
    }
    state = applied.value.state;
    events.push(...applied.value.events);
  }
  const legal = getLegalActions(state);
  if (legal?.playerId !== spot.actorId) {
    throw new Error(
      `${spot.id}: 手番が ${spot.actorId} ではない（${legal?.playerId ?? "なし"}）`,
    );
  }
  // Tournament の Hand は本番の cpuTurn と同じく、Session の情報（設定の Snapshot・参加人数）を渡して Context を作る（#202）。
  const input: OpponentInput = {
    knowledge: projectKnowledgeState(
      events,
      spot.actorId,
      t?.context === true
        ? { tournament: { config: t.config, entrants: t.entrants } }
        : {},
    ),
    legal,
  };
  return {
    actorId: spot.actorId,
    events,
    state,
    input: spot.withLayers?.(input) ?? input,
  };
}

/**
 * 指定した Hole Cards と Board が配布順の位置に来るように 52 枚を並べる（Engine の testing/stacked-deck.ts と同じ配布順。
 * Engine の package は testing を公開しないので、Runtime 側のテスト補助として持つ）。
 * 配布は Button の左から 1 枚ずつ 2 周 → Board（Burn なし）。指定していない位置は使っていない札を新品の Deck 順に詰める。
 */
function stackedDeck(
  seats: readonly SeatInit[],
  buttonPlayerId: string,
  holes: Readonly<Record<string, string>>,
  board: string,
): Card[] {
  const n = seats.length;
  const button = seats.findIndex((s) => s.playerId === buttonPlayerId);
  const slots: (Card | undefined)[] = Array.from(
    { length: 52 },
    () => undefined,
  );
  for (let k = 0; k < n; k++) {
    const seat = seats[(button + 1 + k) % n];
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
