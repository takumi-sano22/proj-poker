// Tournament の Session の型と、Tournament の設定（Versioned Config）・標準 Preset（D108・D127・D128・#183）。
// Tournament は既存の Hand Engine を複製せず、その上に TournamentSession 層を置く（D108）。この Module は設定の型・Preset・検証と、
// Session の開始の Event（SESSION_STARTED）に残した設定の Snapshot の読み方だけを持つ。
// Level の進行・Ante の支払い（#184）、Elimination・順位（#185）、Payout の計算（#186）はここに入れない。
import type { HandEvent } from "./hand-events.js";
import { isChipAmount, type TableConfig } from "./table-config.js";

/** Session の mode（D108・D129）。mode を指定しない Session と、Tournament の設定の無い旧版の Session は cash。 */
export type SessionMode = "cash" | "tournament";

/**
 * Ante の種類（D108・D128）。標準 STT は big_blind_ante。
 * - none: Ante なし
 * - per_player: 各自が払う（各自の拠出として Pot の段に入れる）
 * - big_blind_ante: BB の席が全員分をまとめて払う（BB を先に払い、残りで Ante。Main Pot に入れる。TDA 準拠）
 * Pot での扱いの実装は #184。
 */
export type AnteKind = "none" | "per_player" | "big_blind_ante";

/** Blind の 1 Level。ante は anteKind の 1 回分の額（big_blind_ante は BB の席が払う額、per_player は 1 人分の額）。 */
export interface BlindLevel {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
}

/**
 * Level を上げる基準（D108・D128）。最後の Level は上げずに続ける。
 * - hand_count: Session 内の Hand の数（論理順序。D117）で handsPerLevel ごとに 1 Level 上げる
 * - time_base: プレイ時間（Hand の開始から終わりまでの累計。アプリを閉じていた時間は数えない）で levelDurationMs ごとに 1 Level 上げる。
 *   Level は Hand の開始時に決めて HAND_STARTED に固定する。壁時計は経過時間の計測にだけ使い、意味上の順序には使わない
 * 進行の実装は #184。
 */
export type BlindSchedule =
  | { readonly kind: "hand_count"; readonly handsPerLevel: number }
  | { readonly kind: "time_base"; readonly levelDurationMs: number };

/**
 * Payout の構造（D108）。percentages は 1 位から順の割合（整数の %。合計 100・上位ほど多いか同じ）。
 * Custom Payout は kind を足して表す。Prize Pool（参加費 × 参加人数）・端数・同順位の扱いは #186（docs/02 §7）。
 */
export interface PayoutStructure {
  readonly kind: "percentages";
  readonly percentages: readonly number[];
}

/**
 * Tournament の設定（Versioned Config）。Session の開始の Event（SESSION_STARTED）にそのまま Snapshot として残し（D129）、
 * Preset を後で変えても、始めた Tournament はその Snapshot で続ける（Resume も Snapshot から戻す）。
 * 値はすべて OI-007 の暫定値で、永久仕様ではない（変えるときは version を上げた Preset にする）。
 */
export interface TournamentConfig {
  /** Preset の ID（Session の開始で選ぶ）。 */
  readonly presetId: TournamentPresetId;
  /** 設定の版（値を変えたら上げる）。 */
  readonly version: string;
  /** Session の最初の Hand の全員の Stack（Chip。D74）。 */
  readonly startingStack: number;
  /** Blind の Level 表（1 Level 目から順）。 */
  readonly levels: readonly BlindLevel[];
  readonly schedule: BlindSchedule;
  readonly anteKind: AnteKind;
  readonly payout: PayoutStructure;
  /** 参加費（pt。1 人分）。Prize Pool は参加費 × 参加人数（D127）。Chip とは別の単位。 */
  readonly entryFee: number;
}

/**
 * Session の設定。Session の開始の Event の Snapshot から作る（D129）。
 * mode を指定しない Session・Tournament の設定の無い旧版の Session は cash（既存の経路のまま）。
 */
export type SessionSettings =
  | { readonly mode: "cash" }
  | { readonly mode: "tournament"; readonly tournament: TournamentConfig };

