// CPU の Tilt（#140・D107）の情報境界の検査（不変条件 2・3。docs/05 §4）。
// 1. 静的: Review（review/）と Hero の Learning（learning/）のコードから import をたどっても、Tilt（opponents/tilt.ts・tilt-policy.ts）に届かない
// 2. 動的: Claude の CPU の query() と Review の query() を Fake にして（Claude は呼ばない。D87）2 つの Session を進め、全 Prompt を走査する。
//    - CPU A の Prompt の Tilt の節は、A 自身の席の Tilt（今の Session の、その Hand より前に保存した Hand を A の Persona で畳み込んだ値）
//      だけで、0 なら節ごと無い（同じ Hand で Tilt の違う CPU がいても、他の CPU の値が入らない）
//    - Session が変われば 0 から始まる（前の Session の Tilt を持ち越さない）
//    - Review（Pass A）の Prompt・Hero への API の応答・Event Log に Tilt が出ない
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { InMemoryEventStore } from "../event-store.js";
import { createFakeReviewQuery } from "../review/fake-review-query.js";
import type { ReviewStatus } from "../review/review-service.js";
import { createClaudeOpponentFactory } from "./claude-opponent.js";
import { PERSONA_PRESETS } from "./persona.js";
import { buildTiltsFromStore, foldTilt, loadTiltSources } from "./tilt.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TILT_MODULES = [
  join(SRC, "opponents", "tilt.ts"),
  join(SRC, "opponents", "tilt-policy.ts"),
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

function modulesIn(dir: string): string[] {
  return readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SRC, dir, f));
}

