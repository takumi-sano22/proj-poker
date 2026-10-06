// Review の API の統合テスト（#82）。Hand API で実際に Hand を進め、保存済みの Hand の Hero の判断の Review を作る・読む。
// Claude は呼ばない（D87）: Review AI の query() を Fake に差し替える。生成は非同期で、待ちの状態（pending）を返すことと、
// 同じ判断を二重に要求しても 1 回しか作らないこと（LC-030）・過去の Version を上書きしないこと（D39）・応答に Hero が知り得ない情報・
// 内部のエラー本文が入らないことを確かめる。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  heroInformationSets,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ReviewAppOptions } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { InMemoryEventStore } from "../event-store.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import type { ReviewStatus } from "../review/review-service.js";
import type { ReviewEvidence } from "../review/types.js";
import { forbiddenKeys, leakedCards } from "../testing/leaks.js";

const HERO = "hero";
const SECRET = "/home/u/.claude/.credentials.json sk-ant-secret";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

type App = ReturnType<typeof buildApp>;

/** Evidence の id から、検証を通る出力を作る Fake の Review AI。呼ばれた回数を数える。 */
function fakeReviewAi() {
  let calls = 0;
  const query: ClaudeQuery = (params) => {
    calls++;
    const ids = [...params.prompt.matchAll(/"id":"(math:[^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    return (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: {
          assessment: "reasonable",
          confidence: "medium",
          practical: "Pot Odds と仮定した Range に対する Equity から見て妥当。",
          theoryBasis: "none",
          theory: "",
          exploitBasis: "none",
          exploit: "",
          assumptions: ["相手の Range は標準の想定"],
          conclusionChangers: ["相手の Range がもっと狭いなら結論が変わる"],
          evidenceIds: ids.slice(0, 1),
        },
      } as unknown as SDKMessage;
    })();
  };
  return { query, calls: () => calls };
}

/** 未ログインで失敗する Review AI（assistant の error と is_error の result）。本文に秘密に見える値を入れる。 */
const notLoggedIn: ClaudeQuery = () =>
  (async function* () {
    await Promise.resolve();
    yield {
      type: "assistant",
      error: "authentication_failed",
      message: { content: [] },
    } as unknown as SDKMessage;
    yield {
      type: "result",
      subtype: "success",
      is_error: true,
      result: SECRET,
    } as unknown as SDKMessage;
  })();

function makeApp(seed: number, review?: ReviewAppOptions) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    createOpponent: createRuleBot,
    nextSeed: () => seed,
    nextHandId: () => `hand-${++handNo}`,
    ...(review === undefined ? {} : { review }),
  });
  apps.push(app);
  const events = (handId: string): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { app, events };
}

async function start(app: App): Promise<{ handId: string; view: HeroView }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/hands",
    payload: { afterHandId: null },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ handId: string; view: HeroView }>();
}

function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

/** Hero は Call / Check だけで Hand を最後まで進める（Hero が 1 回は判断する Hand になる seed を使う）。 */
async function playToEnd(
  app: App,
  begun?: { handId: string; view: HeroView },
): Promise<string> {
  const started = begun ?? (await start(app));
  let view = started.view;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    const res = await app.inject({
      method: "POST",
      url: `/api/hands/${started.handId}/actions`,
      payload: {
        lastSeq: view.log.at(-1)?.seq ?? -1,
        action: passiveHero(view),
      },
    });
    expect(res.statusCode).toBe(200);
    view = res.json<{ view: HeroView }>().view;
  }
  return started.handId;
}

const url = (handId: string, index: number | string) =>
  `/api/reviews/hands/${handId}/decisions/${index}`;

async function getStatus(app: App, handId: string, index: number) {
  const res = await app.inject({ method: "GET", url: url(handId, index) });
  expect(res.statusCode).toBe(200);
  return res.json<ReviewStatus>();
}

