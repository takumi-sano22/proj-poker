// Learning Reset（#118・docs/04 §11・D114）のテスト。
// - 区切りは追記型の learning_resets に足すだけで、Event Log・reviews・Note / Tag の行は 1 行も変わらない（正本を消さない）
// - Stats と Session Review は変わらず、Score / Hypothesis / 自然言語の Profile はそれぞれのカテゴリの Reset より後に終わった Hand の
//   Evidence だけになる（Reset 前の Hand を Reset 後に Review しても入らない）
// - Hypothesis の Snapshot（v6）は Reset の区切りで作り直す
// - Policy の Version を変えても正本から計算し直せ、過去の Snapshot・自然言語の Profile を入力にしない
// - 前後は保存の論理順序で決め、壁時計が後ろへ戻っても崩れない（D117・#130）
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { InMemoryEventStore } from "../event-store.js";
import { SqliteNoteStore } from "../notes/note-store.js";
import { SqliteReviewStore } from "../review/review-store.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import {
  LEARNING_HANDS,
  LEARNING_HERO,
  loadLearningFixtures,
  type PlayedHand,
} from "../testing/learning-fixtures.js";
import {
  InMemoryHypothesisSnapshotStore,
  SqliteHypothesisSnapshotStore,
  readHypothesisSnapshot,
  writeHypothesisSnapshot,
} from "./hypothesis-snapshot.js";
import { PHASE6_HYPOTHESIS_V1 } from "./hypothesis-policy.js";
import {
  InMemoryLearningResetStore,
  SqliteLearningResetStore,
  savedAfter,
  type LearningResetStore,
} from "./learning-reset.js";
import { LearningService } from "./learning-service.js";
import {
  PHASE6_PROFILE_V1,
  computePlayerProfile,
  renderProfileText,
  type ProfilePolicy,
} from "./profile.js";

const fixtures = await loadLearningFixtures();

/** 1 分ずつ進める時計（Event の記録時刻と Reset の時刻を同じ時計で決める）。rewind で後ろへ戻せる（OS の時刻の巻き戻りの再現）。 */
function testClock() {
  let t = Date.parse("2026-10-07T00:00:00.000Z");
  return {
    now: () => new Date(t),
    tick: () => {
      t += 60_000;
    },
    rewind: (minutes: number) => {
      t -= minutes * 60_000;
    },
  };
}

describe("LearningResetStore", () => {
  const stores: [string, (now: () => Date) => LearningResetStore][] = [
    ["メモリ", (now) => new InMemoryLearningResetStore({ now })],
    [
      "SQLite",
      (now) => new SqliteLearningResetStore(openDatabase(":memory:"), { now }),
    ],
  ];

  for (const [name, create] of stores) {
    it(`${name}: カテゴリごとに最後の Reset（論理順序の番号と時刻）を返す（Reset していないカテゴリは null）`, () => {
      const clock = testClock();
      const store = create(clock.now);
      expect(store.boundaries()).toEqual({
        score: null,
        hypothesis: null,
        profile: null,
      });
      const first = store.add(["profile", "score"]);
      // カテゴリは決まった順にそろえる。
      expect(first.categories).toEqual(["score", "profile"]);
      const afterFirst = store.boundaries();
      clock.tick();
      const second = store.add(["hypothesis", "score"]);
      const boundaries = store.boundaries();
      expect(boundaries).toMatchObject({
        score: { createdAt: second.createdAt },
        hypothesis: { createdAt: second.createdAt },
        profile: { createdAt: first.createdAt },
      });
      // 1 回の Reset のカテゴリは同じ番号で、後の Reset ほど番号が大きい。
      expect(boundaries.profile?.ord).toBe(afterFirst.score?.ord);
      expect(boundaries.score?.ord).toBe(boundaries.hypothesis?.ord);
      expect(boundaries.score?.ord ?? 0).toBeGreaterThan(
        boundaries.profile?.ord ?? Infinity,
      );
    });

    it(`${name}: 2 回目の Reset の時刻の方が古くても、追加の順で後の Reset を区切りにする（時計の巻き戻り。D117・#130）`, () => {
      const clock = testClock();
      const store = create(clock.now);
      const first = store.add(["score"]);
      const firstOrd = store.boundaries().score?.ord ?? Infinity;
      // 時計が 5 分戻ってから 2 回目の Reset。
      clock.rewind(5);
      const second = store.add(["score"]);
      expect(Date.parse(second.createdAt)).toBeLessThan(
        Date.parse(first.createdAt),
      );
      const boundary = store.boundaries().score;
      // 時刻を clamp せず、2 回目の Reset の時刻をそのまま返す。番号は 1 回目より後。
      expect(boundary?.createdAt).toBe(second.createdAt);
      expect(boundary?.ord ?? 0).toBeGreaterThan(firstOrd);
    });

    it(`${name}: 空・重複・未知のカテゴリは受け付けず、何も足さない`, () => {
      const store = create(testClock().now);
      expect(() => store.add([])).toThrow(RangeError);
      expect(() => store.add(["score", "score"])).toThrow(RangeError);
      expect(() =>
        store.add(["opponent_memory" as unknown as "score"]),
      ).toThrow(RangeError);
      expect(store.boundaries().score).toBeNull();
    });
  }
});

