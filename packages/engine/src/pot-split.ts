// Split Pot の配分（端数込み）。純粋関数で、Chip は整数（D74）。
import type { PlayerChips } from "./hand-events.js";
import type { OddChipRule } from "./table-config.js";

/**
 * Pot を勝者へ分ける。割り切れない端数（Odd Chip）は Rule Profile の規則で 1 Chip ずつ配る（D75）。
 * winnersFromButton は Button の左から時計回りの順に並べた勝者の playerId。
 * 戻り値の Σ amount は必ず pot と一致する（Chip 総量の保存。INV-TEST-005）。
 */
export function splitPot(
  pot: number,
  winnersFromButton: readonly string[],
  rule: OddChipRule,
): PlayerChips[] {
  if (!Number.isSafeInteger(pot) || pot < 0) {
    throw new RangeError(`Pot は 0 以上の整数: ${pot}`);
  }
  if (winnersFromButton.length === 0) {
    throw new RangeError("勝者がいない");
  }
  const base = Math.floor(pot / winnersFromButton.length);
  const oddChips = pot - base * winnersFromButton.length;
  switch (rule) {
    case "first_left_of_button":
      // 端数は 勝者数 未満なので、先頭（Button の左に最も近い勝者）から 1 Chip ずつ配れば 1 周で足りる。
      return winnersFromButton.map((playerId, i) => ({
        playerId,
        amount: base + (i < oddChips ? 1 : 0),
      }));
  }
}
