// テスト用の偽の Solver（CI では実 Solver を呼ばない。#81）。Node で動く .mjs を一時ディレクトリに書き出し、
// Adapter の command に渡す。呼ばれるたびに calls.log へ 1 行足し、受け取った入力を last-request.json に残す。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessCommand } from "../process.js";

/** 実 Solver（amaster97・#76 の River の固定 Spot）の出力を録画したもの。 */
export const RECORDED_RIVER_PATH = fileURLToPath(
  new URL("./amaster97-river.recorded.json", import.meta.url),
);

/**
 * 偽の Solver の振る舞い。
 * - recorded: 録画（argv の 3 番目のファイル）をそのまま出す
 * - sleep: pid を書いて終わらない（Timeout / Cancel の確認用）
 * - slow: 150ms 待ってから録画を出す（同時実行数の確認用。開始と終了の時刻を calls.log に書く）
 * - garbage / crash: 読めない出力 / exit 1
 * - json: argv の 3 番目の文字列をそのまま出す（形の違う JSON の確認用）
 */
export type FakeMode =
  "recorded" | "sleep" | "slow" | "garbage" | "crash" | "json";

const SCRIPT = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [mode, dir, extra] = process.argv.slice(2);
appendFileSync(dir + "/calls.log", mode + " start " + Date.now() + "\\n");
// 録画は整形（Prettier）で複数行になり得るので、実 Solver の runner と同じ 1 行の JSON にして出す。
const recorded = () => JSON.stringify(JSON.parse(readFileSync(extra, "utf8"))) + "\\n";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  writeFileSync(dir + "/last-request.json", input);
  if (mode === "recorded") process.stdout.write(recorded());
  else if (mode === "json") process.stdout.write(extra + "\\n");
  else if (mode === "garbage") process.stdout.write("Traceback? not json\\n");
  else if (mode === "crash") {
    process.stderr.write("ValueError: Invalid rank in 'Xx'\\n");
    process.exit(1);
  } else if (mode === "sleep") {
    writeFileSync(dir + "/pid", String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === "slow") {
    setTimeout(() => {
      appendFileSync(dir + "/calls.log", mode + " end " + Date.now() + "\\n");
      process.stdout.write(recorded());
    }, 150);
  }
});
`;

export interface FakeSolver {
  readonly dir: string;
  command(mode: FakeMode, extra?: string): ProcessCommand;
  /** 呼ばれた回数（calls.log の start の行数）。 */
  calls(): number;
  callLog(): string[];
  lastRequest(): unknown;
  /** sleep で起動したプロセスの pid。 */
  pid(): number;
  cleanup(): void;
}

export function createFakeSolver(): FakeSolver {
  const dir = mkdtempSync(join(tmpdir(), "fake-solver-"));
  const script = join(dir, "fake-solver.mjs");
  writeFileSync(script, SCRIPT);
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  const callLog = () =>
    read("calls.log")
      .split("\n")
      .filter((l) => l !== "");
  return {
    dir,
    command: (mode, extra) => ({
      file: process.execPath,
      args: [
        script,
        mode,
        dir,
        extra ??
          (mode === "recorded" || mode === "slow" ? RECORDED_RIVER_PATH : ""),
      ],
    }),
    calls: () => callLog().filter((l) => l.includes(" start ")).length,
    callLog,
    lastRequest: () => JSON.parse(read("last-request.json")) as unknown,
    pid: () => Number(read("pid")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 偽の導入先（install.json と、存在する Python の代わりに Node の実行ファイル）を作る。 */
export function writeFakeInstall(
  dir: string,
  overrides: Record<string, unknown> = {},
): string {
  const home = mkdtempSync(join(dir, "home-"));
  writeFileSync(
    join(home, "install.json"),
    JSON.stringify({
      solver: "amaster97/poker_solver",
      repository: "https://github.com/amaster97/poker_solver.git",
      commit: "f78f1b2bc338dd8cbb5226ecb8398bbdb3635676",
      version: "1.11.0",
      python: process.execPath,
      ...overrides,
    }),
  );
  return home;
}
