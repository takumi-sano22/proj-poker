import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_THINK_DELAY_MS, parseBotDelayMs } from "./config.js";

describe("parseBotDelayMs", () => {
  it("0 以上の整数だけを受け付け、未設定・不正なら既定値に戻す", () => {
    expect(parseBotDelayMs("0")).toBe(0);
    expect(parseBotDelayMs("250")).toBe(250);
    for (const raw of [undefined, "", " ", "-1", "1.5", "abc", "1e400"]) {
      expect(parseBotDelayMs(raw)).toBe(DEFAULT_BOT_THINK_DELAY_MS);
    }
  });
});
