// Phase 7 の Critical E2E（#144・docs/09 §8）: Rich Opponent Simulation の通し。
// Fixed CPU と Guest の卓で Session を終わりまで Play → 新しい Session → Opponent Memory Reset。
// (1) Fixed CPU と複数 Session をプレイする（Session の終わりは Hero の Bust。アプリの「新しい Session を始める」で次の Session）
// (2) 前の Session の observable Evidence を、次の Session の同じ cpuProfileId の CPU が Memory として使う
// (3) Guest は次の Session に Memory を持ち越さない
// (4) CPU-to-CPU の Private Memory が第三者の CPU に漏れない
// (5) Tilt が Session の終わりで Reset される
// (6) Opponent Memory Reset の後は Reset より前の Hand を Memory に使わず、User Note / Tag は残る
// Hidden の Memory・Persona・Tilt は Hero の画面・API に出さない（D105・D107）ので、確認用の API を本番に足さず、テストプロセスから
// 一時 DB を読み取り専用で開き、server と同じ Projection の関数で作り直して確かめる（support/opponent-memory.ts）。あわせて、
// Hero の画面と API の応答に Memory / Persona / Tilt の値が出ていないことも確かめる。
// 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答なので Claude を呼ばない（D98）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { OpponentMemorySummary } from "../../apps/server/src/memory/memory-summary.js";
import { PHASE7_CPU_POOL } from "../../apps/server/src/opponents/cpu-pool.js";
import { forbiddenKeys } from "../../apps/server/src/testing/leaks.js";
import { startNextHand } from "../support/next-hand.js";
import {
  evidenceHandIds,
  openOpponentMemoryProbe,
  type CpuSeatOfHand,
  type OpponentMemoryProbe,
  type SavedHand,
} from "../support/opponent-memory.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/**
 * 山札の seed の始まり。既定の 6 人卓・Hero が Call / Check だけで打つと、この seed では次の編成になる（RuleBot の決定論）:
 * - Session 1 は数 Hand で Hero が Bust して終わり、CPU の席に Guest が 1 人座る
 * - Session 2 にも別の Guest が座り、Session 1 にいなかった Fixed CPU と、Session 1 にいた Fixed CPU が両方いる
 * - Session 1 の終わりに Tilt が 1 以上の Fixed CPU が、Session 2 にも座る
 * 編成が変わってこの前提が崩れたら、検査を空振りさせずに前提の expect で落とす（seed を選び直す）。
 */
const SEED = "20261042";

// 既定の 1280×720 では、Session の終わりの「新しい Session を始める」が Hero の席に覆われて押せない（#158。この PR では直さない）。
// この E2E は Memory の流れを確かめるものなので、席と重ならない高さの画面で動かす。
test.use({ viewport: { width: 1280, height: 900 } });

let dir = "";
let server: RunningServer | null = null;
let probe: OpponentMemoryProbe | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-memory-"));
});

// Playwright は第 1 引数（fixture）を分割代入で受けることを求めるので、使わない fixture も {} で受ける。
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  probe?.close();
  probe = null;
  if (server !== null) {
    // 失敗したら server のログを添付する（原因の手がかり）。
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("server.log", {
        body: server.output(),
        contentType: "text/plain",
      });
    }
    await stopServer(server);
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 宣言 Button の補助の額（Call は Legal Action の額。合法でなければ出ない）。 */
async function declaredAmount(button: Locator): Promise<number | null> {
  const amount = button.locator(".declaration__amount");
  if ((await amount.count()) === 0) return null;
  const text = (await amount.innerText()).replace(/[,，]/g, "");
  const match = /^\d+/.exec(text);
  return match === null ? null : Number(match[0]);
}

