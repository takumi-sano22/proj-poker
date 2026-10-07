// Targeted Drill（#117）の表示の補助。変形の名前と、Pot に対する割合の表記。
import type { DrillVariant } from "./drill-api.js";

/** 変形の種類の名前（日本語（英語））。 */
export const DRILL_VARIANT_LABELS: Readonly<
  Record<DrillVariant["kind"], string>
> = {
  effective_stack: "有効 Stack（Effective Stack）",
  bet_size: "Bet の額（Bet Size）",
  opponent_tendency: "相手の傾向（Opponent Tendency）",
};

/** 0.75 → "75%"（小数は四捨五入）。 */
export function percentText(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
