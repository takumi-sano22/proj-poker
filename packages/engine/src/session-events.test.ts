// Session・Hand の運用の Event（SESSION_STARTED / SESSION_ENDED / HAND_ABORTED / EMERGENCY_BOT_ENGAGED。D95）の Unit Test。
// 置ける時点・Visibility（system。Hero の View・CPU の KnowledgeState に入らない）・State への効き方
// （打ち切りだけが Hand を終え、Chip は動かさない）・Event の畳み込みでの復元を確かめる。
import { describe, expect, it } from "vitest";
import type { HandEvent } from "./hand-events.js";
import {
  applyAction,
  recordSessionEvent,
  startHand,
  type HandProgress,
} from "./hand-engine.js";
import { foldHandEvents } from "./hand-state.js";
import { getLegalActions } from "./legal-actions.js";
import { projectHeroView, projectKnowledgeState } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";

function started(): HandProgress {
  const result = startHand({
    handId: "s",
    seats: [
      { playerId: "a", stack: 1000 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 1000 },
    ],
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 3 },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function actorOf(progress: HandProgress): string {
  const actor = getLegalActions(progress.state)?.playerId;
  if (actor === undefined) throw new Error("手番が無い");
  return actor;
}

/** 手番の Player が順に Fold して、1 人残りで終わるまで進める。 */
function foldOut(progress: HandProgress): HandEvent[] {
  const events = [...progress.events];
  let state = progress.state;
  while (state.status === "in_progress") {
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("手番が無い");
    const result = applyAction(state, legal.playerId, { type: "fold" });
    if (!result.ok) throw new Error(result.error.message);
    events.push(...result.value.events);
    state = result.value.state;
  }
  return events;
}

describe("recordSessionEvent（D95）", () => {
  it("4 種類とも次の seq の system Visibility の Event になり、Hero の View・CPU の KnowledgeState に入らない", () => {
    const start = started();
    const actor = actorOf(start);
    const sessionStarted = recordSessionEvent(start.state, {
      type: "SESSION_STARTED",
      sessionId: "session-1",
    });
    const engaged = recordSessionEvent(sessionStarted.state, {
      type: "EMERGENCY_BOT_ENGAGED",
      playerId: actor,
      cause: "timeout",
    });
    const aborted = recordSessionEvent(engaged.state, {
      type: "HAND_ABORTED",
      reason: "ai_outage",
    });
    const ended = recordSessionEvent(aborted.state, {
      type: "SESSION_ENDED",
      sessionId: "session-1",
      reason: "ai_outage",
    });
    const added = [
      ...sessionStarted.events,
      ...engaged.events,
      ...aborted.events,
      ...ended.events,
    ];
    expect(added.map((e) => [e.type, e.seq, e.visibility.type])).toEqual([
      ["SESSION_STARTED", start.events.length, "system"],
      ["EMERGENCY_BOT_ENGAGED", start.events.length + 1, "system"],
      ["HAND_ABORTED", start.events.length + 2, "system"],
      ["SESSION_ENDED", start.events.length + 3, "system"],
    ]);

    const log = [...start.events, ...added];
    const before = projectHeroView(start.events, "a");
    // seq 以外は運用の Event の前と同じ（Hero の View にも CPU の KnowledgeState にも入らない）。
    expect(projectHeroView(log, "a")).toEqual(before);
    for (const id of ["a", "b", "c"]) {
      expect(JSON.stringify(projectKnowledgeState(log, id))).not.toMatch(
        /SESSION_|HAND_ABORTED|EMERGENCY_BOT|session-1/,
      );
    }
  });

  it("HAND_ABORTED は Hand を終え（手番なし）、Pot・Stack は打ち切った時点のまま。Event の畳み込みでも同じ State になる", () => {
    const start = started();
    const aborted = recordSessionEvent(start.state, {
      type: "HAND_ABORTED",
      reason: "ai_outage",
    });
    expect(aborted.state.status).toBe("complete");
    expect(aborted.state.actorIndex).toBeNull();
    expect(getLegalActions(aborted.state)).toBeNull();
    expect(aborted.state.pot).toBe(start.state.pot);
    expect(aborted.state.players).toEqual(start.state.players);
    expect(foldHandEvents([...start.events, ...aborted.events])).toEqual(
      aborted.state,
    );
    // 打ち切った Hand には Action を適用できない。
    expect(
      applyAction(aborted.state, actorOf(start), { type: "fold" }),
    ).toMatchObject({ ok: false, error: { kind: "hand_complete" } });
  });

  it("SESSION_STARTED・EMERGENCY_BOT_ENGAGED は卓の State（Chip・手番）を変えない", () => {
    const start = started();
    const actor = actorOf(start);
    const engaged = recordSessionEvent(
      recordSessionEvent(start.state, {
        type: "SESSION_STARTED",
        sessionId: "x",
      }).state,
      { type: "EMERGENCY_BOT_ENGAGED", playerId: actor, cause: "error" },
    );
    expect({ ...engaged.state, nextSeq: 0 }).toEqual({
      ...start.state,
      nextSeq: 0,
    });
  });

  it("SESSION_ENDED は HAND_FINISHED の後に置ける", () => {
    const events = foldOut(started());
    const state = foldHandEvents(events);
    expect(events.at(-1)?.type).toBe("HAND_FINISHED");
    const ended = recordSessionEvent(state, {
      type: "SESSION_ENDED",
      sessionId: "x",
      reason: "hero_busted",
    });
    expect(ended.events[0]?.seq).toBe(events.length);
  });

  it("置けない時点の記録は投げる（呼び出し側の誤り）", () => {
    const start = started();
    const actor = actorOf(start);
    const notActor = ["a", "b", "c"].find((id) => id !== actor) ?? "";
    // SESSION_ENDED は Hand の途中には置けない。
    expect(() =>
      recordSessionEvent(start.state, {
        type: "SESSION_ENDED",
        sessionId: "x",
        reason: "ai_outage",
      }),
    ).toThrow(RangeError);
    // EMERGENCY_BOT_ENGAGED は手番の CPU だけ。
    expect(() =>
      recordSessionEvent(start.state, {
        type: "EMERGENCY_BOT_ENGAGED",
        playerId: notActor,
        cause: "error",
      }),
    ).toThrow(RangeError);
    // 終わった Hand には、SESSION_ENDED 以外は置けない。
    const finished = foldHandEvents(foldOut(start));
    for (const body of [
      { type: "SESSION_STARTED", sessionId: "x" },
      { type: "HAND_ABORTED", reason: "ai_outage" },
      { type: "EMERGENCY_BOT_ENGAGED", playerId: actor, cause: "error" },
    ] as const) {
      expect(() => recordSessionEvent(finished, body)).toThrow(RangeError);
    }
  });
});
