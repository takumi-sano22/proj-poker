// Runtime の卓設定。値は Open Item の暫定値で、永久仕様ではない（Config に置いて差し替えられるようにする）。
import { fileURLToPath } from "node:url";
import { PHASE1_CASH_PRESET, type TableConfig } from "@proj-poker/engine";

/** 卓に座る Player。kind は Hero（ユーザー）か CPU か。displayName は表示用で、Engine は playerId だけを使う。 */
export interface SeatPlayer {
  readonly playerId: string;
  readonly displayName: string;
  readonly kind: "hero" | "cpu";
}

export interface TableSetup {
  readonly table: TableConfig;
  /** 全員の Hand 開始時の Stack（Phase 1 は均等 Stack。D70）。 */
  readonly startingStack: number;
  /** 席順（時計回り）。Hero はちょうど 1 人。 */
  readonly players: readonly SeatPlayer[];
}

/**
 * Phase 1 の卓: Hero 1 人 + CPU 5 人（6-max）。
 * CPU の人数・名前は OI-005（CPU Pool）の暫定値。Chip Preset は OI-004 の暫定値（PHASE1_CASH_PRESET）。
 */
export const PHASE1_TABLE_SETUP: TableSetup = {
  table: PHASE1_CASH_PRESET,
  startingStack: PHASE1_CASH_PRESET.startingStack,
  players: [
    { playerId: "hero", displayName: "Hero", kind: "hero" },
    { playerId: "cpu1", displayName: "CPU 1", kind: "cpu" },
    { playerId: "cpu2", displayName: "CPU 2", kind: "cpu" },
    { playerId: "cpu3", displayName: "CPU 3", kind: "cpu" },
    { playerId: "cpu4", displayName: "CPU 4", kind: "cpu" },
    { playerId: "cpu5", displayName: "CPU 5", kind: "cpu" },
  ],
};

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
