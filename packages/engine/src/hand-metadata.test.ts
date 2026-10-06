// Hand ごとの Best-effort Metadata（HAND_METADATA_RECORDED。#97）の Unit Test。
// 置く位置（HAND_STARTED の直後）・Visibility（system。Hero の View・CPU の KnowledgeState・Learning-only Reveal に入らない）・
// 卓の State を変えないこと・入力の検証・省略したときに Event 列が変わらないことを確かめる。
import { describe, expect, it } from "vitest";
import {
  startHand,
  type HandMetadataInput,
  type StartHandInput,
} from "./hand-engine.js";
import { foldHandEvents } from "./hand-state.js";
import { projectHeroView, projectKnowledgeState } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import { hiddenMarkers } from "./testing/view-leaks.js";

const METADATA: HandMetadataInput = {
  appVersion: "1.2.3",
  cpuProfileVersion: "cpu-profile-v1",
  cpuSeats: [
    {
      playerId: "b",
      provider: "claude",
      modelRole: "opponent_fast",
      model: "claude-test-model",
    },
    { playerId: "c", provider: "emergency_bot", modelRole: null, model: null },
  ],
};

function input(metadata?: HandMetadataInput): StartHandInput {
  return {
    handId: "m",
    seats: [
      { playerId: "a", stack: 1000 },
      { playerId: "b", stack: 1000 },
      { playerId: "c", stack: 1000 },
    ],
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 5 },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function started(metadata?: HandMetadataInput) {
  const result = startHand(input(metadata));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("HAND_METADATA_RECORDED（#97）", () => {
  it("HAND_STARTED の直後（seq 1）に system Visibility で置き、ruleProfileVersion は Rule Profile から写す", () => {
    const { events } = started(METADATA);
    expect(events.slice(0, 3).map((e) => [e.type, e.seq])).toEqual([
      ["HAND_STARTED", 0],
      ["HAND_METADATA_RECORDED", 1],
      ["DECK_SHUFFLED", 2],
    ]);
    expect(events[1]).toEqual({
      type: "HAND_METADATA_RECORDED",
      seq: 1,
      visibility: { type: "system" },
      appVersion: "1.2.3",
      ruleProfileVersion: PHASE1_CASH_PRESET.ruleProfile,
      cpuProfileVersion: "cpu-profile-v1",
      cpuSeats: METADATA.cpuSeats,
    });
  });

  it("省略すると置かず、Event 列は Metadata の無い開始と同じ（Scenario・Opponent Eval の Spot を変えない）", () => {
    const without = started();
    expect(
      without.events.some((e) => e.type === "HAND_METADATA_RECORDED"),
    ).toBe(false);
    expect(without.events[1]?.type).toBe("DECK_SHUFFLED");
  });

  it("卓の State（Chip・手番・札）を変えず、Hero の View・CPU の KnowledgeState に入らない", () => {
    const withMeta = started(METADATA);
    const without = started();
    // seq（nextSeq）以外の State は Metadata の有無で同じ。畳み込みでも同じ State になる。
    expect({ ...withMeta.state, nextSeq: 0 }).toEqual({
      ...without.state,
      nextSeq: 0,
    });
    expect(foldHandEvents(withMeta.events)).toEqual(withMeta.state);
    for (const id of ["a", "b", "c"]) {
      const view = projectHeroView(withMeta.events, id);
      const knowledge = projectKnowledgeState(withMeta.events, id);
      expect(hiddenMarkers(view)).toEqual([]);
      expect(hiddenMarkers(knowledge)).toEqual([]);
      const json = JSON.stringify([view, knowledge]);
      expect(json).not.toMatch(
        /HAND_METADATA|claude-test-model|opponent_fast|emergency_bot|cpu-profile-v1|1\.2\.3/,
      );
    }
  });

  it("Metadata の CPU が卓にいない・重複しているなら開始を拒否する", () => {
    const outsider = startHand(
      input({
        ...METADATA,
        cpuSeats: [
          { playerId: "z", provider: "rule_bot", modelRole: null, model: null },
        ],
      }),
    );
    expect(outsider).toMatchObject({
      ok: false,
      error: { kind: "invalid_input" },
    });
    const duplicated = startHand(
      input({
        ...METADATA,
        cpuSeats: [
          { playerId: "b", provider: "rule_bot", modelRole: null, model: null },
          { playerId: "b", provider: "rule_bot", modelRole: null, model: null },
        ],
      }),
    );
    expect(duplicated).toMatchObject({
      ok: false,
      error: { kind: "invalid_input" },
    });
  });

  it("入力の配列を Event に共有させない（呼び出し側が後で書き換えても Event Log は変わらない）", () => {
    const cpuSeats = [
      {
        playerId: "b",
        provider: "rule_bot" as const,
        modelRole: null,
        model: null,
      },
    ];
    const { events } = started({ ...METADATA, cpuSeats });
    cpuSeats[0] = {
      playerId: "c",
      provider: "rule_bot",
      modelRole: null,
      model: null,
    };
    const recorded = events[1];
    expect(
      recorded?.type === "HAND_METADATA_RECORDED" && recorded.cpuSeats,
    ).toEqual([
      { playerId: "b", provider: "rule_bot", modelRole: null, model: null },
    ]);
  });
});
