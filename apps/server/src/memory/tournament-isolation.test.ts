// Tournament の CPU の入力の情報境界（#188・不変条件 2・INV-INFO-001〜003・INV-TEST-007 / 008・D106・D109・D130）。
// Claude の CPU の query() を Fake にして（Claude は呼ばない。D87）、Cash の Session（Pass A の Hero の弱点・Pass B の Learning-only Reveal を
// 作る）の後に Tournament の Session を進め、CPU の全 Prompt を走査する:
// - Tournament の Hand の Prompt だけが Tournament の System Prompt と Public Tournament Context の節を持ち、その値は公開の Hand の開始時の
//   Stack と Session の設定から作ったもの（他者の札・Deck・Persona・Tilt・system の記録を含まない）
// - Tournament の Hand の Memory は tournament の context で、Evidence は Observer 自身が座って見た Tournament の Hand の Subject の
//   public の Action だけ（Cash の Hand の Hypothesis を混ぜない。他の CPU の観察を含まない）
// - 他者の Hidden Cards・Learning-only Reveal・Hero の弱点・他 CPU の Persona はどの Prompt にも入らない
// 静的な import の検査（learning/ に届かない・Learning-only Reveal を参照しない）は memory-injection-isolation.test.ts が
// opponents/・hand-orchestrator.ts から届く全モジュール（Engine の tournament-knowledge.ts は Engine の中なので対象外で、Engine は
// learning/ を import できない）で行う。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  TOURNAMENT_PRESETS,
  cardToString,
  projectLearningReveal,
  type HandEvent,
  type HeroView,
  type PlayerAction,
  type TournamentKnowledge,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { InMemoryEventStore } from "../event-store.js";
import { createClaudeOpponentFactory } from "../opponents/claude-opponent.js";
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

/** Prompt の、見出しで始まる節の次の節（構造化データの JSON）。無ければ null。 */
function sectionJson<T>(prompt: string, heading: string): T | null {
  const sections = prompt.split("\n\n");
  const at = sections.findIndex((s) => s.startsWith(heading));
  return at < 0 ? null : (JSON.parse(sections[at + 1] ?? "") as T);
}

