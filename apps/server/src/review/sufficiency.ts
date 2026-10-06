// Evidence Sufficiency Gate（docs/03 §7・docs/05 §11）。Review AI を呼ぶ前に、評価に足りる根拠が揃っているかを決定論で判定する。
// 足りなければ Review AI を呼ばずに Insufficient Evidence とする。Web Fallback（OI-010）は MVP に入れない（D94）。
// 基準は暫定値で、Review の運用を見て変える（永久仕様にしない）。
import type { ReviewEvidence } from "./types.js";

/** 足りない根拠の種類。 */
export type MissingEvidence =
  /** 判断時点の卓が読めない（Hero の札・Legal Action が無い）。Event Log が壊れている場合など */
  | "decision_context"
  /** 数値の根拠が無い（Range に対する Equity も、Supported の Solver Evidence も無い） */
  | "quantitative"
  /** 概念・Practical な指針の根拠（Local KB の項目）が 1 つも当たらない */
  | "knowledge";

export type SufficiencyResult =
  | { readonly sufficient: true }
  | {
      readonly sufficient: false;
      readonly missing: readonly MissingEvidence[];
    };

/** Gate の判定。足りないものを全部挙げる（1 つ目で止めない。表示と記録に使う）。 */
export function checkEvidenceSufficiency(
  evidence: ReviewEvidence,
): SufficiencyResult {
  const missing: MissingEvidence[] = [];
  if (
    evidence.context.heroHoleCards.length !== 2 ||
    evidence.context.legalActions.length === 0
  ) {
    missing.push("decision_context");
  }
  if (evidence.math.equity === null && evidence.solver.status !== "supported") {
    missing.push("quantitative");
  }
  if (evidence.knowledge.items.length === 0) missing.push("knowledge");
  return missing.length === 0
    ? { sufficient: true }
    : { sufficient: false, missing };
}

/** 足りない根拠の説明（Insufficient Evidence の Review の本文に使う）。 */
export const MISSING_EVIDENCE_TEXT: Readonly<Record<MissingEvidence, string>> =
  {
    decision_context: "判断時点の卓（Hero の札・選べた Action）を読めなかった",
    quantitative:
      "数値の根拠（仮定した Range に対する Equity、または対応する Solver の結果）が無い",
    knowledge: "この Spot に当てはまる Local KB の項目が無い",
  };
