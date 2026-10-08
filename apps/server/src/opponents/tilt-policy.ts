// CPU の Tilt の Policy（D107・D119・#140。docs/05 §4・OI-011）。Tilt は Session の中の席ごとの transient な状態で、
// Persona（固定の性格）・Long-term Memory（memory/ の Hypothesis）とは別の層として持つ（保存しない）。
// ここにある数値はすべて OI-011 の暫定値で、確定ではない。Eval / Playtest の後に変えるときは、既存の Policy を書き換えず、
// Version を上げた Policy を足す（Tilt は保存しないので、同じ Session の Hand から Version ごとに作り直せる）。

export interface TiltPolicy {
  readonly version: string;
  /** Tilt の段階の上限（0〜maxLevel の整数。0 は平常）。 */
  readonly maxLevel: number;
  /** 「大きい Pot」のしきい値（その Hand の Big Blind の何倍以上か）。負け（Trigger）と大勝ち（Trigger）の両方に使う。 */
  readonly bigPotBigBlinds: number;
  /** 連敗の Trigger になる、Showdown で負けた回数の連続。 */
  readonly lossStreak: number;
  /** 1 Hand で発火した Trigger の数と、Persona の tiltSusceptibility（0〜1）から、その Hand で上がる段の数。 */
  rise(triggers: number, tiltSusceptibility: number): number;
  /** Persona の recoverySpeed（0〜1）から、1 段下がるまでに要る Trigger の無い Hand の数。 */
  calmHandsPerStep(recoverySpeed: number): number;
  /** 1 段あたり、Persona の Preflop Looseness と Aggression をずらす幅（RuleBot。上限は maxLevel 倍）。 */
  readonly traitShiftPerLevel: number;
}

/** 0〜1 の軸を 0.01 刻みの整数（0〜100）にする（浮動小数の端数で段の数が変わらないよう、整数で計算する）。 */
function percentOf(axis: number, name: string): number {
  if (!(axis >= 0 && axis <= 1)) {
    throw new RangeError(`Persona の ${name} ${axis} が 0〜1 でない`);
  }
  return Math.round(axis * 100);
}

/** 1 Trigger あたりの上がり幅（tiltSusceptibility が 1 のとき）。OI-011 の暫定値。確定ではない（D119）。 */
const PHASE7_RISE_PER_TRIGGER_AT_FULL = 2;
/** recoverySpeed 0 → 10 Hand で 1 段、1 → 2 Hand で 1 段（線形）。OI-011 の暫定値。確定ではない（D119）。 */
const PHASE7_CALM_HANDS = { slowest: 10, fastest: 2 } as const;

/**
 * phase7_tilt_v1（D119。数値はすべて OI-011 の暫定値で、確定ではない）。
 * - 段階: 0〜3 の整数
 * - Trigger: 40BB 以上の Pot の負け・3 連敗・Showdown で Bluff が見つかる・大勝ち（40BB 以上の Pot の勝ち）。定義は tilt.ts
 * - 上がり幅: ceil(Trigger の数 × tiltSusceptibility × 2)（Tilt しやすい Persona ほど速く上がる。0 の Persona は上がらない）
 * - 下がり方: Trigger の無い Hand が round(10 − 8 × recoverySpeed) 回続くごとに 1 段（立ち直りの速い Persona ほど速く下がる）
 * - 反映: 1 段あたり Preflop Looseness と Aggression を +0.05（3 段で +0.15 が上限）
 */
export const PHASE7_TILT_V1: TiltPolicy = {
  version: "phase7_tilt_v1",
  maxLevel: 3,
  bigPotBigBlinds: 40,
  lossStreak: 3,
  rise(triggers, tiltSusceptibility) {
    if (!Number.isSafeInteger(triggers) || triggers < 0) {
      throw new RangeError(`Trigger の数 ${triggers} が不正`);
    }
    const s = percentOf(tiltSusceptibility, "tiltSusceptibility");
    return Math.ceil((triggers * s * PHASE7_RISE_PER_TRIGGER_AT_FULL) / 100);
  },
  calmHandsPerStep(recoverySpeed) {
    const r = percentOf(recoverySpeed, "recoverySpeed");
    const { slowest, fastest } = PHASE7_CALM_HANDS;
    return Math.round((slowest * 100 - (slowest - fastest) * r) / 100);
  },
  traitShiftPerLevel: 0.05,
};

/** Version → Policy。Version を変えれば同じ Session の Hand から作り直せる。 */
export const TILT_POLICIES: Readonly<Record<string, TiltPolicy>> = {
  [PHASE7_TILT_V1.version]: PHASE7_TILT_V1,
};

export const DEFAULT_TILT_POLICY = PHASE7_TILT_V1;
