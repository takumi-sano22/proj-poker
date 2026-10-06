// Review Version Store のテスト（メモリ内実装と SQLite 実装を同じ期待で確かめる）。過去の Review を上書きしない（D39）。
import {
  heroInformationSets,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { BTN_VS_UTG, playScriptedHand } from "../testing/review-eval/hands.js";
import { buildReviewEvidence, evidenceIdsOf } from "./evidence.js";
import {
  InMemoryReviewStore,
  SqliteReviewStore,
  type ReviewStore,
} from "./review-store.js";
import type { ReviewDraft } from "./types.js";

const events = playScriptedHand(BTN_VS_UTG);
const handId = events[0]?.type === "HAND_STARTED" ? events[0].handId : "";
const set = heroInformationSets(events, "hero")[3] as HeroInformationSet;
const evidence = await buildReviewEvidence(set, [], {
  kb: loadKb(),
  solver: createAmaster97Adapter({
    install: { installed: false, detail: "テスト" },
    timeoutMs: 1,
    maxConcurrency: 1,
    iterations: 1,
  }),
});

function draft(patch: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    handId,
    decisionIndex: 3,
    actionSeq: set.decision.actionSeq,
    pass: "decision",
    depth: "standard",
    modelRole: "review_standard",
    concreteModel: "claude-sonnet-5-5",
    kbVersion: evidence.knowledge.kbVersion,
    solverVersion: null,
    generatedBy: "review_ai",
    assessment: "reasonable",
    confidence: "medium",
    assumptions: ["前提"],
    evidenceIds: evidenceIdsOf(evidence, [evidence.math.id]),
    explanation: {
      practical: "妥当",
      theory: { basis: "general_theory", text: "理論" },
      exploit: { basis: "none", text: "" },
      conclusionChangers: ["相手の Range が狭いなら Fold"],
    },
    evidence,
    failure: null,
    ...patch,
  };
}

function stores(): [string, () => { store: ReviewStore; close: () => void }][] {
  let n = 0;
  const now = () => new Date(Date.UTC(2026, 9, 6, 0, 0, n++));
  return [
    [
      "InMemoryReviewStore",
      () => ({
        store: new InMemoryReviewStore({ now, newReviewId: () => `r${n}` }),
        close: () => undefined,
      }),
    ],
    [
      "SqliteReviewStore",
      () => {
        // reviews.hand_id は hands を参照するので、先に Hand を保存する（終わった Hand だけが保存される）。
        const db = openDatabase(":memory:");
        new SqliteEventStore(db).append(handId, events);
        return {
          store: new SqliteReviewStore(db, { now, newReviewId: () => `r${n}` }),
          close: () => db.close(),
        };
      },
    ],
  ];
}

describe.each(stores())("%s", (_name, make) => {
  it("同じ判断の Review は Version 1, 2, … と追記され、前の Version は変わらない", () => {
    const { store, close } = make();
    try {
      const first = store.append(draft());
      const second = store.append(
        draft({
          depth: "deep",
          modelRole: "review_deep",
          assessment: "strong",
        }),
      );
      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      const list = store.list(handId, 3, "decision");
      expect(list).toEqual([first, second]);
      expect(list[0]).toMatchObject({
        assessment: "reasonable",
        depth: "standard",
      });
      // 別の判断は別の Version の列。
      expect(store.append(draft({ decisionIndex: 0 })).version).toBe(1);
      expect(store.list(handId, 9, "decision")).toEqual([]);
    } finally {
      close();
    }
  });

  it("保存した値をそのまま読み戻せる（Evidence・Evidence IDs・説明・失敗の記録・NULL の列）", () => {
    const { store, close } = make();
    try {
      const saved = store.append(
        draft({
          concreteModel: null,
          generatedBy: "invalid_output_fallback",
          assessment: "insufficient_evidence",
          confidence: "low",
          failure: {
            kind: "invalid_output",
            attempts: [{ stage: "schema", reason: "assessment が不正" }],
          },
        }),
      );
      expect(saved.createdAt).toMatch(/^2026-10-06T/);
      expect(store.list(handId, 3, "decision")).toEqual([saved]);
      // 返した値を書き換えても保存した値は変わらない。
      (saved.assumptions as string[]).push("書き換え");
      expect(store.list(handId, 3, "decision")[0]?.assumptions).toEqual([
        "前提",
      ]);
    } finally {
      close();
    }
  });
});

describe("SqliteReviewStore", () => {
  it("保存していない Hand の Review は作れない（外部キー）。行の UPDATE は Trigger で拒否する", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteReviewStore(db);
      expect(() => store.append(draft({ handId: "unknown" }))).toThrow(
        /FOREIGN KEY/,
      );
      new SqliteEventStore(db).append(handId, events);
      store.append(draft());
      expect(() => db.exec("UPDATE reviews SET assessment = 'strong'")).toThrow(
        /append-only/,
      );
    } finally {
      db.close();
    }
  });
});
