import { MAX_PLAYERS, MIN_PLAYERS } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { buildTableSetup } from "../config.js";
import {
  composeSessionParticipants,
  guestIdOf,
  PHASE7_CPU_POOL,
  type CpuPool,
  type CpuSeat,
  type SessionParticipant,
} from "./cpu-pool.js";
import { PERSONA_PRESETS, type PersonaPresetId } from "./persona.js";

/** 卓の設定（人数・Persona の割り当て順）の CPU の席。 */
function cpuSeatsOf(
  tableSize: number,
  rotation?: readonly PersonaPresetId[],
): CpuSeat[] {
  const setup = buildTableSetup(tableSize, rotation);
  return setup.players
    .filter((p) => p.kind === "cpu")
    .map((p) => ({
      playerId: p.playerId,
      persona: setup.personas[p.playerId],
    }));
}

const fixedIds = (participants: readonly SessionParticipant[]) =>
  participants.flatMap((p) => (p.kind === "fixed" ? [p.cpuProfileId] : []));

const guests = (participants: readonly SessionParticipant[]) =>
  participants.filter((p) => p.kind === "guest");

/** 編成の参加者だけ（Persona の割り当てを見ない検査用）。 */
const participantsOf = (
  input: Parameters<typeof composeSessionParticipants>[0],
): SessionParticipant[] => composeSessionParticipants(input).participants;

const SEEDS = Array.from({ length: 200 }, (_, i) => i);
const TABLE_SIZES = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, i) => MIN_PLAYERS + i,
);

describe("Fixed Pool（phase7_pool_v1。OI-005 の暫定値）", () => {
  it("Fixed 8 人で ID は重ならず、Persona は既存の Preset、Guest は 1 卓に最大 1 席", () => {
    expect(PHASE7_CPU_POOL.version).toBe("phase7_pool_v1");
    expect(PHASE7_CPU_POOL.fixed).toHaveLength(8);
    const ids = PHASE7_CPU_POOL.fixed.map((p) => p.cpuProfileId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PHASE7_CPU_POOL.fixed) {
      expect(Object.keys(PERSONA_PRESETS)).toContain(p.persona);
    }
    expect(PHASE7_CPU_POOL.maxGuestSeats).toBe(1);
  });
});

