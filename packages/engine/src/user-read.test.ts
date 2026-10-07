// Hero の User Read（USER_READ_RECORDED。D33・D105・D112・#115）の Unit Test。
// 記録できる時点（Hand の途中の自分の手番だけ）・入力の検証・Visibility（記録した本人だけの private。CPU の KnowledgeState・
// 他者の View・Stats の入力〔publicEvents〕・Learning-only Reveal に入らない）・判断時点の扱い
// （判断の前の読みだけがその判断の userReads に入り、判断時点〔decisionPointSeq〕と KnowledgeState は変わらない）を確かめる。
import { describe, expect, it } from "vitest";
import type { HandEvent } from "./hand-events.js";
import {
  applyAction,
  recordUserRead,
  startHand,
  USER_READ_TEXT_MAX,
  type HandProgress,
} from "./hand-engine.js";
import { heroDecisions, heroInformationSets } from "./hand-summary.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { projectLearningReveal } from "./learning-reveal.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import {
  projectHeroView,
  projectKnowledgeState,
  publicEvents,
} from "./projection.js";
import { projectPlayerStats } from "./stats.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";

const PLAYERS = ["a", "b", "c"] as const;

function started(): HandProgress {
  const result = startHand({
    handId: "r",
    seats: PLAYERS.map((playerId) => ({ playerId, stack: 1000 })),
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 3 },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function actorOf(state: HandState): string {
  const actor = getLegalActions(state)?.playerId;
  if (actor === undefined) throw new Error("手番が無い");
  return actor;
}

/** Event の列を持って Hand を進める小さな台本。 */
class Script {
  readonly events: HandEvent[];
  state: HandState;

  constructor(start: HandProgress) {
    this.events = [...start.events];
    this.state = start.state;
  }

  act(action: PlayerAction): void {
    const result = applyAction(this.state, actorOf(this.state), action);
    if (!result.ok) throw new Error(result.error.message);
    this.push(result.value);
  }

  /** 手番の Player が Check / Call する。 */
  passive(): void {
    const legal = getLegalActions(this.state);
    const check = legal?.actions.some((a) => a.type === "check") ?? false;
    this.act({ type: check ? "check" : "call" });
  }

  read(playerId: string, targetPlayerId: string | null, text: string): void {
    const result = recordUserRead(this.state, {
      playerId,
      targetPlayerId,
      text,
    });
    if (!result.ok) throw new Error(result.error.message);
    this.push(result.value);
  }

  private push(progress: HandProgress): void {
    this.events.push(...progress.events);
    this.state = progress.state;
  }
}

describe("recordUserRead（D112）", () => {
  it("手番の Player の読みを次の seq の、記録した本人だけの private Event にする。卓の State は変えない", () => {
    const start = started();
    const hero = actorOf(start.state);
    const target = PLAYERS.find((p) => p !== hero) as string;
    const result = recordUserRead(start.state, {
      playerId: hero,
      targetPlayerId: target,
      text: "  Value が多そう  ",
    });
    if (!result.ok) throw new Error(result.error.message);
    const [event] = result.value.events;
    expect(result.value.events).toHaveLength(1);
    expect(event).toEqual({
      type: "USER_READ_RECORDED",
      playerId: hero,
      street: "preflop",
      targetPlayerId: target,
      text: "Value が多そう",
      seq: start.state.nextSeq,
      visibility: { type: "private", playerId: hero },
    });
    // 卓の State（Chip・手番・Street）は変わらず、seq だけが進む。
    expect({ ...result.value.state, nextSeq: 0 }).toEqual({
      ...start.state,
      nextSeq: 0,
    });
    // Event の畳み込みでも同じ State になる。
    expect(foldHandEvents([...start.events, ...result.value.events])).toEqual(
      result.value.state,
    );
  });

  it("相手を特定しない読み・意図（targetPlayerId: null）も記録できる", () => {
    const start = started();
    const hero = actorOf(start.state);
    const result = recordUserRead(start.state, {
      playerId: hero,
      targetPlayerId: null,
      text: "Pot Odds で Call する",
    });
    expect(result.ok).toBe(true);
  });

  it("手番でない Player・終わった Hand・自分や卓にいない席への読み・空や長すぎる本文は拒否する", () => {
    const start = started();
    const hero = actorOf(start.state);
    const other = PLAYERS.find((p) => p !== hero) as string;
    const kindOf = (input: Parameters<typeof recordUserRead>[1]) => {
      const result = recordUserRead(start.state, input);
      return result.ok ? "ok" : result.error.kind;
    };
    expect(kindOf({ playerId: other, targetPlayerId: hero, text: "x" })).toBe(
      "not_actor",
    );
    expect(kindOf({ playerId: hero, targetPlayerId: hero, text: "x" })).toBe(
      "invalid_input",
    );
    expect(kindOf({ playerId: hero, targetPlayerId: "zz", text: "x" })).toBe(
      "invalid_input",
    );
    expect(kindOf({ playerId: hero, targetPlayerId: other, text: "   " })).toBe(
      "invalid_input",
    );
    expect(
      kindOf({
        playerId: hero,
        targetPlayerId: other,
        text: "あ".repeat(USER_READ_TEXT_MAX + 1),
      }),
    ).toBe("invalid_input");
    expect(
      kindOf({
        playerId: hero,
        targetPlayerId: other,
        text: "あ".repeat(USER_READ_TEXT_MAX),
      }),
    ).toBe("ok");

    // 全員が Fold して終わった Hand。
    const script = new Script(start);
    while (script.state.status === "in_progress") script.act({ type: "fold" });
    const done = recordUserRead(script.state, {
      playerId: hero,
      targetPlayerId: null,
      text: "x",
    });
    expect(done.ok ? "ok" : done.error.kind).toBe("hand_complete");
  });
});

/** Hero が 1 回目の判断の前と、2 回目の判断の前に読みを残し、最後まで Check / Call で進めた Hand。 */
function handWithReads(withReads: boolean): {
  events: HandEvent[];
  hero: string;
} {
  const script = new Script(started());
  const hero = actorOf(script.state);
  const target = PLAYERS.find((p) => p !== hero) as string;
  let heroTurns = 0;
  while (script.state.status === "in_progress") {
    if (actorOf(script.state) === hero) {
      heroTurns++;
      if (withReads && heroTurns <= 2) {
        script.read(hero, target, `読み ${heroTurns}`);
      }
    }
    script.passive();
  }
  return { events: script.events, hero };
}

describe("USER_READ_RECORDED の Visibility（不変条件 2・D105）", () => {
  const { events, hero } = handWithReads(true);
  const without = handWithReads(false).events;
  const reads = events.filter((e) => e.type === "USER_READ_RECORDED");

  it("台本どおり読みが 2 つ入っている", () => {
    expect(reads).toHaveLength(2);
  });

  it("CPU（記録した本人以外）の KnowledgeState と View には入らず、読みの有無で変わらない", () => {
    for (const playerId of PLAYERS.filter((p) => p !== hero)) {
      // seq は読みの分だけずれるので、全 Event の時点で比べる（KnowledgeState・TableView は seq を持たない）。
      expect(projectKnowledgeState(events, playerId)).toEqual(
        projectKnowledgeState(without, playerId),
      );
      expect(
        projectHeroView(events, playerId).log.some(
          (e) => e.type === "USER_READ_RECORDED",
        ),
      ).toBe(false);
    }
    // 判断の途中の時点（読みの直後）でも、他者の KnowledgeState は読みの直前と同じ。
    for (const read of reads) {
      for (const playerId of PLAYERS.filter((p) => p !== hero)) {
        expect(
          projectKnowledgeState(
            events.filter((e) => e.seq <= read.seq),
            playerId,
          ),
        ).toEqual(
          projectKnowledgeState(
            events.filter((e) => e.seq < read.seq),
            playerId,
          ),
        );
      }
    }
  });

  it("記録した本人の View の log には入る（卓の見え方は変わらない）", () => {
    const view = projectHeroView(events, hero);
    expect(view.log.filter((e) => e.type === "USER_READ_RECORDED")).toEqual(
      reads,
    );
    // 卓の見え方（log 以外）は読みの有無で変わらない。
    expect({ ...view, log: [] }).toEqual({
      ...projectHeroView(without, hero),
      log: [],
    });
  });

  it("Stats の入力（publicEvents）・Stats・Learning-only Reveal に入らず、読みの有無で変わらない", () => {
    expect(
      publicEvents(events).some((e) => e.type === "USER_READ_RECORDED"),
    ).toBe(false);
    expect(projectPlayerStats([events])).toEqual(projectPlayerStats([without]));
    expect(projectLearningReveal(events)).toEqual(
      projectLearningReveal(without),
    );
  });
});

describe("判断時点の User Read（heroInformationSets。不変条件 3）", () => {
  const { events, hero } = handWithReads(true);
  const without = handWithReads(false).events;
  const sets = heroInformationSets(events, hero);
  const setsWithout = heroInformationSets(without, hero);

  it("判断時点（decisionPointSeq の Event）と KnowledgeState は、読みの有無で変わらない", () => {
    expect(sets).toHaveLength(setsWithout.length);
    const pointEvent = (evs: readonly HandEvent[], seq: number) => {
      const e = evs.find((x) => x.seq === seq);
      if (e === undefined) throw new Error(`seq ${seq} が無い`);
      return { ...e, seq: 0 };
    };
    sets.forEach((set, i) => {
      const other = setsWithout[i];
      if (other === undefined) throw new Error("判断の数が違う");
      expect(set.knowledge).toEqual(other.knowledge);
      expect(pointEvent(events, set.decision.decisionPointSeq)).toEqual(
        pointEvent(without, other.decision.decisionPointSeq),
      );
      // 判断時点の卓の Event に読みは入れない（読みは userReads だけ）。
      expect(set.events.some((e) => e.type === "USER_READ_RECORDED")).toBe(
        false,
      );
    });
    expect(setsWithout.every((s) => s.userReads.length === 0)).toBe(true);
  });

  it("判断の直前に記録した読みはその判断から入り、判断より後に記録した読みは入らない", () => {
    expect(sets.length).toBeGreaterThanOrEqual(3);
    const texts = sets.map((s) => s.userReads.map((r) => r.text));
    expect(texts[0]).toEqual(["読み 1"]);
    expect(texts[1]).toEqual(["読み 1", "読み 2"]);
    expect(texts[2]).toEqual(["読み 1", "読み 2"]);
    for (const set of sets) {
      for (const read of set.userReads) {
        expect(read.seq).toBeLessThan(set.decision.actionSeq);
      }
    }
    // provenance（seq・Street・対象）を持つ。
    const first = reads()[0];
    expect(sets[0]?.userReads[0]).toEqual({
      seq: first?.seq,
      street: "preflop",
      targetPlayerId:
        first?.type === "USER_READ_RECORDED" ? first.targetPlayerId : null,
      text: "読み 1",
    });
  });

  it("判断の一覧（heroDecisions）の判断時点は、直前の読みを飛ばした卓の Event のまま", () => {
    const decisions = heroDecisions(events, hero);
    for (const d of decisions) {
      const point = events.find((e) => e.seq === d.decisionPointSeq);
      expect(point?.type).not.toBe("USER_READ_RECORDED");
    }
  });

  function reads(): HandEvent[] {
    return events.filter((e) => e.type === "USER_READ_RECORDED");
  }
});