describe("Tilt の境界（静的）", () => {
  it("Review と Hero の Learning のコードは Tilt のモジュールに届かない。CPU の判断（Hand Orchestrator）は届く", () => {
    const reachable = reachableFrom([
      ...modulesIn("review"),
      ...modulesIn("learning"),
    ]);
    expect(
      TILT_MODULES.filter((m) => reachable.has(m)).map((m) => relative(SRC, m)),
    ).toEqual([]);
    // 検査が経路をたどれている（Orchestrator からは届く）。
    expect(reachableFrom([join(SRC, "hand-orchestrator.ts")])).toContain(
      TILT_MODULES[0],
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

/** Prompt の Tilt の段階（節が無ければ 0）。 */
function tiltIn(prompt: string): number {
  const section = prompt
    .split("\n\n")
    .find((s) => s.startsWith("## あなたの今の状態"));
  if (section === undefined) return 0;
  const level = /Tilt: (\d+)（/.exec(section)?.[1];
  if (level === undefined) throw new Error(`Tilt の節の形が違う: ${section}`);
  return Number(level);
}

describe("Tilt の境界（Prompt の動的な走査）", () => {
  it("CPU の Prompt の Tilt は自分の席の値だけで、Session を跨がず、Review・Hero への応答・Event Log に出ない", async () => {
    const store = new InMemoryEventStore();
    let handNo = 0;
    let seedNo = 0;
    const handIdOf = () => `hand-${handNo}`;
    let failNext = false;
    const cpuPrompts: { handId: string; playerId: string; prompt: string }[] =
      [];
    // CPU の Fake: Schema の enum から check → call → fold の順に選ぶ（全員が Showdown まで残り、毎 Hand 誰かが負ける）。
    const cpuQuery: ClaudeQuery = ({ prompt, options }) => {
      const fail = failNext;
      failNext = false;
      if (!fail) {
        cpuPrompts.push({
          handId: handIdOf(),
          playerId: /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "",
          prompt,
        });
      }
      const choices = (
        options.outputFormat?.schema as {
          properties: { action: { enum: string[] } };
        }
      ).properties.action.enum;
      const action =
        ["check", "call", "fold"].find((a) => choices.includes(a)) ?? "fold";
      return (async function* () {
        await Promise.resolve();
        if (fail) throw new Error("テストの障害");
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
    type Outage = { revision: number; current: unknown };
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
    /** Hand を終わりまで進める（Hero は Call / Check）。CPU の障害が起きたら Session 終了を選ぶ。 */
    const play = async (afterHandId: string | null) => {
      const started = await inject<{
        handId: string;
        view: HeroView;
        outage: Outage;
      }>("POST", "/api/hands", { afterHandId });
      let { view, outage } = started;
      for (let guard = 0; view.status !== "complete"; guard++) {
        expect(guard).toBeLessThan(100);
        if (outage.current !== null) {
          await inject("POST", `/api/hands/${started.handId}/outage`, {
            revision: outage.revision,
            choice: "end_session",
          });
          return started.handId;
        }
        const types = view.legalActions?.actions.map((a) => a.type) ?? [];
        const action: PlayerAction = types.includes("call")
          ? { type: "call" }
          : types.includes("check")
            ? { type: "check" }
            : { type: "fold" };
        ({ view, outage } = await inject<{ view: HeroView; outage: Outage }>(
          "POST",
          `/api/hands/${started.handId}/actions`,
          { lastSeq: view.log.at(-1)?.seq ?? -1, action },
        ));
      }
      return started.handId;
    };

    // Session 1: 8 Hand。途中で Hero の判断の Pass A を作る。CPU の障害で Session 1 を終え、Session 2 を 3 Hand 進める。
    let last = await play(null);
    const hand1 = last;
    for (let i = 0; i < 7; i++) last = await play(last);
    const reviewUrl = `/api/reviews/hands/${last}/decisions/0`;
    await inject("POST", reviewUrl, {});
    for (let i = 0; i < 400; i++) {
      const body = await inject<ReviewStatus>("GET", reviewUrl);
      if (body.generation.state !== "pending") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    failNext = true;
    last = await play(last);
    const session1 = store.sessionIdOfHand(hand1) ?? "";
    expect(store.sessionIdOfHand(last)).toBe(session1);
    const session2Hands: string[] = [];
    for (let i = 0; i < 3; i++) {
      last = await play(last);
      session2Hands.push(last);
    }
    const session2 = store.sessionIdOfHand(last) ?? "";
    expect(session2).not.toBe(session1);

    // Prompt ごとに、その CPU 自身の Tilt の期待値（今の Session の、その Hand より前に保存した Hand を自分の Persona で畳み込む）。
    const traitsOf = (prompt: string) => {
      const label = /スタイル: (.+)/.exec(prompt)?.[1];
      const persona = Object.values(PERSONA_PRESETS).find(
        (p) => p.label === label,
      );
      if (persona === undefined) throw new Error(`Persona が無い: ${label}`);
      return persona.traits;
    };
    const levelsByHand = new Map<string, Map<string, number>>();
    for (const { handId, playerId, prompt } of cpuPrompts) {
      const sessionId = store.sessionIdOfHand(handId) ?? "";
      const ord = store.savedOrder(handId);
      expect(ord, handId).not.toBeNull();
      const before = loadTiltSources(store, sessionId).filter(
        (h) => h.ord < (ord ?? 0),
      );
      const expected = foldTilt(before, {
        playerId,
        traits: traitsOf(prompt),
      }).level;
      expect(tiltIn(prompt), `${handId} ${playerId}`).toBe(expected);
      const levels = levelsByHand.get(handId) ?? new Map<string, number>();
      levels.set(playerId, expected);
      levelsByHand.set(handId, levels);
    }

    // 検査が空振りしていない: Tilt のある Prompt があり、同じ Hand で Tilt の違う CPU がいる（他の CPU の値が入れば検出できる）。
    expect(cpuPrompts.some((p) => tiltIn(p.prompt) > 0)).toBe(true);
    expect(
      [...levelsByHand.values()].some((m) => new Set(m.values()).size > 1),
    ).toBe(true);
    // Session 1 は Tilt を残して終わったが、Session 2 の最初の Hand は全員 0 から（Session 終了で Reset）。
    const seats = [...(levelsByHand.get(hand1)?.keys() ?? [])].map(
      (playerId) => {
        const p = cpuPrompts.find((q) => q.playerId === playerId);
        return { playerId, traits: traitsOf(p?.prompt ?? "") };
      },
    );
    expect(
      buildTiltsFromStore(store, { sessionId: session1, seats }).size,
    ).toBeGreaterThan(0);
    const firstOf2 = cpuPrompts.filter((p) => p.handId === session2Hands[0]);
    expect(firstOf2.length).toBeGreaterThan(0);
    for (const p of firstOf2) expect(tiltIn(p.prompt)).toBe(0);

    // Review の Prompt・Hero への API の応答・Event Log に Tilt は出ない。
    expect(reviewPrompts.length).toBeGreaterThan(0);
    for (const prompt of reviewPrompts) {
      expect(prompt).not.toContain("Tilt");
      expect(prompt).not.toContain("あなたの今の状態");
      expect(prompt).not.toContain("phase7_tilt");
    }
    for (const body of responses) {
      expect(body.toLowerCase()).not.toContain("tilt");
    }
    for (const handId of store.finishedHandIds()) {
      for (const s of store.read(handId)) {
        expect(JSON.stringify(s).toLowerCase()).not.toContain("tilt");
      }
    }
  }, 30_000);
});
