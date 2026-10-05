import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOT_THINK_DELAY_MS,
  DEFAULT_DB_PATH,
  parseBotDelayMs,
  resolveDbPath,
} from "./config.js";

describe("parseBotDelayMs", () => {
  it("0 以上の整数だけを受け付け、未設定・不正なら既定値に戻す", () => {
    expect(parseBotDelayMs("0")).toBe(0);
    expect(parseBotDelayMs("250")).toBe(250);
    for (const raw of [undefined, "", " ", "-1", "1.5", "abc", "1e400"]) {
      expect(parseBotDelayMs(raw)).toBe(DEFAULT_BOT_THINK_DELAY_MS);
    }
  });
});

describe("resolveDbPath", () => {
  it("未設定・空なら既定の場所、それ以外は指定どおり", () => {
    expect(resolveDbPath(undefined)).toBe(DEFAULT_DB_PATH);
    expect(resolveDbPath(" ")).toBe(DEFAULT_DB_PATH);
    expect(resolveDbPath(":memory:")).toBe(":memory:");
    expect(resolveDbPath("/tmp/x.sqlite")).toBe("/tmp/x.sqlite");
  });

  it("既定の場所は apps/server/data で、git の管理対象から外れている（DB をコミットしない）", () => {
    const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(relative(serverDir, DEFAULT_DB_PATH)).toBe(
      join("data", "poker.sqlite"),
    );
    // check-ignore は対象が ignore されていれば 0 で終わり、パスを出す（されていなければ例外）。
    const out = execFileSync("git", ["check-ignore", DEFAULT_DB_PATH], {
      cwd: serverDir,
      encoding: "utf8",
    });
    expect(out.trim()).toBe(DEFAULT_DB_PATH);
  });
});