/** Hand の終わりまで、Hero は Call できれば Call、できなければ Check で進める（Fold しないので、数 Hand で Bust しうる）。 */
async function playToHandEnd(page: Page): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  for (let turn = 0; turn < 30; turn++) {
    const done = dock.getByText(
      /Hand が終了しました。|Session が終了しました。/,
    );
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return;

    const before = await log.count();
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    if ((await declaredAmount(call)) !== null) {
      await call.click();
    } else {
      await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    }
    // 操作が裁定されて卓の状態が進む（ログの行が増える）まで待ってから、次の手番を読む（古い画面で二重に操作しない）。
    await expect
      .poll(() => log.count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  }
  throw new Error("Hand が 30 手番で終わらなかった");
}

/** 最初の Hand を始め、その handId を返す。 */
async function startFirstHand(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands",
    ),
    page.getByRole("button", { name: "Hand を始める" }).click(),
  ]);
  expect(res.ok(), "最初の Hand の開始").toBe(true);
  return ((await res.json()) as { handId: string }).handId;
}

/** Session が終わったか（Hero の欄の表示）。 */
async function sessionEnded(page: Page): Promise<boolean> {
  return page
    .getByRole("region", { name: "Hero" })
    .getByText("Session が終了しました。")
    .first()
    .isVisible();
}

/** Memory の要約の Subject（参加者の鍵）ごとの「見た Hand の数」。 */
function observedCounts(summary: OpponentMemorySummary): Map<string, number> {
  return new Map(
    summary.subjects.map((s) => [
      s.subject.kind === "hero"
        ? "hero"
        : s.subject.kind === "cpu_profile"
          ? JSON.stringify(["cpu_profile", s.subject.cpuProfileId])
          : JSON.stringify(["guest", s.subject.guestId]),
      s.handsObserved,
    ]),
  );
}

/** Observer の鍵 → Memory（Hand の開始時に CPU ごとに作った要約。席の鍵を参加者の鍵へ置き換える）。 */
function memoriesByKey(
  memories: ReadonlyMap<string, OpponentMemorySummary>,
  seats: readonly CpuSeatOfHand[],
): Map<string, OpponentMemorySummary> {
  return new Map(
    seats.map((s) => {
      const memory = memories.get(s.playerId);
      if (memory === undefined) throw new Error(`Memory が無い: ${s.key}`);
      return [s.key, memory] as const;
    }),
  );
}

/**
 * 独立に数えた「その Hand の開始時に、Observer が Subject と同じ卓で見た Hand の数」。
 * before の Hand のうち、Observer と Subject の両方が席にいた Hand（Subject が Hero なら Observer が席にいた Hand）を数える。
 * Guest の Observer は自分の Session の Hand だけ（参加者の鍵が Session 限りなので、前の Session の Hand では席にいない）。
 */
function coSeatedHands(
  before: readonly SavedHand[],
  seatsOf: (handId: string) => readonly CpuSeatOfHand[],
  observerKey: string,
  subjectKey: string,
): string[] {
  return before
    .filter((h) => {
      const keys = new Set(seatsOf(h.handId).map((s) => s.key));
      return (
        keys.has(observerKey) && (subjectKey === "hero" || keys.has(subjectKey))
      );
    })
    .map((h) => h.handId);
}

/** Hero の API の応答・画面に出てはいけない語（Memory・Tilt・Table Tendency の値と、Pool の Identity・Persona）。 */
const HIDDEN_TERMS = [
  '"memory"',
  '"memories"',
  '"tilt"',
  '"tableTendency"',
  '"handsObserved"',
  '"tendencies"',
  '"observer"',
  "cpuProfileId",
  "cpu_profile",
  "guest/",
  "phase7_",
  ...PHASE7_CPU_POOL.fixed.map((p) => p.cpuProfileId),
];

function hiddenTermsIn(payload: unknown): string[] {
  const json = JSON.stringify(payload);
  return [
    ...HIDDEN_TERMS.filter((t) => json.includes(t)),
    // Pool の名前（OI-005。画面にも出さない）は JSON の文字列の値として出ていないか。
    ...PHASE7_CPU_POOL.fixed
      .map((p) => `"${p.name}"`)
      .filter((t) => json.includes(t)),
    ...forbiddenKeys(payload),
  ];
}