/** Tournament の Session（D108）。Hand Engine の上に置く層で、Session の ID と開始時の設定の Snapshot を持つ。 */
export interface TournamentSession {
  readonly sessionId: string;
  readonly config: TournamentConfig;
}

/** 標準 Preset の ID（D108・D128）。 */
export const TOURNAMENT_PRESET_IDS = [
  "stt6_hand_count",
  "stt6_time_base",
] as const;
export type TournamentPresetId = (typeof TOURNAMENT_PRESET_IDS)[number];

export function isTournamentPresetId(
  value: unknown,
): value is TournamentPresetId {
  return (
    typeof value === "string" &&
    (TOURNAMENT_PRESET_IDS as readonly string[]).includes(value)
  );
}

/** 標準 Preset の設定の版（OI-007 の暫定値の 1 版目。Playtest 後に見直すときは上げる）。 */
export const TOURNAMENT_CONFIG_VERSION = "phase8_provisional_v1";

/**
 * 標準 6-max STT の Blind 表（D127。OI-007 の暫定値）。Big Blind Ante の額は BB と同じ。最後の Level は上げずに続ける。
 */
const STT6_LEVELS: readonly BlindLevel[] = (
  [
    [10, 20],
    [15, 30],
    [25, 50],
    [50, 100],
    [75, 150],
    [100, 200],
    [150, 300],
    [200, 400],
    [300, 600],
    [400, 800],
    [600, 1_200],
    [1_000, 2_000],
  ] as const
).map(([smallBlind, bigBlind]) => ({
  smallBlind,
  bigBlind,
  ante: bigBlind,
}));

/** 標準 6-max STT の Payout（D108。OI-007 の暫定値）: 1 位 50%・2 位 30%・3 位 20%。 */
const STT6_PAYOUT: PayoutStructure = {
  kind: "percentages",
  percentages: [50, 30, 20],
};

/**
 * 標準 Preset（OI-007 の暫定値。永久仕様ではない）。
 * - stt6_hand_count: 標準の 6-max STT（D127）。Starting Stack 1,500・10 Hand ごとに 1 Level・BBA・参加費 100pt
 * - stt6_time_base: time-base の Preset（D128）。標準と同じ Stack・Blind 表で、1 Level 10 分（プレイ時間）
 */
export const TOURNAMENT_PRESETS: Readonly<
  Record<TournamentPresetId, TournamentConfig>
