// Review Evidence（Pass A の入力）のテスト。Hindsight Leak が無いこと（不変条件 3）・Hidden Information が入らないこと（不変条件 2）・
// 渡す Evidence が判断時点の Information Set から決定論で作られることを確かめる。Claude・実 Solver は呼ばない。
import {
  analyzeDecision,
  cardToString,
  createDeck,
  extractImportantSpots,
  heroInformationSets,
  isVisibleTo,
  type HandEvent,
  type HeroInformationSet,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import { getKbEntry, loadKb } from "../kb/index.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { RuleBot } from "../opponents/rule-bot.js";
import { PERSONA_PRESETS, PERSONA_PRESET_IDS } from "../opponents/persona.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  allowedCardsAt,
  forbiddenKeys,
  leakedCards,
} from "../testing/leaks.js";
import {
  BTN_VS_UTG,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
} from "../testing/review-eval/hands.js";
import { buildReviewEvidence, evidenceIdsOf, kbSpotOf } from "./evidence.js";
import { buildReviewPrompt } from "./review-ai.js";
import type { ReviewEvidence } from "./types.js";

const HERO = "hero";
const kb = loadKb();
const notInstalled = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});
/** CPU の不正な出力に入れる値。system の記録（AI_ACTION_INVALID）にだけ残り、Evidence に出てはいけない。 */
const INVALID_ACTION = "teleport";

/** 判断を求められるたび 3 回に 1 回、不正な出力を返す CPU（system の Event を Log に残すため）。 */
const sometimesInvalid: OpponentFactory = (seed, _playerId, persona) => {
  const bot = new RuleBot(seed, persona);
  let calls = 0;
  return {
    decide: (input) => {
      if (calls++ % 3 === 0) return Promise.resolve({ action: INVALID_ACTION });
      const action = bot.choose(input);
      return Promise.resolve(
        "amount" in action
          ? { action: action.type, amount: action.amount }
          : { action: action.type },
      );
    },
  };
};

/** RuleBot の卓で、Hero は Call / Check だけで Hand を最後まで進めた Event Log。 */
async function playHand(seed: number): Promise<HandEvent[]> {
  const store = new InMemoryEventStore();
  const handId = `hand-${seed}`;
  const orchestrator = new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    createOpponent: sometimesInvalid,
    botDelayMs: 0,
    opponentTimeoutMs: 1000,
    nextSeed: () => seed,
    nextHandId: () => handId,
  });
  const started = await orchestrator.startHand(null);
  if (!started.ok) throw new Error(started.error.message);
  let view: HeroView = started.value.view;
  while (view.status !== "complete") {
    const types = view.legalActions?.actions.map((a) => a.type) ?? [];
    const action: PlayerAction = types.includes("call")
      ? { type: "call" }
      : { type: "check" };
    const result = await orchestrator.heroAction(
      handId,
      view.log.at(-1)?.seq ?? -1,
      action,
    );
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  orchestrator.close();
  return store.read(handId).map((s) => s.event);
}

async function evidenceFor(
  events: readonly HandEvent[],
  index: number,
): Promise<ReviewEvidence> {
  const sets = heroInformationSets(events, HERO);
  const set = sets[index] as HeroInformationSet;
  const reasons =
    extractImportantSpots(sets).find((s) => s.decisionIndex === index)
      ?.reasons ?? [];
  return buildReviewEvidence(set, reasons, { kb, solver: notInstalled });
}

/** Hero に見えない Event の中身（他者の札・Deck・system の記録）を差し替える。Evidence に届く経路が無ければ結果は変わらない。 */
function tamperHidden(events: readonly HandEvent[]): HandEvent[] {
  const reversed = createDeck().reverse();
  return events.map((e) => {
    if (isVisibleTo(e, HERO)) return e;
    switch (e.type) {
      case "HOLE_CARD_DEALT":
        return { ...e, cards: reversed.slice(0, 2) };
      case "DECK_SHUFFLED":
        return { ...e, seed: 999, deck: reversed };
      case "AI_ACTION_INVALID":
        return { ...e, reason: "差し替えた理由" };
      default:
        return e;
    }
  });
}

/** KB の本文（静的な Curated KB。Hidden Information ではない）を除いた Evidence。語の検査に使う。 */
function withoutKbBodies(evidence: ReviewEvidence): ReviewEvidence {
  return {
    ...evidence,
    knowledge: {
      ...evidence.knowledge,
      items: evidence.knowledge.items.map((i) => ({ ...i, body: "" })),
    },
  };
}