/**
 * Play の間に画面が受け取った Hero 向けの応答を全部集める（Hand の開始・操作・Note / Tag の応答と、進行中の SSE の各 Event）。
 * 終わった後の View・Replay だけを見ると、進行中の応答にだけ混ざって終わると消える漏れを見逃すため。
 * SSE は EventSource の本文を Playwright の応答から読めないので、ページの EventSource を包んで受け取った data を残す（テストの手順だけの観測で、
 * 画面の挙動は変えない）。
 */
async function captureHeroTraffic(
  page: Page,
): Promise<() => Promise<{ name: string; body: unknown }[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __heroSse: string[];
      EventSource: typeof EventSource;
    };
    w.__heroSse = [];
    const Original = w.EventSource;
    w.EventSource = class extends Original {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        for (const type of ["view", "session", "outage", "message"]) {
          this.addEventListener(type, (event) => {
            w.__heroSse.push((event as MessageEvent<string>).data);
          });
        }
      }
    };
  });
  const responses: Promise<{ name: string; body: unknown }>[] = [];
  page.on("response", (res) => {
    const url = new URL(res.url());
    const type = res.headers()["content-type"] ?? "";
    if (!url.pathname.startsWith("/api/") || !type.includes("json")) return;
    responses.push(
      res.json().then((body: unknown) => ({
        name: `${res.request().method()} ${url.pathname}`,
        body,
      })),
    );
  });
  return async () => {
    const sse = await page.evaluate(
      () => (window as unknown as { __heroSse: string[] }).__heroSse,
    );
    return [
      ...(await Promise.all(responses)),
      ...sse.map((data, i) => ({
        name: `SSE #${i}`,
        body: JSON.parse(data) as unknown,
      })),
    ];
  };
}

/** SSE の本文の data 行（JSON）。 */
function sseData(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
}

