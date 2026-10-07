// Detailed Statistics の Projection（docs/07 §3・docs/04 §12・D103・D111）。
// Event Log（正本。D37）から全 Player の代表 Stats を再計算する決定論の純粋関数で、結果は保存しない（D111）。
// 入力に使うのは public の Event だけ（publicEvents。卓に座った全員が見聞きした事実）。Hole Cards（private）・Deck（engine）・
// CPU の判断の経緯や Session の運用・Hand の Metadata（system）は読まないので、Hidden Cards・Persona・Learning-only Reveal は
// 入力の経路に無い（Learning-only Full Reveal は learning-reveal.ts の別 Projection で、ここからは参照しない）。
// 指標は STAT_DEFINITIONS の 1 か所に集め、指標ごとに Numerator / Denominator / Opportunity Count を返す
// （`2 / 3` と `200 / 300` を同じに扱わないため。docs/07 §3）。指標を足すときは STAT_DEFINITIONS に要素を足す。
// Play 中の HUD には使わない（D32）。
import type { ActionType, HandEvent, Street } from "./hand-events.js";
import { publicEvents } from "./projection.js";
import type { PositionName } from "./range-config.js";
import { isAggressive, positionName } from "./range-model.js";

/**
 * 指標の定義の版。指標の意味（何を機会・分子・分母に数えるか）や、集計に入れる Hand の条件を変えたら上げる。
 * 定義は Tracker で一般的な数え方に合わせた Phase 6 の最初の版で、永久仕様にしない（D103: 後から指標を足せる境界）。
 * - phase6_stats_v1: 集計に入れるのは HAND_FINISHED まで済んだ Hand（打ち切った Hand・進行中の Hand は入れない）
 */
export const STATS_DEFINITION_VERSION = "phase6_stats_v1";

/** 指標 1 つの集計値。Percentage は numerator / denominator で、表示側が計算する。 */
export interface StatValue {
  readonly numerator: number;
  readonly denominator: number;
  /** その指標が起こりえた機会の数（Sample Size）。Percentage の指標では denominator と同じ。 */
  readonly opportunities: number;
}

/**
 * 指標の種類。
 * - percentage: numerator / denominator を割合で読む（numerator ≤ denominator = opportunities）
 * - ratio: numerator / denominator を比で読む（Aggression Factor。denominator は機会の数と一致しない）
 */
export type StatKind = "percentage" | "ratio";

/** Stats の定義が読む、1 Hand の公開の Action（ACTION_TAKEN）。 */
export interface StatsAction {
  readonly playerId: string;
  readonly street: Street;
  readonly action: ActionType;
  readonly toAmount: number;
  /** Bet / Raise、またはその時点の最高額を超える All-in（range-model.ts の isAggressive と同じ規則）。 */
  readonly aggressive: boolean;
  /** 同じ Street でこの Action より前にあった Aggressive な Action の数（Preflop の Blind は数えない）。 */
  readonly raisesBefore: number;
}

/** Stats の定義の入力になる 1 Hand（public の Event だけから作る）。 */
export interface StatsHand {
  readonly handId: string;
  /** 席順（時計回り）の Player と、その Hand での Position。 */
  readonly seats: readonly {
    readonly playerId: string;
    readonly position: PositionName;
  }[];
  /** ACTION_TAKEN を発行順に並べたもの。 */
  readonly actions: readonly StatsAction[];
}

/** 1 Hand の 1 Player の、指標への寄与（Street ごと）。 */
export interface StatContribution {
  readonly street: Street;
  readonly numerator: number;
  readonly denominator: number;
  readonly opportunities: number;
}

export interface StatDefinition {
  readonly id: string;
  readonly kind: StatKind;
  /** 何を機会・分子・分母に数えるか（表示とレビューのための説明）。 */
  readonly description: string;
  /** その Hand で、その Player に機会が無ければ空配列を返す。 */
  readonly contribute: (
    hand: StatsHand,
    playerId: string,
  ) => readonly StatContribution[];
}