describe("composeSessionParticipants（席の編成。D118）", () => {
  it("同じ Session・席・seed なら同じ編成になる（決定論）", () => {
    const seats = cpuSeatsOf(6);
    for (const seed of SEEDS) {
      expect(participantsOf({ sessionId: "s1", seats, seed })).toEqual(
        participantsOf({ sessionId: "s1", seats, seed }),
      );
    }
    // seed が違えば編成も変わりうる（Guest の有無・同じ Persona の Fixed CPU の選び方）。
    const distinct = new Set(
      SEEDS.map((seed) =>
        JSON.stringify(participantsOf({ sessionId: "s1", seats, seed })),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("人数 2〜8 のどの卓でも、CPU の席を席順にすべて埋め、Fixed CPU は重ならず、Guest は最大 1 席", () => {
    for (const size of TABLE_SIZES) {
      const seats = cpuSeatsOf(size);
      let withGuest = 0;
      for (const seed of SEEDS) {
        const participants = participantsOf({
          sessionId: `s${seed}`,
          seats,
          seed,
        });
        expect(participants.map((p) => p.playerId)).toEqual(
          seats.map((s) => s.playerId),
        );
        const ids = fixedIds(participants);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
          expect(PHASE7_CPU_POOL.fixed.map((p) => p.cpuProfileId)).toContain(
            id,
          );
        }
        expect(guests(participants).length).toBeLessThanOrEqual(1);
        if (guests(participants).length === 1) withGuest++;
        for (const p of participants) {
          expect(p.poolVersion).toBe(PHASE7_CPU_POOL.version);
        }
      }
      // Guest のいる Session も、いない Session もある（seed で決まる）。
      expect(withGuest).toBeGreaterThan(0);
      expect(withGuest).toBeLessThan(SEEDS.length);
    }
  });

  it("既定の割り当て順では、席の Persona と同じ Persona の Fixed CPU が座る（Persona は席の割り当てのまま）", () => {
    const personaOf = new Map(
      PHASE7_CPU_POOL.fixed.map((p) => [p.cpuProfileId, p.persona]),
    );
    for (const size of TABLE_SIZES) {
      const seats = cpuSeatsOf(size);
      for (const seed of SEEDS) {
        const participants = participantsOf({
          sessionId: "s",
          seats,
          seed,
        });
        participants.forEach((p, i) => {
          if (p.kind === "fixed") {
            expect(personaOf.get(p.cpuProfileId)).toBe(seats[i]?.persona);
          }
        });
      }
    }
  });

  it("Fixed CPU は Session を跨いで同じ cpuProfileId、Guest の id は Session ごとに別で次の Session へ持ち越さない", () => {
    const seats = cpuSeatsOf(6);
    // 同じ seed で 2 つの Session を始めると、Fixed CPU は同じ ID、Guest は Session の id から作った別の id になる。
    const seed = SEEDS.find(
      (s) =>
        guests(participantsOf({ sessionId: "x", seats, seed: s })).length === 1,
    );
    if (seed === undefined) throw new Error("Guest の座る seed が無い");
    const first = participantsOf({
      sessionId: "session-1",
      seats,
      seed,
    });
    const second = participantsOf({
      sessionId: "session-2",
      seats,
      seed,
    });
    expect(fixedIds(second)).toEqual(fixedIds(first));
    const [guest1] = guests(first);
    const [guest2] = guests(second);
    expect(guest1?.kind === "guest" && guest1.guestId).toBe(
      guestIdOf("session-1", guest1?.playerId ?? ""),
    );
    expect(guest2?.kind === "guest" && guest2.guestId).not.toBe(
      guest1?.kind === "guest" && guest1.guestId,
    );

    // 多くの Session を通して、Guest の id は 1 度しか現れない。
    const seen = new Set<string>();
    for (const s of SEEDS) {
      for (const p of participantsOf({
        sessionId: `session-${s}`,
        seats,
        seed: s,
      })) {
        if (p.kind !== "guest") continue;
        expect(seen.has(p.guestId)).toBe(false);
        seen.add(p.guestId);
      }
    }
  });

  it("既定の割り当て順では、上書きの効かない席は無く、Persona の割り当ては卓の設定のまま", () => {
    for (const size of TABLE_SIZES) {
      const setup = buildTableSetup(size);
      const seats = cpuSeatsOf(size);
      for (const seed of SEEDS) {
        const composed = composeSessionParticipants({
          sessionId: "s",
          seats,
          seed,
        });
        expect(composed.unmatched).toEqual([]);
        expect(composed.personas).toEqual(setup.personas);
      }
    }
  });

  it("CPU_PERSONAS で偏らせても（全席 maniac）止まらず、同じ cpuProfileId の Persona は Session を跨いで変わらず、Guest は 1 席以下で、効かなかった席を返す", () => {
    const personaOf = new Map(
      PHASE7_CPU_POOL.fixed.map((p) => [p.cpuProfileId, p.persona]),
    );
    for (const size of [6, MAX_PLAYERS]) {
      const seats = cpuSeatsOf(size, ["maniac"]);
      for (const seed of SEEDS) {
        const composed = composeSessionParticipants({
          sessionId: `s${seed}`,
          seats,
          seed,
        });
        const { participants, personas, unmatched } = composed;
        expect(participants).toHaveLength(size - 1);
        expect(new Set(fixedIds(participants)).size).toBe(
          fixedIds(participants).length,
        );
        expect(guests(participants).length).toBeLessThanOrEqual(1);
        // Fixed CPU は常に Pool の Persona（どの Session・seed でも同じ cpuProfileId は同じ Persona）。
        for (const p of participants) {
          if (p.kind === "fixed") {
            expect(personas[p.playerId]).toBe(personaOf.get(p.cpuProfileId));
          } else {
            expect(personas[p.playerId]).toBe("maniac");
          }
        }
        // maniac の Fixed CPU は 1 人なので、Guest と合わせて最大 2 席だけが maniac。残りは上書きが効かない席として返る。
        const maniacSeats = participants.filter(
          (p) => personas[p.playerId] === "maniac",
        );
        expect(maniacSeats.length).toBeLessThanOrEqual(2);
        expect(unmatched.map((u) => u.playerId)).toEqual(
          participants
            .filter((p) => personas[p.playerId] !== "maniac")
            .map((p) => p.playerId),
        );
        expect(unmatched.every((u) => u.requested === "maniac")).toBe(true);
      }
    }
  });

  it("満たせない席が、後ろの席の求める Persona の Fixed CPU を先に取らない", () => {
    // 席 1・2 が maniac（Fixed は 1 人）、席 3 が nit（Fixed は 1 人）。席 2 が先に nit の Fixed CPU を取ると席 3 も満たせなくなる。
    const seats: CpuSeat[] = [
      { playerId: "cpu1", persona: "maniac" },
      { playerId: "cpu2", persona: "maniac" },
      { playerId: "cpu3", persona: "nit" },
    ];
    const noGuest: CpuPool = { ...PHASE7_CPU_POOL, maxGuestSeats: 0 };
    for (const seed of SEEDS) {
      const composed = composeSessionParticipants({
        sessionId: "s",
        seats,
        seed,
        pool: noGuest,
      });
      expect(composed.personas["cpu3"]).toBe("nit");
      expect(composed.unmatched).toEqual([
        { playerId: "cpu2", requested: "maniac" },
      ]);
    }
  });

  it("Pool の人数を変えても編成でき、Fixed CPU が足りない Pool の設定は RangeError にする", () => {
    const small: CpuPool = {
      version: "test_pool",
      fixed: [{ cpuProfileId: "only", name: "Only", persona: "nit" }],
      maxGuestSeats: 1,
      guestSeatChance: 1,
    };
    // CPU 2 席: Guest 1 席 + Fixed 1 人で埋まる。
    expect(
      participantsOf({
        sessionId: "s",
        seats: cpuSeatsOf(3),
        seed: 1,
        pool: small,
      }).map((p) => p.kind),
    ).toEqual(expect.arrayContaining(["guest", "fixed"]));
    expect(() =>
      participantsOf({
        sessionId: "s",
        seats: cpuSeatsOf(4),
        seed: 1,
        pool: small,
      }),
    ).toThrow(RangeError);
    // Guest を座らせない Pool。
    const noGuest: CpuPool = { ...PHASE7_CPU_POOL, maxGuestSeats: 0 };
    for (const seed of SEEDS) {
      expect(
        guests(
          participantsOf({
            sessionId: "s",
            seats: cpuSeatsOf(6),
            seed,
            pool: noGuest,
          }),
        ),
      ).toEqual([]);
    }
  });
});
