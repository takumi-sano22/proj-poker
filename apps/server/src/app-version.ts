// アプリの版（Hand ごとの Best-effort Metadata の App Version。#97・docs/04 §9）。
// apps/server の package.json の version を読む。src（dev）からも dist（start）からも 1 階層上なので同じファイルになる
// （config.ts の DEFAULT_DB_PATH と同じ作法）。
import { readFileSync } from "node:fs";

/** package.json の version。読めない・空なら起動時に誤りとして止める（Metadata に黙って別の値を残さない）。 */
export function readAppVersion(
  url: URL = new URL("../package.json", import.meta.url),
): string {
  const { version } = JSON.parse(readFileSync(url, "utf8")) as {
    version?: unknown;
  };
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`package.json に version が無い: ${url.href}`);
  }
  return version;
}

export const APP_VERSION = readAppVersion();
