// CPU の Memory の注入（#139・D121）の情報境界の検査（不変条件 2・INV-INFO-001〜003・INV-TEST-008）。
// 1. 静的: CPU の判断のコード（opponents/・hand-orchestrator.ts）と Memory の要約（memory/memory-summary.ts）から import をたどり、
//    learning/（Hero の弱点）に届かず、Learning-only Reveal を参照しない（learning/learning-isolation.test.ts と同じ考え方）
// 2. 動的: Claude の CPU の query() を Fake にして（Claude は呼ばない。D87）複数の Session を進め、CPU の全 Prompt を走査する。
//    Pass A（Hero の弱点の Profile ができる）と Pass B（Learning-only Reveal）を作った後も、CPU A の Prompt の Memory は
//    A 自身が座って見た Hand の public の Action だけを Evidence に持ち（他の CPU の観察・Observer が座っていなかった Hand を含まない）、
//    前の Session の Guest を持ち越さず、他者の札・Persona・Learning-only Reveal・Hero の弱点の Profile が入らないことを確かめる。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  MAX_PLAYERS,
  projectLearningReveal,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { deriveSeed } from "../hand-orchestrator.js";
import { createClaudeOpponentFactory } from "../opponents/claude-opponent.js";
import {
  composeSessionParticipants,
  type SessionParticipant,
} from "../opponents/cpu-pool.js";
import { PERSONA_PRESETS } from "../opponents/persona.js";
import { createFakeReviewQuery } from "../review/fake-review-query.js";
import type { RevealStatus, ReviewStatus } from "../review/review-service.js";
import { allowedCardsAt, forbiddenKeys } from "../testing/leaks.js";
import type { OpponentMemorySummary } from "./memory-summary.js";
import {
  participantKey,
  participantRefOf,
  type ParticipantRef,
} from "./observation.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEARNING = join(SRC, "learning");

/** ファイルの相対 import（`import ... from "./x.js"` / `export ... from` / `import("./x.js")`）を .ts のパスにして返す。 */
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

/** コメントを除いたコード（コメントで名前を挙げただけのファイルを拾わない）。 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 入口から相対 import をたどって届く apps/server/src のファイル。 */
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

/** CPU の判断の入口（opponents/ と hand-orchestrator.ts。テストを除く）と Memory の要約。 */
function injectionEntries(): string[] {
  const opponents = join(SRC, "opponents");
  return [
    ...readdirSync(opponents)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(opponents, f)),
    join(SRC, "hand-orchestrator.ts"),
    join(SRC, "memory", "memory-summary.ts"),
  ];
}