/** 機会 1 回の寄与（Percentage の指標）。 */
function chance(street: Street, hit: boolean): StatContribution {
  return { street, numerator: hit ? 1 : 0, denominator: 1, opportunities: 1 };
}

function streetActions(hand: StatsHand, street: Street): StatsAction[] {
  return hand.actions.filter((a) => a.street === street);
}

/** Preflop で最初に Aggressive な Action をした Player（Open Raiser）。Raise が無ければ null。 */
function opener(hand: StatsHand): string | null {
  return (
    streetActions(hand, "preflop").find((a) => a.aggressive)?.playerId ?? null
  );
}

/** Preflop で最後に Aggressive な Action をした Player（Preflop Aggressor）。Raise が無ければ null。 */
function preflopAggressor(hand: StatsHand): string | null {
  return (
    streetActions(hand, "preflop").findLast((a) => a.aggressive)?.playerId ??
    null
  );
}

/** Bet / Raise を追加せずに Chip を出した Action（Call と、最高額以下の All-in）。 */
function isCall(a: StatsAction): boolean {
  return !a.aggressive && (a.action === "call" || a.action === "all_in");
}

/**
 * 指標の定義の一覧（指標の定義はここに集める。STATS_DEFINITION_VERSION の版の中身）。
 * Preflop の機会は「その Player が Preflop で Action した Hand」で数え、Blind を出しただけで Action が来なかった Hand
 * （Walk・Blind で All-in）は機会に入れない。
 */
export const STAT_DEFINITIONS = [
  {
    id: "vpip",
    kind: "percentage",
    description:
      "VPIP。機会: Preflop で Action した Hand。分子: Preflop で自分から Chip を出した（Call / Bet / Raise / All-in）Hand",
    contribute: (hand, playerId) => {
      const own = streetActions(hand, "preflop").filter(
        (a) => a.playerId === playerId,
      );
      if (own.length === 0) return [];
      return [
        chance(
          "preflop",
          own.some((a) => a.action !== "check" && a.action !== "fold"),
        ),
      ];
    },
  },
  {
    id: "pfr",
    kind: "percentage",
    description:
      "PFR。機会: Preflop で Action した Hand。分子: Preflop で Raise（Aggressive な Action）をした Hand",
    contribute: (hand, playerId) => {
      const own = streetActions(hand, "preflop").filter(
        (a) => a.playerId === playerId,
      );
      if (own.length === 0) return [];
      return [
        chance(
          "preflop",
          own.some((a) => a.aggressive),
        ),
      ];
    },
  },
  {
    id: "three_bet",
    kind: "percentage",
    description:
      "3-bet。機会: Preflop で Raise 1 回（Open）に直面して Action した Hand（Open した本人は除く）。分子: そこで Raise した",
    contribute: (hand, playerId) => {
      const open = opener(hand);
      if (open === null || open === playerId) return [];
      const facing = streetActions(hand, "preflop").find(
        (a) => a.playerId === playerId && a.raisesBefore === 1,
      );
      return facing === undefined ? [] : [chance("preflop", facing.aggressive)];
    },
  },
  {
    id: "fold_to_three_bet",
    kind: "percentage",
    description:
      "Fold to 3-bet。機会: Open した後に 3-bet（Raise 2 回目）に直面して Action した Hand。分子: そこで Fold した",
    contribute: (hand, playerId) => {
      if (opener(hand) !== playerId) return [];
      const facing = streetActions(hand, "preflop").find(
        (a) => a.playerId === playerId && a.raisesBefore === 2,
      );
      return facing === undefined
        ? []
        : [chance("preflop", facing.action === "fold")];
    },
  },
  {
    id: "cbet_flop",
    kind: "percentage",
    description:
      "Flop の Continuation Bet。機会: Preflop Aggressor が、Flop で誰も Bet していない時点で Action した Hand。分子: そこで Bet した",
    contribute: (hand, playerId) => {
      if (preflopAggressor(hand) !== playerId) return [];
      const first = streetActions(hand, "flop").find(
        (a) => a.playerId === playerId,
      );
      if (first === undefined || first.raisesBefore !== 0) return [];
      return [chance("flop", first.aggressive)];
    },
  },
  {
    id: "fold_to_cbet_flop",
    kind: "percentage",
    description:
      "Flop の Fold to Continuation Bet。機会: Preflop Aggressor の Flop の Continuation Bet に（Raise の前に）直面して Action した Hand。分子: そこで Fold した",
    contribute: (hand, playerId) => {
      const aggressor = preflopAggressor(hand);
      if (aggressor === null || aggressor === playerId) return [];
      const flop = streetActions(hand, "flop");
      const firstBet = flop.findIndex((a) => a.aggressive);
      if (firstBet < 0 || flop[firstBet]?.playerId !== aggressor) return [];
      const facing = flop
        .slice(firstBet + 1)
        .find((a) => a.playerId === playerId && a.raisesBefore === 1);
      return facing === undefined
        ? []
        : [chance("flop", facing.action === "fold")];
    },
  },
  {
    id: "aggression_frequency",
    kind: "percentage",
    description:
      "Postflop の Aggression Frequency。機会: Postflop の Check 以外の Action（Bet / Raise / Call / Fold）。分子: Bet / Raise",
    contribute: (hand, playerId) =>
      hand.actions
        .filter(
          (a) =>
            a.playerId === playerId &&
            a.street !== "preflop" &&
            a.action !== "check",
        )
        .map((a) => chance(a.street, a.aggressive)),
  },
  {
    id: "aggression_factor",
    kind: "ratio",
    description:
      "Postflop の Aggression Factor。分子: Postflop の Bet / Raise の回数。分母: Postflop の Call の回数。機会: その 2 つの合計",
    contribute: (hand, playerId) =>
      hand.actions
        .filter(
          (a) =>
            a.playerId === playerId &&
            a.street !== "preflop" &&
            (a.aggressive || isCall(a)),
        )
        .map((a) => ({
          street: a.street,
          numerator: a.aggressive ? 1 : 0,
          denominator: a.aggressive ? 0 : 1,
          opportunities: 1,
        })),
  },
] as const satisfies readonly StatDefinition[];

