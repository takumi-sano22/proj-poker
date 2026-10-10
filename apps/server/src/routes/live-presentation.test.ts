// UX-06（#221）の技術検証: 今の REST / SSE の配り方のまま、Live の演出（D140）が受信の重複・再接続・古い表示からの操作に耐えるか。
// 製品のコードは変えない検証テスト。表示側の手順（pendingEvents）は packages/engine/src/live-presentation.test.ts と同じ参照実装で、
// UX-07（#222）の Presentation Controller の契約の下敷きにする（整理は docs/taskLog/issue-221-live-presentation-verification.md）。
import {
  projectHeroView,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryEventStore } from "../event-store.js";
import { forbiddenKeys, leakedCards, personaTerms } from "../testing/leaks.js";

const HERO = "hero";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** CPU の思考待ち 0 の app を listen し、base URL と Event Log を返す。 */
async function listenApp(seed: number) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    nextSeed: () => seed,
    nextHandId: () => `hand-${++handNo}`,
  });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("listen したアドレスが取れない");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    events: (handId: string): HandEvent[] =>
      store.read(handId).map((s) => s.event),
  };
}

function lastSeqOf(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/** 受け取った View のうち、まだ表示に積んでいない Event（seq が表示済みより大きいもの）。 */
function pendingEvents(view: HeroView, displayedSeq: number): HandEvent[] {
  return view.log.filter((e) => e.seq > displayedSeq);
}

function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

async function startHand(base: string) {
  const res = await fetch(`${base}/api/hands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ afterHandId: null }),
  });
  return (await res.json()) as { handId: string; view: HeroView };
}

async function act(
  base: string,
  handId: string,
  lastSeq: number,
  action: PlayerAction,
) {
  return fetch(`${base}/api/hands/${handId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastSeq, action }),
  });
}

