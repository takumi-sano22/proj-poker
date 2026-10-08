// hand-summary の Property と固定 Scenario が共有する検査（#78・#167。INV-TEST-007 / 008 に相当）。build 対象外（src/testing）。
import { expect } from "vitest";
import { cardToString } from "../card.js";
import type { HandEvent } from "../hand-events.js";
import {
  extractImportantSpots,
  heroInformationSets,
  projectHandSummary,
} from "../hand-summary.js";
import { foldHandEvents } from "../hand-state.js";
import { projectLearningReveal } from "../learning-reveal.js";
import { projectKnowledgeState } from "../projection.js";
import {
  collectCards,
  hiddenMarkers,
  leakedCards,
  tamperHiddenEvents,
} from "./view-leaks.js";

const cardsIn = (value: unknown) => collectCards(value).map(cardToString);

/** checkHand が通した Hand の種類（網羅の記録）。値は下の COVERAGE_KINDS。 */
export type CoverageKind =
  "aborted" | "system" | "ruling" | "oot" | "river" | "spot";

/** 検査が空振りしていないことの確認の対象（裁定の入った判断・Out-of-Turn の拘束・River の判断・打ち切り・system の記録・Important Spot）。 */
export const COVERAGE_KINDS: readonly CoverageKind[] = [
  "aborted",
  "oot",
  "river",
  "ruling",
  "spot",
  "system",
];

/**
 * 1 つの Hand の Event Log について、Hero の Information Set・Hand Summary・Learning-only Full Reveal の不変条件を検査する。
 * Property（hand-summary.property.test.ts。任意の入力で崩れない）と固定 Scenario（hand-summary.test.ts。各種類の Hand を
 * 確実に通す）が同じ検査を共有する。`seen` には通した Hand の種類を足す（呼び出し側が網羅を確認する）。
 */
export function checkHand(
  events: readonly HandEvent[],
  hero: string,
  seen: Set<CoverageKind> = new Set(),
) {
  const HERO = hero;
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
