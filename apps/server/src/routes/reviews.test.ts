// Review の API の統合テスト（#82）。Hand API で実際に Hand を進め、保存済みの Hand の Hero の判断の Review を作る・読む。
// Claude は呼ばない（D87）: Review AI の query() を Fake に差し替える。生成は非同期で、待ちの状態（pending）を返すことと、
// 同じ判断を二重に要求しても 1 回しか作らないこと（LC-030）・過去の Version を上書きしないこと（D39）・応答に Hero が知り得ない情報・
// 内部のエラー本文が入らないことを確かめる。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  createDeck,
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
import type {
  FollowUpStatus,
  RevealStatus,
  ReviewStatus,
} from "../review/review-service.js";
import type { ReviewEvidence } from "../review/types.js";
import {
  allowedCardsAt,
  forbiddenKeys,
  leakedCards,
} from "../testing/leaks.js";

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

/**
 * Pass A・Pass B・Follow-up の出力 Schema を見て、検証を通る出力を返す Fake の Review AI（#83）。
 * 呼ばれた Prompt を種類ごとに記録する。
 */
function fakeAllPassesAi(delayMs = 5) {
  const prompts: {
    kind: "decision" | "reveal" | "followup";
    prompt: string;
  }[] = [];
  const query: ClaudeQuery = (params) => {
    const schema = params.options.outputFormat?.schema as {
      properties: Record<string, { items?: { enum?: string[] } }>;
    };
    const ids = schema.properties["evidenceIds"]?.items?.enum ?? [];
    const kind =
      "readComparison" in schema.properties
        ? "reveal"
        : "scope" in schema.properties
          ? "followup"
          : "decision";
    prompts.push({ kind, prompt: params.prompt });
    const output =
      kind === "reveal"
        ? {
            readComparison: "読みと実際の札の比較。",
            actualEquity: "実際の Equity と仮定した Range の Equity の違い。",
            bluffValue: "Bet / Raise の答え合わせ。",
            takeaways: ["Range の幅を考える"],
            evidenceIds: ids.slice(0, 1),
          }
        : kind === "followup"
          ? {
              scope: "answered",
              answer: `答え${prompts.length}`,
              evidenceIds: ids.slice(0, 1),
            }
          : {
              assessment: "reasonable",
              confidence: "medium",
              practical: "Pot Odds から見て妥当。",
              theoryBasis: "none",
              theory: "",
              exploitBasis: "none",
              exploit: "",
              assumptions: ["相手の Range は標準の想定"],
              conclusionChangers: ["相手の Range が狭いなら結論が変わる"],
              evidenceIds: ids.slice(0, 1),
            };
    return (async function* () {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: output,
      } as unknown as SDKMessage;
    })();
  };
  return { query, prompts };
}

const revealUrl = (handId: string, index: number) =>
  `${url(handId, index)}/reveal`;
const followUpUrl = (
  handId: string,
  index: number,
  pass: string,
  version: number | string,
) => `${url(handId, index)}/passes/${pass}/versions/${version}/followups`;

async function waitPath<T extends { generation: { state: string } }>(
  app: App,
  path: string,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    const body = res.json<T>();
    if (body.generation.state !== "pending") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("生成が終わらない");
}

/** 判断時点の Hero が知り得ない札の表記（"Ks" 等）が文字列に入っていれば返す。 */
function hiddenCardsIn(text: string, log: HandEvent[], upto: number): string[] {
  const allowed = allowedCardsAt(log, HERO, upto);
  return createDeck()
    .map(cardToString)
    .filter((c) => !allowed.has(c) && text.includes(`"${c}"`));
}