describe("savedAfter（区切りの判定。D117）", () => {
  it("Hand の保存の番号が区切りの Reset の番号より大きい Hand だけを入れ、終わっていない Hand は入れない", () => {
    const boundary = { ord: 5, createdAt: "2026-10-07T00:00:00.000Z" };
    expect(savedAfter(6, boundary)).toBe(true);
    expect(savedAfter(4, boundary)).toBe(false);
    expect(savedAfter(4, null)).toBe(true);
    expect(savedAfter(null, null)).toBe(false);
    expect(savedAfter(null, boundary)).toBe(false);
  });

  it("メモリ内の Event Store と Reset Store は同じカウンタで番号を振り、壁時計が戻っても保存と Reset の前後を保つ", () => {
    const clock = testClock();
    const events = new InMemoryEventStore({ now: clock.now });
    const resets = new InMemoryLearningResetStore({ now: clock.now });
    const btn = fixtures.play(LEARNING_HANDS.btn);
    const sb = fixtures.play(LEARNING_HANDS.sb);
    events.append(btn.handId, btn.events);
    // Reset は btn の保存の後だが、時計が戻って時刻は btn の終わりより前。
    clock.rewind(3);
    resets.add(["score"]);
    // sb は Reset の後に保存したが、時計がさらに戻って時刻は Reset より前。
    clock.rewind(3);
    events.append(sb.handId, sb.events);
    const boundary = resets.boundaries().score;
    expect(savedAfter(events.savedOrder(btn.handId), boundary)).toBe(false);
    expect(savedAfter(events.savedOrder(sb.handId), boundary)).toBe(true);
    expect(events.savedOrder("unknown")).toBeNull();
  });
});

/** SQLite の Store を全部同じ DB で組み、Hand の保存と Review を時計で順に進める。 */
function sqliteLearning() {
  const clock = testClock();
  const db = openDatabase(":memory:");
  const events = new SqliteEventStore(db, { now: clock.now });
  const reviews = new SqliteReviewStore(db, { now: clock.now });
  const resets = new SqliteLearningResetStore(db, { now: clock.now });
  const hypotheses = new SqliteHypothesisSnapshotStore(db);
  const notes = new SqliteNoteStore(db, { now: clock.now });
  const service = (policy?: ProfilePolicy) =>
    new LearningService({
      events,
      reviews,
      heroId: LEARNING_HERO,
      hypotheses,
      resets,
      now: clock.now,
      ...(policy === undefined ? {} : { policy }),
    });
  const save = (hand: PlayedHand, sessionId: string, advance = true) => {
    if (advance) clock.tick();
    events.append(hand.handId, hand.events, { sessionId });
  };
  return { clock, db, events, reviews, resets, notes, service, save };
}

/** 正本のテーブルの行（Reset の前後で 1 行も変わらないこと）。 */
function sourceRows(db: DatabaseSync) {
  const all = (table: string) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return {
    sessions: all("sessions"),
    hands: all("hands"),
    events: all("events"),
    reviews: all("reviews"),
    userNotes: all("user_notes"),
    userTags: all("user_tags"),
    sessionProjections: all("session_projections"),
  };
}

