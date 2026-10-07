// Targeted Drill の変形の選び方（docs/07 §7・D105・D110・D116・#117）。過去の Hand の Hero の判断 1 つから、一要素だけ変えた類題を
// 決定論で選ぶ。LLM は使わない（D110）。変形の種類と値は Version 付きの暫定 Policy（OI-006 の暫定値。永久仕様にしない）。
// - effective_stack: 開始時の全員の Stack を倍率で変える
// - bet_size: Hero が直面した相手の最初の Bet の額を、Bet の直前の Pot の割合で変える
// - opponent_tendency: Spot は元のまま、判断の後の相手（全員）の Action を、Preset の Persona の RuleBot（決定論）で決める。
//   どの Preset かは Drill の設定として Hero に見せる（元の Hand の CPU の Hidden Persona は読まない・見せない。seed だけで選ぶ）
// 候補の順は seed のシャッフルで決め（種類の順 → 種類ごとの値の順）、Engine の Validation（startDrillHand）を通る最初の候補を使う。通る候補が無ければ Drill を出さない。
// 入力は判断時点の Hero Information Set と seed と卓の設定だけで、ユーザーの弱点（Profile・Hypothesis・Score）は受け取らない
// （CPU の入力〔RuleBot の Persona〕に弱点が入る経路を作らない。不変条件 2）。
import {
  buildDrillSpot,
  createRng,
  shuffle,
  startDrillHand,
  type DrillSpot,
  type DrillSpotChange,
  type HeroInformationSet,
  type TableConfig,
} from "@proj-poker/engine";
import {
  PERSONA_PRESET_IDS,
  type PersonaPresetId,
} from "../opponents/persona.js";

/** 変形 1 つ（一要素だけ変える）。drills テーブルの variant 列にこの形で残す。 */
export type DrillVariant =
  | { readonly kind: "effective_stack"; readonly factor: number }
  | { readonly kind: "bet_size"; readonly potFraction: number }
  | { readonly kind: "opponent_tendency"; readonly presetId: PersonaPresetId };

export type DrillVariantKind = DrillVariant["kind"];

/** 変形の候補の Policy（数値はすべて OI-006 の暫定値）。値を変えるときは既存の Policy を書き換えず Version を足す。 */
export interface DrillPolicy {
  readonly version: string;
  /** effective_stack の倍率。 */
  readonly stackFactors: readonly number[];
  /** bet_size の、Bet の直前の Pot に対する割合。 */
  readonly betPotFractions: readonly number[];
  /** opponent_tendency の Persona の Preset。 */
  readonly tendencyPresets: readonly PersonaPresetId[];
}

export const DRILL_POLICIES = {
  phase6_drill_v1: {
    version: "phase6_drill_v1",
    stackFactors: [0.5, 2],
    betPotFractions: [0.33, 0.75, 1.5],
    tendencyPresets: PERSONA_PRESET_IDS,
  },
} as const satisfies Readonly<Record<string, DrillPolicy>>;

export const DEFAULT_DRILL_POLICY: DrillPolicy = DRILL_POLICIES.phase6_drill_v1;

/** 選んだ Drill。spot は Engine の Validation を通った Spot、persona は判断の後の相手の RuleBot の Persona（無ければ既定の RuleBot）。 */
export interface DrillPlan {
  readonly policyVersion: string;
  readonly seed: number;
  readonly variant: DrillVariant;
  readonly spot: DrillSpot;
  readonly persona: PersonaPresetId | null;
}

/**
 * 候補を seed で並べる。変形の種類の順を先に決め、種類ごとに値の順を決める（値の数が多い種類に偏らせない）。
 * 同じ Policy・同じ seed からは同じ順。
 */
export function orderedDrillCandidates(
  policy: DrillPolicy,
  seed: number,
): DrillVariant[] {
  const rng = createRng(seed);
  const byKind: Record<DrillVariantKind, DrillVariant[]> = {
    effective_stack: policy.stackFactors.map((factor) => ({
      kind: "effective_stack",
      factor,
    })),
    bet_size: policy.betPotFractions.map((potFraction) => ({
      kind: "bet_size",
      potFraction,
    })),
    opponent_tendency: policy.tendencyPresets.map((presetId) => ({
      kind: "opponent_tendency",
      presetId,
    })),
  };
  const kinds: DrillVariantKind[] = [
    "effective_stack",
    "bet_size",
    "opponent_tendency",
  ];
  return shuffle(kinds, rng).flatMap((kind) => shuffle(byKind[kind], rng));
}

function spotChangeOf(variant: DrillVariant): DrillSpotChange {
  switch (variant.kind) {
    case "effective_stack":
      return { kind: "effective_stack", factor: variant.factor };
    case "bet_size":
      return { kind: "bet_size", potFraction: variant.potFraction };
    case "opponent_tendency":
      // 相手の傾向は Spot を変えない（判断の後の RuleBot の Persona だけを変える）。
      return { kind: "unchanged" };
  }
}

/**
 * 変形 1 つを当てた Drill を作り、Engine の Validation（startDrillHand）に通す。通らなければ null。
 * 同じ Information Set・変形・seed・卓の設定からは同じ結果（決定論）。
 */
export function buildDrillPlan(
  set: HeroInformationSet,
  variant: DrillVariant,
  seed: number,
  config: TableConfig,
  policyVersion: string = DEFAULT_DRILL_POLICY.version,
): DrillPlan | null {
  const built = buildDrillSpot(set, spotChangeOf(variant), seed);
  if (!built.ok) return null;
  const validated = startDrillHand({
    handId: "drill-validation",
    sessionId: "drill-validation",
    spot: built.value,
    config,
  });
  if (!validated.ok) return null;
  return {
    policyVersion,
    seed,
    variant,
    spot: built.value,
    persona: variant.kind === "opponent_tendency" ? variant.presetId : null,
  };
}

/**
 * seed で候補の順を決め、Engine の Validation を通る最初の変形で Drill を作る。通る候補が無ければ null（Drill を出さない）。
 */
export function planDrill(
  set: HeroInformationSet,
  seed: number,
  config: TableConfig,
  policy: DrillPolicy = DEFAULT_DRILL_POLICY,
): DrillPlan | null {
  for (const variant of orderedDrillCandidates(policy, seed)) {
    const plan = buildDrillPlan(set, variant, seed, config, policy.version);
    if (plan !== null) return plan;
  }
  return null;
}
