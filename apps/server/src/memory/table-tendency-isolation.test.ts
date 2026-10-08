// Table Tendency（#141・D106）の情報境界の検査（不変条件 2・3。docs/05 §5）。
// 1. 静的: Table Tendency のモジュールから import をたどっても、Hero の弱点（learning/）・CPU の Private Hypothesis / Memory の要約・
//    Tilt に届かず、Learning-only Reveal を参照しない（個々の CPU の Private Memory を集約して作らない）
// 2. 動的: Claude の CPU の query() と Review の query() を Fake にして（Claude は呼ばない。D87）Session を進め、全 Prompt を走査する。
//    - CPU の Prompt の卓の傾向の節は、その CPU が座っていた、その Hand より前に保存した Hand の public の Event から作った値だけで、
//      Hand が 0 なら節ごと無い（Session の最初の Hand は今と同じ Prompt）
//    - Review（Pass A）の Prompt・Hero への API の応答・Event Log に Table Tendency が出ない（Review の Evidence にはまだつながない）
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { InMemoryEventStore } from "../event-store.js";
import { createClaudeOpponentFactory } from "../opponents/claude-opponent.js";
import { createFakeReviewQuery } from "../review/fake-review-query.js";
import type { ReviewStatus } from "../review/review-service.js";
import {
  buildTableTendency,
  loadTableTendencySources,
} from "./table-tendency.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = [
  join(SRC, "memory", "table-tendency.ts"),
  join(SRC, "memory", "table-tendency-policy.ts"),
];

/** ファイルの相対 import（`from "./x.js"` / `import("./x.js")`）を .ts のパスにして返す。 */
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

/** コメントを除いたコード（コメントで名前を挙げただけのファイルを拾わない）。 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Table Tendency の境界（静的）", () => {
  it("Hero の弱点・CPU の Private Hypothesis / Memory の要約・Tilt のモジュールに届かず、Learning-only Reveal を参照しない", () => {
    const reachable = reachableFrom(ENTRIES);
    // たどれていること自体を確かめる（Observation の whitelist を経由する）。
    expect(reachable).toContain(join(SRC, "memory", "observation.ts"));
    const forbidden = [
      join(SRC, "memory", "opponent-hypothesis.ts"),
      join(SRC, "memory", "memory-summary.ts"),
      join(SRC, "memory", "memory-policy.ts"),
      join(SRC, "opponents", "tilt.ts"),
      join(SRC, "opponents", "tilt-policy.ts"),
    ];
    expect(
      [...reachable]
        .filter(
          (f) =>
            forbidden.includes(f) || f.startsWith(join(SRC, "learning") + "/"),
        )
        .map((f) => relative(SRC, f)),
    ).toEqual([]);
    expect(
      [...reachable]
        .filter((f) =>
          /projectLearningReveal|learning-reveal|LearningReveal/.test(
            codeOf(f),
          ),
        )
        .map((f) => relative(SRC, f)),
    ).toEqual([]);
    // 検査が経路をたどれている（Orchestrator からは Table Tendency に届く。陽性の対照）。
    expect(reachableFrom([join(SRC, "hand-orchestrator.ts")])).toContain(
      ENTRIES[0],
    );
  });
});

let apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function result(output: unknown): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: output,
  } as unknown as SDKMessage;
}

/** Prompt の卓の傾向の節の JSON（節が無ければ undefined）。 */
function tendencyIn(prompt: string): unknown {
  const sections = prompt.split("\n\n");
  const at = sections.findIndex((s) => s.startsWith("## 卓の傾向"));
  return at < 0 ? undefined : JSON.parse(sections[at + 1] ?? "");
}