describe("LearningService の Learning Reset（SQLite）", () => {
  let ctx: ReturnType<typeof sqliteLearning>;
  let btn: PlayedHand;
  let sb: PlayedHand;
  let multi: PlayedHand;

  beforeEach(() => {
    ctx = sqliteLearning();
    btn = fixtures.play(LEARNING_HANDS.btn);
    sb = fixtures.play(LEARNING_HANDS.sb);
    multi = fixtures.play(LEARNING_HANDS.multi);
    // Reset の前: btn・sb（Session s1）に Leak の Review。
    ctx.save(btn, "s1");
    ctx.save(sb, "s1");
    ctx.reviews.append(fixtures.review(btn, 0, "major_leak"));
    ctx.reviews.append(fixtures.review(sb, 2, "improvement_suggested"));
    ctx.notes.addNote(
      { kind: "session_player", sessionId: "s1", playerId: "cpu1" },
      "よく Bluff する",
    );
    ctx.notes.addTag(
      { kind: "session_player", sessionId: "s1", playerId: "cpu1" },
      "LAG",
    );
  });

  afterEach(() => {
    ctx.db.close();
  });

  it("全カテゴリの Reset: 正本・Note / Tag・Stats・Session Review は変わらず、Score / Hypothesis / Profile は Reset 後の Hand だけになる", () => {
    const before = ctx.service().profile();
    expect(before.profile.decisions).toEqual({ total: 9, reviewed: 2 });
    expect(before.profile.hypotheses.length).toBeGreaterThan(0);
    const sessionBefore = ctx.service().sessionReview(btn.handId);
    const rowsBefore = sourceRows(ctx.db);

    ctx.clock.tick();
    const { reset, resets } = ctx
      .service()
      .reset(["score", "hypothesis", "profile"]);
    expect(resets).toEqual({
      score: reset.createdAt,
      hypothesis: reset.createdAt,
      profile: reset.createdAt,
    });
    // 区切りの行を足しただけで、正本・Note / Tag の行は 1 行も変わらない（削除拒否の Trigger も残る）。
    expect(sourceRows(ctx.db)).toEqual(rowsBefore);
    expect(() => ctx.db.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => ctx.db.exec("DELETE FROM reviews")).toThrow(/append-only/);
    // Reset の区切りで Snapshot を作り直した（Reset 後の Hand がまだ無いので空）。
    expect(readHypothesisSnapshot(ctx.db)).toEqual([]);
    // Stats と Session Review（1 Session の振り返り）は Reset の対象に無いので変わらない。
    const justAfter = ctx.service().profile();
    expect(justAfter.heroStats).toEqual(before.heroStats);
    expect(justAfter.profile.decisions).toEqual({ total: 0, reviewed: 0 });
    expect(ctx.service().sessionReview(btn.handId)).toEqual(sessionBefore);

    // Reset の後: multi（Session s2）と、Reset 前の Hand（sb）への Reset 後の Review。
    ctx.save(multi, "s2");
    ctx.reviews.append(fixtures.review(multi, 0, "major_leak"));
    ctx.reviews.append(fixtures.review(sb, 0, "major_leak"));

    const after = ctx.service().profile();
    // multi の Hand（判断 4）だけ。Reset 前の Hand は Reset 後に Review しても入らない。
    expect(after.profile.decisions).toEqual({ total: 4, reviewed: 1 });
    expect(after.profile.longTerm.reviewed).toBe(1);
    for (const h of after.profile.hypotheses) {
      for (const id of [...h.supportingEvidenceIds, ...h.counterEvidenceIds]) {
        expect(id.startsWith(`${multi.handId}/`)).toBe(true);
      }
    }
    expect(after.profile.hypotheses.length).toBeGreaterThan(0);
    // Snapshot も同じ区切りの Hypothesis に入れ替わる。
    expect(
      readHypothesisSnapshot(ctx.db).map((h) => h.supportingEvidenceIds),
    ).toEqual(after.profile.hypotheses.map((h) => h.supportingEvidenceIds));
    expect(after.text).toContain("Review 済みの判断 1 件（対象の判断 4 件中）");
    // profile の区切りの後は、文の Long-term も「全期間」と呼ばない。
    expect(after.text).toContain("Reset 後の Overall");
    expect(after.text).not.toContain("全期間");
    expect(after.resets.score).toBe(reset.createdAt);
    // Stats は全期間（Reset 前の 2 Hand + Reset 後の 1 Hand）。
    expect(after.heroStats.hands).toBe(3);
    // Note / Tag は Reset 後も読める。
    expect(
      ctx.notes.notesOf({
        kind: "session_player",
        sessionId: "s1",
        playerId: "cpu1",
      }),
    ).toMatchObject({ notes: [{ body: "よく Bluff する" }], tags: ["LAG"] });
  });

  it("カテゴリごとに独立: Hypothesis だけの Reset では Score と自然言語の Profile は全期間のまま", () => {
    ctx.clock.tick();
    const { reset } = ctx.service().reset(["hypothesis"]);
    ctx.save(multi, "s2");
    ctx.reviews.append(fixtures.review(multi, 0, "improvement_suggested"));

    const res = ctx.service().profile();
    expect(res.resets).toEqual({
      score: null,
      hypothesis: reset.createdAt,
      profile: null,
    });
    expect(res.profile.decisions).toEqual({ total: 13, reviewed: 3 });
    expect(res.text).toContain("Review 済みの判断 3 件（対象の判断 13 件中）");
    expect(res.text).toContain("全期間の Overall");
    for (const h of res.profile.hypotheses) {
      for (const id of h.supportingEvidenceIds) {
        expect(id.startsWith(`${multi.handId}/`)).toBe(true);
      }
    }
  });

  it("Policy の Version を変えても、正本（Event Log・reviews）から Reset 後の Evidence だけで計算し直せる", () => {
    ctx.service().profile();
    ctx.clock.tick();
    ctx.service().reset(["score", "hypothesis", "profile"]);
    ctx.save(multi, "s2");
    ctx.reviews.append(fixtures.review(multi, 0, "major_leak"));
    ctx.reviews.append(fixtures.review(multi, 3, "improvement_suggested"));

    // しきい値と Version だけを変えた Policy（値を変えるときは Version を足す。docs/07 §4・§5）。
    const v2: ProfilePolicy = {
      ...PHASE6_PROFILE_V1,
      version: "test_profile_v2",
      recentDecisions: 1,
      hypothesisPolicy: {
        ...PHASE6_HYPOTHESIS_V1,
        version: "test_hypothesis_v2",
        thresholds: { ...PHASE6_HYPOTHESIS_V1.thresholds, minSample: 1 },
      },
    };
    const res = ctx.service(v2).profile();
    expect(res.profile.policyVersion).toBe("test_profile_v2");
    expect(res.profile.recent.window).toBe(1);
    // 前の Version の Snapshot は残らず、新しい Version の行だけに入れ替わる。
    const rows = readHypothesisSnapshot(ctx.db);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.policyVersion).toBe("test_hypothesis_v2");
      expect(row.hypothesisId.startsWith("test_hypothesis_v2/")).toBe(true);
    }
    // 正本から Reset 後の Hand だけで計算し直した値と同じ。
    const expected = computePlayerProfile(
      { hands: [multi.events], reviews: ctx.reviews, heroId: LEARNING_HERO },
      { policy: v2 },
    );
    expect(res.profile.decisions).toEqual(expected.decisions);
    expect(res.profile.longTerm).toEqual(expected.longTerm);
    expect(
      res.profile.hypotheses.map((h) => {
        const { computedAt, ...rest } = h;
        expect(typeof computedAt).toBe("string");
        return rest;
      }),
    ).toEqual(expected.hypotheses);
    expect(res.text).toBe(renderProfileText(expected, { afterReset: true }));
  });

  it("過去の Snapshot・自然言語の Profile を入力にしない（作り直しの結果は前の状態によらない）", () => {
    // 前の Snapshot に、正本に無い Hypothesis を入れておく。
    writeHypothesisSnapshot(
      ctx.db,
      [
        {
          hypothesisId: "phase6_hypothesis_v1/bet_raise",
          type: "bet_raise",
          status: "strong",
          supportingEvidenceIds: ["unknown/d0/v1"],
          counterEvidenceIds: [],
          policyVersion: "phase6_hypothesis_v1",
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    const first = ctx.service().profile();
    ctx.clock.tick();
    ctx.service().reset(["profile"]);
    ctx.save(multi, "s2");
    ctx.reviews.append(fixtures.review(multi, 0, "strong"));
    const second = ctx.service().profile();

    // 前の Snapshot は消え、正本から作った行だけになる。
    expect(
      first.profile.hypotheses.flatMap((h) => h.supportingEvidenceIds),
    ).not.toContain("unknown/d0/v1");
    // 自然言語の Profile は Reset 後の Structured Profile だけから作る（前の文を含まない）。
    const expected = computePlayerProfile({
      hands: [multi.events],
      reviews: ctx.reviews,
      heroId: LEARNING_HERO,
    });
    expect(second.text).toBe(renderProfileText(expected, { afterReset: true }));
    expect(second.text).not.toBe(first.text);
    // 同じ正本からは、前の Snapshot の有無によらず同じ結果（新しい空の Snapshot で作っても同じ）。
    const fresh = new LearningService({
      events: ctx.events,
      reviews: ctx.reviews,
      heroId: LEARNING_HERO,
      hypotheses: new InMemoryHypothesisSnapshotStore(),
      resets: ctx.resets,
      now: ctx.clock.now,
    }).profile();
    expect(fresh).toEqual(second);
  });
});

describe("Learning Reset の前後は壁時計の巻き戻りに影響されない（SQLite。D117・#130）", () => {
  it("Hand の終わりの時刻が Reset より後でも保存が Reset より前なら除き、時刻が前でも保存が後なら入れる（Score・Hypothesis・Profile）", () => {
    const ctx = sqliteLearning();
    try {
      const btn = fixtures.play(LEARNING_HANDS.btn);
      const multi = fixtures.play(LEARNING_HANDS.multi);
      ctx.save(btn, "s1");
      ctx.reviews.append(fixtures.review(btn, 0, "major_leak"));
      // 時計が 10 分戻ってから Reset（Reset の時刻は btn の終わりより前）。
      ctx.clock.rewind(10);
      const { reset } = ctx.service().reset(["score", "hypothesis", "profile"]);
      // さらに 10 分戻ってから multi を保存（multi の終わりの時刻は Reset より前）。
      ctx.clock.rewind(10);
      ctx.save(multi, "s2", false);
      ctx.reviews.append(fixtures.review(multi, 0, "major_leak"));
      const endedAt = (handId: string) =>
        Date.parse(ctx.events.read(handId).at(-1)?.recordedAt ?? "");
      expect(endedAt(btn.handId)).toBeGreaterThan(Date.parse(reset.createdAt));
      expect(endedAt(multi.handId)).toBeLessThan(Date.parse(reset.createdAt));

      const res = ctx.service().profile();
      // Reset の後に保存した multi（判断 4）だけ。Reset の前に保存した btn は、終わりの時刻が後でも入らない。
      expect(res.profile.decisions).toEqual({ total: 4, reviewed: 1 });
      expect(res.profile.hypotheses.length).toBeGreaterThan(0);
      for (const h of res.profile.hypotheses) {
        for (const id of [
          ...h.supportingEvidenceIds,
          ...h.counterEvidenceIds,
        ]) {
          expect(id.startsWith(`${multi.handId}/`)).toBe(true);
        }
      }
      expect(res.text).toContain("Review 済みの判断 1 件（対象の判断 4 件中）");
      // 応答の時刻は表示用で、clamp しない（Reset の記録時刻のまま）。
      expect(res.resets).toEqual({
        score: reset.createdAt,
        hypothesis: reset.createdAt,
        profile: reset.createdAt,
      });
      // Stats は Reset の対象ではないので全期間。
      expect(res.heroStats.hands).toBe(2);
    } finally {
      ctx.db.close();
    }
  });
});
