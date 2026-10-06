// INV-TEST-008（Runtime 側。#83）: Learning-only Full Reveal は CPU の KnowledgeState・CPU の判断（Claude Opponent の Prompt）に入らない。
// Hand 1 を終えて Pass B（全員の札を使う Reveal Review）とその Follow-up を作ってから Hand 2 を続け、両 Hand の CPU の全 Prompt を走査する。
// CPU Memory はまだ無い（docs/09 INV-TEST-008）ので、CPU の入力（Prompt）に入る札が、その時点でその CPU が知ってよい札だけであること・
// Learning-only の印が無いことで確かめる。Claude は呼ばない（D87）: CPU と Review AI の query() は Fake。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  projectLearningReveal,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { InMemoryEventStore } from "../event-store.js";
import { createClaudeOpponentFactory } from "../opponents/claude-opponent.js";
import { allowedCardsAt } from "../testing/leaks.js";
import type { FollowUpStatus, RevealStatus } from "./review-service.js";

let apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function cardsIn(text: string): string[] {
  return [...text.matchAll(/"([2-9TJQKA][cdhs])"/g)].map((m) => m[1] ?? "");
}

function result(output: unknown): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: output,
  } as unknown as SDKMessage;
}

describe("INV-TEST-008: Learning-only Reveal を CPU の判断に入れない", () => {
  it.each([3, 7, 11])(
    "seed %i: Pass B と Follow-up を作った後の Hand でも、CPU の Prompt に入る札はその時点でその CPU が知ってよい札だけ",
    async (seed) => {
      const store = new InMemoryEventStore();
      let handNo = 0;
      const handIdOf = () => `hand-${handNo}`;
      // CPU の Fake: Schema の enum から check → call → fold の順に選ぶ（Showdown まで進みやすい）。
      const cpuPrompts: {
        handId: string;
        playerId: string;
        prompt: string;
        upto: number;
      }[] = [];
      const cpuQuery: ClaudeQuery = ({ prompt, options }) => {
        const handId = handIdOf();
        cpuPrompts.push({
          handId,
          playerId: /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "",
          prompt,
          upto: store.read(handId).length - 1,
        });
        const choices = (
          options.outputFormat?.schema as {
            properties: { action: { enum: string[] } };
          }
        ).properties.action.enum;
        const action =
          ["check", "call", "fold"].find((a) => choices.includes(a)) ?? "fold";
        return (async function* () {
          await Promise.resolve();
          yield result({ action });
        })();
      };
      // Review AI の Fake: Pass B と Follow-up に、検証を通る出力を返す。Prompt を記録する。
      const reviewPrompts: string[] = [];
      const reviewQuery: ClaudeQuery = ({ prompt, options }) => {
        reviewPrompts.push(prompt);
        const schema = options.outputFormat?.schema as {
          properties: Record<string, { items?: { enum?: string[] } }>;
        };
        const ids = schema.properties["evidenceIds"]?.items?.enum ?? [];
        const output =
          "readComparison" in schema.properties
            ? {
                readComparison: "比較",
                actualEquity: "実際の Equity",
                bluffValue: "答え合わせ",
                takeaways: ["次に活かす点"],
                evidenceIds: ids.slice(0, 1),
              }
            : {
                scope: "answered",
                answer: "答え",
                evidenceIds: ids.slice(0, 1),
              };
        return (async function* () {
          await Promise.resolve();
          yield result(output);
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
        review: { query: reviewQuery },
      });
      apps.push(app);

      const play = async (afterHandId: string | null) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/hands",
          payload: { afterHandId },
        });
        expect(res.statusCode).toBe(201);
        const started = res.json<{ handId: string; view: HeroView }>();
        let view = started.view;
        for (let guard = 0; view.status !== "complete"; guard++) {
          expect(guard).toBeLessThan(100);
          const types = view.legalActions?.actions.map((a) => a.type) ?? [];
          const action: PlayerAction = types.includes("call")
            ? { type: "call" }
            : types.includes("check")
              ? { type: "check" }
              : { type: "fold" };
          const next = await app.inject({
            method: "POST",
            url: `/api/hands/${started.handId}/actions`,
            payload: { lastSeq: view.log.at(-1)?.seq ?? -1, action },
          });
          expect(next.statusCode).toBe(200);
          view = next.json<{ view: HeroView }>().view;
        }
        return started.handId;
      };

      const hand1 = await play(null);
      // Hand 1 の Pass B と、その Follow-up を作る（全員の札を Review AI に渡す）。
      const base = `/api/reviews/hands/${hand1}/decisions/0`;
      await app.inject({ method: "POST", url: `${base}/reveal`, payload: {} });
      const waitFor = async <T extends { generation: { state: string } }>(
        path: string,
      ) => {
        for (let i = 0; i < 400; i++) {
          const body = (
            await app.inject({ method: "GET", url: path })
          ).json<T>();
          if (body.generation.state !== "pending") return body;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("生成が終わらない");
      };
      const reveal = await waitFor<RevealStatus>(`${base}/reveal`);
      expect(reveal.versions).toBe(1);
      const followUp = `${base}/passes/reveal/versions/1/followups`;
      await app.inject({
        method: "POST",
        url: followUp,
        payload: { question: "相手の札は？" },
      });
      expect((await waitFor<FollowUpStatus>(followUp)).turns).toHaveLength(1);

      // Pass B の Prompt には Hand 1 の全員の札が入っている（検査の前提: 漏れうる値が実際に Runtime にある）。
      const log1 = store.read(hand1).map((s) => s.event);
      const revealed = (projectLearningReveal(log1)?.holeCards ?? []).flatMap(
        (h) => h.cards.map(cardToString),
      );
      expect(revealed.length).toBeGreaterThan(4);
      for (const card of revealed) {
        expect(reviewPrompts[0]).toContain(`"${card}"`);
      }

      const hand2 = await play(hand1);
      const logs: Record<string, HandEvent[]> = {
        [hand1]: log1,
        [hand2]: store.read(hand2).map((s) => s.event),
      };
      expect(cpuPrompts.some((p) => p.handId === hand2)).toBe(true);
      for (const { handId, playerId, prompt, upto } of cpuPrompts) {
        expect(playerId).toMatch(/^cpu\d$/);
        const allowed = allowedCardsAt(logs[handId] ?? [], playerId, upto);
        expect(cardsIn(prompt).filter((c) => !allowed.has(c))).toEqual([]);
        expect(prompt).not.toContain("learning_only");
        expect(prompt).not.toContain("readComparison");
      }
      // Hero 自身の Hand 2 の View にも Hand 1 の Reveal は入らない（Hero View は Hand ごとの Projection）。
      expect(JSON.stringify(logs[hand2])).not.toContain("learning_only");
    },
  );
});
