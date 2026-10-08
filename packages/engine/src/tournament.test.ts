// Tournament の設定（Versioned Config）・標準 Preset・SESSION_STARTED の Snapshot の契約（D108・D127・D128・D129・#183）。
import { describe, expect, it } from "vitest";
import { recordSessionEvent, startHand } from "./hand-engine.js";
import type { HandEvent } from "./hand-events.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  TOURNAMENT_CONFIG_VERSION,
  TOURNAMENT_PRESET_IDS,
  TOURNAMENT_PRESETS,
  isTournamentPresetId,
  sessionSettingsOf,
  tableConfigForLevel,
  validateTournamentConfig,
  type TournamentConfig,
} from "./tournament.js";

const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;

/** 6 人が 1,500 で座った Hand の開始の結果（SESSION_STARTED を置ける Hand の途中）。 */
function openedHand() {
  const started = startHand({
    handId: "h1",
    seats: ["hero", "cpu1", "cpu2", "cpu3", "cpu4", "cpu5"].map((playerId) => ({
      playerId,
      stack: STANDARD.startingStack,
    })),
    buttonPlayerId: "hero",
    config: tableConfigForLevel(PHASE1_CASH_PRESET, STANDARD.levels[0]!),
    deal: { seed: 1 },
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
}

describe("標準 Preset（OI-007 の暫定値。D127・D128）", () => {
  it("標準 6-max STT は Starting Stack 1,500・10/20 から 10 Hand ごと・BBA の額は BB・50/30/20・参加費 100pt", () => {
    expect(STANDARD).toEqual({
      presetId: "stt6_hand_count",
      version: TOURNAMENT_CONFIG_VERSION,
      startingStack: 1_500,
      tableSize: 6,
      levels: [
        { smallBlind: 10, bigBlind: 20, ante: 20 },
        { smallBlind: 15, bigBlind: 30, ante: 30 },
        { smallBlind: 25, bigBlind: 50, ante: 50 },
        { smallBlind: 50, bigBlind: 100, ante: 100 },
        { smallBlind: 75, bigBlind: 150, ante: 150 },
        { smallBlind: 100, bigBlind: 200, ante: 200 },
        { smallBlind: 150, bigBlind: 300, ante: 300 },
        { smallBlind: 200, bigBlind: 400, ante: 400 },
        { smallBlind: 300, bigBlind: 600, ante: 600 },
        { smallBlind: 400, bigBlind: 800, ante: 800 },
        { smallBlind: 600, bigBlind: 1_200, ante: 1_200 },
        { smallBlind: 1_000, bigBlind: 2_000, ante: 2_000 },
      ],
      schedule: { kind: "hand_count", handsPerLevel: 10 },
      anteKind: "big_blind_ante",
      payout: { kind: "percentages", percentages: [50, 30, 20] },
      entryFee: 100,
    });
  });

  it("time-base の Preset は標準と同じ Stack・Blind 表・Ante・Payout で、1 Level 10 分", () => {
    const timeBase = TOURNAMENT_PRESETS.stt6_time_base;
    expect(timeBase.schedule).toEqual({
      kind: "time_base",
      levelDurationMs: 600_000,
    });
    expect({ ...timeBase, presetId: "x", schedule: null }).toEqual({
      ...STANDARD,
      presetId: "x",
      schedule: null,
    });
  });

  it("どの Preset も検証を通り、ID は表の鍵と一致する", () => {
    for (const id of TOURNAMENT_PRESET_IDS) {
      expect(TOURNAMENT_PRESETS[id].presetId).toBe(id);
      expect(validateTournamentConfig(TOURNAMENT_PRESETS[id])).toBeNull();
    }
    expect(isTournamentPresetId("stt6_hand_count")).toBe(true);
    expect(isTournamentPresetId("mtt")).toBe(false);
    expect(isTournamentPresetId(undefined)).toBe(false);
  });
});

describe("validateTournamentConfig", () => {
  const broken: [string, Partial<Record<keyof TournamentConfig, unknown>>][] = [
    ["知らない Preset", { presetId: "mtt" }],
    ["版が空", { version: "" }],
    ["Starting Stack が小数", { startingStack: 1_500.5 }],
    ["Level 表が空", { levels: [] }],
    ["SB > BB", { levels: [{ smallBlind: 30, bigBlind: 20, ante: 0 }] }],
    ["Ante が負", { levels: [{ smallBlind: 10, bigBlind: 20, ante: -1 }] }],
    [
      "Ante なしの設定に Ante の額",
      {
        anteKind: "none",
        levels: [{ smallBlind: 10, bigBlind: 20, ante: 20 }],
      },
    ],
    ["知らない Ante の種類", { anteKind: "button_ante" }],
    ["Starting Stack が BB と Ante の合計以下", { startingStack: 40 }],
    [
      "Level の基準が 0",
      { schedule: { kind: "hand_count", handsPerLevel: 0 } },
    ],
    ["知らない Level の基準", { schedule: { kind: "orbit", orbits: 1 } }],
    [
      "Payout の合計が 100 でない",
      { payout: { kind: "percentages", percentages: [50, 30, 10] } },
    ],
    [
      "Payout が下位ほど多い",
      { payout: { kind: "percentages", percentages: [30, 50, 20] } },
    ],
    [
      "Payout の割合が小数",
      { payout: { kind: "percentages", percentages: [50.5, 49.5] } },
    ],
    ["参加費が 0", { entryFee: 0 }],
    ["参加人数が 1", { tableSize: 1 }],
    ["参加人数が 9", { tableSize: 9 }],
    [
      "入賞の数が参加人数より多い",
      {
        tableSize: 2,
        payout: { kind: "percentages", percentages: [50, 30, 20] },
      },
    ],
  ];

  it.each(broken)("%s は理由を返す", (_name, change) => {
    expect(validateTournamentConfig({ ...STANDARD, ...change })).toEqual(
      expect.any(String),
    );
  });

  it("object でない値・null は理由を返す", () => {
    expect(validateTournamentConfig(null)).toEqual(expect.any(String));
    expect(validateTournamentConfig("stt6_hand_count")).toEqual(
      expect.any(String),
    );
  });

  it("Ante なしの設定（Ante の額が 0）と、1 位総取りの Payout は通る", () => {
    expect(
      validateTournamentConfig({
        ...STANDARD,
        anteKind: "none",
        levels: STANDARD.levels.map((l) => ({ ...l, ante: 0 })),
        payout: { kind: "percentages", percentages: [100] },
      }),
    ).toBeNull();
  });
});

describe("tableConfigForLevel", () => {
  it("Rule Profile は Cash と共有し、Blind だけを Level の額にする（D108）", () => {
    const config = tableConfigForLevel(PHASE1_CASH_PRESET, STANDARD.levels[2]!);
    expect(config).toEqual({
      ...PHASE1_CASH_PRESET,
      smallBlind: 25,
      bigBlind: 50,
    });
    // 元の Cash の設定は変えない。
    expect(PHASE1_CASH_PRESET.bigBlind).toBe(2);
  });
});

describe("SESSION_STARTED の Tournament の設定の Snapshot（D129）", () => {
  it("Snapshot を持つ SESSION_STARTED は tournament として読み、Snapshot をそのまま返す", () => {
    const opened = openedHand();
    const progress = recordSessionEvent(opened.state, {
      type: "SESSION_STARTED",
      sessionId: "s1",
      tournament: STANDARD,
    });
    const events = [...opened.events, ...progress.events];
    expect(progress.events).toEqual([
      {
        type: "SESSION_STARTED",
        sessionId: "s1",
        tournament: STANDARD,
        seq: opened.events.length,
        visibility: { type: "system" },
      },
    ]);
    expect(sessionSettingsOf(events)).toEqual({
      mode: "tournament",
      tournament: STANDARD,
    });
    // JSON を通しても（保存して読み直しても）同じに読める。
    expect(
      sessionSettingsOf(JSON.parse(JSON.stringify(events)) as HandEvent[]),
    ).toEqual({ mode: "tournament", tournament: STANDARD });
  });

  it("Snapshot の無い SESSION_STARTED（mode を指定しない Session・旧版の行）は cash、SESSION_STARTED の無い Hand は null", () => {
    const opened = openedHand();
    const progress = recordSessionEvent(opened.state, {
      type: "SESSION_STARTED",
      sessionId: "s1",
    });
    expect(progress.events[0]).not.toHaveProperty("tournament");
    expect(sessionSettingsOf([...opened.events, ...progress.events])).toEqual({
      mode: "cash",
    });
    expect(sessionSettingsOf(opened.events)).toBeNull();
  });

  it("不正な Snapshot は Event にせず投げ、保存済みの壊れた Snapshot は cash として扱わずに投げる", () => {
    const opened = openedHand();
    const bad = { ...STANDARD, startingStack: 0 };
    expect(() =>
      recordSessionEvent(opened.state, {
        type: "SESSION_STARTED",
        sessionId: "s1",
        tournament: bad,
      }),
    ).toThrow(RangeError);
    const stored = {
      type: "SESSION_STARTED",
      sessionId: "s1",
      tournament: bad,
      seq: opened.events.length,
      visibility: { type: "system" },
    } as HandEvent;
    expect(() => sessionSettingsOf([...opened.events, stored])).toThrow(
      RangeError,
    );
  });
});
