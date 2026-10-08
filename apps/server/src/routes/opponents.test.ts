// Opponent Memory Reset の API（#143・D120）の統合テスト。区切りを足して時刻・対象だけを返すこと、知らない CPU・形の不正を拒否して
// 何も足さないこと、応答に Persona・Pool の名前・Hypothesis の中身を入れないことを確かめる。
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createOrdinalCounter } from "../logical-order.js";
import { InMemoryEventStore } from "../event-store.js";
import { InMemoryOpponentMemoryResetStore } from "../memory/memory-reset.js";
import { PHASE7_CPU_POOL } from "../opponents/cpu-pool.js";
import { forbiddenKeys } from "../testing/leaks.js";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;

function setup() {
  const ordinals = createOrdinalCounter();
  const resets = new InMemoryOpponentMemoryResetStore({
    ordinals,
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    newResetId: () => "reset-1",
  });
  const app = buildApp({
    logger: false,
    store: new InMemoryEventStore({ ordinals }),
    opponentMemoryResetStore: resets,
  });
  apps.push(app);
  return { app, resets };
}

describe("POST /api/opponents/memory-resets", () => {
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