/** SSE に接続し、最初の view イベントを受けたら切る（ブラウザの EventSource の切断と、次の接続の最初の 1 通を再現する）。 */
async function firstViewThenDisconnect(
  base: string,
  handId: string,
): Promise<HeroView> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/hands/${handId}/stream`, {
    signal: controller.signal,
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const block = text.split("\n\n").find((b) => b.startsWith("event: view\n"));
    if (block !== undefined) {
      controller.abort();
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse((data as string).slice("data: ".length)) as HeroView;
    }
  }
  throw new Error("view イベントを受けずに SSE が閉じた");
}

/** SSE の本文から view イベントの data を取り出す。 */
function parseSseViews(text: string): HeroView[] {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event: view\n"))
    .map((b) => {
      const data = b.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse((data as string).slice("data: ".length)) as HeroView;
    });
}

function expectNoLeak(view: HeroView, log: readonly HandEvent[]) {
  expect(leakedCards(view, log, HERO, lastSeqOf(view))).toEqual([]);
  expect(forbiddenKeys(view)).toEqual([]);
  expect(personaTerms(view)).toEqual([]);
}

describe("Live の演出の受信経路（UX-06・#221）", () => {
  it("SSE を切って張り直すと、最初の 1 通が見える Event の全量を運ぶので、切断中に進んだ Event を取りこぼさない", async () => {
    const { base, events } = await listenApp(9);
    const { handId, view: started } = await startHand(base);

    const beforeDisconnect = await firstViewThenDisconnect(base, handId);
    // 切断中に Hero が操作し、CPU が進む（思考待ち 0 なので、応答の時点で次の Hero の手番か Hand の終了まで進んでいる）。
    const res = await act(
      base,
      handId,
      lastSeqOf(beforeDisconnect),
      passiveHero(beforeDisconnect),
    );
    expect(res.status).toBe(200);
    const afterReconnect = await firstViewThenDisconnect(base, handId);

    // 張り直した最初の View の log は、切る前の log をそのまま先頭に持つ（書き換え・欠落が無い）。
    expect(afterReconnect.log.slice(0, beforeDisconnect.log.length)).toEqual(
      beforeDisconnect.log,
    );
    // 表示済み（切る前）から先の Event を seq で取り出せば、Hero に見える Event の全量になる。
    const missed = pendingEvents(afterReconnect, lastSeqOf(beforeDisconnect));
    expect([...beforeDisconnect.log, ...missed]).toEqual(afterReconnect.log);
    expect(missed.length).toBeGreaterThan(0);
    expect(lastSeqOf(afterReconnect)).toBeGreaterThan(lastSeqOf(started));
    const log = events(handId);
    expectNoLeak(beforeDisconnect, log);
    expectNoLeak(afterReconnect, log);
  });

  it("REST の応答と SSE の Push が同じ View を重ねて運んでも、seq で積めば同じ Event を 2 回演出しない", async () => {
    const { base, events } = await listenApp(9);
    const { handId, view: started } = await startHand(base);
    const stream = await fetch(`${base}/api/hands/${handId}/stream`);
    const bodyPromise = stream.text();

    const responses: HeroView[] = [started];
    let view = started;
    while (view.status !== "complete") {
      const res = await act(base, handId, lastSeqOf(view), passiveHero(view));
      expect(res.status).toBe(200);
      view = ((await res.json()) as { view: HeroView }).view;
      responses.push(view);
    }
    const pushed = parseSseViews(await bodyPromise);

    // REST の応答の View は、同じ時点の SSE の View と同じもの（どちらを先に受けても良い）。
    const pushedBySeq = new Map(pushed.map((v) => [lastSeqOf(v), v]));
    for (const r of responses) {
      expect(pushedBySeq.get(lastSeqOf(r))).toEqual(r);
    }
    // REST と SSE を交互に、重ねて受けた順に積んでも、積んだ Event は Hero に見える Event の全量で重複しない。
    const merged = [...pushed, ...responses].sort(
      (a, b) => lastSeqOf(a) - lastSeqOf(b),
    );
    const queued: HandEvent[] = [];
    let queuedSeq = -1;
    for (const v of merged) {
      queued.push(...pendingEvents(v, queuedSeq));
      queuedSeq = Math.max(queuedSeq, lastSeqOf(v));
    }
    expect(queued).toEqual(view.log);
    expect(new Set(queued.map((e) => e.seq)).size).toBe(queued.length);
    for (const v of pushed) expectNoLeak(v, events(handId));
  });

  it("演出が追いついていない表示（途中の時点）の lastSeq で操作を送ると stale_view で弾かれ、Event Log は変わらない", async () => {
    const { base, events } = await listenApp(9);
    const { handId, view } = await startHand(base);
    // Hand の開始の 1 通は複数の Event を運ぶ。そのうち途中の Event までしか表示していない状態を想定する。
    expect(view.log.length).toBeGreaterThan(1);
    const displayedSeq = (view.log.at(-2) as HandEvent).seq;
    const before = events(handId).length;

    const stale = await act(base, handId, displayedSeq, passiveHero(view));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { kind: "stale_view" } });
    expect(events(handId)).toHaveLength(before);

    // 表示が最新に追いついた（表示中の lastSeq = 最新の lastSeq）ときだけ通る（seed 9 では開始の時点で Hero の手番）。
    expect(view.legalActions?.playerId).toBe(HERO);
    const ok = await act(base, handId, lastSeqOf(view), passiveHero(view));
    expect(ok.status).toBe(200);
  });
  it("Live の log から client で作る各時点の卓は、Replay の steps と同じ（演出の部品を Live と Replay で共有できる）", async () => {
    const { base } = await listenApp(9);
    const { handId, view: started } = await startHand(base);
    let view = started;
    while (view.status !== "complete") {
      const res = await act(base, handId, lastSeqOf(view), passiveHero(view));
      view = ((await res.json()) as { view: HeroView }).view;
    }
    const replay = (await (
      await fetch(`${base}/api/replay/hands/${handId}`)
    ).json()) as { steps: HeroView[] };
    // Replay は Action に決まった裁定とその ACTION_TAKEN を 1 step にまとめる（replaySteps）。画面からの操作の無いこの Hand では 1 Event = 1 step。
    expect(view.log.some((e) => e.type === "DEALER_RULING")).toBe(false);
    const live = view.log.map((_, i) => ({
      ...projectHeroView(view.log.slice(0, i + 1), HERO),
      legalActions: null,
    }));
    expect(replay.steps).toEqual(live);
  });
});
