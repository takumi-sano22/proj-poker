// ETIQUETTE の確認（Ack）の API（UX-11 #226・D145）の統合テスト（Fastify の inject と、SSE は実際に listen して fetch で読む）。
// - POST /api/hands/:handId/etiquette-ack {rulingSeq} の受理・冪等・409 stale_etiquette・入力の形の 400・無い Hand の 404
// - REST の応答（hands・physical-actions・actions・outage・etiquette-ack）の etiquette {revision, pendingRulingSeq}
// - 確認待ちの Hero の操作・次の Hand の開始は 409 etiquette_ack_required（Hand を返すだけの再要求は 200 で Ack の状態を載せる）
// - SSE の etiquette イベント（接続時と変化時）。Hand を終える裁定でも、Hand の完了で閉じる前に届く
import type { HeroView, LegalActionSet } from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { buildTableSetup } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import type {
  OpponentFactory,
  OpponentOutput,
} from "../opponents/opponent-agent.js";

interface EtiquetteBody {
  readonly revision: number;
  readonly pendingRulingSeq: number | null;
}

interface PlayBody {
  readonly view: HeroView;
  readonly session: { state: string };
  readonly outage: unknown;
  readonly etiquette: EtiquetteBody;
}

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** CPU は Call か Check だけ（Hero の手番の Call 額が BB のまま決まる）。 */
const passiveCpus: OpponentFactory = () => ({
  decide: ({ legal }: { legal: LegalActionSet }) =>
    Promise.resolve<OpponentOutput>(
      legal.actions.some((a) => a.type === "call")
        ? { action: "call" }
        : { action: "check" },
    ),
});

function makeApp(players = 6) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    setup: buildTableSetup(players),
    createOpponent: passiveCpus,
    nextSeed: () => 42,
    nextHandId: () => `hand-${++handNo}`,
  });
  apps.push(app);
  return { app, store };
}

const lastSeq = (view: HeroView): number => view.log.at(-1)?.seq ?? -1;

function post(
  app: ReturnType<typeof buildApp>,
  url: string,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url, payload });
}

/** Hand を始め、Hero の手番で宣言なしの 5 の Chip を 1 枚出す（Oversized Chip → Call。確認を待つ）。 */
async function oversizedChip(app: ReturnType<typeof buildApp>) {
  const created = await post(app, "/api/hands", { afterHandId: null });
  expect(created.statusCode).toBe(201);
  const started = created.json<PlayBody & { handId: string }>();
  // 開始の応答にも確認の状態を載せる（まだ待っていない）。
  expect(started.etiquette).toEqual({ revision: 0, pendingRulingSeq: null });
  expect(started.view.actorId).toBe("hero");
  const res = await post(app, `/api/hands/${started.handId}/physical-actions`, {
    lastSeq: lastSeq(started.view),
    actions: [{ type: "chip_push", chips: [5] }],
  });
  expect(res.statusCode).toBe(200);
  return { handId: started.handId, body: res.json<PlayBody>() };
}

/** SSE の本文を（name, data）の列にする。 */
function parseSseEvents(body: string): { name: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const name = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "";
      return { name, data: JSON.parse(data) as unknown };
    });
}

