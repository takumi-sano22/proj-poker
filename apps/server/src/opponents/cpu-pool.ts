// CPU の永続 Identity（D106・D118・#136）。席・player id（cpu1 等）は Hand・Session ごとに別の CPU が座りうるので Identity にしない。
// Session の始まりに、CPU の席ごとに「Fixed CPU（Session を跨いで同じ cpuProfileId）」か「Guest（その Session 限りの id）」を決め、
// Event Store が Session の最初の Hand の保存と同じトランザクションで追記型の session_participants（マイグレーション v10）に残す。
// Fixed Pool（cpuProfileId・名前・Persona Preset）は DB に置かず、ここの Version 付き Config に置く（Persona Preset と同じ扱い）。
// DB は人数・ID の一覧を知らない（OI-005: DB Schema を固定人数に Couple しない）。
import { createRng, randomInt } from "@proj-poker/engine";
import type { PersonaPresetId } from "./persona.js";

/** Fixed Pool の 1 人。persona はその CPU 自身の判断にだけ使う Secret で、Hero・Event・DB には出さない（D28）。 */
export interface FixedCpuProfile {
  readonly cpuProfileId: string;
  /** 名前（OI-005 の暫定値）。今は画面に出さない（席の表示名は従来どおり「CPU n」）。 */
  readonly name: string;
  /** その CPU の Persona Preset（席の Persona と同じなら優先して座る。下の composeSessionParticipants）。 */
  readonly persona: PersonaPresetId;
}

export interface CpuPool {
  /** 保存の行（session_participants.pool_version）に残す版。Pool の中身を変えたら上げる。 */
  readonly version: string;
  readonly fixed: readonly FixedCpuProfile[];
  /** 1 卓に座れる Guest の上限。 */
  readonly maxGuestSeats: number;
  /** Session の始まりに Guest を 1 席座らせる確率（0〜1。seed で決定論に引く）。 */
  readonly guestSeatChance: number;
}

/**
 * Phase 7 の Fixed Pool。OI-005 の暫定値。確定ではない（人数・名前・Persona Distribution・Guest の出やすさは Playtest で見直す）。
 * Fixed 8 人＋Guest は 1 卓に最大 1 席（D118）。Persona の内訳は、既定の割り当て順（config.ts の DEFAULT_PERSONA_ROTATION）で
 * 最大の卓（CPU 7 人。TAG Regular が 2 席）を Fixed CPU だけで埋められ、同じ Persona の席に 2 人の候補が出るように置いた。
 */
export const PHASE7_CPU_POOL: CpuPool = {
  version: "phase7_pool_v1",
  fixed: [
    { cpuProfileId: "fixed_aki", name: "Aki", persona: "tag_regular" },
    { cpuProfileId: "fixed_ben", name: "Ben", persona: "tag_regular" },
    { cpuProfileId: "fixed_chika", name: "Chika", persona: "lag" },
    { cpuProfileId: "fixed_dan", name: "Dan", persona: "lag" },
    { cpuProfileId: "fixed_emi", name: "Emi", persona: "nit" },
    { cpuProfileId: "fixed_fumi", name: "Fumi", persona: "calling_station" },
    {
      cpuProfileId: "fixed_goro",
      name: "Goro",
      persona: "weak_tight_recreational",
    },
    { cpuProfileId: "fixed_hana", name: "Hana", persona: "maniac" },
  ],
  maxGuestSeats: 1,
  guestSeatChance: 0.5,
};

/** Session の CPU の席 1 つの参加者。Fixed は Pool の cpuProfileId、Guest はその Session 限りの id（次の Session では使わない）。 */
export type SessionParticipant =
  | {
      readonly playerId: string;
      readonly kind: "fixed";
      readonly cpuProfileId: string;
      readonly poolVersion: string;
    }
  | {
      readonly playerId: string;
      readonly kind: "guest";
      readonly guestId: string;
      readonly poolVersion: string;
    };

/** 編成の入力の CPU の席（席順）。persona はその席の Persona（卓の設定・CPU_PERSONAS の割り当て。無ければ undefined）。 */
export interface CpuSeat {
  readonly playerId: string;
  readonly persona: PersonaPresetId | undefined;
}

/**
 * Guest の id。Session の id（UUID）と席から作るので、別の Session と重ならない（同じ id を別の Session で使わない。
 * DB でも session_participants.guest_id の一意制約で守る）。
 */
export function guestIdOf(sessionId: string, playerId: string): string {
  return `guest/${sessionId}/${playerId}`;
}

/**
 * 新しい Session の CPU の席の参加者を seed で決定論に決める（同じ入力なら同じ編成）。
 * 1. Guest: guestSeatChance の確率で、CPU の席のどれか 1 つ（maxGuestSeats が 0 なら座らせない）
 * 2. 残りの席を席順に、まだ座っていない Fixed CPU で埋める。席の Persona と同じ Persona の Fixed CPU がいればその中から、
 *    いなければ（CPU_PERSONAS で偏らせたとき）まだ座っていない Fixed CPU 全体から seed で選ぶ
 * 席の Persona は変えない（CPU_PERSONAS の上書きと既存の割り当てを保つ）。Fixed CPU が足りなければ RangeError（Pool の設定の誤り）。
 */
export function composeSessionParticipants(input: {
  readonly sessionId: string;
  readonly seats: readonly CpuSeat[];
  readonly seed: number;
  readonly pool?: CpuPool;
}): SessionParticipant[] {
  const pool = input.pool ?? PHASE7_CPU_POOL;
  const rng = createRng(input.seed);
  // 乱数を引く順（Guest の有無 → Guest の席 → 席順の Fixed CPU）を固定し、同じ seed で同じ編成にする。
  const guestSeat =
    input.seats.length > 0 &&
    pool.maxGuestSeats > 0 &&
    rng() < pool.guestSeatChance
      ? randomInt(rng, input.seats.length)
      : null;
  const unused = [...pool.fixed];
  return input.seats.map((seat, i): SessionParticipant => {
    if (i === guestSeat) {
      return {
        playerId: seat.playerId,
        kind: "guest",
        guestId: guestIdOf(input.sessionId, seat.playerId),
        poolVersion: pool.version,
      };
    }
    const matching = unused.filter(
      (p) => seat.persona === undefined || p.persona === seat.persona,
    );
    const candidates = matching.length > 0 ? matching : unused;
    if (candidates.length === 0) {
      throw new RangeError(
        `Fixed Pool（${pool.version}）の人数 ${pool.fixed.length} では CPU の席 ${input.seats.length} を埋められない`,
      );
    }
    const chosen = candidates[
      randomInt(rng, candidates.length)
    ] as FixedCpuProfile;
    unused.splice(unused.indexOf(chosen), 1);
    return {
      playerId: seat.playerId,
      kind: "fixed",
      cpuProfileId: chosen.cpuProfileId,
      poolVersion: pool.version,
    };
  });
}