describe("Memory の注入の境界（静的）", () => {
  it("CPU の判断のコードは Memory の要約に届き、learning/（Hero の弱点）には届かない", () => {
    const entries = injectionEntries();
    const reachable = reachableFrom(entries);
    // Hand Orchestrator と RuleBot から Memory の要約・Hypothesis に届いている（検査が注入の経路をたどれている）。
    expect(reachableFrom([join(SRC, "hand-orchestrator.ts")])).toContain(
      join(SRC, "memory", "memory-summary.ts"),
    );
    expect(reachable).toContain(join(SRC, "memory", "opponent-hypothesis.ts"));
    const leaked = [...reachable]
      .filter((f) => f.startsWith(LEARNING))
      .map((f) => relative(SRC, f));
    expect(leaked).toEqual([]);
  });

  it("CPU の判断のコードと、そこから届くモジュールは Learning-only Reveal を参照しない", () => {
    const referencing = [...reachableFrom(injectionEntries())]
      .filter((f) =>
        /projectLearningReveal|learning-reveal|LearningReveal/.test(codeOf(f)),
      )
      .map((f) => relative(SRC, f));
    expect(referencing).toEqual([]);
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

function cardsIn(text: string): string[] {
  return [...text.matchAll(/"([2-9TJQKA][cdhs])"/g)].map((m) => m[1] ?? "");
}

/** Prompt の Memory の節（無ければ null）。 */
function memoryIn(prompt: string): OpponentMemorySummary | null {
  const sections = prompt.split("\n\n");
  const at = sections.findIndex((s) => s.startsWith("## あなたの記憶"));
  return at < 0
    ? null
    : (JSON.parse(sections[at + 1] ?? "") as OpponentMemorySummary);
}

/** 既定の卓（6 人）で、新しい Session の編成に Guest が座る seed（Guest の持ち越しの検査を空振りさせない）。 */
function seedWithGuest(): number {
  const seats = PHASE1_TABLE_SETUP.players
    .filter((p) => p.kind === "cpu")
    .map((p) => ({
      playerId: p.playerId,
      persona: PHASE1_TABLE_SETUP.personas[p.playerId],
    }));
  for (let seed = 1; seed < 500; seed++) {
    const { participants } = composeSessionParticipants({
      sessionId: "probe",
      seats,
      seed: deriveSeed(seed, MAX_PLAYERS),
    });
    if (participants.some((p) => p.kind === "guest")) return seed;
  }
  throw new Error("Guest の座る seed が無い");
}

describe("Memory の注入の境界（Prompt の動的な走査）", () => {
  it("CPU の Prompt の Memory は自分が座って見た public の Action だけで、Guest を持ち越さず、札・Persona・Reveal・Hero の弱点が入らない", async () => {
    const seed = seedWithGuest();
    const store = new InMemoryEventStore();
    let handNo = 0;
    const handIdOf = () => `hand-${handNo}`;
    let failNext = false;
    const cpuPrompts: {
      handId: string;
      playerId: string;
      prompt: string;
      upto: number;
    }[] = [];
    // CPU の Fake: Schema の enum から check → call → fold の順に選ぶ（Showdown まで進みやすい）。failNext なら障害にする。
    const cpuQuery: ClaudeQuery = ({ prompt, options }) => {
      const handId = handIdOf();
      const fail = failNext;
      failNext = false;
      if (!fail) {
        cpuPrompts.push({
          handId,
          playerId: /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "",
          prompt,
          upto: store.read(handId).length - 1,
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
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      store,
      createOpponent: createClaudeOpponentFactory({
        model: "test-model",
        env: {},
        query: cpuQuery,
      }),
      nextSeed: () => seed,
      nextHandId: () => `hand-${++handNo}`,
      // Pass A は「改善の余地あり」（Hero の Weakness Hypothesis が Profile に出る）。
      review: { query: createFakeReviewQuery("improvement_suggested") },
    });
    apps.push(app);

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
    const waitSettled = async <T extends { generation: { state: string } }>(
      url: string,
    ): Promise<T> => {
      for (let i = 0; i < 400; i++) {
        const body = await inject<T>("GET", url);
        if (body.generation.state !== "pending") return body;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("生成が終わらない");
    };

    // Session 1: Hand 1 の後に Pass A（Hero の弱点）と Pass B（Learning-only Reveal）を作り、続けて 2 Hand。
    let last = await play(null);
    const hand1 = last;
    const reviewUrl = `/api/reviews/hands/${hand1}/decisions/0`;
    await inject("POST", reviewUrl, {});
    expect(
      (await waitSettled<ReviewStatus>(reviewUrl)).latest?.assessment,
    ).toBe("improvement_suggested");
    await inject("POST", `${reviewUrl}/reveal`, {});
    const passB = await waitSettled<RevealStatus>(`${reviewUrl}/reveal`);
    const revealText = passB.latest?.explanation.readComparison ?? "";
    expect(revealText).not.toBe("");
    const profile = await inject<{
      profile: { hypotheses: Record<string, unknown>[] };
    }>("GET", "/api/learning/profile");
    // 前提: Hero の弱点の Hypothesis が実際にある（空の Profile で通っているのではない）。
    expect(profile.profile.hypotheses.length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) last = await play(last);
    // CPU の障害で Session 1 を終え（Session 終了を選ぶ）、Session 2 を 3 Hand 進める。
    failNext = true;
    last = await play(last);
    const session1 = store.sessionIdOfHand(hand1) ?? "";
    expect(store.sessionIdOfHand(last)).toBe(session1);
    for (let i = 0; i < 3; i++) last = await play(last);
    const session2 = store.sessionIdOfHand(last) ?? "";
    expect(session2).not.toBe(session1);

    // 各 Hand の席 → 参加者（Hero は hero、CPU は session_participants）。
    const participantsOf = (sessionId: string): SessionParticipant[] => [
      ...store.sessionParticipants(sessionId),
    ];
    const refOf = (
      sessionId: string,
      playerId: string,
    ): ParticipantRef | null => {
      if (playerId === "hero") return { kind: "hero" };
      const p = participantsOf(sessionId).find((q) => q.playerId === playerId);
      return p === undefined ? null : participantRefOf(p);
    };
    const eventsOf = (handId: string): HandEvent[] =>
      store.read(handId).map((s) => s.event);
    const seatedIn = (handId: string): string[] => {
      const started = eventsOf(handId)[0];
      return started?.type === "HAND_STARTED"
        ? started.seats.map((s) => s.playerId)
        : [];
    };
    const guestIdsOf = (sessionId: string) =>
      participantsOf(sessionId).flatMap((p) =>
        p.kind === "guest" ? [p.guestId] : [],
      );
    // 前提: Session 1 に Guest がいて、Session 2 の Guest は別の id。
    expect(guestIdsOf(session1)).toHaveLength(1);
    expect(guestIdsOf(session2)).not.toContain(guestIdsOf(session1)[0]);

    // Hero の弱点の Profile と Learning-only Reveal の印・文。
    const profileTerms = [
      ...new Set(
        profile.profile.hypotheses.flatMap((h) =>
          [h["hypothesisId"], h["type"]].filter(
            (v): v is string => typeof v === "string",
          ),
        ),
      ),
    ];
    expect(profileTerms.length).toBeGreaterThan(0);
    const revealed = (
      projectLearningReveal(eventsOf(hand1))?.holeCards ?? []
    ).flatMap((h) => h.cards.map(cardToString));
    expect(revealed.length).toBeGreaterThan(4);

    let withEvidence = 0;
    let carriedOver = 0;
    for (const { handId, playerId, prompt, upto } of cpuPrompts) {
      const sessionId = store.sessionIdOfHand(handId) ?? "";
      // 札はその時点でその CPU が知ってよいものだけ（他者の Hidden Cards・Learning-only Reveal の札が無い）。
      const allowed = allowedCardsAt(eventsOf(handId), playerId, upto);
      expect(cardsIn(prompt).filter((c) => !allowed.has(c))).toEqual([]);
      expect(prompt).not.toContain("learning_only");
      expect(prompt).not.toContain("readComparison");
      expect(prompt).not.toContain(revealText);
      for (const term of profileTerms) expect(prompt).not.toContain(term);
      // 自分の Persona（性格の節）以外の Persona の名前は出ない（他 CPU の Secret Persona）。
      const own = /スタイル: (.+)/.exec(prompt)?.[1];
      for (const p of Object.values(PERSONA_PRESETS)) {
        if (p.label !== own) expect(prompt, playerId).not.toContain(p.label);
      }
      // 前の Session の Guest は Prompt のどこにも出ない（Guest の Memory は次の Session で読まない。D118）。
      if (sessionId === session2) {
        for (const id of guestIdsOf(session1)) expect(prompt).not.toContain(id);
      }

      const memory = memoryIn(prompt);
      const observer = refOf(sessionId, playerId);
      // 参加者の引ける CPU（このテストの全 CPU）は Memory を持つ。
      expect(observer).not.toBeNull();
      expect(memory).not.toBeNull();
      if (memory === null || observer === null) continue;
      // Memory の要約は構造化データで、Persona・Deck・system の記録を含まない。
      expect(forbiddenKeys(memory)).toEqual([]);
      const seated = seatedIn(handId);
      for (const subject of memory.subjects) {
        // Subject は今の Hand の他の参加者で、席の playerId との対応はこの Hand の Session のもの。
        expect(seated).toContain(subject.playerId);
        expect(subject.playerId).not.toBe(playerId);
        expect(subject.subject).toEqual(refOf(sessionId, subject.playerId));
        for (const item of subject.items) {
          expect(item.evidenceIds.length).toBeLessThanOrEqual(3);
          for (const id of item.evidenceIds) {
            withEvidence++;
            const [evidenceHand = "", seq = ""] = id.split("#");
            // 保存済みの、今の Hand より前の Hand。
            expect(evidenceHand).not.toBe(handId);
            expect(store.savedOrder(evidenceHand)).not.toBeNull();
            const evidenceSession = store.sessionIdOfHand(evidenceHand) ?? "";
            if (evidenceSession !== sessionId) carriedOver++;
            // Observer はその Hand に座っていた（座っていない Hand・他の CPU だけが見た Hand の Evidence は入らない）。
            const observerSeat = participantsOf(evidenceSession).find(
              (p) =>
                participantKey(participantRefOf(p)) ===
                participantKey(observer),
            )?.playerId;
            expect(observerSeat, id).toBeDefined();
            expect(seatedIn(evidenceHand)).toContain(observerSeat);
            // Guest は Observer・Subject のどちらでも今の Session の Hand だけ。
            if (observer.kind === "guest" || subject.subject.kind === "guest") {
              expect(evidenceSession).toBe(sessionId);
            }
            // Evidence はその Subject の public の Action。
            const event = store
              .read(evidenceHand)
              .find((s) => s.event.seq === Number(seq))?.event;
            expect(event?.type).toBe("ACTION_TAKEN");
            expect(event?.visibility.type).toBe("public");
            const actor = event?.type === "ACTION_TAKEN" ? event.playerId : "";
            expect(refOf(evidenceSession, actor)).toEqual(subject.subject);
          }
        }
      }
    }
    // 検査が空振りしていない: Evidence を持つ Memory があり、Fixed CPU は前の Session の観察を持ち越している。
    expect(withEvidence).toBeGreaterThan(0);
    expect(carriedOver).toBeGreaterThan(0);
  }, 30_000);
});
