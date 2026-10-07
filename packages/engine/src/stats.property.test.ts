// Stats Projection の Property テスト（#112・docs/07 §3・INV-TEST-007 に相当・poker-engine-testing §5）。
// 2〜8 人・ランダムな Stack と合法 Action の列で複数の Hand を進め（CPU の手番に system の記録を混ぜ、時々 Hand を打ち切る）、
//  - public でない Event（Hole Cards・Deck・system）の中身を差し替えても、取り除いても結果が変わらない（情報境界）
//  - Hand を渡す順に依らない・除外は Hand を渡さないのと同じ（決定論）
//  - Numerator ≤ Denominator・全体 = Position 別の和 = Street 別の和（集計の整合）
// を確かめる。fast-check の seed は実行ごとに変わる（POKER_PROPERTY_SEED で固定。testing/property.ts）。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  recordAiEvent,
  recordSessionEvent,
  startHand,
  type HandProgress,
} from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { publicEvents } from "./projection.js";
import {
  STAT_DEFINITIONS,
  projectPlayerStats,
  type StatTable,
  type StatsProjection,
} from "./stats.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  collectCards,
  hiddenMarkers,
  tamperHiddenEvents,
  testMetadata,
} from "./testing/view-leaks.js";
import { propertyParams } from "./testing/property.js";

const MAX_STEPS = 500;

function canonicalFrom(option: LegalAction, choice: number): PlayerAction {
  switch (option.type) {
    case "bet":
    case "raise":
      return {
        type: option.type,
        amount: option.min + (choice % (option.max - option.min + 1)),
      };
    case "call":
      return { type: "call" };
    default:
      return { type: option.type };
  }
}

/** 1 Hand を最後まで（または打ち切りまで）進めた Event Log。 */
function playHand(
  handId: string,
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
): HandEvent[] {
  const started = startHand({
    handId,
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
    // system Visibility の Metadata（#97）も混ぜる。
    metadata: testMetadata(seats),
  });
  if (!started.ok) throw new Error(started.error.message);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  let cursor = 0;
  const next = () => choices[cursor++ % choices.length] ?? 0;
  const take = (r: HandProgress) => {
    state = r.state;
    events.push(...r.events);
  };
  // Stack が Blind 以下で開始直後に終わる Hand もあるので、進行中のときだけ置く（置ける時点の検査は Engine が持つ）。
  if (state.status === "in_progress") {
    take(
      recordSessionEvent(state, { type: "SESSION_STARTED", sessionId: "s" }),
    );
  }
  const abortAt = next() % 4 === 0 ? next() % 10 : -1;

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    if (step === abortAt) {
      take(
        recordSessionEvent(state, {
          type: "HAND_ABORTED",
          reason: "ai_outage",
        }),
      );
      break;
    }
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    // CPU の出力の値を含みうる system の記録。
    if (next() % 3 === 0) {
      take(
        recordAiEvent(state, {
          type: "AI_ACTION_INVALID",
          playerId: legal.playerId,
          attempt: 1,
          stage: "legal_action",
          reason: "raise 999999",
        }),
      );
    }
    const option = legal.actions[next() % legal.actions.length] as LegalAction;
    const r = applyAction(state, legal.playerId, canonicalFrom(option, next()));
    if (!r.ok) throw new Error(r.error.message);
    take(r.value);
  }
  return events;
}