export type StatId = (typeof STAT_DEFINITIONS)[number]["id"];

export type StatTable = Readonly<Record<StatId, StatValue>>;

export interface PlayerStats {
  readonly playerId: string;
  /** 集計に入れた Hand のうち、この Player が座っていた数。 */
  readonly hands: number;
  readonly overall: StatTable;
  /** その Hand での Position ごと（全 Position を持ち、機会の無い Position は 0）。 */
  readonly byPosition: Readonly<Record<PositionName, StatTable>>;
  /** Street ごと（全 Street を持ち、その Street に機会の無い指標は 0）。 */
  readonly byStreet: Readonly<Record<Street, StatTable>>;
}

export interface StatsProjection {
  readonly version: typeof STATS_DEFINITION_VERSION;
  /** 集計に入れた Hand の数（終わっていない Hand・除外した Hand は数えない）。 */
  readonly handCount: number;
  /** playerId の昇順（入力の Hand の順に依らない）。 */
  readonly players: readonly PlayerStats[];
}

export interface StatsOptions {
  /**
   * 集計から除く Hand の handId（D116: Drill の Hand は通常の集計から除く。drills テーブルは #117 で作るので、
   * 呼び出し側が渡す）。
   */
  readonly excludeHandIds?: ReadonlySet<string>;
}

const POSITIONS: readonly PositionName[] = [
  "UTG",
  "HJ",
  "CO",
  "BTN",
  "SB",
  "BB",
];
const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river"];

/**
 * Hand ごとの Event Log から、全 Player の Stats を計算する。
 * 同じ Event Log からは（Hand を渡す順に依らず）同じ結果になる。
 */
