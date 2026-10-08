// Hero の Review（Pass A）の Evidence に入る Table Tendency（D122・#153）の境界のテスト。Claude は呼ばない（Fake。D87）。
// - 判断の Hand と同じ Session の、その Hand より前に保存した Hand の public の Event だけから作る
//   （その Hand 自身・後の Hand・別の Session の Hand を入れない。判断より後の情報を混ぜない。不変条件 3）
// - 見えない Event（他者の Hole Cards・Deck。Learning-only Reveal の元）を差し替えても、Pass B を先に作っても変わらない
// - 十分な項目が無ければ Opponent Observation は unavailable のまま（#153 より前と同じ Evidence）
// - Pass B（Reveal Review）の Evidence には入れない（既存の契約のまま）
import { createDeck, isVisibleTo, type HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { loadKb } from "../kb/index.js";
import { buildHeroTableTendencyFromStore } from "../memory/table-tendency.js";
import { forbiddenKeys, leakedCards } from "../testing/leaks.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
} from "../testing/review-eval/hands.js";
import { createFakeReviewQuery } from "./fake-review-query.js";
import {
  InMemoryFollowUpStore,
  InMemoryRevealReviewStore,
} from "./reveal-store.js";
import { InMemoryReviewStore } from "./review-store.js";
import { ReviewService } from "./review-service.js";
import type { ReviewEvidence } from "./types.js";

const HERO = "hero";
const SESSION = "session-main";
const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

/** Review の対象の Hand（BTN_VS_UTG。handId は review-btn_vs_utg）。 */
const REVIEWED = playScriptedHand(BTN_VS_UTG);
const REVIEWED_ID = "review-btn_vs_utg";

/** Hero に見えない Event の中身（他者の札・Deck）を差し替える。Learning-only Reveal（全員の札）もこれで変わる。 */
function tamperHidden(events: readonly HandEvent[]): HandEvent[] {
  const reversed = createDeck().reverse();
  return events.map((e) => {
    if (isVisibleTo(e, HERO)) return e;
    switch (e.type) {
      case "HOLE_CARD_DEALT":
        return { ...e, cards: reversed.slice(0, 2) };
      case "DECK_SHUFFLED":
        return { ...e, seed: 999, deck: reversed };
      default:
        return e;
    }
  });
}

/**
 * Event Store を作る。別の Session の Hand（3）→ 前の Hand（priorHands。SB_VS_BTN の形）→ Review の対象の Hand →
 * 後の Hand（later なら MULTIWAY_FLOP の形を 5）の順に保存する（保存の順が論理順序。D117）。
 */
function storeWith(o: {
  readonly priorHands: number;
  readonly later?: boolean;
  readonly tamper?: boolean;
}) {
  const events = new InMemoryEventStore();
  for (let i = 0; i < 3; i++) {
    const hand = playScriptedHand({ ...MULTIWAY_FLOP, id: `other-${i}` });
    events.append(`review-other-${i}`, hand, { sessionId: "session-other" });
  }
  for (let i = 0; i < o.priorHands; i++) {
    const hand = playScriptedHand({ ...SB_VS_BTN, id: `prior-${i}` });
    events.append(`review-prior-${i}`, o.tamper ? tamperHidden(hand) : hand, {
      sessionId: SESSION,
    });
  }
  events.append(REVIEWED_ID, REVIEWED, { sessionId: SESSION });
  if (o.later === true) {
    for (let i = 0; i < 5; i++) {
      const hand = playScriptedHand({ ...MULTIWAY_FLOP, id: `later-${i}` });
      events.append(`review-later-${i}`, hand, { sessionId: SESSION });
    }
  }
  return events;
}

function serviceFor(events: InMemoryEventStore) {
  const reviews = new InMemoryReviewStore();
  const reveals = new InMemoryRevealReviewStore();
  const service = new ReviewService({
    events,
    reviews,
    reveals,
    followUps: new InMemoryFollowUpStore(),
    heroId: HERO,
    players: PHASE1_TABLE_SETUP.players,
    kb,
    solver,
    env: {},
    query: createFakeReviewQuery(),
    timeoutMs: 60_000,
  });
  return { service, reviews, reveals };
}