describe("POST /api/hands/:handId/etiquette-ack（D145）", () => {
  it("確認を待つ裁定の seq を REST の応答で返し、Ack まで操作を 409 で拒否し、Ack で再開する（二重の Ack は 200）", async () => {
    const { app, store } = makeApp();
    const { handId, body } = await oversizedChip(app);
    const pending = body.etiquette.pendingRulingSeq;
    expect(body.etiquette.revision).toBe(1);
    expect(pending).not.toBeNull();
    // 待っている裁定は Hero の View の log にある DEALER_RULING。
    expect(body.view.log.find((e) => e.seq === pending)).toMatchObject({
      type: "DEALER_RULING",
      notes: ["oversized_chip"],
    });
    const logged = store.read(handId).length;

    // 確認待ちの Hero の操作は 409 etiquette_ack_required で、Log を変えない。
    const action = await post(app, `/api/hands/${handId}/actions`, {
      lastSeq: lastSeq(body.view),
      action: { type: "fold" },
    });
    expect(action.statusCode).toBe(409);
    expect(action.json()).toMatchObject({
      error: { kind: "etiquette_ack_required" },
    });
    const physical = await post(app, `/api/hands/${handId}/physical-actions`, {
      lastSeq: lastSeq(body.view),
      actions: [{ type: "declare", declaration: { kind: "fold" } }],
    });
    expect(physical.statusCode).toBe(409);
    expect(store.read(handId)).toHaveLength(logged);

    // Ack の要らない seq（HAND_STARTED）・未来の seq は 409 stale_etiquette。
    for (const rulingSeq of [0, 9_999]) {
      const stale = await post(app, `/api/hands/${handId}/etiquette-ack`, {
        rulingSeq,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: { kind: "stale_etiquette" },
      });
    }

    const acked = await post(app, `/api/hands/${handId}/etiquette-ack`, {
      rulingSeq: pending,
    });
    expect(acked.statusCode).toBe(200);
    const ackedBody = acked.json<PlayBody>();
    expect(Object.keys(ackedBody).sort()).toEqual([
      "etiquette",
      "outage",
      "session",
      "view",
    ]);
    expect(ackedBody.etiquette).toEqual({
      revision: 2,
      pendingRulingSeq: null,
    });
    expect(ackedBody.outage).toEqual({ revision: 0, current: null });
    // Ack の後に CPU が進んだ（Log が伸びた）。
    expect(store.read(handId).length).toBeGreaterThan(logged);

    // 二重の Ack（応答が消えた再送）は 200 で何もしない。
    const again = await post(app, `/api/hands/${handId}/etiquette-ack`, {
      rulingSeq: pending,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<PlayBody>().etiquette).toEqual({
      revision: 2,
      pendingRulingSeq: null,
    });
    // 操作の応答にも確認の状態を載せる。
    const next = await post(app, `/api/hands/${handId}/actions`, {
      lastSeq: lastSeq(again.json<PlayBody>().view),
      action: { type: "fold" },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json<PlayBody>().etiquette).toEqual({
      revision: 2,
      pendingRulingSeq: null,
    });
  });

  it("入力の形の不正は 400、無い Hand は 404", async () => {
    const { app } = makeApp();
    const { handId, body } = await oversizedChip(app);
    for (const bad of [
      {},
      { rulingSeq: -1 },
      { rulingSeq: "3" },
      { rulingSeq: 1.5 },
      { rulingSeq: body.etiquette.pendingRulingSeq, extra: true },
    ]) {
      const res = await post(app, `/api/hands/${handId}/etiquette-ack`, bad);
      expect(res.statusCode).toBe(400);
    }
    const missing = await post(app, "/api/hands/unknown/etiquette-ack", {
      rulingSeq: body.etiquette.pendingRulingSeq,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("Hand を終える裁定の後は、確認まで次の Hand の開始が 409。Hand を返すだけの再要求は 200 で Ack の状態を載せ、確認の後は始められる", async () => {
    const { app } = makeApp(2);
    const created = await post(app, "/api/hands", { afterHandId: null });
    const { handId, view } = created.json<PlayBody & { handId: string }>();
    expect(view.actorId).toBe("hero");
    // 宣言 2 回 → declaration_ignored で Fold（Heads-Up なので Hand が終わる）。
    const res = await post(app, `/api/hands/${handId}/physical-actions`, {
      lastSeq: lastSeq(view),
      actions: [
        { type: "declare", declaration: { kind: "fold" } },
        { type: "declare", declaration: { kind: "fold" } },
      ],
    });
    expect(res.statusCode).toBe(200);
    const ended = res.json<PlayBody>();
    expect(ended.view.status).toBe("complete");
    const pending = ended.etiquette.pendingRulingSeq;
    expect(pending).not.toBeNull();

    const rejected = await post(app, "/api/hands", { afterHandId: handId });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { kind: "etiquette_ack_required" },
    });
    // 再接続・再読み込み（結果をまだ見ていない）の再要求は、同じ Hand と確認の状態を返す。
    const unseen = await post(app, "/api/hands", { afterHandId: null });
    expect(unseen.statusCode).toBe(200);
    expect(unseen.json<PlayBody & { handId: string }>()).toMatchObject({
      handId,
      etiquette: { revision: 1, pendingRulingSeq: pending },
    });

    const acked = await post(app, `/api/hands/${handId}/etiquette-ack`, {
      rulingSeq: pending,
    });
    expect(acked.statusCode).toBe(200);
    // Ack は Event を足さないので、Hero が見ていた lastSeq は変わらない。
    expect(lastSeq(acked.json<PlayBody>().view)).toBe(lastSeq(ended.view));
    const next = await post(app, "/api/hands", { afterHandId: handId });
    expect(next.statusCode).toBe(201);
  });
});

describe("SSE の etiquette イベント（D145）", () => {
  async function listen(app: ReturnType<typeof buildApp>) {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listen したアドレスが取れない");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function postJson(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as PlayBody & { handId: string };
  }

  it("接続時と、待ちが立つ・解けるたびに etiquette を送る", async () => {
    const { app } = makeApp();
    const base = await listen(app);
    const started = await postJson(`${base}/api/hands`, { afterHandId: null });
    const { handId } = started;
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/hands/${handId}/stream`, {
      signal: controller.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      stream.body?.getReader();
    if (reader === undefined) throw new Error("SSE の本文が無い");
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (done: (t: string) => boolean) => {
      while (!done(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil((t) => t.includes("event: view"));

    const acted = await postJson(
      `${base}/api/hands/${handId}/physical-actions`,
      {
        lastSeq: lastSeq(started.view),
        actions: [{ type: "chip_push", chips: [5] }],
      },
    );
    const pending = acted.etiquette.pendingRulingSeq;
    await readUntil((t) => t.includes('"pendingRulingSeq":' + String(pending)));
    await postJson(`${base}/api/hands/${handId}/etiquette-ack`, {
      rulingSeq: pending,
    });
    await readUntil((t) => t.includes('"revision":2'));
    controller.abort();

    const events = parseSseEvents(text);
    expect(events.slice(0, 3).map((e) => e.name)).toEqual([
      "outage",
      "etiquette",
      "view",
    ]);
    expect(
      events.filter((e) => e.name === "etiquette").map((e) => e.data),
    ).toEqual([
      { revision: 0, pendingRulingSeq: null },
      { revision: 1, pendingRulingSeq: pending },
      { revision: 2, pendingRulingSeq: null },
    ]);
    // 確認の待ちは、その裁定を含む View より先に届く。
    const pendingAt = events.findIndex(
      (e) =>
        e.name === "etiquette" &&
        (e.data as EtiquetteBody).pendingRulingSeq === pending,
    );
    const viewWithRuling = events.findIndex(
      (e) =>
        e.name === "view" &&
        (e.data as HeroView).log.some((x) => x.seq === pending),
    );
    expect(pendingAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeLessThan(viewWithRuling);
  });

  it("Hand を終える裁定でも、Hand の完了で閉じる前に etiquette（待ち）・session・view の順で届く。終わった Hand へ繋ぎ直しても待ちを返す", async () => {
    const { app } = makeApp(2);
    const base = await listen(app);
    const started = await postJson(`${base}/api/hands`, { afterHandId: null });
    const { handId } = started;
    const stream = await fetch(`${base}/api/hands/${handId}/stream`);
    const bodyPromise = stream.text();
    const acted = await postJson(
      `${base}/api/hands/${handId}/physical-actions`,
      {
        lastSeq: lastSeq(started.view),
        actions: [
          { type: "declare", declaration: { kind: "fold" } },
          { type: "declare", declaration: { kind: "fold" } },
        ],
      },
    );
    const pending = acted.etiquette.pendingRulingSeq;
    expect(pending).not.toBeNull();
    // サーバーが Hand の完了で閉じるので、本文は最後まで読める。
    const events = parseSseEvents(await bodyPromise);
    expect(events.map((e) => e.name)).toEqual([
      "outage",
      "etiquette",
      "view",
      "etiquette",
      "session",
      "view",
    ]);
    expect(events[3]?.data).toEqual({ revision: 1, pendingRulingSeq: pending });
    expect((events[5]?.data as HeroView).status).toBe("complete");

    // 終わった Hand へ繋ぎ直す（Home / Learn から戻る）と、接続時の etiquette で未確認の待ちを返す。
    const reconnected = parseSseEvents(
      await (await fetch(`${base}/api/hands/${handId}/stream`)).text(),
    );
    expect(reconnected.map((e) => e.name)).toEqual([
      "outage",
      "etiquette",
      "session",
      "view",
    ]);
    expect(reconnected[1]?.data).toEqual({
      revision: 1,
      pendingRulingSeq: pending,
    });
  });
});