test("Fixed CPU と Guest の卓で複数 Session を Play し、Memory の持ち越し・Guest の破棄・Private Memory の分離・Tilt の Reset・Opponent Memory Reset を確かめる", async ({
  page,
}) => {
  // Session を 2 つ遊ぶので、既定（120 秒）より長く待つ。
  test.setTimeout(300_000);
  const dbPath = join(dir, "poker.sqlite");
  server = await startServer(dbPath, { POKER_SEED: SEED });
  // 読み取り専用の接続は server の書き込みと並べて使える（SQLite）。Hand の保存は Hand の終わりに 1 トランザクションで行われる。
  probe = openOpponentMemoryProbe(dbPath);
  const p = probe;

  // 画面が Play の間に受け取る応答（進行中の SSE を含む）を、最初のページの読み込みの前から集める。
  const heroTraffic = await captureHeroTraffic(page);

  // Hand は一覧の並びではなく、開始の応答の handId で特定する（#129・D117）。
  const session1: string[] = [];
  const session2: string[] = [];

  await test.step("(1) Fixed CPU と Guest の卓で、Hero が Bust して Session が終わるまで Play する", async () => {
    await page.goto("/");
    session1.push(await startFirstHand(page));
    for (let i = 0; i < 30; i++) {
      await playToHandEnd(page);
      if (await sessionEnded(page)) break;
      session1.push(await startNextHand(page));
    }
    await expect(
      page
        .getByRole("region", { name: "Hero" })
        .getByText("Session が終了しました。")
        .first(),
    ).toBeVisible();
    // Memory の作り直しに Session の中の Hand が 2 つ以上いる（Guest が Session の中で Memory を積むことも見る）。
    expect(session1.length, "Session 1 の Hand の数").toBeGreaterThanOrEqual(2);
  });

  await test.step("新しい Session を始めて、最初の Hand を最後まで Play する", async () => {
    session2.push(await startNextHand(page, "新しい Session を始める"));
    await playToHandEnd(page);
    expect(await sessionEnded(page), "Session 2 は続く").toBe(false);
  });

  const saved = () => p.savedHands();
  const handOf = (handId: string): SavedHand => {
    const hand = saved().find((h) => h.handId === handId);
    if (hand === undefined) throw new Error(`保存されていない: ${handId}`);
    return hand;
  };
  const before = (handId: string): SavedHand[] =>
    saved().filter((h) => h.ord < handOf(handId).ord);
  const seatsOf = (handId: string) => p.cpuSeatsOf(handId);

  const s1Id = handOf(session1[0] ?? "").sessionId;
  const s2First = session2[0] ?? "";
  const s2Id = handOf(s2First).sessionId;
  const s1Last = session1.at(-1) ?? "";

  // 編成の前提（seed の選び方。崩れたら検査が空振りするので先に落とす）。
  const s1Participants = p.participants(s1Id);
  const s2Participants = p.participants(s2Id);
  const guest1 = s1Participants.find((q) => q.kind === "guest");
  const guest2 = s2Participants.find((q) => q.kind === "guest");
  const fixed1 = new Set(
    s1Participants.flatMap((q) => (q.kind === "fixed" ? [q.cpuProfileId] : [])),
  );
  const fixed2 = s2Participants.flatMap((q) =>
    q.kind === "fixed" ? [q.cpuProfileId] : [],
  );
  const fixedBoth = fixed2.filter((id) => fixed1.has(id));
  const fixedNew = fixed2.filter((id) => !fixed1.has(id));
  const cpuKey = (id: string) => JSON.stringify(["cpu_profile", id]);
  expect(s1Id).not.toBe(s2Id);
  expect(guest1, "Session 1 に Guest が座る").toBeDefined();
  expect(guest2, "Session 2 に Guest が座る").toBeDefined();
  expect(
    fixedBoth.length,
    "両方の Session に座る Fixed CPU",
  ).toBeGreaterThanOrEqual(2);
  expect(
    fixedNew.length,
    "Session 2 で初めて座る Fixed CPU",
  ).toBeGreaterThanOrEqual(1);

  await test.step("(2) 前の Session の観察（observable Evidence）を、次の Session の同じ Fixed CPU が Memory として使う", () => {
    const memories = memoriesByKey(
      p.memoriesAt(s2First, { withResets: true }),
      seatsOf(s2First),
    );
    const earlier = before(s2First);
    // Session 2 の最初の Hand の開始時に保存済みなのは Session 1 の Hand だけ。
    expect(earlier.map((h) => h.handId).sort()).toEqual([...session1].sort());
    for (const id of fixedBoth) {
      const memory = memories.get(cpuKey(id));
      if (memory === undefined) throw new Error(`Memory が無い: ${id}`);
      const seen = coSeatedHands(earlier, seatsOf, cpuKey(id), "hero");
      expect(
        seen.length,
        `${id} が Session 1 で Hero と同じ卓にいた Hand`,
      ).toBeGreaterThan(0);
      // Hero について見た Hand の数は、Session 1 で同じ卓にいた Hand の数（cpuProfileId で Session を跨いで引く）。
      expect(observedCounts(memory).get("hero"), id).toBe(seen.length);
      // Evidence は Session 1 の、その CPU が座っていた Hand の public の Action から来ている。
      const evidence = evidenceHandIds(memory);
      expect(evidence.size, `${id} の Evidence`).toBeGreaterThan(0);
      for (const handId of evidence) expect(seen).toContain(handId);
    }
  });

  await test.step("(3) Guest は次の Session に Memory を持ち越さない", () => {
    if (guest1 === undefined || guest2 === undefined)
      throw new Error("Guest が無い");
    const g1 = JSON.stringify([
      "guest",
      guest1.kind === "guest" ? guest1.guestId : "",
    ]);
    const g2 = JSON.stringify([
      "guest",
      guest2.kind === "guest" ? guest2.guestId : "",
    ]);
    // Guest の Identity は Session 限り（別の Session の Guest は別の id。前の Session の Guest は座らない）。
    expect(g2).not.toBe(g1);
    expect(seatsOf(s2First).map((s) => s.key)).not.toContain(g1);

    // Session 1 の Guest は、その Session の中では Memory を積む（Session 1 の最後の Hand の開始時）。
    const inSession1 = memoriesByKey(
      p.memoriesAt(s1Last, { withResets: true }),
      seatsOf(s1Last),
    ).get(g1);
    if (inSession1 === undefined)
      throw new Error("Session 1 の Guest の Memory が無い");
    const g1Seen = coSeatedHands(before(s1Last), seatsOf, g1, "hero");
    expect(g1Seen.length).toBeGreaterThan(0);
    expect(observedCounts(inSession1).get("hero")).toBe(g1Seen.length);

    // Session 2 の Guest は空の Memory から始まる（前の Session に同じ席に座っていた CPU の観察も引き継がない）。
    const memories = memoriesByKey(
      p.memoriesAt(s2First, { withResets: true }),
      seatsOf(s2First),
    );
    const g2Memory = memories.get(g2);
    if (g2Memory === undefined)
      throw new Error("Session 2 の Guest の Memory が無い");
    expect(g2Memory.subjects.length).toBeGreaterThan(0);
    for (const subject of g2Memory.subjects) {
      expect(subject.handsObserved, `Guest から見た ${subject.playerId}`).toBe(
        0,
      );
      expect(subject.items).toEqual([]);
    }
    // Fixed CPU から見た Session 2 の Guest も初対面（Session 1 の Guest の観察が、新しい Guest に付かない）。
    for (const [key, memory] of memories) {
      if (key === g2) continue;
      expect(observedCounts(memory).get(g2), `${key} から見た Guest`).toBe(0);
    }
  });

  await test.step("(4) CPU-to-CPU の Private Memory が第三者の CPU に漏れない", () => {
    const seats = seatsOf(s2First);
    const memories = memoriesByKey(
      p.memoriesAt(s2First, { withResets: true }),
      seats,
    );
    const earlier = before(s2First);
    // どの Observer の Memory も、その Observer 自身が同じ卓で見た Hand だけから作られている
    // （別の CPU の観察が混ざれば、見た Hand の数が同じ卓にいた Hand の数を超える）。
    for (const observer of seats) {
      const memory = memories.get(observer.key);
      if (memory === undefined)
        throw new Error(`Memory が無い: ${observer.key}`);
      for (const [subjectKey, count] of observedCounts(memory)) {
        expect(count, `${observer.key} から見た ${subjectKey}`).toBe(
          coSeatedHands(earlier, seatsOf, observer.key, subjectKey).length,
        );
      }
      const own = coSeatedHands(earlier, seatsOf, observer.key, "hero");
      for (const handId of evidenceHandIds(memory)) {
        expect(own, `${observer.key} の Evidence の Hand`).toContain(handId);
      }
    }
    // 空振りでない: Session 1 から座る Fixed CPU A は Fixed CPU B を見ているが、Session 2 で初めて座る Fixed CPU C から見た B は 0。
    const [a, b] = fixedBoth;
    const c = fixedNew[0];
    if (a === undefined || b === undefined || c === undefined)
      throw new Error("編成の前提");
    expect(
      observedCounts(memories.get(cpuKey(a)) as OpponentMemorySummary).get(
        cpuKey(b),
      ),
    ).toBeGreaterThan(0);
    expect(
      observedCounts(memories.get(cpuKey(c)) as OpponentMemorySummary).get(
        cpuKey(b),
      ),
    ).toBe(0);
  });

  await test.step("(5) Tilt は Session の終わりで Reset され、Memory は持ち越す", () => {
    // Session 1 の終わりの Tilt（Session 1 の Hand を全部畳み込んだ値）が 1 以上で、Session 2 にも座る Fixed CPU。
    const endOf1 = p.tiltsAfter(s1Last);
    const s1Seats = seatsOf(s1Last);
    const tilted = s1Seats.filter(
      (s) =>
        (endOf1.get(s.playerId)?.level ?? 0) >= 1 &&
        s.participant.kind === "fixed" &&
        fixedBoth.includes(s.participant.cpuProfileId),
    );
    expect(
      tilted.length,
      "Session 1 の終わりに Tilt が上がっていて、Session 2 にも座る Fixed CPU",
    ).toBeGreaterThan(0);
    // Session 2 の最初の Hand の開始時の Tilt は全員 0（Tilt は Session の中だけの transient な状態。D107）。
    expect([...p.tiltsAt(s2First)]).toEqual([]);
    // 同じ CPU の Memory（永続の層）は持ち越している。
    const memories = memoriesByKey(
      p.memoriesAt(s2First, { withResets: true }),
      seatsOf(s2First),
    );
    for (const s of tilted) {
      expect(
        observedCounts(memories.get(s.key) as OpponentMemorySummary).get(
          "hero",
        ),
      ).toBeGreaterThan(0);
    }
  });

  // Note / Tag を残した Hand と席（Session 2 の Fixed CPU）。
  let noteHand = "";
  let notePlayer = "";
  const NOTE = "Reset の後も残る Note";
  const TAG = "Sticky";
  await test.step("Session 2 の Hand を Play し、Fixed CPU に Note / Tag を残す", async () => {
    noteHand = await startNextHand(page);
    session2.push(noteHand);
    await playToHandEnd(page);
    expect(await sessionEnded(page), "Session 2 は続く").toBe(false);
    const seat = seatsOf(noteHand).find((s) => s.participant.kind === "fixed");
    if (seat === undefined) throw new Error("Fixed CPU の席が無い");
    notePlayer = seat.playerId;
    const notes = page.locator(".opponent-notes");
    await notes.getByText("CPU の Note / Tag").click();
    await notes
      .getByRole("combobox")
      .selectOption({ label: `CPU ${notePlayer.replace("cpu", "")}` });
    await notes.getByRole("textbox", { name: "Tag" }).fill(TAG);
    await notes.getByRole("button", { name: "Tag を付ける" }).click();
    await expect(notes.locator(".opponent-notes__tag")).toHaveText([TAG]);
    await notes.getByRole("textbox", { name: "Note" }).fill(NOTE);
    await notes.getByRole("button", { name: "Note を残す" }).click();
    await expect(notes.getByText(NOTE)).toBeVisible();
  });

  let resetPayload: unknown = null;
  let afterReset = "";
  await test.step("(6) Opponent Memory Reset の後は Reset より前の Hand を Memory に使わず、User Note / Tag は残る", async () => {
    const notesBefore: unknown = await (
      await page.request.get(
        `/api/hands/${noteHand}/players/${notePlayer}/notes`,
      )
    ).json();

    const res = await page.request.post("/api/opponents/memory-resets", {
      data: { scope: "all" },
    });
    expect(res.status()).toBe(201);
    resetPayload = await res.json();
    // 応答は区切りの時刻と対象だけ（Memory の中身・Pool の名前を返さない）。
    const reset = (resetPayload as { reset: Record<string, unknown> }).reset;
    expect(Object.keys(reset).sort()).toEqual([
      "cpuProfileId",
      "createdAt",
      "resetId",
      "scope",
    ]);
    expect(reset["scope"]).toBe("all");
    expect(reset["cpuProfileId"]).toBeNull();

    // 区切りは追加した時点の最後の保存済みの Hand（Reset の直前の Hand）。全 CPU に効く。
    const lastBeforeReset = handOf(noteHand);
    for (const s of seatsOf(noteHand)) {
      const observer =
        s.participant.kind === "fixed"
          ? {
              kind: "cpu_profile" as const,
              cpuProfileId: s.participant.cpuProfileId,
            }
          : { kind: "guest" as const, guestId: s.participant.guestId };
      expect(p.resetBoundary(observer)).toBe(lastBeforeReset.ord);
    }

    // Reset の後の最初の Hand: どの CPU の Memory も空（Reset より前の Hand を使わない）。区切りを当てなければ、前の Hand から作られる。
    afterReset = await startNextHand(page);
    session2.push(afterReset);
    await playToHandEnd(page);
    expect(await sessionEnded(page), "Session 2 は続く").toBe(false);
    const withReset = p.memoriesAt(afterReset, { withResets: true });
    const withoutReset = p.memoriesAt(afterReset, { withResets: false });
    for (const s of seatsOf(afterReset)) {
      for (const subject of withReset.get(s.playerId)?.subjects ?? []) {
        expect(
          subject.handsObserved,
          `${s.key} から見た ${subject.playerId}`,
        ).toBe(0);
      }
      const unreset = withoutReset.get(s.playerId);
      expect(
        observedCounts(unreset as OpponentMemorySummary).get("hero"),
        `${s.key}（区切りなし）`,
      ).toBeGreaterThan(0);
    }

    // その次の Hand: Reset より後に保存された Hand（Reset の後の最初の Hand）だけから作り直す。
    const next = await startNextHand(page);
    session2.push(next);
    await playToHandEnd(page);
    const rebuilt = memoriesByKey(
      p.memoriesAt(next, { withResets: true }),
      seatsOf(next),
    );
    for (const s of seatsOf(next)) {
      const memory = rebuilt.get(s.key) as OpponentMemorySummary;
      const seen = coSeatedHands(
        saved().filter(
          (h) => h.ord > lastBeforeReset.ord && h.ord < handOf(next).ord,
        ),
        seatsOf,
        s.key,
        "hero",
      );
      expect(observedCounts(memory).get("hero"), s.key).toBe(seen.length);
      for (const handId of evidenceHandIds(memory)) {
        expect(handOf(handId).ord, `${s.key} の Evidence`).toBeGreaterThan(
          lastBeforeReset.ord,
        );
      }
    }

    // User Note / Tag は Reset の対象ではない（D120。Hero の記録は別の層）。
    const notesAfter: unknown = await (
      await page.request.get(
        `/api/hands/${noteHand}/players/${notePlayer}/notes`,
      )
    ).json();
    expect(notesAfter).toEqual(notesBefore);
    expect(JSON.stringify(notesAfter)).toContain(NOTE);
    expect(JSON.stringify(notesAfter)).toContain(TAG);
  });

  await test.step("Hero の画面と API の応答に Memory / Persona / Tilt の値が出ていない", async () => {
    // Reset の応答は、要求の対象を返す cpuProfileId の項目（all は null）だけを持つ。中身は上で確かめた。
    expect(forbiddenKeys(resetPayload)).toEqual([]);

    // Play の間に画面が受け取った応答（Hand の開始・操作・Note / Tag・進行中の SSE の各 View）。
    const live = await heroTraffic();
    expect(
      live.filter((x) => x.name.startsWith("SSE")).length,
      "進行中の SSE を受け取った",
    ).toBeGreaterThan(session1.length + session2.length);
    expect(
      live.filter((x) => x.name === "POST /api/hands").length,
      "Hand の開始の応答",
    ).toBe(session1.length + session2.length);
    const payloads: { name: string; body: unknown }[] = [...live];
    const getJson = async (path: string) => {
      const res = await page.request.get(path);
      expect(res.ok(), path).toBe(true);
      payloads.push({ name: path, body: await res.json() });
    };
    await getJson("/api/replay/hands");
    for (const handId of [...session1, ...session2]) {
      await getJson(`/api/replay/hands/${handId}`);
      // 終わった Hand の SSE は、Session の状態と Hero の View を 1 回ずつ送って閉じる。
      const stream = await page.request.get(`/api/hands/${handId}/stream`);
      expect(stream.ok()).toBe(true);
      payloads.push({
        name: `${handId}/stream`,
        body: sseData(await stream.text()),
      });
      for (const s of seatsOf(handId)) {
        await getJson(`/api/hands/${handId}/players/${s.playerId}/notes`);
      }
    }
    for (const { name, body } of payloads) {
      expect(hiddenTermsIn(body), name).toEqual([]);
    }

    // 画面（今の卓・進行ログ・Note / Tag の欄）にも Pool の Identity・名前・Persona が出ない。
    const text = await page.locator("body").innerText();
    expect(hiddenTermsIn(text)).toEqual([]);
    for (const profile of PHASE7_CPU_POOL.fixed) {
      expect(text).not.toMatch(new RegExp(`\\b${profile.name}\\b`));
    }
  });
});
