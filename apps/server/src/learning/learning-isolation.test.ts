// 不変条件 2（情報境界・D28）: ユーザーの弱点（Hypothesis・Player Profile・Score）は、CPU の KnowledgeState・Prompt・CPU Memory に渡さない。
// CPU の判断を組み立てるコード（opponents/ と、CPU の手番を進める hand-orchestrator.ts）から import をたどり、
// learning/ のモジュールに届かないことを確かめる（届かなければ、CPU の入力に弱点が入る経路が無い）。
// KnowledgeState を作る Engine（packages/engine）は apps/server を import できない（パッケージの境界）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEARNING = join(SRC, "learning");

/** CPU の判断の入口（テストを除く）。 */
function cpuEntryFiles(): string[] {
  const opponents = join(SRC, "opponents");
  return [
    ...readdirSync(opponents)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(opponents, f)),
    join(SRC, "hand-orchestrator.ts"),
  ];
}

/** ファイルの相対 import（`import ... from "./x.js"` / `export ... from` / `import("./x.js")`）を .ts のパスにして返す。 */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [
    ...text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g),
    ...text.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((m) => m[1] ?? "");
  return specs.map((spec) =>
    resolve(dirname(file), spec.replace(/\.js$/, ".ts")),
  );
}

/** 入口から相対 import をたどって届く apps/server/src のファイル。 */
function reachableFrom(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    stack.push(...relativeImports(file));
  }
  return seen;
}

describe("不変条件 2: ユーザーの弱点を CPU の入力に渡さない", () => {
  it("CPU の判断のコードから learning/（Hypothesis・Profile・Score）に届かない", () => {
    const entries = cpuEntryFiles();
    expect(entries.length).toBeGreaterThan(1);
    const reachable = reachableFrom(entries);
    // たどれていること自体を確かめる（正規表現が何も拾わないと、検査が空振りする）。
    expect(reachable.size).toBeGreaterThan(entries.length);
    const leaked = [...reachable]
      .filter((f) => f.startsWith(LEARNING))
      .map((f) => relative(SRC, f));
    expect(leaked).toEqual([]);
  });

  it("検査は learning/ への import を拾える（陽性の対照）", () => {
    const reachable = reachableFrom([join(LEARNING, "profile.ts")]);
    expect(reachable).toContain(join(LEARNING, "hypothesis.ts"));
    expect(reachable).toContain(join(LEARNING, "score.ts"));
  });
});
