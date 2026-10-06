// Property テスト（docs/09 §9・poker-engine-testing §5）。Legal Action からランダムに選んで Hand を最後まで進め、
// 各ステップで Invariant・Event の畳み込み・Projection の情報漏れを確かめる。
// fast-check の seed は実行ごとに変わる。失敗時は fast-check が seed と縮小済みの反例を出すので、Scenario へ昇格させる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { nextHandSeating } from "./position.js";
import { projectHeroView, projectKnowledgeState } from "./projection.js";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PHASE1_CASH_PRESET,
} from "./table-config.js";
import {
  checkHandFinished,
  checkInvariants,
  checkPotAwards,
  initialChipTotal,
} from "./testing/invariants.js";
import {
  hiddenMarkers,
  leakedCards,
  tamperHiddenEvents,
  testMetadata,
} from "./testing/view-leaks.js";

const MAX_STEPS = 500;

interface PlayedHand {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/**
 * choices を順に使って Legal Action と額を選ぶ。各ステップで check を呼ぶ。
 * Button は指定が無ければ seed から選ぶ（Session では nextHandSeating の結果を渡す）。
 */
function playHand(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
  check: (state: HandState, events: readonly HandEvent[]) => void,
  buttonPlayerId: string = (seats[seed % seats.length] as SeatInit).playerId,
): PlayedHand {
  const started = startHand({
    handId: "prop",
    seats,
    buttonPlayerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
    // system Visibility の Metadata（#97）も混ぜ、View・KnowledgeState・Hero Information Set に届かないことを一緒に確かめる。
    metadata: testMetadata(seats),
  });
  // 正しい入力の開始は拒否されない（Stack が Blind に満たなくても Blind で All-in して始まる）。
  if (!started.ok) throw new Error(started.error.message);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  check(state, events);

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const pick = (k: number) => choices[(step * 2 + k) % choices.length] ?? 0;
    const option = legal.actions[pick(0) % legal.actions.length] as LegalAction;
    const result = applyAction(
      state,
      legal.playerId,
      toAction(option, pick(1)),
    );
    // Legal Action から選んだ入力は拒否されない（Side Pot も扱えるので、止まる状態は無い。D78）。
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
    check(state, events);
  }
  return { state, events };
}

function toAction(option: LegalAction, choice: number): PlayerAction {
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

/** Invariant・畳み込み・INV-TEST-006・Projection の漏れを 1 ステップ分まとめて確かめる。 */
function checkStep(total: number) {
  return (state: HandState, events: readonly HandEvent[]) => {
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);

    // INV-TEST-006: 手番でない Player の Action は拒否され、State は変わらない。
    const actorId = getLegalActions(state)?.playerId;
    for (const p of state.players) {
      if (p.playerId === actorId) continue;
      const r = applyAction(state, p.playerId, { type: "fold" });
      expect(r.ok).toBe(false);
    }

    // INV-TEST-007（Engine 側）: 全席・全手番で、どの Player の View / KnowledgeState にも、
    // 他者の Hidden Cards・Deck（未来の Card）・engine Visibility の Event が入らない。
    const legal = getLegalActions(state);
    for (const p of state.players) {
      const hero = projectHeroView(events, p.playerId);
      const knowledge = projectKnowledgeState(events, p.playerId);
      expect(leakedCards(hero, state, p.playerId)).toEqual([]);
      expect(leakedCards(knowledge, state, p.playerId)).toEqual([]);
      expect(hiddenMarkers(knowledge)).toEqual([]);
      // 見えない Event の中身を差し替えても KnowledgeState は変わらない（中身が出力に届く経路が無い）。
      expect(
        projectKnowledgeState(
          tamperHiddenEvents(events, p.playerId),
          p.playerId,
        ),
      ).toEqual(knowledge);
      // 見える Event だけから計算した Legal Action・Pot・Call 額が、全情報の State と一致する。
      const isActor = legal?.playerId === p.playerId;
      expect(knowledge.legalActions).toEqual(isActor ? legal : null);
      expect(knowledge.pot).toBe(state.pot);
      if (isActor) {
        const call = legal.actions.find((a) => a.type === "call");
        expect(knowledge.math.callAmount).toBe(call?.amount ?? 0);
      }
    }
  };
}

/** Invariant と畳み込みだけを確かめる（Projection の検査を省いた軽い版。Session の多数 Hand 用）。 */
function checkChips(total: number) {
  return (state: HandState, events: readonly HandEvent[]) => {
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);
  };
}

const playerCount = fc.integer({ min: MIN_PLAYERS, max: MAX_PLAYERS });
const seed = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const choices = fc.array(fc.nat({ max: 10_000 }), {
  minLength: 1,
  maxLength: 64,
});
/** 2〜8 人の不均等 Stack（Blind に満たない 1〜2 を含む）。 */
const unevenStacks = fc.array(fc.integer({ min: 1, max: 400 }), {
  minLength: MIN_PLAYERS,
  maxLength: MAX_PLAYERS,
});

