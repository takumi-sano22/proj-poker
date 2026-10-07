// Phase 6 の Learning 系の応答の Leakage 0（#119・docs/09 §10）。
// Hand API で Persona つきの RuleBot と実際に Hand を進め、User Read・Note / Tag を記録し、E2E 用の固定応答の Review AI で
// Pass A と Pass B（Learning-only Reveal）を作ってから Drill を始め、Hero に返す Learning の応答
// （Session Review・Player Profile・Drill の一覧・Note / Tag・読みの後の HeroView・Pass A の Evidence）に、
// CPU の Hidden Persona・Pass B の文・Hero が知り得ない札が 1 つも入らないことを、同じ 1 本の流れで確かめる。
// 個々の経路の詳細は learning.test.ts・session-review.test.ts・drills.test.ts・notes.test.ts・evidence.test.ts が持つ。
import {
  cardToString,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import { createFakeReviewQuery } from "../review/fake-review-query.js";
import type { RevealStatus, ReviewStatus } from "../review/review-service.js";
import { collectCards, forbiddenKeys, personaTerms } from "../testing/leaks.js";

const HERO = "hero";
const CPU = PHASE1_TABLE_SETUP.players.find((p) => p.kind === "cpu")
  ?.playerId as string;
const READ_TEXT = "読みのテキスト-leak-5d1e";
const NOTE_TEXT = "ノートのテキスト-leak-8b20";

type App = ReturnType<typeof buildApp>;

let apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function lastSeq(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

async function inject<T>(
  app: App,
  method: "GET" | "POST",
  url: string,
  payload?: object,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(res.statusCode, `${method} ${url}`).toBeLessThan(300);
  return res.json<T>();
}

/** Hand を最後まで進める（Hero は Call / Check）。 */
async function playToEnd(
  app: App,
  handId: string,
  from: HeroView,
): Promise<HeroView> {
  let view = from;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    view = (
      await inject<{ view: HeroView }>(
        app,
        "POST",
        `/api/hands/${handId}/actions`,
        { lastSeq: lastSeq(view), action: passive(view) },
      )
    ).view;
  }
  return view;
}

/** 生成が終わる（pending でなくなる）まで GET を繰り返す。 */
async function waitSettled<T extends { generation: { state: string } }>(
  app: App,
  url: string,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const body = await inject<T>(app, "GET", url);
    if (body.generation.state !== "pending") return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Review の生成が終わらない");
}

describe("Phase 6 の Learning 系の応答の Leakage 0（Hidden Persona・Learning-only Reveal）", () => {
  it("User Read・Note / Tag・Pass A / Pass B・Drill の後も、Learning の応答に Persona・Pass B の文・Hero が知り得ない札が入らない", async () => {
    const store = new InMemoryEventStore();
    let handNo = 0;
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      store,
      // CPU は Persona つきの RuleBot（席順に Preset を割り当てる既定の卓）。
      createOpponent: createRuleBot,
      nextSeed: () => 42,
      nextHandId: () => `hand-${++handNo}`,
      // Pass A は「改善の余地あり」（Leak と Weakness Hypothesis と Drill の候補が出る）。
      review: { query: createFakeReviewQuery("improvement_suggested") },
    });
    apps.push(app);

    // Hero の手番に読みを記録し、CPU に Note / Tag を残してから Hand を終える。
    const started = await inject<{ handId: string; view: HeroView }>(
      app,
      "POST",
      "/api/hands",
      { afterHandId: null },
    );
    const { handId } = started;
    expect(started.view.actorId).toBe(HERO);
    const afterRead = (
      await inject<{ view: HeroView }>(
        app,
        "POST",
        `/api/hands/${handId}/reads`,
        {
          lastSeq: lastSeq(started.view),
          targetPlayerId: CPU,
          text: READ_TEXT,
        },
      )
    ).view;
    const notesUrl = `/api/hands/${handId}/players/${CPU}`;
    await inject(app, "POST", `${notesUrl}/notes`, {
      noteId: randomUUID(),
      body: NOTE_TEXT,
    });
    await inject(app, "POST", `${notesUrl}/tags`, { tag: "Loose" });
    await playToEnd(app, handId, afterRead);

    // Pass A（判断時点）と Pass B（Learning-only Reveal）を作る。
    const reviewUrl = `/api/reviews/hands/${handId}/decisions/0`;
    await inject(app, "POST", reviewUrl, {});
    const passA = await waitSettled<ReviewStatus>(app, reviewUrl);
    expect(passA.latest?.assessment).toBe("improvement_suggested");
    expect(passA.latest?.evidence.userRead.status).toBe("collected");
    await inject(app, "POST", `${reviewUrl}/reveal`, {});
    const passB = await waitSettled<RevealStatus>(app, `${reviewUrl}/reveal`);
    const revealText = passB.latest?.explanation.readComparison ?? "";
    expect(revealText).not.toBe("");

    // 元の判断から Drill を始める（Drill の Hand は終えなくてよい。一覧と provenance だけを見る）。
    await inject(app, "POST", "/api/drills", { handId, decisionIndex: 0 });

    const sessionReview = await inject<object>(
      app,
      "GET",
      `/api/learning/session-review/${handId}`,
    );
    const profile = await inject<object>(app, "GET", "/api/learning/profile");
    const drills = await inject<{ drills: Record<string, unknown>[] }>(
      app,
      "GET",
      "/api/drills",
    );
    const notes = await inject<object>(app, "GET", `${notesUrl}/notes`);
    expect(drills.drills).toHaveLength(1);
    expect(JSON.stringify(notes)).toContain(NOTE_TEXT);
    // 前提: Leak から Hypothesis が作られている（空の応答で通っているのではない）。
    expect(JSON.stringify(profile)).toContain("supportingEvidenceIds");

    // Drill の一覧の variant / change は Drill 自身の設定（opponent_tendency の Preset は Drill の相手の傾向で、
    // 元の CPU の Hidden Persona ではない。docs/07 §7）なので外して調べる。
    const drillsWithoutSetting = drills.drills.map((d) => ({
      ...d,
      variant: null,
      change: null,
    }));

    for (const [name, payload] of Object.entries({
      sessionReview,
      profile,
      drills: drillsWithoutSetting,
      notes,
      afterRead,
      passAEvidence: passA.latest?.evidence.userRead,
    })) {
      // Hidden Persona（Preset の ID・名前・"persona"）・Deck・seed・system の記録が入らない。
      expect(forbiddenKeys(payload), name).toEqual([]);
      expect(personaTerms(payload), name).toEqual([]);
    }

    // Learning-only Reveal（Pass B）の文・評価の列は、Learning の応答に入らない。
    for (const payload of [sessionReview, profile, drills]) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain(revealText);
      expect(json).not.toContain("readComparison");
      expect(json).not.toContain("reveal");
    }

    // 札: Profile と Drill の一覧は札を持たない。Session Review の札は Hero 自身の札だけ
    // （Showdown で公開された他者の札・Learning-only Reveal の札も出さない）。
    expect(collectCards(profile)).toEqual([]);
    expect(collectCards(drills)).toEqual([]);
    const log: HandEvent[] = store.read(handId).map((s) => s.event);
    const own = log.find(
      (e) => e.type === "HOLE_CARD_DEALT" && e.playerId === HERO,
    );
    const heroCards =
      own?.type === "HOLE_CARD_DEALT" ? own.cards.map(cardToString) : [];
    const shown = collectCards(sessionReview).map(cardToString);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((c) => heroCards.includes(c))).toBe(true);
  });
});