describe("Tournament の CPU の入力の境界（Prompt の動的な走査）", () => {
  it("Tournament の Prompt は公開の Tournament Context と tournament の Memory だけを足し、札・Reveal・Hero の弱点・他 CPU の Persona・Cash の Hypothesis が入らない", async () => {
    const store = new InMemoryEventStore();
    let handNo = 0;
    const handIdOf = () => `hand-${handNo}`;
    let failNext = false;
    const cpuPrompts: {
      handId: string;
      playerId: string;
      prompt: string;
      systemPrompt: string;
      upto: number;
    }[] = [];
    // CPU の Fake: Schema の enum から check → call → fold の順に選ぶ。failNext なら障害にする。
    const cpuQuery: ClaudeQuery = ({ prompt, options }) => {
      const handId = handIdOf();
      const fail = failNext;
      failNext = false;
      if (!fail) {
        cpuPrompts.push({
          handId,
          playerId: /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "",
          prompt,
          systemPrompt:
            typeof options.systemPrompt === "string"
              ? options.systemPrompt
              : "",
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
      nextSeed: () => 7 + handNo,
      nextHandId: () => `hand-${++handNo}`,
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
    /** Hand を終わりまで進める。CPU の障害が起きたら Session 終了を選ぶ。 */
    const play = async (
      afterHandId: string | null,
      policy: (types: string[]) => PlayerAction,
      session?: object,
    ) => {
      const started = await inject<{
        handId: string;
        view: HeroView;
        outage: Outage;
      }>("POST", "/api/hands", {
        afterHandId,
        ...(session === undefined ? {} : { session }),
      });
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
        ({ view, outage } = await inject<{ view: HeroView; outage: Outage }>(
          "POST",
          `/api/hands/${started.handId}/actions`,
          { lastSeq: view.log.at(-1)?.seq ?? -1, action: policy(types) },
        ));
      }
      return started.handId;
    };
    const callOrCheck = (types: string[]): PlayerAction =>
      types.includes("call")
        ? { type: "call" }
        : types.includes("check")
          ? { type: "check" }
          : { type: "fold" };
    // Tournament では Hero が Bust しにくいよう、Check できなければ Fold する。
    const checkOrFold = (types: string[]): PlayerAction =>
      types.includes("check") ? { type: "check" } : { type: "fold" };
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

    // Session 1（Cash）: Hand 1 の後に Pass A（Hero の弱点）と Pass B（Learning-only Reveal）を作り、もう 1 Hand 進めて障害で終える。
    let last = await play(null, callOrCheck);
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
    expect(profile.profile.hypotheses.length).toBeGreaterThan(0);
    last = await play(last, callOrCheck);
    failNext = true;
    last = await play(last, callOrCheck);
    const cashSession = store.sessionIdOfHand(hand1) ?? "";
    expect(store.sessionIdOfHand(last)).toBe(cashSession);

    // Session 2（Tournament）: 標準 STT で 4 Hand（Hero が Bust したらそこで終わる）。
    last = await play(last, checkOrFold, {
      mode: "tournament",
      presetId: "stt6_hand_count",
    });
    const tournamentSession = store.sessionIdOfHand(last) ?? "";
    expect(tournamentSession).not.toBe(cashSession);
    for (let i = 0; i < 3; i++) last = await play(last, checkOrFold);

    const eventsOf = (handId: string): HandEvent[] =>
      store.read(handId).map((s) => s.event);
    const startedOf = (handId: string) => {
      const started = eventsOf(handId)[0];
      if (started?.type !== "HAND_STARTED") throw new Error("HAND_STARTED");
      return started;
    };
    const refOf = (
      sessionId: string,
      playerId: string,
    ): ParticipantRef | null => {
      if (playerId === "hero") return { kind: "hero" };
      const p = store
        .sessionParticipants(sessionId)
        .find((q) => q.playerId === playerId);
      return p === undefined ? null : participantRefOf(p);
    };
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

    let tournamentPrompts = 0;
    let tournamentEvidence = 0;
    let cashPrompts = 0;
    for (const { handId, playerId, prompt, systemPrompt, upto } of cpuPrompts) {
      const sessionId = store.sessionIdOfHand(handId) ?? "";
      // 共通: 札はその時点でその CPU が知ってよいものだけ。Reveal・Hero の弱点・他 CPU の Persona は入らない。
      const allowed = allowedCardsAt(eventsOf(handId), playerId, upto);
      expect(cardsIn(prompt).filter((c) => !allowed.has(c))).toEqual([]);
      expect(prompt).not.toContain("learning_only");
      expect(prompt).not.toContain("readComparison");
      expect(prompt).not.toContain(revealText);
      for (const term of profileTerms) expect(prompt).not.toContain(term);
      const own = /スタイル: (.+)/.exec(prompt)?.[1];
      for (const p of Object.values(PERSONA_PRESETS)) {
        if (p.label !== own) expect(prompt, playerId).not.toContain(p.label);
      }
      const tournament = sectionJson<TournamentKnowledge>(
        prompt,
        "## トーナメントの状況",
      );
      const memory = sectionJson<OpponentMemorySummary>(
        prompt,
        "## あなたの記憶",
      );

      if (sessionId === cashSession) {
        // Cash の Hand は #188 より前と同じ: Cash の System Prompt で、Tournament の節が無く、Memory は cash。
        cashPrompts++;
        expect(systemPrompt).toContain("（キャッシュゲーム）");
        expect(tournament).toBeNull();
        expect(prompt).not.toContain("トーナメント");
        if (memory !== null) expect(memory.context).toBe("cash");
        continue;
      }

      expect(sessionId).toBe(tournamentSession);
      tournamentPrompts++;
      expect(systemPrompt).toContain("（トーナメント。");
      // Public Tournament Context: 公開の Hand の開始時の Stack と Session の設定から作った値だけ。
      const started = startedOf(handId);
      expect(tournament).not.toBeNull();
      if (tournament === null) continue;
      expect(forbiddenKeys(tournament)).toEqual([]);
      expect(cardsIn(JSON.stringify(tournament))).toEqual([]);
      expect(tournament.entrants).toBe(6);
      expect(tournament.prizePool).toBe(
        TOURNAMENT_PRESETS.stt6_hand_count.entryFee * 6,
      );
      expect(tournament.remaining).toBe(started.seats.length);
      expect(tournament.level).toBe(started.tournament?.level);
      expect(tournament.seats.map((s) => [s.playerId, s.stack])).toEqual(
        started.seats.map((s) => [s.playerId, s.stack]),
      );
      expect(tournament.bubbleFactors.map((b) => b.opponentId)).toEqual(
        started.seats.map((s) => s.playerId).filter((id) => id !== playerId),
      );

      // Memory は tournament の context で、Evidence は自分が座って見た Tournament の Hand の Subject の public の Action だけ。
      const observer = refOf(sessionId, playerId);
      expect(observer).not.toBeNull();
      expect(memory).not.toBeNull();
      if (memory === null || observer === null) continue;
      expect(memory.context).toBe("tournament");
      expect(forbiddenKeys(memory)).toEqual([]);
      for (const subject of memory.subjects) {
        for (const item of subject.items) {
          for (const id of item.evidenceIds) {
            tournamentEvidence++;
            const [evidenceHand = "", seq = ""] = id.split("#");
            expect(evidenceHand).not.toBe(handId);
            // Cash の Session の Hand の Hypothesis は混ぜない（D106）。
            expect(store.sessionIdOfHand(evidenceHand), id).toBe(
              tournamentSession,
            );
            const observerSeat = store
              .sessionParticipants(tournamentSession)
              .find(
                (p) =>
                  participantKey(participantRefOf(p)) ===
                  participantKey(observer),
              )?.playerId;
            expect(
              startedOf(evidenceHand).seats.map((s) => s.playerId),
            ).toContain(observerSeat);
            const event = store
              .read(evidenceHand)
              .find((s) => s.event.seq === Number(seq))?.event;
            expect(event?.type).toBe("ACTION_TAKEN");
            expect(event?.visibility.type).toBe("public");
            const actor = event?.type === "ACTION_TAKEN" ? event.playerId : "";
            expect(refOf(tournamentSession, actor)).toEqual(subject.subject);
          }
        }
      }
    }
    // 検査が空振りしていない: Cash と Tournament の両方の Prompt があり、Tournament の Memory に Evidence がある。
    expect(cashPrompts).toBeGreaterThan(0);
    expect(tournamentPrompts).toBeGreaterThan(0);
    expect(tournamentEvidence).toBeGreaterThan(0);
  }, 30_000);
});
