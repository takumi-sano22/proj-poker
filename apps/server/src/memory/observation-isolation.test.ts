// Observation の抽出（memory/）の静的な境界の検査（#137・D106・不変条件 2・INV-INFO-002）。
// - apps/server/src/learning/（Hero の弱点: Score・Hypothesis・Profile）へ import をたどって届かない
// - Learning-only Reveal（packages/engine の learning-reveal.ts の projectLearningReveal）を参照しない
// 静的 import の検査は learning/learning-isolation.test.ts と同じ考え方（相対 import をたどる）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEMORY = join(SRC, "memory");
const LEARNING = join(SRC, "learning");

/** memory/ のモジュール（テストを除く）。 */
function memoryFiles(): string[] {
  return readdirSync(MEMORY)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(MEMORY, f));
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

/** コメントを除いたコード（コメントで名前を挙げただけのファイルを拾わない）。 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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

describe("Observation の抽出の境界（静的）", () => {
  it("memory/ から learning/（Hero の弱点）に届かない", () => {
    const entries = memoryFiles();
    // CPU の Private Hypothesis と Policy（#138）も検査の入口に入っている（Hero の Weakness Hypothesis と型・モジュールを共有しない）。
    expect(entries).toEqual(
      expect.arrayContaining([
        join(MEMORY, "observation.ts"),
        join(MEMORY, "opponent-hypothesis.ts"),
        join(MEMORY, "memory-policy.ts"),
      ]),
    );
    const reachable = reachableFrom(entries);
    // たどれていること自体を確かめる（正規表現が何も拾わないと、検査が空振りする）。
    expect(reachable.size).toBeGreaterThan(entries.length);
    const leaked = [...reachable]
      .filter((f) => f.startsWith(LEARNING))
      .map((f) => relative(SRC, f));
    expect(leaked).toEqual([]);
  });

  it("memory/ と、そこから届くモジュールは Learning-only Reveal を参照しない", () => {
    const reachable = reachableFrom(memoryFiles());
    const referencing = [...reachable]
      .filter((f) =>
        /projectLearningReveal|learning-reveal|LearningReveal/.test(codeOf(f)),
      )
      .map((f) => relative(SRC, f));
    expect(referencing).toEqual([]);
  });

  it("検査は learning/ への import と Learning-only Reveal の参照を拾える（陽性の対照）", () => {
    const reachable = reachableFrom([join(LEARNING, "profile.ts")]);
    expect(reachable).toContain(join(LEARNING, "hypothesis.ts"));
    const review = reachableFrom([join(SRC, "review", "review-service.ts")]);
    expect(
      [...review].some((f) => /projectLearningReveal/.test(codeOf(f))),
    ).toBe(true);
  });
});