describe("Hand 進行: Property", () => {
  it("均等 Stack（Phase 1 Preset）なら Hand は最後まで進み（端数込み）、Chip が保存され、情報が漏れない", () => {
    fc.assert(
      fc.property(playerCount, seed, choices, (n, s, cs) => {
        const seats = Array.from({ length: n }, (_, i) => ({
          playerId: `p${i}`,
          stack: PHASE1_CASH_PRESET.startingStack,
        }));
        const played = playHand(
          seats,
          s,
          cs,
          checkStep(initialChipTotal(seats)),
        );
        // 同着の端数も配られ、Pot は空になる（D75）。
        expect(played.state.status).toBe("complete");
        expect(played.state.pot).toBe(0);
        expect(
          checkHandFinished(played.events, initialChipTotal(seats)),
        ).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it("不均等 Stack（Blind に満たない Stack を含む）・2〜8 人でも Hand は最後まで進み、Side Pot ごとの配分で Chip が保存され、情報が漏れない", () => {
    fc.assert(
      fc.property(unevenStacks, seed, choices, (ss, s, cs) => {
        const seats = ss.map((stack, i) => ({ playerId: `p${i}`, stack }));
        const total = initialChipTotal(seats);
        const played = playHand(seats, s, cs, checkStep(total));
        expect(played.state.status).toBe("complete");
        expect(played.state.pot).toBe(0);
        expect(checkPotAwards(played.events)).toEqual([]);
        // Σ potTotal = Σ Commit、各 Player の終了時 Stack = 開始 − Commit + 配分（Event だけで数え直す）。
        expect(checkHandFinished(played.events, total)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("Session: nextHandSeating で Stack を持ち越して Hand を続けても Chip 総量は変わらず、Bust した Player だけが抜ける（D80）", () => {
    const hands = fc.integer({ min: 1, max: 12 });
    fc.assert(
      fc.property(unevenStacks, seed, choices, hands, (ss, s, cs, n) => {
        let seats: readonly SeatInit[] = ss.map((stack, i) => ({
          playerId: `p${i}`,
          stack,
        }));
        let button = (seats[s % seats.length] as SeatInit).playerId;
        const total = initialChipTotal(seats);
        for (let h = 0; h < n; h++) {
          // Hand ごとに Action の選び方をずらす。
          const rotated = cs.map((_, i) => cs[(i + h) % cs.length] as number);
          const played = playHand(
            seats,
            s + h,
            rotated,
            checkChips(total),
            button,
          );
          expect(checkPotAwards(played.events)).toEqual([]);
          expect(checkHandFinished(played.events, total)).toEqual([]);

          // 次 Hand の席は、この Hand の Event（HAND_STARTED の席順・Button と HAND_FINISHED の Stack）だけから作る。
          const first = played.events[0];
          const last = played.events.at(-1);
          if (
            first?.type !== "HAND_STARTED" ||
            last?.type !== "HAND_FINISHED"
          ) {
            throw new Error("Event Log の始まりか終わりが無い");
          }
          const next = nextHandSeating(
            {
              seatOrder: first.seats.map((x) => x.playerId),
              stacks: last.stacks,
              buttonPlayerId: first.buttonPlayerId,
            },
            PHASE1_CASH_PRESET,
          );
          if (!next.ok) throw new Error(next.error.message);
          const alive = last.stacks.flatMap((x) =>
            x.amount > 0 ? [{ playerId: x.playerId, stack: x.amount }] : [],
          );
          if (next.value.kind === "no_next_hand") {
            // Chip が残っている限り、勝ち残った 1 人が全部を持つ。
            expect(next.value.remaining).toEqual(alive);
            expect(alive).toHaveLength(1);
            expect(initialChipTotal(alive)).toBe(total);
            return;
          }
          // 席順を保って Bust だけが抜け、持ち越した Stack の合計は開始時の総量のまま。
          expect(next.value.seats).toEqual(alive);
          expect(initialChipTotal(next.value.seats)).toBe(total);
          seats = next.value.seats;
          button = next.value.buttonPlayerId;
        }
      }),
      { numRuns: 100 },
    );
  });

  it("同じ seed と同じ Action 列からは同じ Event 列と State ができる（再現性）", () => {
    fc.assert(
      fc.property(playerCount, seed, choices, (n, s, cs) => {
        const seats = Array.from({ length: n }, (_, i) => ({
          playerId: `p${i}`,
          stack: 200,
        }));
        const first = playHand(seats, s, cs, () => {});
        const second = playHand(seats, s, cs, () => {});
        expect(second.events).toEqual(first.events);
        expect(second.state).toEqual(first.state);
      }),
      { numRuns: 50 },
    );
  });
});