export function projectPlayerStats(
  hands: readonly (readonly HandEvent[])[],
  options: StatsOptions = {},
): StatsProjection {
  const exclude = options.excludeHandIds ?? new Set<string>();
  const players = new Map<string, MutablePlayerStats>();
  let handCount = 0;

  for (const events of hands) {
    const hand = toStatsHand(events);
    if (hand === null || exclude.has(hand.handId)) continue;
    handCount++;
    for (const seat of hand.seats) {
      const stats = players.get(seat.playerId) ?? emptyPlayer(seat.playerId);
      players.set(seat.playerId, stats);
      stats.hands++;
      for (const def of STAT_DEFINITIONS) {
        for (const c of def.contribute(hand, seat.playerId)) {
          add(stats.overall[def.id], c);
          add(stats.byPosition[seat.position][def.id], c);
          add(stats.byStreet[c.street][def.id], c);
        }
      }
    }
  }

  return {
    version: STATS_DEFINITION_VERSION,
    handCount,
    // locale に依らない順にする（同じ入力から同じ並び）。
    players: [...players.values()].sort((a, b) =>
      a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0,
    ),
  };
}

/**
 * 1 Hand の Event Log を、public の Event だけから Stats の入力へ畳み込む。
 * HAND_FINISHED まで済んでいない Hand（進行中・HAND_ABORTED で打ち切った Hand）は null（集計に入れない）。
 */
export function toStatsHand(events: readonly HandEvent[]): StatsHand | null {
  const visible = publicEvents(events);
  if (!visible.some((e) => e.type === "HAND_FINISHED")) return null;
  const started = visible.find((e) => e.type === "HAND_STARTED");
  if (started === undefined) {
    // 終わった Hand に開始の Event が無いのは壊れた Log。黙って読み飛ばさない。
    throw new RangeError("HAND_STARTED の無い Hand の Event Log は読めない");
  }

  const n = started.seats.length;
  const button = started.seats.findIndex(
    (s) => s.playerId === started.buttonPlayerId,
  );
  const seats = started.seats.map((s, i) => ({
    playerId: s.playerId,
    position: positionName((i - button + n) % n, n),
  }));

  const actions: StatsAction[] = [];
  let street: Street | null = null;
  let currentBet = 0;
  let raises = 0;
  for (const e of visible) {
    if (e.type !== "ACTION_TAKEN") continue;
    if (e.street !== street) {
      // Street が変わったら最高額と Raise の数を数え直す。Preflop は BB の額から（Blind は Raise に数えない）。
      street = e.street;
      currentBet = street === "preflop" ? started.bigBlind : 0;
      raises = 0;
    }
    const aggressive = isAggressive(e, currentBet);
    actions.push({
      playerId: e.playerId,
      street: e.street,
      action: e.action,
      toAmount: e.toAmount,
      aggressive,
      raisesBefore: raises,
    });
    if (aggressive) raises++;
    currentBet = Math.max(currentBet, e.toAmount);
  }
  return { handId: started.handId, seats, actions };
}

interface MutableStatValue {
  numerator: number;
  denominator: number;
  opportunities: number;
}

type MutableStatTable = Record<StatId, MutableStatValue>;

interface MutablePlayerStats {
  readonly playerId: string;
  hands: number;
  readonly overall: MutableStatTable;
  readonly byPosition: Record<PositionName, MutableStatTable>;
  readonly byStreet: Record<Street, MutableStatTable>;
}

function emptyTable(): MutableStatTable {
  return Object.fromEntries(
    STAT_DEFINITIONS.map((d) => [
      d.id,
      { numerator: 0, denominator: 0, opportunities: 0 },
    ]),
  ) as MutableStatTable;
}

function emptyPlayer(playerId: string): MutablePlayerStats {
  return {
    playerId,
    hands: 0,
    overall: emptyTable(),
    byPosition: Object.fromEntries(
      POSITIONS.map((p) => [p, emptyTable()]),
    ) as Record<PositionName, MutableStatTable>,
    byStreet: Object.fromEntries(
      STREETS.map((s) => [s, emptyTable()]),
    ) as Record<Street, MutableStatTable>,
  };
}

function add(target: MutableStatValue, c: StatContribution): void {
  target.numerator += c.numerator;
  target.denominator += c.denominator;
  target.opportunities += c.opportunities;
}