/** Review の対象の判断（River の Call）の Pass A の Evidence を、その Store で作る。 */
async function decisionEvidence(
  events: InMemoryEventStore,
  o: { readonly revealFirst?: boolean } = {},
): Promise<ReviewEvidence> {
  const { service, reviews, reveals } = serviceFor(events);
  if (o.revealFirst === true) {
    // 前の Hand の Pass B（Learning-only Full Reveal を使う）を先に作っておく。
    service.requestReveal("review-prior-0", 0, "standard");
    await service.idle();
    expect(reveals.list("review-prior-0", 0)).toHaveLength(1);
  }
  service.request(REVIEWED_ID, 3, "standard");
  await service.idle();
  const record = reviews.list(REVIEWED_ID, 3, "decision").at(-1);
  if (record === undefined) throw new Error("Review が作られていない");
  return record.evidence;
}

/** 項目の数え（id と割合を除く）。 */
function countsOf(evidence: ReviewEvidence) {
  if (evidence.opponentObservation.status !== "available") return null;
  return {
    hands: evidence.opponentObservation.tableTendency.hands,
    items: evidence.opponentObservation.tableTendency.items.map(
      ({ item, numerator, denominator, hands, sufficient }) => ({
        item,
        numerator,
        denominator,
        hands,
        sufficient,
      }),
    ),
  };
}