describe("Reveal Review（Pass B）と Follow-up の API（#83）", () => {
  it("Pass B は別の Version の列として追記し、Pass A の Review を書き換えない。評価を持たない", async () => {
    const ai = fakeAllPassesAi();
    const { app, events } = makeApp(7, { query: ai.query });
    const handId = await playToEnd(app);
    const log = events(handId);

    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    const decision = await waitSettled(app, handId, 0);
    expect(decision.versions).toBe(1);

    const before = await app.inject({
      method: "GET",
      url: revealUrl(handId, 0),
    });
    expect(before.json<RevealStatus>()).toMatchObject({
      generation: { state: "idle" },
      latest: null,
      versions: 0,
    });
    const started = await app.inject({
      method: "POST",
      url: revealUrl(handId, 0),
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(started.json<RevealStatus>().generation.state).toBe("pending");
    const reveal = await waitPath<RevealStatus>(app, revealUrl(handId, 0));
    expect(reveal.versions).toBe(1);
    expect(reveal.latest).toMatchObject({
      pass: "reveal",
      version: 1,
      generatedBy: "review_ai",
      modelRole: "review_standard",
    });
    expect(reveal.latest).not.toHaveProperty("assessment");
    expect(reveal.latest?.evidence.reveal.visibility).toBe("learning_only");

    // 2 回目は Version 2。Pass A の Review はそのまま（Version も中身も変わらない）。
    await app.inject({
      method: "POST",
      url: revealUrl(handId, 0),
      payload: { depth: "deep" },
    });
    const again = await waitPath<RevealStatus>(app, revealUrl(handId, 0));
    expect(again.versions).toBe(2);
    expect(again.latest).toMatchObject({
      version: 2,
      modelRole: "review_deep",
    });
    expect(await getStatus(app, handId, 0)).toEqual(decision);

    // Pass B の Prompt には Hand 後に見せた札が入るが、Pass A の Prompt・応答には入らない。
    const upto =
      heroInformationSets(log, HERO)[0]?.decision.decisionPointSeq ?? -1;
    const revealPrompt =
      ai.prompts.find((p) => p.kind === "reveal")?.prompt ?? "";
    expect(hiddenCardsIn(revealPrompt, log, upto).length).toBeGreaterThan(0);
    const decisionPrompt =
      ai.prompts.find((p) => p.kind === "decision")?.prompt ?? "";
    expect(hiddenCardsIn(decisionPrompt, log, upto)).toEqual([]);
    expect(leakedCards(decision, log, HERO, upto)).toEqual([]);
  });

  it("Follow-up: Pass A の Version に複数ターンで質問でき、履歴は Version に紐づく。Pass A への質問の Prompt に Hand 後の情報が入らない", async () => {
    const ai = fakeAllPassesAi();
    const { app, events } = makeApp(7, { query: ai.query });
    const handId = await playToEnd(app);
    const log = events(handId);
    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    await waitSettled(app, handId, 0);
    // 同じ判断の Pass B も作っておく（Pass A の Follow-up に混ざらないことを見るため）。
    await app.inject({
      method: "POST",
      url: revealUrl(handId, 0),
      payload: {},
    });
    await waitPath<RevealStatus>(app, revealUrl(handId, 0));

    const path = followUpUrl(handId, 0, "decision", 1);
    const empty = await app.inject({ method: "GET", url: path });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<FollowUpStatus>()).toMatchObject({
      pass: "decision",
      version: 1,
      generation: { state: "idle" },
      turns: [],
    });

    const first = await app.inject({
      method: "POST",
      url: path,
      payload: { question: "相手の実際の札は何でしたか？" },
    });
    expect(first.statusCode).toBe(202);
    // 前の質問の答えを作っている間は、次の質問を受け付けない（黙って捨てない）。
    const busy = await app.inject({
      method: "POST",
      url: path,
      payload: { question: "もう一つ" },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json<{ error: { kind: string } }>().error.kind).toBe(
      "followup_in_progress",
    );
    await waitPath<FollowUpStatus>(app, path);
    await app.inject({
      method: "POST",
      url: path,
      payload: { question: "  Fold ならどうでしたか？  ", depth: "deep" },
    });
    const done = await waitPath<FollowUpStatus>(app, path);
    expect(done.turns.map((t) => [t.turn, t.question, t.modelRole])).toEqual([
      [1, "相手の実際の札は何でしたか？", "review_standard"],
      [2, "Fold ならどうでしたか？", "review_deep"],
    ]);
    expect(done.turns[0]).toMatchObject({
      pass: "decision",
      reviewVersion: 1,
      generatedBy: "review_ai",
      answer: { scope: "answered" },
    });

    const followUpPrompts = ai.prompts.filter((p) => p.kind === "followup");
    expect(followUpPrompts).toHaveLength(2);
    // 2 ターン目の Prompt には 1 ターン目の質問と答えが入る。
    expect(followUpPrompts[1]?.prompt).toContain(
      "相手の実際の札は何でしたか？",
    );
    expect(followUpPrompts[1]?.prompt).toContain(done.turns[0]?.answer.text);
    // Pass A への質問の Prompt には、判断時点の Hero が知り得ない札・Learning-only の印が入らない。
    const upto =
      heroInformationSets(log, HERO)[0]?.decision.decisionPointSeq ?? -1;
    for (const { prompt } of followUpPrompts) {
      expect(hiddenCardsIn(prompt, log, upto)).toEqual([]);
      expect(prompt).not.toContain("learning_only");
    }
    expect(leakedCards(done, log, HERO, upto)).toEqual([]);

    // 別の Version には別の履歴（空）。
    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    await waitSettled(app, handId, 0);
    const v2 = await app.inject({
      method: "GET",
      url: followUpUrl(handId, 0, "decision", 2),
    });
    expect(v2.json<FollowUpStatus>().turns).toEqual([]);
  });

  it("Follow-up: Pass B の Version への質問は Pass B の Evidence（Hand 後の札）で答える", async () => {
    const ai = fakeAllPassesAi();
    const { app } = makeApp(7, { query: ai.query });
    const handId = await playToEnd(app);
    await app.inject({
      method: "POST",
      url: revealUrl(handId, 0),
      payload: {},
    });
    await waitPath<RevealStatus>(app, revealUrl(handId, 0));
    const path = followUpUrl(handId, 0, "reveal", 1);
    await app.inject({
      method: "POST",
      url: path,
      payload: { question: "相手の Bet は Bluff でしたか？" },
    });
    const done = await waitPath<FollowUpStatus>(app, path);
    expect(done.turns).toHaveLength(1);
    expect(done.turns[0]).toMatchObject({ pass: "reveal", reviewVersion: 1 });
    const prompt = ai.prompts.find((p) => p.kind === "followup")?.prompt ?? "";
    expect(prompt).toContain("learning_only");
  });

  it("Follow-up の不正な指定: 無い Review の Version は 404、空白だけ・長すぎる質問・知らない Pass は 400", async () => {
    const ai = fakeAllPassesAi();
    const { app } = makeApp(7, { query: ai.query });
    const handId = await playToEnd(app);
    const missing = await app.inject({
      method: "POST",
      url: followUpUrl(handId, 0, "decision", 1),
      payload: { question: "質問" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { kind: string } }>().error.kind).toBe(
      "review_not_found",
    );
    await app.inject({ method: "POST", url: url(handId, 0), payload: {} });
    await waitSettled(app, handId, 0);
    const path = followUpUrl(handId, 0, "decision", 1);
    for (const payload of [
      { question: "   " },
      { question: "あ".repeat(501) },
      {},
      { question: "質問", extra: 1 },
    ]) {
      expect(
        (await app.inject({ method: "POST", url: path, payload })).statusCode,
      ).toBe(400);
    }
    for (const bad of [
      followUpUrl(handId, 0, "summary", 1),
      followUpUrl(handId, 0, "decision", 0),
    ]) {
      expect((await app.inject({ method: "GET", url: bad })).statusCode).toBe(
        400,
      );
    }
    expect(ai.prompts.filter((p) => p.kind === "followup")).toHaveLength(0);
  });
});
