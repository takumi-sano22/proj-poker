import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOT_THINK_DELAY_MS,
  DEFAULT_DB_PATH,
  DEFAULT_OPPONENT_TIMEOUT_MS,
  DEFAULT_PERSONA_ROTATION,
  DEFAULT_SOLVER_ITERATIONS,
  DEFAULT_SOLVER_MAX_CONCURRENCY,
  DEFAULT_SOLVER_TIMEOUT_MS,
  DEFAULT_TABLE_SIZE,
  MODEL_ROLES,
  PHASE1_TABLE_SETUP,
  buildTableSetup,
  parseBotDelayMs,
  parseOpponentProvider,
  parseOpponentTimeoutMs,
  parsePersonaRotation,
  parseSolverIterations,
  parseSolverMaxConcurrency,
  parseSolverTimeoutMs,
  parseTableSize,
  resolveDbPath,
  resolveSolverHome,
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

describe("parseOpponentTimeoutMs", () => {
  it("1 以上の整数だけを受け付け、未設定・不正なら既定値（暫定値）に戻す", () => {
    expect(parseOpponentTimeoutMs("1")).toBe(1);
    expect(parseOpponentTimeoutMs("8000")).toBe(8000);
    for (const raw of [undefined, "", " ", "0", "-1", "1.5", "abc", "1e400"]) {
      expect(parseOpponentTimeoutMs(raw)).toBe(DEFAULT_OPPONENT_TIMEOUT_MS);
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
      expect(setup.players.at(-1)?.playerId).toBe(`cpu${n - 1}`);
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

describe("Persona の割り当て（#51・OI-005 の暫定値）", () => {
  it("既定の 6-max は CPU 1〜5 に席順で TAG Regular・LAG・Nit・Calling Station・Weak-tight Recreational を当てる（Hero には当てない）", () => {
    expect(PHASE1_TABLE_SETUP.personas).toEqual({
      cpu1: "tag_regular",
      cpu2: "lag",
      cpu3: "nit",
      cpu4: "calling_station",
      cpu5: "weak_tight_recreational",
    });
    expect(buildTableSetup(6)).toEqual(buildTableSetup(6));
  });

  it("CPU が割り当て順より多ければ先頭から繰り返し、少なければ先頭から使う", () => {
    expect(buildTableSetup(8).personas).toEqual({
      cpu1: "tag_regular",
      cpu2: "lag",
      cpu3: "nit",
      cpu4: "calling_station",
      cpu5: "weak_tight_recreational",
      cpu6: "maniac",
      cpu7: "tag_regular",
    });
    expect(buildTableSetup(2, ["maniac", "nit"]).personas).toEqual({
      cpu1: "maniac",
    });
    expect(buildTableSetup(4, ["nit"]).personas).toEqual({
      cpu1: "nit",
      cpu2: "nit",
      cpu3: "nit",
    });
    expect(() => buildTableSetup(6, [])).toThrow(RangeError);
  });

  it("Hero への応答に載る players には Persona を入れない（Secret Persona。D28）", () => {
    for (const p of buildTableSetup(8).players) {
      expect(Object.keys(p).sort()).toEqual([
        "displayName",
        "kind",
        "playerId",
      ]);
    }
  });

  it("CPU_PERSONAS はカンマ区切りの Preset ID だけを受け付け、未設定・空なら既定、知らない ID は起動時の誤りにする", () => {
    expect(parsePersonaRotation(undefined)).toBe(DEFAULT_PERSONA_ROTATION);
    expect(parsePersonaRotation(" ")).toBe(DEFAULT_PERSONA_ROTATION);
    expect(parsePersonaRotation("maniac, nit ,lag")).toEqual([
      "maniac",
      "nit",
      "lag",
    ]);
    for (const raw of ["tag", "maniac,", "Maniac", "difficulty"]) {
      expect(() => parsePersonaRotation(raw)).toThrow(RangeError);
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

describe("parseOpponentProvider", () => {
  it("未設定・空なら RuleBot、rulebot / claude はそのまま、知らない値は起動時の誤りにする", () => {
    for (const raw of [undefined, "", " "]) {
      expect(parseOpponentProvider(raw)).toBe("rulebot");
    }
    expect(parseOpponentProvider("rulebot")).toBe("rulebot");
    expect(parseOpponentProvider("claude")).toBe("claude");
    expect(parseOpponentProvider(" claude ")).toBe("claude");
    for (const raw of ["Claude", "anthropic", "true"]) {
      expect(() => parseOpponentProvider(raw)).toThrow(RangeError);
    }
  });
});

describe("MODEL_ROLES", () => {
  it("opponent_fast は暫定値（D85・OI-001）の claude-haiku-4-5", () => {
    expect(MODEL_ROLES.opponent_fast).toBe("claude-haiku-4-5");
  });
});

describe("Solver の設定（#81）", () => {
  it("POKER_SOLVER_HOME は未設定・空なら null（Solver 未導入として扱う）", () => {
    expect(resolveSolverHome(undefined)).toBeNull();
    expect(resolveSolverHome(" ")).toBeNull();
    expect(resolveSolverHome("/opt/solver")).toBe("/opt/solver");
  });

  it("Timeout・同時実行数・Iteration は正の整数だけを受け付け、未設定・不正なら既定値に戻す", () => {
    const cases = [
      [parseSolverTimeoutMs, DEFAULT_SOLVER_TIMEOUT_MS],
      [parseSolverMaxConcurrency, DEFAULT_SOLVER_MAX_CONCURRENCY],
      [parseSolverIterations, DEFAULT_SOLVER_ITERATIONS],
    ] as const;
    for (const [parse, fallback] of cases) {
      expect(parse("3")).toBe(3);
      for (const raw of [undefined, "", "0", "-1", "1.5", "abc"]) {
        expect(parse(raw)).toBe(fallback);
      }
    }
    // 既定の同時実行数は 1（Solver は CPU・メモリを使う）。
    expect(DEFAULT_SOLVER_MAX_CONCURRENCY).toBe(1);
  });
});