describe("Review の Evidence の Table Tendency（D122・#153）", () => {
  it("判断の Hand と同じ Session の、その Hand より前に保存した Hand の public の Event だけから作る（その Hand 自身・後の Hand・別の Session は入らない）", async () => {
    const events = storeWith({ priorHands: 11, later: true });
    const evidence = await decisionEvidence(events);

    // 期待値: 前の Hand だけを入れた Store で、Hero から見た Table Tendency。
    const onlyPrior = new InMemoryEventStore();
    for (let i = 0; i < 11; i++) {
      const hand = playScriptedHand({ ...SB_VS_BTN, id: `prior-${i}` });
      onlyPrior.append(`review-prior-${i}`, hand, { sessionId: SESSION });
    }
    const expected = buildHeroTableTendencyFromStore(onlyPrior, {
      sessionId: SESSION,
      heroPlayerId: HERO,
    });
    expect(expected.hands).toBe(11);
    expect(countsOf(evidence)).toEqual({
      hands: expected.hands,
      items: expected.items.map(
        ({ item, numerator, denominator, hands, sufficient }) => ({
          item,
          numerator,
          denominator,
          hands,
          sufficient,
        }),
      ),
    });
    // 後の Hand を入れると値が変わる（検査が空振りしていない）。
    const withLater = buildHeroTableTendencyFromStore(events, {
      sessionId: SESSION,
      heroPlayerId: HERO,
    });
    expect(withLater.hands).toBe(17);
    expect(withLater.items).not.toEqual(expected.items);
    // 後の Hand が無い Store でも同じ Evidence。
    expect(await decisionEvidence(storeWith({ priorHands: 11 }))).toEqual(
      evidence,
    );
  });

  it("項目ごとに Evidence ID と決定論の割合を持ち、Review の Evidence IDs に残る。不十分な項目も保留として残す", async () => {
    const evidence = await decisionEvidence(storeWith({ priorHands: 11 }));
    expect(evidence.opponentObservation.status).toBe("available");
    if (evidence.opponentObservation.status !== "available") return;
    const { tableTendency } = evidence.opponentObservation;
    expect(tableTendency.policyVersion).toBe("phase7_table_tendency_v1");
    expect(tableTendency.items.map((i) => i.id)).toEqual([
      `tendency:${REVIEWED_ID}/d3/vpip`,
      `tendency:${REVIEWED_ID}/d3/pfr`,
      `tendency:${REVIEWED_ID}/d3/aggression_frequency`,
      `tendency:${REVIEWED_ID}/d3/showdown`,
    ]);
    for (const i of tableTendency.items) {
      expect(i.rate).toBe(
        i.denominator === 0
          ? null
          : Math.round((i.numerator / i.denominator) * 1000) / 1000,
      );
    }
    // 十分な項目と、保留の項目（Showdown は Hand 単位で機会が 11 < 20）の両方がある。
    expect(tableTendency.items.some((i) => i.sufficient)).toBe(true);
    expect(
      tableTendency.items.find((i) => i.item === "showdown")?.sufficient,
    ).toBe(false);
  });

  it("見えない Event（他者の札・Deck。Learning-only Reveal の元）を差し替えても、前の Hand の Pass B を先に作っても変わらない", async () => {
    const plain = await decisionEvidence(storeWith({ priorHands: 11 }));
    const tampered = await decisionEvidence(
      storeWith({ priorHands: 11, tamper: true }),
    );
    expect(tampered.opponentObservation).toEqual(plain.opponentObservation);
    const afterReveal = await decisionEvidence(storeWith({ priorHands: 11 }), {
      revealFirst: true,
    });
    expect(afterReveal.opponentObservation).toEqual(plain.opponentObservation);
  });

  it("前の Hand が無い・十分な項目が無ければ unavailable のまま（#153 より前と同じ Evidence）", async () => {
    for (const priorHands of [0, 4]) {
      const evidence = await decisionEvidence(storeWith({ priorHands }));
      expect(evidence.opponentObservation).toEqual({
        status: "unavailable",
        reason:
          "相手の過去の傾向（Observation）の記録はまだ無い。この Hand の公開された Action 以外に、相手の読みの根拠は無い。",
      });
    }
  });

  it("API が返す保存済みの Review（status・version）の Evidence に、作った時の Table Tendency がそのまま入り、CPU の内部状態・Reveal を指す語が無い（#169）", async () => {
    const events = storeWith({ priorHands: 11 });
    const { service, reviews } = serviceFor(events);
    service.request(REVIEWED_ID, 3, "standard");
    await service.idle();
    const saved = reviews.list(REVIEWED_ID, 3, "decision").at(-1);
    if (saved === undefined) throw new Error("Review が作られていない");

    // 画面が読む応答（最新の状態と、Version を指定した読み）は、保存した Evidence を作り直さずそのまま返す。
    const status = service.status(REVIEWED_ID, 3);
    const version = service.version(REVIEWED_ID, 3, saved.version);
    if (!status.ok || !version.ok) throw new Error("応答が読めない");
    expect(status.value.latest?.evidence.opponentObservation).toEqual(
      saved.evidence.opponentObservation,
    );
    expect(version.value.evidence.opponentObservation).toEqual(
      saved.evidence.opponentObservation,
    );
    expect(saved.evidence.opponentObservation.status).toBe("available");

    // 応答に、CPU の Private Memory / Hypothesis・Persona・Tilt を指す語が無く、判断時点で Hero に見えない札（Learning-only Reveal の元）も無い。
    for (const payload of [status.value, version.value]) {
      const json = JSON.stringify(payload).toLowerCase();
      expect(forbiddenKeys(payload)).toEqual([]);
      for (const word of [
        "memory",
        "hypothesis",
        "tilt",
        "persona",
        "phase7_memory",
        "phase7_tilt",
      ]) {
        const at = json.indexOf(word);
        expect(
          at < 0 ? "" : json.slice(Math.max(0, at - 60), at + 60),
          word,
        ).toBe("");
      }
      expect(leakedCards(payload, REVIEWED, HERO, saved.actionSeq)).toEqual([]);
    }
  });

  it("Pass B（Reveal Review）の Evidence には入れない（既存の契約のまま）", async () => {
    const { service, reveals } = serviceFor(storeWith({ priorHands: 11 }));
    service.requestReveal(REVIEWED_ID, 3, "standard");
    await service.idle();
    const record = reveals.list(REVIEWED_ID, 3).at(-1);
    expect(record).toBeDefined();
    const json = JSON.stringify(record?.evidence);
    expect(json).not.toContain("tableTendency");
    expect(json).not.toContain("tendency:");
  });
});