/** 生成が終わる（pending でなくなる）まで GET を繰り返す。 */
async function waitSettled(app: App, handId: string, index: number) {
  for (let i = 0; i < 400; i++) {
    const status = await getStatus(app, handId, index);
    if (status.generation.state !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Review の生成が終わらない");
}

function withoutKbBodies(evidence: ReviewEvidence): ReviewEvidence {
  return {
    ...evidence,
    knowledge: {
      ...evidence.knowledge,
      items: evidence.knowledge.items.map((i) => ({ ...i, body: "" })),
    },
  };
}

describe("Review の API", () => {
  it("作る → 待ち → 保存。二重の要求でも 1 回だけ作り、次の要求は次の Version（過去は残る）", async () => {
    const ai = fakeReviewAi();
    const { app, events } = makeApp(7, { query: ai.query });
    const handId = await playToEnd(app);
    const log = events(handId);
    expect(heroInformationSets(log, HERO).length).toBeGreaterThan(0);

    const before = await getStatus(app, handId, 0);
    expect(before).toEqual({
      handId,
      decisionIndex: 0,
      generation: { state: "idle" },
      latest: null,
      versions: 0,
    });

    const first = await app.inject({
      method: "POST",
      url: url(handId, 0),
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    expect(first.json<ReviewStatus>().generation).toEqual({
      state: "pending",
      depth: "standard",
    });
    // 生成中にもう一度要求しても、新しくは始めない。
    const again = await app.inject({
      method: "POST",
      url: url(handId, 0),
      payload: {},
    });
    expect(again.statusCode).toBe(202);
    expect(again.json<ReviewStatus>().generation.state).toBe("pending");

    const done = await waitSettled(app, handId, 0);
    expect(ai.calls()).toBe(1);
    expect(done.generation).toEqual({ state: "idle" });
    expect(done.versions).toBe(1);
    expect(done.latest).toMatchObject({
      handId,
      decisionIndex: 0,
      version: 1,
      pass: "decision",
      depth: "standard",
      modelRole: "review_standard",
      concreteModel: "claude-sonnet-5-5",
      generatedBy: "review_ai",
      assessment: "reasonable",
      solverVersion: null,
    });

    // 詳しく（deep）を要求すると次の Version。Version 1 はそのまま残る。
    const deep = await app.inject({
      method: "POST",
      url: url(handId, 0),
      payload: { depth: "deep" },
    });
    expect(deep.statusCode).toBe(202);
    const after = await waitSettled(app, handId, 0);
    expect(after.versions).toBe(2);
    expect(after.latest).toMatchObject({
      version: 2,
      depth: "deep",
      modelRole: "review_deep",
      concreteModel: "claude-opus-5-5",
    });

    // 応答の Evidence に、判断時点の Hero が知り得ない札・Deck・seed・system の記録・Persona が無い。
    const decision = heroInformationSets(log, HERO)[0]?.decision;
    const evidence = after.latest?.evidence as ReviewEvidence;
    expect(
      leakedCards(after, log, HERO, decision?.decisionPointSeq ?? -1),
    ).toEqual([]);
    expect(forbiddenKeys(withoutKbBodies(evidence))).toEqual([]);
  });

  it("Claude の呼び出しの失敗は Review を作らずに失敗の種類だけを返し（本文は返さない）、もう一度要求できる", async () => {
    const { app } = makeApp(7, { query: notLoggedIn });
    const handId = await playToEnd(app);
    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    const failed = await waitSettled(app, handId, 0);
    expect(failed.generation).toEqual({
      state: "failed",
      depth: "standard",
      kind: "unauthenticated",
    });
    expect(failed.latest).toBeNull();
    expect(JSON.stringify(failed)).not.toContain("sk-ant");
    const retry = await app.inject({
      method: "POST",
      url: url(handId, 0),
      payload: {},
    });
    expect(retry.json<ReviewStatus>().generation.state).toBe("pending");
    await waitSettled(app, handId, 0);
  });

  it("Review AI の query を渡さない組み立て（テストの既定）は Claude を呼ばずに失敗にする（D87）", async () => {
    const { app } = makeApp(7);
    const handId = await playToEnd(app);
    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    const failed = await waitSettled(app, handId, 0);
    expect(failed.generation).toMatchObject({ state: "failed", kind: "error" });
  });

  it("Hand が無い・判断が無いは 404、終わっていない Hand は 409、不正な指定は 400", async () => {
    const ai = fakeReviewAi();
    const { app } = makeApp(7, { query: ai.query });
    expect(
      (await app.inject({ method: "GET", url: url("nope", 0) })).statusCode,
    ).toBe(404);

    // 進行中の Hand（Hero の手番で止まっている）。
    const started = await start(app);
    const inProgress = await app.inject({
      method: "GET",
      url: url(started.handId, 0),
    });
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.json<{ error: { kind: string } }>().error.kind).toBe(
      "hand_not_finished",
    );
    const handId = await playToEnd(app, started);
    const missing = await app.inject({
      method: "POST",
      url: url(handId, 999),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { kind: string } }>().error.kind).toBe(
      "decision_not_found",
    );
    for (const index of ["-1", "abc", "01", "1.5"]) {
      expect(
        (await app.inject({ method: "GET", url: url(handId, index) }))
          .statusCode,
      ).toBe(400);
    }
    const badDepth = await app.inject({
      method: "POST",
      url: url(handId, 0),
      payload: { depth: "extreme" },
    });
    expect(badDepth.statusCode).toBe(400);
    expect(ai.calls()).toBe(0);
  });
});
