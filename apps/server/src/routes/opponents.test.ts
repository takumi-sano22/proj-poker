// Opponent Memory Reset の API（#143・D120）の統合テスト。区切りを足して時刻・対象だけを返すこと、知らない CPU・形の不正を拒否して
// 何も足さないこと、応答に Persona・Pool の名前・Hypothesis の中身を入れないことを確かめる。
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { HeroView } from "@proj-poker/engine";
import { InMemoryEventStore } from "../event-store.js";
import { createOrdinalCounter, processOrdinals } from "../logical-order.js";
import { InMemoryOpponentMemoryResetStore } from "../memory/memory-reset.js";
import type { OpponentMemorySummary } from "../memory/memory-summary.js";
import { PHASE7_CPU_POOL } from "../opponents/cpu-pool.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import { forbiddenKeys } from "../testing/leaks.js";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;

function setup() {
  const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
  const resets = new InMemoryOpponentMemoryResetStore({
    lastOrdinal: () => store.lastOrdinal(),
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    newResetId: () => "reset-1",
  });
  const app = buildApp({
    logger: false,
    store,
    opponentMemoryResetStore: resets,
  });
  apps.push(app);
  return { app, resets };
}

describe("POST /api/opponents/memory-resets", () => {
  it("Reset Store を省き、Event Store だけを独自の順序の源で渡しても、Reset の後の Hand の CPU の Memory は前の Hand を含まない（D117）", async () => {
    // プロセスの既定のカウンタを先に進めておく（別の順序の源を読むと区切りがずれる状態を作る）。
    processOrdinals.next();
    processOrdinals.next();
    processOrdinals.next();
    const seen = new Map<string, (OpponentMemorySummary | undefined)[]>();
    const createOpponent: OpponentFactory = (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) => {
          const list = seen.get(input.knowledge.handId) ?? [];
          list.push(input.knowledge.memory);
          seen.set(input.knowledge.handId, list);
          return bot.decide(input, signal);
        },
      };
    };
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      nextSeed: () => 42,
      store: new InMemoryEventStore({ ordinals: createOrdinalCounter() }),
      createOpponent,
    });
    apps.push(app);

    let afterHandId: string | null = null;
    const play = async (): Promise<string> => {
      const started = await app.inject({
        method: "POST",
        url: "/api/hands",
        payload: { afterHandId },
      });
      const body = started.json<{ handId: string; view: HeroView }>();
      let view = body.view;
      for (let guard = 0; view.status !== "complete"; guard++) {
        expect(guard).toBeLessThan(100);
        const types = view.legalActions?.actions.map((a) => a.type) ?? [];
        const action = types.includes("call")
          ? { type: "call" }
          : types.includes("check")
            ? { type: "check" }
            : { type: "fold" };
        const res = await app.inject({
          method: "POST",
          url: `/api/hands/${body.handId}/actions`,
          payload: { lastSeq: view.log.at(-1)?.seq ?? -1, action },
        });
        view = res.json<{ view: HeroView }>().view;
      }
      afterHandId = body.handId;
      return body.handId;
    };
    const maxObserved = (handId: string) =>
      Math.max(
        ...(seen.get(handId) ?? []).flatMap((m) =>
          (m?.subjects ?? []).map((s) => s.handsObserved),
        ),
      );

    await play();
    const h2 = await play();
    expect(maxObserved(h2)).toBe(1);
    const reset = await app.inject({
      method: "POST",
      url: "/api/opponents/memory-resets",
      payload: { scope: "all" },
    });
    expect(reset.statusCode).toBe(201);
    const h3 = await play();
    expect(seen.get(h3)?.length ?? 0).toBeGreaterThan(0);
    expect(maxObserved(h3)).toBe(0);
    // 区切りが Hand の番号より先へずれていない（Reset の後に保存した h3 は次の Hand の Memory に入る）。
    const h4 = await play();
    expect(maxObserved(h4)).toBe(1);
  });

  it("全 CPU の区切りを足し、時刻と対象だけを返す", async () => {
    const { app, resets } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/opponents/memory-resets",
      payload: { scope: "all" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      reset: {
        resetId: "reset-1",
        createdAt: "2026-10-08T00:00:00.000Z",
        scope: "all",
        cpuProfileId: null,
      },
    });
    expect(resets.boundaryFor(AKI)?.ord).toBe(0);
    expect(resets.boundaryFor(BEN)?.ord).toBe(0);
  });

  it("1 つの Fixed CPU の区切りを足す（他の CPU には効かない）。応答に Pool の名前・Persona を入れない", async () => {
    const { app, resets } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/opponents/memory-resets",
      payload: { scope: "cpu_profile", cpuProfileId: "fixed_aki" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ reset: Record<string, unknown> }>();
    expect(Object.keys(body.reset).sort()).toEqual([
      "cpuProfileId",
      "createdAt",
      "resetId",
      "scope",
    ]);
    expect(body.reset).toMatchObject({
      scope: "cpu_profile",
      cpuProfileId: "fixed_aki",
    });
    expect(resets.boundaryFor(AKI)).not.toBeNull();
    expect(resets.boundaryFor(BEN)).toBeNull();
    const aki = PHASE7_CPU_POOL.fixed.find(
      (p) => p.cpuProfileId === "fixed_aki",
    );
    expect(res.body).not.toContain(aki?.name ?? "?");
    expect(res.body).not.toContain(aki?.persona ?? "?");
    expect(forbiddenKeys(body)).toEqual([]);
  });

  it("Pool に無い CPU は 404 で、何も足さない", async () => {
    const { app, resets } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/opponents/memory-resets",
      payload: { scope: "cpu_profile", cpuProfileId: "fixed_zz" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { kind: "cpu_profile_not_found" },
    });
    expect(resets.boundaryFor({ kind: "guest", guestId: "g" })).toBeNull();
  });

  it.each([
    {},
    { scope: "guest" },
    { scope: "all", cpuProfileId: "fixed_aki" },
    { scope: "cpu_profile" },
    { scope: "cpu_profile", cpuProfileId: "" },
    { scope: "cpu_profile", cpuProfileId: 1 },
    { scope: "all", extra: true },
  ])("形の不正は 400 で、何も足さない（%j）", async (payload) => {
    const { app, resets } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/opponents/memory-resets",
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(resets.boundaryFor(AKI)).toBeNull();
  });
});
