// Pass B と Follow-up の Store のテスト（メモリ内実装と SQLite 実装を同じ期待で確かめる）。過去の行を上書きしない（D39）。
import {
  heroInformationSets,
  projectLearningReveal,
  type HeroInformationSet,
  type LearningReveal,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { BTN_VS_UTG, playScriptedHand } from "../testing/review-eval/hands.js";
import { buildRevealEvidence, revealEvidenceIdsOf } from "./reveal-evidence.js";
import {
  InMemoryFollowUpStore,
  InMemoryRevealReviewStore,
  SqliteFollowUpStore,
  SqliteRevealReviewStore,
  type FollowUpStore,
  type RevealReviewStore,
} from "./reveal-store.js";
import type { FollowUpDraft, RevealReviewDraft } from "./reveal-types.js";

const events = playScriptedHand(BTN_VS_UTG);
const handId = events[0]?.type === "HAND_STARTED" ? events[0].handId : "";
const set = heroInformationSets(events, "hero")[3] as HeroInformationSet;
const evidence = await buildRevealEvidence(
  set,
  projectLearningReveal(events) as LearningReveal,
  events,
  [],
);

function revealDraft(
  patch: Partial<RevealReviewDraft> = {},
): RevealReviewDraft {
  return {
    handId,
    decisionIndex: 3,
    actionSeq: set.decision.actionSeq,
    pass: "reveal",
    depth: "standard",
    modelRole: "review_standard",
    concreteModel: "claude-sonnet-5-5",
    generatedBy: "review_ai",
    evidenceIds: revealEvidenceIdsOf(evidence, [evidence.reveal.id]),
    explanation: {
      readComparison: "読みと実際",
      actualEquity: "実際の Equity",
      bluffValue: "value",
      takeaways: ["次に活かす点"],
    },
    evidence,
    failure: null,
    ...patch,
  };
}

function followUpDraft(
  reviewId: string,
  reviewVersion: number,
  question: string,
): FollowUpDraft {
  return {
    reviewId,
    pass: "reveal",
    handId,
    decisionIndex: 3,
    reviewVersion,
    depth: "standard",
    modelRole: "review_standard",
    concreteModel: "claude-sonnet-5-5",
    generatedBy: "review_ai",
    question,
    answer: {
      scope: "answered",
      text: `${question} への答え`,
      evidenceIds: [evidence.equity.id],
    },
    failure: null,
  };
}

function stores(): [
  string,
  () => {
    reveals: RevealReviewStore;
    followUps: FollowUpStore;
    close: () => void;
  },
][] {
  let n = 0;
  const now = () => new Date(Date.UTC(2026, 9, 6, 0, 0, n++));
  const newReviewId = () => `id${n++}`;
  return [
    [
      "メモリ内実装",
      () => ({
        reveals: new InMemoryRevealReviewStore({ now, newReviewId }),
        followUps: new InMemoryFollowUpStore({ now, newReviewId }),
        close: () => undefined,
      }),
    ],
    [
      "SQLite 実装",
      () => {
        // hand_id は hands を参照するので、先に Hand を保存する。
        const db = openDatabase(":memory:");
        new SqliteEventStore(db).append(handId, events);
        return {
          reveals: new SqliteRevealReviewStore(db, { now, newReviewId }),
          followUps: new SqliteFollowUpStore(db, { now, newReviewId }),
          close: () => db.close(),
        };
      },
    ],
  ];
}

describe.each(stores())("Pass B・Follow-up の Store（%s）", (_name, make) => {
  it("Pass B は同じ判断ごとに Version 1, 2, … と追記され、前の Version は変わらない", () => {
    const { reveals, close } = make();
    try {
      const first = reveals.append(revealDraft());
      const second = reveals.append(
        revealDraft({ depth: "deep", modelRole: "review_deep" }),
      );
      expect([first.version, second.version]).toEqual([1, 2]);
      expect(reveals.list(handId, 3)).toEqual([first, second]);
      expect(reveals.list(handId, 3)[0]).toMatchObject({ depth: "standard" });
      expect(reveals.list(handId, 0)).toEqual([]);
      // 失敗の記録・NULL の列もそのまま読み戻せる。返した値を書き換えても保存した値は変わらない。
      const fallback = reveals.append(
        revealDraft({
          concreteModel: null,
          generatedBy: "sufficiency_gate",
          failure: {
            kind: "invalid_output",
            attempts: [{ stage: "schema", reason: "x" }],
          },
        }),
      );
      expect(reveals.list(handId, 3)[2]).toEqual(fallback);
      (fallback.explanation.takeaways as string[]).push("書き換え");
      expect(reveals.list(handId, 3)[2]?.explanation.takeaways).toEqual([
        "次に活かす点",
      ]);
    } finally {
      close();
    }
  });

  it("Follow-up は Review の Version ごとにターン 1, 2, … と追記され、別の Version の履歴と混ざらない", () => {
    const { reveals, followUps, close } = make();
    try {
      const v1 = reveals.append(revealDraft());
      const v2 = reveals.append(revealDraft());
      const a = followUps.append(followUpDraft(v1.reviewId, 1, "質問1"));
      const b = followUps.append(followUpDraft(v1.reviewId, 1, "質問2"));
      const c = followUps.append(followUpDraft(v2.reviewId, 2, "別の質問"));
      expect([a.turn, b.turn, c.turn]).toEqual([1, 2, 1]);
      expect(followUps.list(v1.reviewId)).toEqual([a, b]);
      expect(followUps.list(v2.reviewId)).toEqual([c]);
      expect(followUps.list("none")).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("SqliteFollowUpStore", () => {
  it("実在しない Review の Version を指す Follow-up は Trigger で拒否し、行の UPDATE も拒否する", () => {
    const db = openDatabase(":memory:");
    try {
      new SqliteEventStore(db).append(handId, events);
      const reveals = new SqliteRevealReviewStore(db);
      const followUps = new SqliteFollowUpStore(db);
      const v1 = reveals.append(revealDraft());
      expect(() =>
        followUps.append(followUpDraft("unknown", 1, "質問")),
      ).toThrow(/existing review version/);
      expect(() =>
        followUps.append(followUpDraft(v1.reviewId, 2, "質問")),
      ).toThrow(/existing review version/);
      followUps.append(followUpDraft(v1.reviewId, 1, "質問"));
      expect(() =>
        db.exec("UPDATE review_followups SET question = 'x'"),
      ).toThrow(/append-only/);
      expect(() =>
        db.exec("UPDATE reveal_reviews SET explanation = '{}'"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });
});
