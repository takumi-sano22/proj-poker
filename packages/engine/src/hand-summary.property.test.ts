// 判断時点の Hero Information Set・Hand Summary・Learning-only Full Reveal の Property テスト
// （#78・docs/05 §7 Pass A・INV-TEST-007 / 008 に相当・poker-engine-testing §5）。
// Hero（p0）は Canonical Action と物理的な操作（Out-of-Turn を含む）を混ぜ、CPU の手番には system の記録（不正な出力・
// Fallback・Emergency Bot）を時々置き、時々 Hand を打ち切る（HAND_ABORTED。D95）。その Event Log の全判断について、
// Information Set に未来の Card・他者の Hidden Cards・system / engine の Event・Learning-only Reveal が入らないことを確かめる。
// fast-check の seed は実行ごとに変わる（POKER_PROPERTY_SEED で固定。testing/property.ts）。失敗時は fast-check が seed と縮小済みの反例を出すので、Scenario へ昇格させる。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cardToString } from "./card.js";
import type { HandEvent, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  recordAiEvent,
  recordSessionEvent,
  resolvePendingOutOfTurn,
  startHand,
  type HandProgress,
} from "./hand-engine.js";
import {
  extractImportantSpots,
  heroInformationSets,
  projectHandSummary,
} from "./hand-summary.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { projectLearningReveal } from "./learning-reveal.js";
import {
  getLegalActions,
  type LegalAction,
  type PlayerAction,
} from "./legal-actions.js";
import { projectKnowledgeState } from "./projection.js";
import type { PhysicalAction } from "./ruling.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  collectCards,
  hiddenMarkers,
  leakedCards,
  tamperHiddenEvents,
  testMetadata,
} from "./testing/view-leaks.js";
import { propertyParams } from "./testing/property.js";

const MAX_STEPS = 500;
const HERO = "p0";
const VALUES = PHASE1_CASH_PRESET.chipDenominations.map((d) => d.value);

/** Hero の 1 回の操作（宣言だけ、または Chip を 1〜2 回。出す額は Stack 以下）。 */
function physicalFrom(next: () => number, stack: number): PhysicalAction[] {
  const kinds = ["fold", "check", "call", "all_in", "bet", "raise"] as const;
  if (next() % 2 === 0) {
    const kind = kinds[next() % kinds.length] as (typeof kinds)[number];
    return [{ type: "declare", declaration: { kind } }];
  }
  const actions: PhysicalAction[] = [];
  let rest = stack;
  for (let m = 0; m < 1 + (next() % 2); m++) {
    const value = VALUES[next() % VALUES.length] as number;
    if (value > rest) break;
    rest -= value;
    actions.push({
      type: actions.length === 0 ? "chip_push" : "chip_add",
      chips: [value],
    });
  }
  return actions.length > 0
    ? actions
    : [{ type: "declare", declaration: { kind: "call" } }];
}

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