> = {
  stt6_hand_count: {
    presetId: "stt6_hand_count",
    version: TOURNAMENT_CONFIG_VERSION,
    startingStack: 1_500,
    levels: STT6_LEVELS,
    schedule: { kind: "hand_count", handsPerLevel: 10 },
    anteKind: "big_blind_ante",
    payout: STT6_PAYOUT,
    entryFee: 100,
  },
  stt6_time_base: {
    presetId: "stt6_time_base",
    version: TOURNAMENT_CONFIG_VERSION,
    startingStack: 1_500,
    levels: STT6_LEVELS,
    schedule: { kind: "time_base", levelDurationMs: 10 * 60 * 1_000 },
    anteKind: "big_blind_ante",
    payout: STT6_PAYOUT,
    entryFee: 100,
  },
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Tournament の設定を検証する。正しければ null、誤りならその理由。
 * Preset と、保存済みの Snapshot（Resume で読む）の両方に使う。Snapshot は JSON から読むので、型を信用せずに値を確かめる。
 */
export function validateTournamentConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) {
    return "Tournament の設定が object でない";
  }
  const c = config as Partial<Record<keyof TournamentConfig, unknown>>;
  if (!isTournamentPresetId(c.presetId)) {
    return `知らない Preset: ${String(c.presetId)}`;
  }
  if (typeof c.version !== "string" || c.version === "") {
    return "設定の版が空";
  }
  if (!isPositiveInteger(c.startingStack)) {
    return `Starting Stack は 1 以上の整数: ${String(c.startingStack)}`;
  }
  const anteKind = c.anteKind;
  if (
    anteKind !== "none" &&
    anteKind !== "per_player" &&
    anteKind !== "big_blind_ante"
  ) {
    return `知らない Ante の種類: ${String(anteKind)}`;
  }
  if (!Array.isArray(c.levels) || c.levels.length === 0) {
    return "Blind の Level 表が空";
  }
  for (const [i, level] of (c.levels as unknown[]).entries()) {
    const l = (level ?? {}) as Partial<Record<keyof BlindLevel, unknown>>;
    if (
      !isPositiveInteger(l.smallBlind) ||
      !isPositiveInteger(l.bigBlind) ||
      l.bigBlind < l.smallBlind ||
      typeof l.ante !== "number" ||
      !isChipAmount(l.ante)
    ) {
      return `Level ${i + 1} は 0 < SB <= BB・0 <= Ante の整数`;
    }
    // Ante の無い Tournament に Ante の額を持たせない（どちらが正しいか読み手が迷う）。
    if (anteKind === "none" && l.ante !== 0) {
      return `Ante なしの設定の Level ${i + 1} に Ante の額がある`;
    }
  }
  // Session の最初の Hand は、Blind と Ante を払っても全員の Stack が残る（開始の時点で Hand が終わらない）額にする。
  const first = c.levels[0] as BlindLevel;
  if (c.startingStack <= first.bigBlind + first.ante) {
    return `Starting Stack は 1 Level 目の BB と Ante の合計より多くする: ${c.startingStack}`;
  }
  const schedule = (c.schedule ?? {}) as Record<string, unknown>;
  if (!(
    (schedule.kind === "hand_count" &&
      isPositiveInteger(schedule.handsPerLevel)) ||
    (schedule.kind === "time_base" &&
      isPositiveInteger(schedule.levelDurationMs))
  )) {
    return "Level を上げる基準は hand_count（handsPerLevel）か time_base（levelDurationMs）の 1 以上の整数";
  }
  const payout = (c.payout ?? {}) as Partial<
    Record<keyof PayoutStructure, unknown>
  >;
  if (
    payout.kind !== "percentages" ||
    !Array.isArray(payout.percentages) ||
    payout.percentages.length === 0 ||
    !payout.percentages.every(isPositiveInteger)
  ) {
    return "Payout は 1 以上の整数の % の列";
  }
  const percentages = payout.percentages;
  if (percentages.reduce((sum, p) => sum + p, 0) !== 100) {
    return `Payout の割合の合計は 100%: ${percentages.join(" / ")}`;
  }
  if (percentages.some((p, i) => i > 0 && p > (percentages[i - 1] as number))) {
    return `Payout は上位ほど多いか同じ: ${percentages.join(" / ")}`;
  }
  if (!isPositiveInteger(c.entryFee)) {
    return `参加費は 1 以上の整数: ${String(c.entryFee)}`;
  }
  return null;
}

/**
 * Tournament の Hand の卓の設定。Rule Profile（Betting・Ruling の規則）は Cash と共有し（D108。Hand の Rule の Invariant を共有）、
 * Blind だけをその Level の額にする。Ante を Hand に入れるのは #184。
 */
export function tableConfigForLevel(
  base: TableConfig,
  level: BlindLevel,
): TableConfig {
  return { ...base, smallBlind: level.smallBlind, bigBlind: level.bigBlind };
}

/**
 * Hand の Event Log から、その Hand で始まった Session の設定を読む（D129）。
 * SESSION_STARTED の無い Hand（Session の 2 Hand 目以降）は null。Tournament の設定の無い SESSION_STARTED（mode を指定しない
 * Session・旧版の行）は cash。Snapshot が壊れていれば（読めない設定を黙って cash として扱わない）例外にする。
 */
export function sessionSettingsOf(
  events: readonly HandEvent[],
): SessionSettings | null {
  const started = events.find((e) => e.type === "SESSION_STARTED");
  if (started?.type !== "SESSION_STARTED") return null;
  if (started.tournament === undefined) return { mode: "cash" };
  const invalid = validateTournamentConfig(started.tournament);
  if (invalid !== null) {
    throw new RangeError(`Tournament の設定の Snapshot を読めない: ${invalid}`);
  }
  return { mode: "tournament", tournament: started.tournament };
}
