import { describe, expect, it } from "vitest";
import {
  PERSONA_PRESETS,
  PERSONA_PRESET_IDS,
  describePersona,
  isPersonaPresetId,
  type PersonaTraits,
} from "./persona.js";

/** docs/05 §2 の 11 軸。 */
const AXES: readonly (keyof PersonaTraits)[] = [
  "skill",
  "preflopLooseness",
  "aggression",
  "bluffTendency",
  "riskTolerance",
  "discipline",
  "adaptability",
  "trapTendency",
  "opponentReadingQuality",
  "tiltSusceptibility",
  "recoverySpeed",
];

describe("Persona の Preset（D85・OI-005 の暫定値）", () => {
  it("6 つの Preset があり、ID と名前が重ならない", () => {
    expect(PERSONA_PRESET_IDS).toEqual([
      "tag_regular",
      "lag",
      "calling_station",
      "nit",
      "maniac",
      "weak_tight_recreational",
    ]);
    const labels = PERSONA_PRESET_IDS.map((id) => PERSONA_PRESETS[id].label);
    expect(labels).toEqual([
      "TAG Regular",
      "LAG",
      "Calling Station",
      "Nit",
      "Maniac",
      "Weak-tight Recreational",
    ]);
    for (const id of PERSONA_PRESET_IDS) {
      expect(PERSONA_PRESETS[id].id).toBe(id);
    }
  });

  it("どの Preset も 11 軸をちょうど持ち、値は 0〜1", () => {
    for (const id of PERSONA_PRESET_IDS) {
      const traits = PERSONA_PRESETS[id].traits;
      expect(Object.keys(traits).sort()).toEqual([...AXES].sort());
      for (const axis of AXES) {
        expect(traits[axis]).toBeGreaterThanOrEqual(0);
        expect(traits[axis]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("一つの difficulty に縮約しない: Skill が同程度でも他の軸で別の性格になり、Skill の順と他の軸の順は一致しない", () => {
    const { tag_regular, lag, maniac, nit, calling_station } = PERSONA_PRESETS;
    // Skill が近い TAG と LAG は、Looseness と Aggression で分かれる。
    expect(Math.abs(tag_regular.traits.skill - lag.traits.skill)).toBeLessThan(
      0.1,
    );
    expect(lag.traits.preflopLooseness).toBeGreaterThan(
      tag_regular.traits.preflopLooseness,
    );
    // Skill の低い Maniac は Skill の高い Nit より攻撃的（Skill だけで並べた軸ではない）。
    expect(maniac.traits.skill).toBeLessThan(nit.traits.skill);
    expect(maniac.traits.aggression).toBeGreaterThan(nit.traits.aggression);
    // Calling Station は広く参加するが攻撃性は低い。
    expect(calling_station.traits.preflopLooseness).toBeGreaterThan(0.6);
    expect(calling_station.traits.aggression).toBeLessThan(0.4);
  });

  it("isPersonaPresetId は Preset の ID だけを受け付ける", () => {
    for (const id of PERSONA_PRESET_IDS)
      expect(isPersonaPresetId(id)).toBe(true);
    for (const raw of ["", "TAG", "tag", "difficulty", "Maniac"]) {
      expect(isPersonaPresetId(raw)).toBe(false);
    }
  });
});

describe("describePersona（Claude の Prompt 用の文章）", () => {
  it("名前と 9 軸の値を書き、Tilt の 2 軸（Phase 7）は書かない", () => {
    const text = describePersona(PERSONA_PRESETS.maniac);
    expect(text).toContain("スタイル: Maniac");
    expect(text).toContain("攻撃性（Aggression）: 0.95（とても高い）");
    expect(text).toContain("実力（Skill）: 0.35（低い）");
    expect(text.match(/^- .+: \d\.\d\d（.+）$/gm)).toHaveLength(9);
    expect(text).not.toMatch(/Tilt|Recovery/);
  });

  it("クセ（Leak）は Preset が持つときだけ節ごと入れる", () => {
    const station = describePersona(PERSONA_PRESETS.calling_station);
    expect(station).toContain("あなたのクセ");
    for (const leak of PERSONA_PRESETS.calling_station.leaks) {
      expect(station).toContain(`- ${leak}`);
    }
    expect(PERSONA_PRESETS.tag_regular.leaks).toEqual([]);
    expect(describePersona(PERSONA_PRESETS.tag_regular)).not.toContain(
      "あなたのクセ",
    );
  });
});
