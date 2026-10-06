// Runtime の卓設定。値は Open Item の暫定値で、永久仕様ではない（Config に置いて差し替えられるようにする）。
import { fileURLToPath } from "node:url";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PHASE1_CASH_PRESET,
  type TableConfig,
} from "@proj-poker/engine";

/** 卓に座る Player。kind は Hero（ユーザー）か CPU か。displayName は表示用で、Engine は playerId だけを使う。 */
export interface SeatPlayer {
  readonly playerId: string;
  readonly displayName: string;
  readonly kind: "hero" | "cpu";
}

export interface TableSetup {
  readonly table: TableConfig;
  /** Session の最初の Hand の全員の Stack（均等 Stack。D70）。2 Hand 目以降は前 Hand の Stack を持ち越す（D80）。 */
  readonly startingStack: number;
  /** 席順（時計回り）。Hero はちょうど 1 人。 */
  readonly players: readonly SeatPlayer[];
}

/** 卓の既定の人数（6-max。Hero 1 人 + CPU 5 人）。 */
export const DEFAULT_TABLE_SIZE = 6;

/**
 * Hero 1 人 + CPU（人数 - 1）人の卓を作る。人数は Engine が扱える 2〜8（MIN_PLAYERS〜MAX_PLAYERS）。
 * CPU の人数・名前は OI-005（CPU Pool）の暫定値で、永久仕様ではない。Chip Preset は OI-004 の暫定値（PHASE1_CASH_PRESET）。
 * 席順は Hero → CPU 1 → CPU 2 …（時計回り）。Session の最初の Hand は席順の先頭（Hero）が Button で、
 * 以降の席と Button は Hand Orchestrator が前 Hand の結果から Position Engine で決める（D80）。
 */
export function buildTableSetup(tableSize: number): TableSetup {
  if (
    !Number.isSafeInteger(tableSize) ||
    tableSize < MIN_PLAYERS ||
    tableSize > MAX_PLAYERS
  ) {
    throw new RangeError(
      `卓の人数は ${MIN_PLAYERS}〜${MAX_PLAYERS}: ${tableSize}`,
    );
  }
  const cpus: SeatPlayer[] = Array.from({ length: tableSize - 1 }, (_, i) => ({
    playerId: `cpu${i + 1}`,
    displayName: `CPU ${i + 1}`,
    kind: "cpu",
  }));
  return {
    table: PHASE1_CASH_PRESET,
    startingStack: PHASE1_CASH_PRESET.startingStack,
    players: [{ playerId: "hero", displayName: "Hero", kind: "hero" }, ...cpus],
  };
}

/** 既定の卓: 6-max（Hero 1 人 + CPU 5 人）。 */
export const PHASE1_TABLE_SETUP: TableSetup =
  buildTableSetup(DEFAULT_TABLE_SIZE);

/**
 * 環境変数 TABLE_SIZE の値を卓の人数として読む。未設定・不正（範囲外・小数・文字列）なら既定の 6 人に戻す
 * （parseBotDelayMs と同じ作法）。UI での人数選択は作らず、起動時の設定だけで選ぶ。
 */
export function parseTableSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TABLE_SIZE;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= MIN_PLAYERS &&
    value <= MAX_PLAYERS
    ? value
    : DEFAULT_TABLE_SIZE;
}

/**
 * CPU の思考に見せる待ち時間（ミリ秒）の既定値。演出のためだけの値で、ルールには影響しない。
 * 環境変数 BOT_THINK_DELAY_MS で上書きできる。テストでは 0 を渡す。
 */
export const DEFAULT_BOT_THINK_DELAY_MS = 600;

/** 環境変数の値を待ち時間として読む。未設定・不正なら既定値に戻す（負数・小数・文字列は受け付けない）。 */
export function parseBotDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BOT_THINK_DELAY_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_BOT_THINK_DELAY_MS;
}

/**
 * CPU の 1 回の判断（OpponentAgent.decide の 1 呼び出し）を待つ上限（ミリ秒）。
 * 暫定値（OI-001 の Cost / Latency Policy が決まるまでの仮置き。永久仕様ではない）。
 * 超えたら「障害」として Hand を止める（RuleBot へ自動で切り替えない。D86）。
 * 環境変数 OPPONENT_TIMEOUT_MS で上書きできる。
 * #47 で 15000ms と置き、#50 の Claude の実測（最大 約 15.5 秒）で超える回があったため、最大の約 2 倍に見直した（docs/11 OI-001）。
 */
export const DEFAULT_OPPONENT_TIMEOUT_MS = 30_000;

/** 環境変数の値を判断待ちの上限として読む。未設定・不正（0 以下・小数・文字列）なら既定値に戻す。 */
export function parseOpponentTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_OPPONENT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_OPPONENT_TIMEOUT_MS;
}

/**
 * SQLite の DB ファイルの既定の置き場所: apps/server/data/poker.sqlite（gitignore 済み）。
 * src（dev）からも dist（start）からも 1 階層上なので、同じ場所になる。worktree ごとに別の DB になる。
 */
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../data/poker.sqlite", import.meta.url),
);

/** 環境変数 POKER_DB_PATH の値を DB の場所として読む。未設定・空なら既定の場所。":memory:" も受け付ける。 */
export function resolveDbPath(raw: string | undefined): string {
  return raw === undefined || raw.trim() === "" ? DEFAULT_DB_PATH : raw;
}

/**
 * Model Role ごとの具体モデル名（role-based config。docs/03 §3・docs/05 §13）。Domain Logic にモデル名を書かず、ここで解決する。
 * 値は暫定値（D85・OI-001。確定ではない）。Review の Role（review_standard / review_deep）は Review を作る Issue で足す。
 */
export const MODEL_ROLES = {
  opponent_fast: "claude-haiku-4-5",
} as const;

export type ModelRole = keyof typeof MODEL_ROLES;

/** CPU の判断に使う実装。既定は RuleBot（D71）。"claude" のときだけ Claude（Agent SDK・OAuth。D87）を使う。 */
export type OpponentProvider = "rulebot" | "claude";

/** 環境変数 OPPONENT_PROVIDER の値を読む。未設定・空なら RuleBot。知らない値は起動時に誤りとして止める（黙って RuleBot にしない）。 */
export function parseOpponentProvider(
  raw: string | undefined,
): OpponentProvider {
  if (raw === undefined || raw.trim() === "") return "rulebot";
  const value = raw.trim();
  if (value === "rulebot" || value === "claude") return value;
  throw new RangeError(
    `OPPONENT_PROVIDER は rulebot か claude: ${JSON.stringify(raw)}`,
  );
}