/** Hand を最後まで（または打ち切りまで）進めた Event Log を返す。 */
function playHand(
  seats: readonly SeatInit[],
  seed: number,
  choices: readonly number[],
): HandEvent[] {
  const started = startHand({
    handId: "summary-prop",
    seats,
    buttonPlayerId: (seats[seed % seats.length] as SeatInit).playerId,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
    // system Visibility の Metadata（#97）も混ぜ、View・KnowledgeState・Hero Information Set に届かないことを一緒に確かめる。
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
  take(recordSessionEvent(state, { type: "SESSION_STARTED", sessionId: "s" }));
  // 打ち切る手番（-1 なら打ち切らない）。
  const abortAt = next() % 3 === 0 ? next() % 12 : -1;

  for (let step = 0; state.status === "in_progress"; step++) {
    if (step >= MAX_STEPS) throw new Error("Hand が終わらない");
    if (step === abortAt) {
      take(
        recordSessionEvent(state, {
          type: "HAND_ABORTED",
          reason: "ai_outage",
        }),
      );
      take(
        recordSessionEvent(state, {
          type: "SESSION_ENDED",
          sessionId: "s",
          reason: "ai_outage",
        }),
      );
      break;
    }
    const legal = getLegalActions(state);
    if (legal === null) throw new Error("進行中なのに Actor がいない");
    const hero = state.players.find((p) => p.playerId === HERO);
    const heroCanAct = hero !== undefined && !hero.folded && !hero.allIn;

    // 手番でない Hero が時々操作する（Out-of-Turn で保留）。
    if (
      legal.playerId !== HERO &&
      heroCanAct &&
      state.pendingOutOfTurn === null &&
      next() % 5 === 0
    ) {
      const r = applyPhysicalActions(
        state,
        HERO,
        physicalFrom(next, hero.stack),
        PHASE1_CASH_PRESET,
      );
      if (!r.ok) throw new Error(r.error.message);
      take(r.value);
    }

    if (legal.playerId === HERO && hero !== undefined) {
      if (state.pendingOutOfTurn !== null) {
        const r = resolvePendingOutOfTurn(state, PHASE1_CASH_PRESET);
        if (!r.ok) throw new Error(r.error.message);
        take(r.value);
        if (r.value.ruling.kind === "action") continue;
      } else if (next() % 2 === 0) {
        const r = applyPhysicalActions(
          state,
          HERO,
          physicalFrom(next, hero.stack),
          PHASE1_CASH_PRESET,
        );
        if (!r.ok) throw new Error(r.error.message);
        take(r.value);
        if (r.value.ruling.kind === "action") continue;
      }
    } else {
      // CPU の手番の system の記録（CPU の出力の値を含む）。
      switch (next() % 4) {
        case 0:
          take(
            recordAiEvent(state, {
              type: "AI_ACTION_INVALID",
              playerId: legal.playerId,
              attempt: 1,
              stage: "schema",
              reason: "teleport",
            }),
          );
          break;
        case 1:
          take(
            recordSessionEvent(state, {
              type: "EMERGENCY_BOT_ENGAGED",
              playerId: legal.playerId,
              cause: "timeout",
            }),
          );
          take(
            recordAiEvent(state, {
              type: "AI_FALLBACK_USED",
              playerId: legal.playerId,
              fallbackKind: "emergency_bot",
              reason: "teleport",
            }),
          );
          break;
        default:
          break;
      }
    }
    const r = applyAction(
      state,
      legal.playerId,
      canonicalFrom(
        legal.actions[next() % legal.actions.length] as LegalAction,
        next(),
      ),
    );
    if (!r.ok) throw new Error(r.error.message);
    take(r.value);
  }
  return events;
}

const cardsIn = (value: unknown) => collectCards(value).map(cardToString);

/** 検査が空振りしていないことの記録（裁定の入った判断・Out-of-Turn の拘束・打ち切り・Important Spot を通ったか）。 */
const seen = new Set<string>();

function checkHand(events: readonly HandEvent[]) {
  const sets = heroInformationSets(events, HERO);
  if (events.some((e) => e.type === "HAND_ABORTED")) seen.add("aborted");
  if (events.some((e) => e.type === "EMERGENCY_BOT_ENGAGED"))
    seen.add("system");
  for (const s of sets) {
    if (s.decision.rulingNotes.length > 0) seen.add("ruling");
    if (s.decision.rulingNotes.includes("out_of_turn_binding")) seen.add("oot");
    if (s.knowledge.street === "river") seen.add("river");
  }
  const heroActions = events.filter(
    (e) => e.type === "ACTION_TAKEN" && e.playerId === HERO,
  );
  expect(sets.map((s) => s.decision.actionSeq)).toEqual(
    heroActions.map((e) => e.seq),
  );

  for (const set of sets) {
    const { decision } = set;
    // 判断時点までの、Hero に見える Event だけ（system・engine・他者宛ての private が無い）。
    expect(set.events.every((e) => e.seq <= decision.decisionPointSeq)).toBe(
      true,
    );
    expect(
      set.events.every(
        (e) =>
          e.visibility.type === "public" ||
          (e.visibility.type === "private" && e.visibility.playerId === HERO),
      ),
    ).toBe(true);
    // 判断時点の卓: Hero が手番で、Legal Action がある。
    expect(set.knowledge.actorId).toBe(HERO);
    expect(set.knowledge.legalActions?.playerId).toBe(HERO);
    // 判断時点の全情報の State と比べて、Hero が知り得ない Card（他者の札・未来の Card）が無い。
    const truth = foldHandEvents(
      events.filter((e) => e.seq <= decision.decisionPointSeq),
    );
    expect(leakedCards(set, truth, HERO)).toEqual([]);
    expect(hiddenMarkers(set)).toEqual([]);
    expect(JSON.stringify(set)).not.toContain("teleport");
    // 判断より後の Event を切り落としても同じ（未来を読まない）。
    const truncated = heroInformationSets(
      events.filter((e) => e.seq <= decision.actionSeq),
      HERO,
    );
    expect(truncated[decision.index]).toEqual(set);
  }
  // 見えない Event の中身を差し替えても同じ（中身が届く経路が無い）。
  expect(heroInformationSets(tamperHiddenEvents(events, HERO), HERO)).toEqual(
    sets,
  );

  // Important Spot は判断の部分列で、同じ入力から同じ結果になる。
  const spots = extractImportantSpots(sets);
  if (spots.length > 0) seen.add("spot");
  expect(extractImportantSpots(heroInformationSets(events, HERO))).toEqual(
    spots,
  );
  for (const spot of spots) {
    expect(spot.reasons.length).toBeGreaterThan(0);
    expect(sets[spot.decisionIndex]?.decision.decisionPointSeq).toBe(
      spot.decisionPointSeq,
    );
  }

  // Hand Summary: Hero に見える情報だけで、終わった Hand の Chip は保存される。
  const summary = projectHandSummary(events, HERO);
  const final = foldHandEvents(events);
  expect(leakedCards(summary, final, HERO)).toEqual([]);
  expect(hiddenMarkers(summary)).toEqual([]);
  expect(summary.importantSpots).toEqual(spots);
  const aborted = events.some((e) => e.type === "HAND_ABORTED");
  expect(summary.outcome).toBe(aborted ? "aborted" : "complete");
  if (summary.finalStacks !== null) {
    const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(summary.finalStacks.map((s) => s.amount))).toBe(
      sum(summary.seats.map((s) => s.stack)),
    );
    expect(summary.totalPot).toBe(
      sum(summary.pots.flatMap((p) => p.awards.map((a) => a.amount))),
    );
  }

  // Learning-only Full Reveal: Hand の後だけ出し、そこでだけ見える札（公開されなかった他者の札）は
  // Pass A の入力・Summary・どの CPU の KnowledgeState（全 prefix）にも入らない（INV-TEST-008 に相当）。
  const reveal = projectLearningReveal(events);
  expect(reveal).not.toBeNull();
  const shown = new Set(
    final.players
      .filter((p) => p.shown)
      .flatMap((p) => p.holeCards ?? [])
      .map(cardToString),
  );
  for (const { playerId, cards } of reveal?.holeCards ?? []) {
    const revealOnly = cards.map(cardToString).filter((c) => !shown.has(c));
    if (playerId !== HERO) {
      for (const value of [sets, summary]) {
        for (const c of revealOnly) expect(cardsIn(value)).not.toContain(c);
      }
    }
    for (let n = 1; n <= events.length; n++) {
      for (const p of final.players) {
        if (p.playerId === HERO || p.playerId === playerId) continue;
        const knowledge = projectKnowledgeState(events.slice(0, n), p.playerId);
        for (const c of revealOnly) expect(cardsIn(knowledge)).not.toContain(c);
        expect(hiddenMarkers(knowledge)).toEqual([]);
      }
    }
  }
}

describe("判断時点の Hero Information Set・Hand Summary（Property）", () => {
  it("どの判断の Information Set にも、未来の Card・他者の Hidden Cards・system の Event・Learning-only Reveal が入らない", () => {
    const params = propertyParams(150);
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.integer({ min: 20, max: 2000 }), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }),
        (n, stacks, seed, choices) => {
          const seats = stacks
            .slice(0, n)
            .map((stack, i) => ({ playerId: `p${i}`, stack }));
          checkHand(playHand(seats, seed, choices));
        },
      ),
      params,
    );
    // 網羅の確認が落ちたときも、seed から同じ入力で再現できるようメッセージへ入れる（#95）。
    expect([...seen].sort(), `網羅の確認（seed=${params.seed}）`).toEqual([
      "aborted",
      "oot",
      "river",
      "ruling",
      "spot",
      "system",
    ]);
  });
});
