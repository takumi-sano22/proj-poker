// #76 の PoC の固定 Spot（Representative River / Turn / Small Flop）を AnalysisSpot にしたもの。
// テスト・録画・手動スモークで同じ入力を使う。額は Chip（PHASE1_CASH_PRESET の BB = 2）で、PoC の BB 表記の 2 倍。
import { parseCards, type Card } from "@proj-poker/engine";
import { DEFAULT_BET_TREE } from "../amaster97-adapter.js";
import { rangeFromNotation } from "../spot.js";
import type { AnalysisSpot } from "../types.js";

/** PoC の IP（後に行動する側）の Range。 */
export const POC_IP_RANGE =
  "AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,65s,AKo,AQo,AJo,KQo";

/** PoC の OOP（先に行動する側）の Range。 */
export const POC_OOP_RANGE =
  "TT,99,88,77,66,55,44,33,22,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,QJs,QTs,Q9s,JTs,J9s,T9s,T8s,98s,97s,87s,86s,76s,65s,54s,AQo,AJo,ATo,KQo,KJo,QJo";

function pocSpot(
  street: AnalysisSpot["street"],
  board: Card[],
  pot: number,
  effectiveStack: number,
): AnalysisSpot {
  return {
    street,
    playerCount: 2,
    mode: "cash",
    board,
    pot,
    effectiveStack,
    rakeRate: 0,
    ranges: {
      oop: rangeFromNotation(POC_OOP_RANGE, board, "#76 の PoC の OOP Range"),
      ip: rangeFromNotation(POC_IP_RANGE, board, "#76 の PoC の IP Range"),
    },
    betTree: DEFAULT_BET_TREE,
    assumptions: [],
  };
}

/** Representative River: Ks 7d 2c 4h 9s・Pot 24BB・Eff. Stack 32BB。 */
export const RIVER_SPOT = pocSpot(
  "river",
  parseCards("Ks 7d 2c 4h 9s"),
  48,
  64,
);

/** Representative Turn: Ks 7d 2c 4h・Pot 12BB・Eff. Stack 44BB。 */
export const TURN_SPOT = pocSpot("turn", parseCards("Ks 7d 2c 4h"), 24, 88);

/** Small Flop: Ks 7d 2c・Pot 6BB・Eff. Stack 20BB（Capability 外。Unsupported の確認用）。 */
export const FLOP_SPOT = pocSpot("flop", parseCards("Ks 7d 2c"), 12, 40);