describe("Table Tendency の境界（Prompt の動的な走査）", () => {
  it("CPU の Prompt の卓の傾向は、その CPU が座っていた前の Hand の public の Event からの値だけで、Review・Hero への応答・Event Log に出ない", async () => {
    const store = new InMemoryEventStore();
    let handNo = 0;
    let seedNo = 0;
    const cpuPrompts: { handId: string; playerId: string; prompt: string }[] =
      [];
    // CPU の Fake: Schema の enum から call → check → fold の順に選ぶ。
    const cpuQuery: ClaudeQuery = ({ prompt, options }) => {
      cpuPrompts.push({
        handId: `hand-${handNo}`,
        playerId: /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "",
        prompt,
      });
      const choices = (
        options.outputFormat?.schema as {
          properties: { action: { enum: string[] } };
        }
      ).properties.action.enum;
      const action =
        ["call", "check", "fold"].find((a) => choices.includes(a)) ?? "fold";
      return (async function* () {
        await Promise.resolve();
        yield result({ action });
      })();
    };
    const reviewPrompts: string[] = [];
    const fakeReview = createFakeReviewQuery("improvement_suggested");
    const reviewQuery: ClaudeQuery = (args) => {
      reviewPrompts.push(args.prompt);
      return fakeReview(args);
    };
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      store,
      createOpponent: createClaudeOpponentFactory({
        model: "test-model",
        env: {},
        query: cpuQuery,
      }),
      nextSeed: () => ++seedNo,
      nextHandId: () => `hand-${++handNo}`,
      review: { query: reviewQuery },
    });
    apps.push(app);

    const responses: string[] = [];
    const inject = async <T>(
      method: "GET" | "POST",
      url: string,
      payload?: object,
    ): Promise<T> => {
      const res = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `${method} ${url}`).toBeLessThan(300);
      responses.push(res.body);
      return res.json<T>();
    };
    /** Hand を終わりまで進める（Hero は Call / Check）。 */
    const play = async (afterHandId: string | null) => {
      const started = await inject<{ handId: string; view: HeroView }>(
        "POST",
        "/api/hands",
        { afterHandId },
      );
      let { view } = started;
      for (let guard = 0; view.status !== "complete"; guard++) {
        expect(guard).toBeLessThan(100);
        const types = view.legalActions?.actions.map((a) => a.type) ?? [];
        const action: PlayerAction = types.includes("call")
          ? { type: "call" }
          : types.includes("check")
            ? { type: "check" }
            : { type: "fold" };
        ({ view } = await inject<{ view: HeroView }>(
          "POST",
          `/api/hands/${started.handId}/actions`,
          { lastSeq: view.log.at(-1)?.seq ?? -1, action },
        ));
      }
      return started.handId;
    };

    let last = await play(null);
    const hand1 = last;
    for (let i = 0; i < 4; i++) last = await play(last);
    const reviewUrl = `/api/reviews/hands/${last}/decisions/0`;
    await inject("POST", reviewUrl, {});
    for (let i = 0; i < 400; i++) {
      const body = await inject<ReviewStatus>("GET", reviewUrl);
      if (body.generation.state !== "pending") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const sessionId = store.sessionIdOfHand(hand1) ?? "";
    expect(store.sessionIdOfHand(last)).toBe(sessionId);

    // Prompt ごとに、その CPU が座っていた、その Hand より前に保存した Hand から作った値と一致する（Hand が 0 なら節が無い）。
    const sources = loadTableTendencySources(store, sessionId);
    for (const { handId, playerId, prompt } of cpuPrompts) {
      const ord = store.savedOrder(handId);
      expect(ord, handId).not.toBeNull();
      const expected = buildTableTendency(
        sources.filter((h) => h.ord < (ord ?? 0)),
        playerId,
      );
      expect(tendencyIn(prompt), `${handId} ${playerId}`).toEqual(
        expected.hands === 0 ? undefined : expected,
      );
    }
    // 検査が空振りしていない: 最初の Hand には節が無く、後の Hand には節がある。
    const first = cpuPrompts.filter((p) => p.handId === hand1);
    expect(first.length).toBeGreaterThan(0);
    for (const p of first) expect(tendencyIn(p.prompt)).toBeUndefined();
    expect(cpuPrompts.some((p) => tendencyIn(p.prompt) !== undefined)).toBe(
      true,
    );

    // Review の Prompt・Hero への API の応答・Event Log に Table Tendency は出ない。
    expect(reviewPrompts.length).toBeGreaterThan(0);
    for (const prompt of reviewPrompts) {
      expect(prompt).not.toContain("卓の傾向");
      expect(prompt).not.toContain("phase7_table_tendency");
    }
    for (const body of responses) {
      expect(body).not.toContain("tableTendency");
      expect(body).not.toContain("phase7_table_tendency");
    }
    for (const handId of store.finishedHandIds()) {
      for (const s of store.read(handId)) {
        expect(JSON.stringify(s)).not.toContain("phase7_table_tendency");
      }
    }
  }, 30_000);
});
