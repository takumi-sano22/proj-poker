import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOT_THINK_DELAY_MS,
  DEFAULT_DB_PATH,
  DEFAULT_TABLE_SIZE,
  PHASE1_TABLE_SETUP,
  buildTableSetup,
  parseBotDelayMs,
  parseTableSize,
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

describe("parseTableSize / buildTableSetup（卓の人数 2〜8）", () => {
  it("2〜8 の整数だけを受け付け、未設定・不正なら既定の 6 人に戻す", () => {
    for (const n of [2, 6, 8]) expect(parseTableSize(String(n))).toBe(n);
    for (const raw of [undefined, "", " ", "1", "9", "0", "-2", "3.5", "abc"]) {
      expect(parseTableSize(raw)).toBe(DEFAULT_TABLE_SIZE);
    }
    expect(DEFAULT_TABLE_SIZE).toBe(6);
  });

  it.each([2, 6, 8])(
    "%i 人卓は Hero 1 人 + CPU の席順で、playerId が重複しない",
    (n) => {
      const setup = buildTableSetup(n);
      expect(setup.players).toHaveLength(n);
      expect(setup.players[0]).toMatchObject({
        playerId: "hero",
        kind: "hero",
      });
      expect(setup.players.filter((p) => p.kind === "cpu")).toHaveLength(n - 1);
      expect(new Set(setup.players.map((p) => p.playerId)).size).toBe(n);
      expect(setup.players.at(-1)?.playerId).toBe(
        n === 2 ? "cpu1" : `cpu${n - 1}`,
      );
    },
  );

  it("範囲外の人数は作らない（設定の取り違えを黙って通さない）", () => {
    for (const n of [1, 9, 2.5, Number.NaN]) {
      expect(() => buildTableSetup(n)).toThrow(RangeError);
    }
  });

  it("既定の卓（PHASE1_TABLE_SETUP）は 6-max", () => {
    expect(PHASE1_TABLE_SETUP.players.map((p) => p.playerId)).toEqual([
      "hero",
      "cpu1",
      "cpu2",
      "cpu3",
      "cpu4",
      "cpu5",
    ]);
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
