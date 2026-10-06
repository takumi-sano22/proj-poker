// Review Orchestrator のテスト（非同期の生成・上限の超過・アプリの終了・順に 1 つずつ）。Claude は呼ばない（D87）。
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import { SB_VS_BTN, playScriptedHand } from "../testing/review-eval/hands.js";
import {
  InMemoryFollowUpStore,
  InMemoryRevealReviewStore,
} from "./reveal-store.js";
import { InMemoryReviewStore } from "./review-store.js";
import { ReviewService } from "./review-service.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

/** abort されるまで何も返さない query（SDK と同じく、abort されたら例外で終わる）。渡された Options を記録する。 */
function hangingQuery() {
  const options: Options[] = [];
  const prompts: string[] = [];
  let active = 0;
  let maxActive = 0;
  const query: ClaudeQuery = (params) => {
    prompts.push(params.prompt);
    options.push(params.options);
    const signal = params.options.abortController?.signal;
    return (async function* () {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        });
        yield undefined as unknown as SDKMessage;
      } finally {
        active--;
      }
    })();
  };
  return { query, options, prompts, maxActive: () => maxActive };
}

function setup(query: ClaudeQuery, timeoutMs: number) {
  const events = new InMemoryEventStore();
  const hand = playScriptedHand(SB_VS_BTN);
  const handId = hand[0]?.type === "HAND_STARTED" ? hand[0].handId : "";
  events.append(handId, hand);
  const reviews = new InMemoryReviewStore();
  const service = new ReviewService({
    events,
    reviews,
    reveals: new InMemoryRevealReviewStore(),
    followUps: new InMemoryFollowUpStore(),
    heroId: "hero",
    players: PHASE1_TABLE_SETUP.players,
    kb,
    solver,
    env: {},
    query,
    timeoutMs,
  });
  return { service, reviews, handId };
}

describe("ReviewService", () => {
  it("Review AI が上限の時間内に返さなければ止めて、失敗（timeout）として Review を作らない", async () => {
    const fake = hangingQuery();
    const { service, reviews, handId } = setup(fake.query, 20);
    const pending = service.request(handId, 0, "standard");
    expect(pending).toMatchObject({
      ok: true,
      value: { generation: { state: "pending", depth: "standard" } },
    });
    await service.idle();
    expect(service.status(handId, 0)).toMatchObject({
      ok: true,
      value: {
        generation: { state: "failed", kind: "timeout" },
        latest: null,
        versions: 0,
      },
    });
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    expect(reviews.list(handId, 0, "decision")).toEqual([]);
  });

  it("Review AI へ渡す Evidence の席に、卓の表示名（Hero の画面に出ている名前）を添える（#96）", async () => {
    const fake = hangingQuery();
    const { service, handId } = setup(fake.query, 20);
    service.request(handId, 0, "standard");
    await service.idle();
    expect(fake.prompts[0]).toContain(
      '"playerId":"cpu5","displayName":"CPU 5"',
    );
    expect(fake.prompts[0]).toContain('"playerId":"hero","displayName":"Hero"');
  });

  it("アプリの終了で進行中の呼び出しを止め、待ちの生成は始めない", async () => {
    const fake = hangingQuery();
    const { service, reviews, handId } = setup(fake.query, 60_000);
    service.request(handId, 0, "standard");
    service.request(handId, 1, "standard");
    // 1 つ目の呼び出しが始まるまで待つ（Evidence の組み立てを挟む）。
    for (let i = 0; i < 200 && fake.options.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.options).toHaveLength(1);
    service.close();
    await service.idle();
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    // 2 つ目は始めない。どちらも Review は作らない。
    expect(fake.options).toHaveLength(1);
    expect(reviews.list(handId, 0, "decision")).toEqual([]);
    expect(reviews.list(handId, 1, "decision")).toEqual([]);
    // 終了後の要求は生成を始めない。
    expect(service.request(handId, 2, "standard")).toMatchObject({
      ok: true,
      value: { generation: { state: "idle" } },
    });
  });

  it("別の判断の生成は 1 つずつ順に進める（Claude の子プロセスを同時に複数動かさない）", async () => {
    const fake = hangingQuery();
    const { service, handId } = setup(fake.query, 30);
    for (let i = 0; i < 3; i++) service.request(handId, i, "standard");
    await service.idle();
    expect(fake.options).toHaveLength(3);
    expect(fake.maxActive()).toBe(1);
  });
});