describe("buildReviewEvidence: Hindsight Leak と Hidden Information（不変条件 2・3）", () => {
  it("多数の Hand の全判断で、Evidence と Prompt に判断時点の Hero が知り得ない札・system の記録・Persona が入らない", async () => {
    let decisions = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const events = await playHand(seed);
      expect(events.some((e) => e.type === "AI_ACTION_INVALID")).toBe(true);
      const sets = heroInformationSets(events, HERO);
      for (const set of sets) {
        decisions++;
        const evidence = await evidenceFor(events, set.decision.index);
        const upto = set.decision.decisionPointSeq;
        // Card: 判断時点の Hero の札・公開 Board 以外が無い（Showdown・後の Board・他者の札を含まない）。
        expect(leakedCards(evidence, events, HERO, upto)).toEqual([]);
        // Prompt は Card を "As" の表記にするので、表記でも確かめる。
        const prompt = buildReviewPrompt(evidence);
        const allowed = allowedCardsAt(events, HERO, upto);
        const inPrompt = createDeck()
          .map(cardToString)
          .filter((c) => prompt.includes(`"${c}"`));
        expect(inPrompt.filter((c) => !allowed.has(c))).toEqual([]);
        // Deck・seed・engine / system の記録・CPU の出力の値・Persona を指す語が無い（KB の本文は静的な Curated KB なので除いて見る）。
        expect(forbiddenKeys(withoutKbBodies(evidence))).toEqual([]);
        expect(prompt).not.toContain(INVALID_ACTION);
        for (const id of PERSONA_PRESET_IDS) {
          expect(prompt).not.toContain(`"${id}"`);
        }
        for (const p of Object.values(PERSONA_PRESETS)) {
          expect(JSON.stringify(withoutKbBodies(evidence))).not.toContain(
            p.label,
          );
        }
        // KB の本文は KB の項目そのもの（Hand の情報から作った文ではない）。
        for (const item of evidence.knowledge.items) {
          expect(item.body).toBe(getKbEntry(kb, item.kbId)?.body);
        }
      }
    }
    expect(decisions).toBeGreaterThan(20);
  });

  it("判断より後の Event を切り落としても、見えない Event の中身を差し替えても、Evidence は変わらない", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const events = await playHand(seed);
      const tampered = tamperHidden(events);
      for (const set of heroInformationSets(events, HERO)) {
        const index = set.decision.index;
        const evidence = await evidenceFor(events, index);
        const truncated = events.filter((e) => e.seq <= set.decision.actionSeq);
        expect(await evidenceFor(truncated, index)).toEqual(evidence);
        expect(await evidenceFor(tampered, index)).toEqual(evidence);
      }
    }
  });

  it("Showdown で負けた River の Call でも、相手の実際の札（Showdown で公開）は Evidence に入らない", async () => {
    const events = playScriptedHand(BTN_VS_UTG);
    expect(events.some((e) => e.type === "CARDS_TABLED")).toBe(true);
    const evidence = await evidenceFor(events, 3);
    const prompt = buildReviewPrompt(evidence);
    expect(prompt).not.toContain('"Ks"');
    expect(prompt).not.toContain('"Qs"');
    expect(evidence.context.board.map(cardToString)).toEqual([
      "Jc",
      "8s",
      "3d",
      "2h",
      "Kc",
    ]);
  });
});

