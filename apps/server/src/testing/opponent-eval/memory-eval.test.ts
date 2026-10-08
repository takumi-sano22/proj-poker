// Opponent Memory の Eval（#142・docs/09 §5）。RuleBot の決定論だけで回し、Claude も API キーも使わない（CI の pnpm test で回る）。
// (1) Memory が戦略に効く代表 Spot / (2) Fixed Pool の継続性 / (3) Guest の一時性 / (4) Action Diversity・Strategic coherence /
// (5) Latency（値は作業ログに残し、CI では大きさを判定しない）/ (6) Leakage 0 / 時計が後ろへ戻った記録でも結果が変わらない（D117）。
import {
  MAX_PLAYERS,
  projectKnowledgeState,
  type ActionType,
} from "@proj-poker/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../../config.js";
import { deriveSeed } from "../../hand-orchestrator.js";
import { participantKey, participantRefOf } from "../../memory/observation.js";
import { composeSessionParticipants } from "../../opponents/cpu-pool.js";
import { PERSONA_PRESET_IDS } from "../../opponents/persona.js";
import { composeTuning } from "../../opponents/rule-bot.js";
import { forbiddenKeys, leakedCards } from "../leaks.js";
import {
  LAYER_CONDITIONS,
  MEMORY_EVAL_TARGETS,
  rateOf,
  runRuleBotSessions,
  spotDistribution,
  summarizeLayerCondition,
  type CpuDecisionRecord,
  type LayerCondition,
  type SessionRunResult,
} from "./memory-eval.js";

const condition = (id: string): LayerCondition => {
  const c = LAYER_CONDITIONS.find((x) => x.id === id);
  if (c === undefined) throw new Error(`条件が無い: ${id}`);
  return c;
};