const handsArb = fc
  .array(
    fc.record({
      players: fc.integer({ min: 2, max: 8 }),
      stacks: fc.array(fc.integer({ min: 1, max: 400 }), {
        minLength: 8,
        maxLength: 8,
      }),
      seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      choices: fc.array(fc.nat(1000), { minLength: 1, maxLength: 60 }),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((specs) =>
    specs.map((spec, i) => {
      // 席の Player は Hand をまたいで同じ id（Player ごとの集計が Hand をまたぐ）。
      const seats = Array.from({ length: spec.players }, (_, k) => ({
        playerId: `p${k}`,
        stack: spec.stacks[k] ?? 100,
      }));
      return playHand(`h${i}`, seats, spec.seed, spec.choices);
    }),
  );

function sumTables(tables: readonly StatTable[]): StatTable {
  return Object.fromEntries(
    STAT_DEFINITIONS.map((d) => [
      d.id,
      tables.reduce(
        (acc, t) => ({
          numerator: acc.numerator + t[d.id].numerator,
          denominator: acc.denominator + t[d.id].denominator,
          opportunities: acc.opportunities + t[d.id].opportunities,
        }),
        { numerator: 0, denominator: 0, opportunities: 0 },
      ),
    ]),
  ) as StatTable;
}

function finishedHands(hands: readonly HandEvent[][]): HandEvent[][] {
  return hands.filter((h) => h.some((e) => e.type === "HAND_FINISHED"));
}

describe("projectPlayerStats（Property）", () => {
  it("public でない Event を差し替えても取り除いても同じ結果で、Card・hidden の印を含まない", () => {
    fc.assert(
      fc.property(handsArb, (hands) => {
        const stats = projectPlayerStats(hands);
        expect(
          projectPlayerStats(
            hands.map((h) => tamperHiddenEvents(h, "__no_viewer__")),
          ),
        ).toEqual(stats);
        expect(projectPlayerStats(hands.map(publicEvents))).toEqual(stats);
        expect(collectCards(stats)).toEqual([]);
        expect(hiddenMarkers(stats)).toEqual([]);
      }),
      propertyParams(100),
    );
  });

  it("Hand を渡す順に依らず、除外は Hand を渡さないのと同じ", () => {
    fc.assert(
      fc.property(handsArb, fc.nat(), (hands, pick) => {
        const stats = projectPlayerStats(hands);
        expect(projectPlayerStats([...hands].reverse())).toEqual(stats);
        const excluded = `h${pick % hands.length}`;
        expect(
          projectPlayerStats(hands, { excludeHandIds: new Set([excluded]) }),
        ).toEqual(
          projectPlayerStats(
            hands.filter(
              (h) =>
                !h.some(
                  (e) => e.type === "HAND_STARTED" && e.handId === excluded,
                ),
            ),
          ),
        );
      }),
      propertyParams(100),
    );
  });

  it("集計が整合する（Numerator ≤ Denominator・全体 = Position 別の和 = Street 別の和）", () => {
    fc.assert(
      fc.property(handsArb, (hands) => {
        const stats: StatsProjection = projectPlayerStats(hands);
        const finished = finishedHands(hands);
        expect(stats.handCount).toBe(finished.length);
        const seated = finished.flatMap((h) => {
          const s = h.find((e) => e.type === "HAND_STARTED");
          return s?.type === "HAND_STARTED" ? s.seats : [];
        });
        expect(stats.players.reduce((n, p) => n + p.hands, 0)).toBe(
          seated.length,
        );
        for (const p of stats.players) {
          expect(sumTables(Object.values(p.byPosition))).toEqual(p.overall);
          expect(sumTables(Object.values(p.byStreet))).toEqual(p.overall);
          for (const d of STAT_DEFINITIONS) {
            const value = p.overall[d.id];
            if (d.kind === "percentage") {
              expect(value.numerator).toBeLessThanOrEqual(value.denominator);
              expect(value.denominator).toBe(value.opportunities);
            } else {
              expect(value.numerator + value.denominator).toBe(
                value.opportunities,
              );
            }
          }
          // Preflop の指標は 1 Hand に高々 1 回の機会。PFR の Hand は VPIP の Hand に含まれる。
          expect(p.overall.vpip.opportunities).toBeLessThanOrEqual(p.hands);
          expect(p.overall.pfr.numerator).toBeLessThanOrEqual(
            p.overall.vpip.numerator,
          );
          expect(p.overall.three_bet.opportunities).toBeLessThanOrEqual(
            p.overall.vpip.opportunities,
          );
        }
      }),
      propertyParams(100),
    );
  });
});
