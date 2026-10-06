// CPU の Persona（docs/05 §2・FR-CPU-004）。多軸のパラメータで性格を表し、一つの difficulty に縮約しない。
// Persona はその CPU 自身の判断（LLM の Prompt・RuleBot のしきい値）にだけ使う。KnowledgeState・Event・DB・Hero への応答には入れない
// （他 CPU の Secret Persona を漏らさない。D28・docs/05 §1）。
// Preset の種類と数値は OI-005 の暫定値（D85）で、永久仕様ではない。Playtest で見直す。

/** docs/05 §2 の 11 軸。値は 0〜1（0.5 が平均的なプレイヤー）。 */
export interface PersonaTraits {
  readonly skill: number;
  readonly preflopLooseness: number;
  readonly aggression: number;
  readonly bluffTendency: number;
  readonly riskTolerance: number;
  readonly discipline: number;
  readonly adaptability: number;
  readonly trapTendency: number;
  readonly opponentReadingQuality: number;
  /** Tilt（Transient State）は Phase 7 で扱う。今は値を持つだけで、Prompt にも RuleBot にも使わない。 */
  readonly tiltSusceptibility: number;
  /** 同上（Phase 7）。 */
  readonly recoverySpeed: number;
}

export const PERSONA_PRESET_IDS = [
  "tag_regular",
  "lag",
  "calling_station",
  "nit",
  "maniac",
  "weak_tight_recreational",
] as const;

export type PersonaPresetId = (typeof PERSONA_PRESET_IDS)[number];

export interface Persona {
  readonly id: PersonaPresetId;
  /** Prompt に出す名前。 */
  readonly label: string;
  readonly traits: PersonaTraits;
  /**
   * 一貫して出るクセ（docs/05 §3 の Leak の例から選ぶ）。弱さは Illegal / 無意味な Random Action ではなく、これと traits で表す。
   * 空なら Prompt に節ごと入れない。
   */
  readonly leaks: readonly string[];
}

/** 6 つの Preset（D85）。数値はすべて OI-005 の暫定値（確定ではない）。 */
export const PERSONA_PRESETS: Readonly<Record<PersonaPresetId, Persona>> = {
  tag_regular: {
    id: "tag_regular",
    label: "TAG Regular",
    traits: {
      skill: 0.75,
      preflopLooseness: 0.4,
      aggression: 0.7,
      bluffTendency: 0.45,
      riskTolerance: 0.5,
      discipline: 0.8,
      adaptability: 0.65,
      trapTendency: 0.4,
      opponentReadingQuality: 0.7,
      tiltSusceptibility: 0.25,
      recoverySpeed: 0.75,
    },
    leaks: [],
  },
  lag: {
    id: "lag",
    label: "LAG",
    traits: {
      skill: 0.7,
      preflopLooseness: 0.7,
      aggression: 0.85,
      bluffTendency: 0.65,
      riskTolerance: 0.7,
      discipline: 0.6,
      adaptability: 0.7,
      trapTendency: 0.35,
      opponentReadingQuality: 0.65,
      tiltSusceptibility: 0.4,
      recoverySpeed: 0.6,
    },
    leaks: [],
  },
  calling_station: {
    id: "calling_station",
    label: "Calling Station",
    traits: {
      skill: 0.3,
      preflopLooseness: 0.8,
      aggression: 0.2,
      bluffTendency: 0.1,
      riskTolerance: 0.75,
      discipline: 0.3,
      adaptability: 0.2,
      trapTendency: 0.2,
      opponentReadingQuality: 0.2,
      tiltSusceptibility: 0.5,
      recoverySpeed: 0.5,
    },
    leaks: [
      "Call Range が広すぎる",
      "Draw を追いすぎる",
      "River で Overcall する",
    ],
  },
  nit: {
    id: "nit",
    label: "Nit",
    traits: {
      skill: 0.5,
      preflopLooseness: 0.15,
      aggression: 0.35,
      bluffTendency: 0.1,
      riskTolerance: 0.2,
      discipline: 0.8,
      adaptability: 0.3,
      trapTendency: 0.3,
      opponentReadingQuality: 0.4,
      tiltSusceptibility: 0.2,
      recoverySpeed: 0.6,
    },
    leaks: ["River で Overfold する", "Bluff が少なすぎる（Underbluff）"],
  },
  maniac: {
    id: "maniac",
    label: "Maniac",
    traits: {
      skill: 0.35,
      preflopLooseness: 0.9,
      aggression: 0.95,
      bluffTendency: 0.9,
      riskTolerance: 0.9,
      discipline: 0.15,
      adaptability: 0.3,
      trapTendency: 0.1,
      opponentReadingQuality: 0.3,
      tiltSusceptibility: 0.7,
      recoverySpeed: 0.3,
    },
    leaks: ["Bluff が多すぎる（Overbluff）", "Position を軽視する"],
  },
  weak_tight_recreational: {
    id: "weak_tight_recreational",
    label: "Weak-tight Recreational",
    traits: {
      skill: 0.25,
      preflopLooseness: 0.3,
      aggression: 0.25,
      bluffTendency: 0.15,
      riskTolerance: 0.25,
      discipline: 0.45,
      adaptability: 0.2,
      trapTendency: 0.2,
      opponentReadingQuality: 0.25,
      tiltSusceptibility: 0.45,
      recoverySpeed: 0.5,
    },
    leaks: [
      "3-bet が少なすぎる",
      "Cold Call しすぎる",
      "River で Overfold する",
    ],
  },
};

/** Prompt に出す軸と名前。Tilt の 2 軸は Transient State が無い今は入れない（Phase 7。条件付きの指示を文で書かず、節ごと出し分ける）。 */
const PROMPT_TRAITS: readonly (readonly [keyof PersonaTraits, string])[] = [
  ["skill", "実力（Skill）"],
  ["preflopLooseness", "Preflop で参加する手の広さ（Preflop Looseness）"],
  ["aggression", "攻撃性（Aggression）"],
  ["bluffTendency", "Bluff の多さ（Bluff Tendency）"],
  ["riskTolerance", "リスクの許容（Risk Tolerance）"],
  ["discipline", "規律（Discipline）"],
  ["adaptability", "相手への適応（Adaptability）"],
  ["trapTendency", "Slow Play / Trap の多さ（Trap Tendency）"],
  ["opponentReadingQuality", "相手の読みの精度（Opponent Reading Quality）"],
];

function levelOf(value: number): string {
  if (value < 0.2) return "とても低い";
  if (value < 0.4) return "低い";
  if (value < 0.6) return "平均的";
  if (value < 0.8) return "高い";
  return "とても高い";
}

/** Persona を Claude の Prompt 用の文章にする（ClaudeOpponent の「あなたの性格」の節に入る）。 */
export function describePersona(persona: Persona): string {
  const lines = [
    `スタイル: ${persona.label}`,
    "次の傾向で一貫してプレイしてください（0〜1。0.5 が平均的なプレイヤー）。",
    ...PROMPT_TRAITS.map(
      ([key, name]) =>
        `- ${name}: ${persona.traits[key].toFixed(2)}（${levelOf(persona.traits[key])}）`,
    ),
  ];
  if (persona.leaks.length > 0) {
    lines.push(
      "あなたのクセ（毎回一貫して出す）:",
      ...persona.leaks.map((leak) => `- ${leak}`),
    );
  }
  return lines.join("\n");
}

/** 文字列が Preset の ID か。 */
export function isPersonaPresetId(value: string): value is PersonaPresetId {
  return (PERSONA_PRESET_IDS as readonly string[]).includes(value);
}