describe("buildReviewEvidence: 中身", () => {
  it("Math は Engine の analyzeDecision と同じ値（Monte Carlo の seed は入れない）。ID は Hand と判断から決まる", async () => {
    const events = playScriptedHand(BTN_VS_UTG);
    const set = heroInformationSets(events, HERO)[3] as HeroInformationSet;
    const evidence = await evidenceFor(events, 3);
    const analysis = analyzeDecision(set);
    expect(evidence.math).toMatchObject({
      id: "math:review-btn_vs_utg/d3",
      pot: analysis.pot,
      callAmount: analysis.callAmount,
      potOdds: analysis.potOdds,
      alternatives: analysis.alternatives,
      assumptions: analysis.assumptions,
    });
    expect(evidence.math.equity?.equity).toBe(analysis.equity?.equity);
    expect(evidence.math.equity).not.toHaveProperty("seed");
    expect(evidence.range.villains).toEqual(analysis.ranges);
    // River の大きい Bet は Important Spot なので、Range の想定ごとの比較（D08）がある。
    expect(evidence.context.importantSpotReasons).toEqual([
      "big_pot",
      "river_big_bet",
    ]);
    expect(evidence.range.comparisons?.map((c) => c.profileId)).toEqual([
      "standard",
      "tight",
      "loose",
    ]);
    expect(evidence.context.decision).toEqual({
      action: "call",
      amount: 24,
      toAmount: 24,
      allIn: false,
    });
    expect(evidence.opponentObservation.status).toBe("unavailable");
    expect(evidence.userRead.status).toBe("not_collected");
  });

  it("Important Spot でない判断は Range の比較を持たない", async () => {
    const evidence = await evidenceFor(playScriptedHand(BTN_VS_UTG), 0);
    expect(evidence.context.importantSpotReasons).toEqual([]);
    expect(evidence.range.comparisons).toBeNull();
  });

  it("Knowledge は KB の Version 付きの evidenceId を持ち、Evidence IDs に分類して残る", async () => {
    const evidence = await evidenceFor(playScriptedHand(BTN_VS_UTG), 3);
    expect(evidence.knowledge.kbVersion).toBe(kb.version);
    expect(evidence.knowledge.items.length).toBeGreaterThan(0);
    for (const item of evidence.knowledge.items) {
      expect(item.id).toMatch(
        new RegExp(`^kb:${kb.version}:${item.kbId}@\\d+$`),
      );
    }
    const ids = evidenceIdsOf(evidence, ["math:review-btn_vs_utg/d3"]);
    expect(ids).toEqual({
      context: ["ctx:review-btn_vs_utg/d3"],
      math: ["math:review-btn_vs_utg/d3"],
      range: [
        "range:review-btn_vs_utg/d3",
        "range:review-btn_vs_utg/d3/standard",
        "range:review-btn_vs_utg/d3/tight",
        "range:review-btn_vs_utg/d3/loose",
      ],
      solver: [],
      knowledge: evidence.knowledge.items.map((i) => i.id),
      userRead: [],
      cited: ["math:review-btn_vs_utg/d3"],
    });
  });

  it("Solver: Preflop は対象外、Multiway は player_count、未導入は solver_not_installed（導入先のパスを渡さない）", async () => {
    const preflop = await evidenceFor(playScriptedHand(BTN_VS_UTG), 0);
    expect(preflop.solver).toMatchObject({
      status: "not_applicable",
      reason: "preflop",
    });
    const multiway = await evidenceFor(playScriptedHand(MULTIWAY_FLOP), 1);
    expect(multiway.solver).toMatchObject({
      status: "unsupported",
      reason: "player_count",
    });
    const turn = await evidenceFor(playScriptedHand(SB_VS_BTN), 2);
    expect(turn.solver).toEqual({
      status: "unsupported",
      reason: "solver_not_installed",
      detail: "Solver が導入されていない",
    });
  });
});

describe("kbSpotOf: KB の検索に使う Spot の特徴（判断時点の情報だけ）", () => {
  const knowledgeAt = (events: readonly HandEvent[], index: number) =>
    (heroInformationSets(events, HERO)[index] as HeroInformationSet).knowledge;

  it("Preflop の Open への Call は preflop_facing_raise、後ろに Blind が残るので multiway", () => {
    expect(kbSpotOf(knowledgeAt(playScriptedHand(BTN_VS_UTG), 0))).toEqual({
      street: "preflop",
      position: "BTN",
      players: "multiway",
      spotKind: "preflop_facing_raise",
      actions: ["not_acted", "open"],
    });
  });

  it("Postflop: Bet に直面は postflop_facing_bet、Preflop の Raiser でない Hero が先に動くのは postflop_checked_to", () => {
    const btn = playScriptedHand(BTN_VS_UTG);
    expect(kbSpotOf(knowledgeAt(btn, 3))).toMatchObject({
      street: "river",
      players: "heads_up",
      spotKind: "postflop_facing_bet",
      actions: ["open"],
    });
    const sb = playScriptedHand(SB_VS_BTN);
    expect(kbSpotOf(knowledgeAt(sb, 2))).toMatchObject({
      street: "turn",
      position: "SB",
      spotKind: "postflop_checked_to",
    });
  });
});
