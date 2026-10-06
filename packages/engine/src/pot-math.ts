// Pot Odds など、公開された額だけから決まる決定論の Math（docs/research/02 §2・§5）。
// 計算はここ 1 か所に置き、KnowledgeState の math（projection.ts）・Decision Analysis・web の Dealer Feedback が同じ関数を使う。
// 比率は表示・判断の目安で、Chip の移動には使わない（Chip は整数のまま。D74）。

/**
 * Pot Odds（Call に要る勝率の目安）= Call 額 ÷（Pot + Call 額）。
 * pot は Call する前の Pot（相手の Bet を含む）。Call 額が 0 なら Call が要らないので null。
 */
export function potOdds(callAmount: number, pot: number): number | null {
  return callAmount <= 0 ? null : callAmount / (pot + callAmount);
}

/**
 * Equity が 0 の Bet / Raise が損をしない Fold 率（Break-even Fold Frequency）= 出す額 ÷（Pot + 出す額）。
 * pot は今取れる Pot、risk は今から出す額。docs/research/02 §5 の F = B / (P + B)。
 * 必要な Fold 率は数学で、相手が実際に何 % Fold するかは推定（同じ確からしさで扱わない）。
 */
export function breakEvenFoldFrequency(risk: number, pot: number): number {
  if (risk <= 0) return 0;
  return risk / (pot + risk);
}