/** 3 つの条件（Memory なし・Loose・Tight）で、Spot の判断の types の割合を Persona ごとに出す。 */
function ratesBySubject(spotId: string, types: readonly ActionType[]) {
  return PERSONA_PRESET_IDS.map((personaId) => {
    const of = (id: string) =>
      rateOf(spotDistribution(spotId, personaId, condition(id)).counts, types);
    return {
      personaId,
      none: of("none"),
      loose: of("memory_loose"),
      tight: of("memory_tight"),
      insufficient: of("memory_insufficient"),
    };
  });
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

describe("Opponent Memory の Eval: 代表 Spot（RuleBot。#142）", () => {
  it("(1) River の大きい Bet: 攻める（Loose）相手と分かっていれば Call を広げ、攻めない（Tight）相手なら狭める。保留の Memory では変えない", () => {
    const rates = ratesBySubject("river_facing_big_bet", ["call"]);
    for (const r of rates) {
      expect(r.loose, r.personaId).toBeGreaterThanOrEqual(r.none);
      expect(r.tight, r.personaId).toBeLessThanOrEqual(r.none);
      expect(r.insufficient, r.personaId).toBe(r.none);
    }
    // 全 Persona を合わせると、Memory の有無で分布が向きどおりに動いている（同じ seed なので差は Memory だけ）。
    expect(sum(rates.map((r) => r.loose))).toBeGreaterThan(
      sum(rates.map((r) => r.none)),
    );
    expect(sum(rates.map((r) => r.tight))).toBeLessThan(
      sum(rates.map((r) => r.none)),
    );
  });

  it("(1) Flop の C-bet（Bluff）: C-bet によく降りる（Tight）相手には増やし、降りない（Loose）相手には減らす", () => {
    const rates = ratesBySubject("flop_cbet", ["bet"]);
    for (const r of rates) {
      expect(r.tight, r.personaId).toBeGreaterThanOrEqual(r.none);
      expect(r.loose, r.personaId).toBeLessThanOrEqual(r.none);
      expect(r.insufficient, r.personaId).toBe(r.none);
    }
    expect(sum(rates.map((r) => r.tight))).toBeGreaterThan(
      sum(rates.map((r) => r.none)),
    );
    expect(sum(rates.map((r) => r.loose))).toBeLessThan(
      sum(rates.map((r) => r.none)),
    );
  });

  it("(4) 層を足しても Persona の分布が潰れず（Action Diversity・Persona Differentiation）、Illegal・Check できるのに Fold が 0 で、攻撃性の順序が保たれる", () => {
    const t = MEMORY_EVAL_TARGETS;
    const base = summarizeLayerCondition(condition("none"));
    for (const c of LAYER_CONDITIONS) {
      const s = c.id === "none" ? base : summarizeLayerCondition(c, undefined);
      expect(s.illegal, c.id).toBe(0);
      expect(s.foldWhenCheck, c.id).toBe(0);
      expect(s.personaDifferentiation, c.id).toBeGreaterThanOrEqual(
        base.personaDifferentiation * t.minDifferentiationRatio,
      );
      for (const personaId of PERSONA_PRESET_IDS) {
        expect(
          s.actionDiversity[personaId],
          `${c.id} ${personaId}`,
        ).toBeGreaterThanOrEqual(
          (base.actionDiversity[personaId] ?? 0) * t.minDiversityRatio,
        );
      }
      for (const [more, less] of t.aggressionOrder) {
        expect(
          s.aggressionRate[more],
          `${c.id}: ${more} > ${less}`,
        ).toBeGreaterThan(s.aggressionRate[less] ?? 1);
      }
    }
  });
});

/** 既定の卓の CPU の席（Session の編成の入力。Orchestrator と同じ）。 */
const CPU_SEATS = PHASE1_TABLE_SETUP.players
  .filter((p) => p.kind === "cpu")
  .map((p) => ({
    playerId: p.playerId,
    persona: PHASE1_TABLE_SETUP.personas[p.playerId],
  }));

/** その Hand の seed で新しい Session を始めたとき、Guest が座る席（座らなければ null）。 */
function guestSeatAt(handSeed: number): string | null {
  const { participants } = composeSessionParticipants({
    sessionId: "probe",
    seats: CPU_SEATS,
    seed: deriveSeed(handSeed, MAX_PLAYERS),
  });
  return participants.find((p) => p.kind === "guest")?.playerId ?? null;
}

/** Session 1 の Hand の数。Session 2 の最初の Hand は、区切りの（打ち切る）Hand の次。 */
const SESSION1_HANDS = 60;
const SESSION2_HANDS = 20;
const SESSION2_FIRST_HAND = SESSION1_HANDS + 2;

/**
 * 2 つの Session の両方で、同じ席に Guest が座る seed の列（Guest の一時性の検査を空振りさせない。同じ席なら playerId も同じで、
 * 前の Guest の Memory が席で引き継がれていないかを確かめられる）。
 */
function seedsWithGuests(): (handNo: number) => number {
  for (let base = 1; base < 1000; base++) {
    const first = guestSeatAt(base * 1000 + 1);
    if (
      first !== null &&
      first === guestSeatAt(base * 1000 + SESSION2_FIRST_HAND)
    ) {
      return (handNo) => base * 1000 + handNo;
    }
  }
  throw new Error("両方の Session で同じ席に Guest が座る seed が無い");
}

/** Evidence ID（`<hand_id>#<seq>`）の Hand。 */
const handOfEvidence = (id: string) => id.slice(0, id.lastIndexOf("#"));

describe("Opponent Memory の Eval: Session を跨ぐ（本番の Hand Orchestrator・RuleBot。#142）", () => {
  let run: SessionRunResult;
  let session1: string;
  let session2: string;
  beforeAll(async () => {
    run = await runRuleBotSessions({
      handsPerSession: [SESSION1_HANDS, SESSION2_HANDS],
      seedOfHand: seedsWithGuests(),
    });
    [session1 = "", session2 = ""] = run.sessions;
  }, 60_000);

  const decisionsIn = (sessionId: string) =>
    run.decisions.filter((d) => d.sessionId === sessionId);
  const handOf = (handId: string) => {
    const h = run.hands.find((x) => x.handId === handId);
    if (h === undefined) throw new Error(`層の記録が無い: ${handId}`);
    return h;
  };
  /** その判断の CPU が最初に判断した Session 2 の判断。 */
  const firstIn = (sessionId: string, d: (r: CpuDecisionRecord) => boolean) =>
    decisionsIn(sessionId).find(d);

  it("2 つの Session を区切りどおりに進め、層の値は本番の Orchestrator が CPU に渡した値と同じ（ハーネスと本番の組み立ての一致）", () => {
    expect(run.sessions).toHaveLength(2);
    expect(
      run.store
        .finishedHandIds()
        .filter((h) => run.store.sessionIdOfHand(h) === session1).length,
    ).toBe(SESSION1_HANDS + 1);
    expect(run.decisions.length).toBeGreaterThan(0);
    for (const d of run.decisions) {
      const { layers } = handOf(d.handId);
      const k = d.input.knowledge;
      const at = `${d.handId} ${d.playerId}`;
      expect(k.memory, at).toEqual(layers.memories.get(d.playerId));
      expect(k.tilt, at).toEqual(layers.tilts.get(d.playerId));
      expect(k.tableTendency, at).toEqual(
        layers.tableTendencies.get(d.playerId),
      );
    }
    // 検査が空振りしていない: 3 つの層がどれも入った判断がある。
    expect(
      run.decisions.some((d) => d.input.knowledge.tilt !== undefined),
    ).toBe(true);
    expect(
      run.decisions.some((d) => d.input.knowledge.tableTendency !== undefined),
    ).toBe(true);
  });

  it("(2) Fixed Pool の継続性: 両方の Session に座った Fixed CPU は、Session 2 の最初の判断から Session 1 の観察を Memory に持ち、戦略に使う", () => {
    const fixedIn = (sessionId: string) =>
      run.store
        .sessionParticipants(sessionId)
        .flatMap((p) => (p.kind === "fixed" ? [p.cpuProfileId] : []));
    const carried = fixedIn(session2).filter((id) =>
      fixedIn(session1).includes(id),
    );
    expect(carried.length).toBeGreaterThan(0);
    for (const cpuProfileId of carried) {
      const first = firstIn(
        session2,
        (d) =>
          d.participant?.kind === "fixed" &&
          d.participant.cpuProfileId === cpuProfileId,
      );
      const memory = first?.input.knowledge.memory;
      expect(memory, cpuProfileId).toBeDefined();
      const evidenceHands = (memory?.subjects ?? []).flatMap((s) =>
        s.items.flatMap((i) => i.evidenceIds.map(handOfEvidence)),
      );
      expect(evidenceHands.length, cpuProfileId).toBeGreaterThan(0);
      expect(
        evidenceHands.every((h) => run.store.sessionIdOfHand(h) === session1),
        cpuProfileId,
      ).toBe(true);
      // Hero は Session 1 の全 Hand に座っていたので、その Fixed CPU は Hero を見た Hand を持ち越している。
      const hero = memory?.subjects.find((s) => s.subject.kind === "hero");
      expect(hero?.handsObserved ?? 0, cpuProfileId).toBeGreaterThan(0);
    }
    // 使う: Session 2 で、持ち越した Fixed CPU の判断のしきい値が Memory の有無で変わる判断がある。
    const used = decisionsIn(session2).filter(
      (d) =>
        d.participant?.kind === "fixed" &&
        carried.includes(d.participant.cpuProfileId) &&
        JSON.stringify(composeTuning(d.persona, d.input.knowledge)) !==
          JSON.stringify(
            composeTuning(d.persona, {
              ...d.input.knowledge,
              memory: undefined,
            }),
          ),
    );
    expect(used.length).toBeGreaterThan(0);
  });

  it("(3) Guest の一時性: Session 1 の Guest は Session の中で Memory を積むが、次の Session では誰の Memory にも出ず、同じ席の新しい Guest の Memory は空から始まる", () => {
    const guestOf = (sessionId: string) =>
      run.store.sessionParticipants(sessionId).find((p) => p.kind === "guest");
    const guest1 = guestOf(session1);
    const guest2 = guestOf(session2);
    if (guest1?.kind !== "guest" || guest2?.kind !== "guest") {
      throw new Error("両方の Session に Guest が座っていない");
    }
    expect(guest2.playerId).toBe(guest1.playerId);
    expect(guest2.guestId).not.toBe(guest1.guestId);
    // Session 1 の中では、Guest も観察を積む。
    expect(
      decisionsIn(session1).some(
        (d) =>
          d.playerId === guest1.playerId &&
          (d.input.knowledge.memory?.subjects ?? []).some(
            (s) => s.handsObserved > 0,
          ),
      ),
    ).toBe(true);
    // Session 2 の同じ席の新しい Guest は、最初の判断で誰についても観察を持たない。
    const first = firstIn(session2, (d) => d.playerId === guest2.playerId);
    expect(first).toBeDefined();
    for (const s of first?.input.knowledge.memory?.subjects ?? []) {
      expect(s.handsObserved, participantKey(s.subject)).toBe(0);
      expect(s.items).toEqual([]);
    }
    // Session 2 の誰の Memory にも、Session 1 の Guest は Subject として出ない。
    const gone = participantKey(participantRefOf(guest1));
    for (const d of decisionsIn(session2)) {
      for (const s of d.input.knowledge.memory?.subjects ?? []) {
        expect(participantKey(s.subject)).not.toBe(gone);
      }
    }
  });

  it("(6) Leakage 0: CPU の入力は自分の KnowledgeState と自分の層だけで、他者の札・Future Cards・他の CPU の観察・Persona・Reveal・Hero の弱点が無い", () => {
    const fixedNotIn1 = run.store
      .sessionParticipants(session2)
      .filter(
        (p) =>
          p.kind === "fixed" &&
          !run.store
            .sessionParticipants(session1)
            .some(
              (q) => q.kind === "fixed" && q.cpuProfileId === p.cpuProfileId,
            ),
      );
    for (const d of run.decisions) {
      const at = `${d.handId} ${d.playerId}`;
      const events = run.store
        .read(d.handId)
        .map((s) => s.event)
        .filter((e) => e.seq <= d.uptoSeq);
      expect(leakedCards(d.input, events, d.playerId, d.uptoSeq), at).toEqual(
        [],
      );
      expect(forbiddenKeys(d.input), at).toEqual([]);
      expect(JSON.stringify(d.input), at).not.toMatch(
        /reveal|weakness|learning/i,
      );
      // 層を除いた KnowledgeState は、Engine の Projection（その CPU に見える Event だけ）と同じ（他の項目を足していない）。
      const { memory, tilt, tableTendency, ...projected } = d.input.knowledge;
      expect(projected, at).toEqual(projectKnowledgeState(events, d.playerId));
      void tilt;
      void tableTendency;
      // Memory は自分を Subject に持たず、Evidence はその CPU 自身が座っていた Hand だけ（他の CPU の観察を含まない）。
      const self = d.participant;
      if (memory !== undefined && self !== undefined) {
        const selfKey = participantKey(participantRefOf(self));
        for (const s of memory.subjects) {
          expect(participantKey(s.subject), at).not.toBe(selfKey);
          for (const handId of s.items.flatMap((i) =>
            i.evidenceIds.map(handOfEvidence),
          )) {
            const sat = run.store
              .sessionParticipants(run.store.sessionIdOfHand(handId) ?? "")
              .some((p) => participantKey(participantRefOf(p)) === selfKey);
            expect(sat, `${at} ← ${handId}`).toBe(true);
          }
        }
      }
    }
    // 検査が空振りしていない: Session 1 にいなかった Fixed CPU が Session 2 にいて、その Memory に Session 1 の Hand が無い。
    expect(fixedNotIn1.length).toBeGreaterThan(0);
  });

  it("(5) Latency: Hand の開始時の Memory・Tilt・Table Tendency の計算時間を、保存済みの Hand の数ごとに記録する（大きさは作業ログで見る）", () => {
    expect(run.hands.length).toBeGreaterThan(SESSION1_HANDS);
    for (const h of run.hands) {
      for (const ms of Object.values(h.timings)) {
        expect(Number.isFinite(ms) && ms >= 0).toBe(true);
      }
    }
    const saved = run.hands.map((h) => h.savedHands);
    expect([...saved].sort((a, b) => a - b)).toEqual(saved);
    expect(saved.at(-1)).toBeGreaterThan(SESSION1_HANDS);
  });
});

describe("時計が後ろへ戻った記録（D117・#142）", () => {
  it("記録時刻が保存の順と逆でも、CPU に渡る合成の入力（Memory・Tilt・Table Tendency）と判断は変わらない", async () => {
    let t = Date.parse("2026-10-08T12:00:00.000Z");
    const backwards = () => {
      t -= 60 * 1000;
      return new Date(t);
    };
    const options = {
      handsPerSession: [12, 8],
      seedOfHand: (n: number) => 7000 + n,
    };
    const back = await runRuleBotSessions({ ...options, now: backwards });
    const forward = await runRuleBotSessions(options);
    const finished = back.store.finishedHandIds();
    const times = finished.map((h) => back.store.read(h)[0]?.recordedAt ?? "");
    // 記録時刻は保存の順と逆に並んでいる（時計が戻った）。
    expect([...times].sort().reverse()).toEqual(times);
    const view = (r: SessionRunResult) =>
      r.decisions.map((d) => ({
        handId: d.handId,
        playerId: d.playerId,
        input: d.input,
        output: d.output,
      }));
    expect(view(back)).toEqual(view(forward));
    // 検査が空振りしていない: Session を跨いだ Memory の入った判断がある。
    expect(
      back.decisions.some(
        (d) =>
          d.sessionId === back.sessions[1] &&
          (d.input.knowledge.memory?.subjects ?? []).some(
            (s) => s.handsObserved > 0,
          ),
      ),
    ).toBe(true);
  }, 60_000);
});
