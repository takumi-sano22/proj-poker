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
      expect(
        composeSessionParticipants({ sessionId: "s1", seats, seed }),
      ).toEqual(composeSessionParticipants({ sessionId: "s1", seats, seed }));
    }
    // seed が違えば編成も変わりうる（Guest の有無・同じ Persona の Fixed CPU の選び方）。
    const distinct = new Set(
      SEEDS.map((seed) =>
        JSON.stringify(
          composeSessionParticipants({ sessionId: "s1", seats, seed }),
        ),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("人数 2〜8 のどの卓でも、CPU の席を席順にすべて埋め、Fixed CPU は重ならず、Guest は最大 1 席", () => {
    for (const size of TABLE_SIZES) {
      const seats = cpuSeatsOf(size);
      let withGuest = 0;
      for (const seed of SEEDS) {
        const participants = composeSessionParticipants({
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
        const participants = composeSessionParticipants({
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
        guests(composeSessionParticipants({ sessionId: "x", seats, seed: s }))
          .length === 1,
    );
    if (seed === undefined) throw new Error("Guest の座る seed が無い");
    const first = composeSessionParticipants({
      sessionId: "session-1",
      seats,
      seed,
    });
    const second = composeSessionParticipants({
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
      for (const p of composeSessionParticipants({
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

  it("CPU_PERSONAS で Persona を偏らせても止まらず、足りない席は Persona の違う Fixed CPU で埋める（席の Persona は上書きのまま）", () => {
    const seats = cpuSeatsOf(MAX_PLAYERS, ["maniac"]);
    for (const seed of SEEDS) {
      const participants = composeSessionParticipants({
        sessionId: "s",
        seats,
        seed,
      });
      expect(participants).toHaveLength(MAX_PLAYERS - 1);
      expect(new Set(fixedIds(participants)).size).toBe(
        fixedIds(participants).length,
      );
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
      composeSessionParticipants({
        sessionId: "s",
        seats: cpuSeatsOf(3),
        seed: 1,
        pool: small,
      }).map((p) => p.kind),
    ).toEqual(expect.arrayContaining(["guest", "fixed"]));
    expect(() =>
      composeSessionParticipants({
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
          composeSessionParticipants({
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
