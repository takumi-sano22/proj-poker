// Range Model の Config（Position・Preflop の Action 列ごとの標準 Range と、Postflop の絞り込みの割合）。
// D08「標準 Range 推定＋重要 Spot で別 Range 想定を比較」のため、標準（standard）に加えて狭い（tight）・広い（loose）の
// 別の想定を同じ形で持つ。
//
// 中身はすべて暫定値（永久仕様にしない。運用と Review の品質評価を見て変える）。
// 根拠: docs/research/02_strategy_and_math.md §8（Early Position ほど Range は狭く、Late Position ほど広い。
// Button は Postflop で最後に Action できる）・§9（Preflop の Action ごとに Range を更新する）・§10（RFI / Limp / Cold Call /
// 3-bet / 4-bet / Blind Defense を区別する）。同 §8 のとおり「UTG は常に上位 X%」のような数字は RULE ではないので、
// ここの表記は Solver の出力や特定の Chart の転記ではなく、§8 の傾向に沿って 6-max・100BB の Cash を想定して置いた目安。
// 参考にした一般的な考え方の出典は docs/research/SOURCES.md の「Upswing Poker — Preflop Charts and Ranges」
// 「PokerStars Learn — Hand Ranges / Thinking in Ranges」。
// 表記の書き方は range.ts。

/** Range を決めるための席の名前（Button からの距離で決める。range-model.ts の positionName）。 */
export type PositionName = "UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB";

/**
 * 相手の Preflop の Action 列の分類（その相手の最後の Preflop の Action と、それより前の Raise の回数で決める）。
 * - open: 誰も Raise していないところで最初に Raise した（RFI。BB の Limp への Raise を含む）
 * - limp: 誰も Raise していないところで Call した（SB の Complete を含む）
 * - call_open: Raise 1 回に Call した（Cold Call・Blind Defense）
 * - three_bet: Raise 1 回に Raise した
 * - call_three_bet: Raise 2 回以上に Call した
 * - four_bet_plus: Raise 2 回以上に Raise した
 * - check_option: Raise の無い Pot で BB が Check した（Range を絞る材料が無い）
 * - not_acted: まだ Preflop で Action していない（Range を絞る材料が無い）
 */
export type PreflopSpot =
  | "open"
  | "limp"
  | "call_open"
  | "three_bet"
  | "call_three_bet"
  | "four_bet_plus"
  | "check_option"
  | "not_acted";

export interface RangeProfile {
  readonly id: string;
  /** 表示名（日本語 + 標準 Term）。 */
  readonly label: string;
  /** open の Range（Position ごと）。 */
  readonly open: Readonly<Record<PositionName, string>>;
  readonly limp: string;
  readonly callOpen: string;
  readonly threeBet: string;
  readonly callThreeBet: string;
  readonly fourBetPlus: string;
  /**
   * Postflop の簡易な絞り込み。その Street の Board での役の強さ（Made Hand の強さ。Draw は数えない）の上位から、
   * Bet / Raise なら betOrRaiseKeep、Call なら callKeep の割合の Combo を残す。Check では絞らない。
   */
  readonly postflop: {
    readonly betOrRaiseKeep: number;
    readonly callKeep: number;
  };
}

/** 標準の Range（暫定値）。Position ごとの open は Early から Late へ広げる。 */
export const STANDARD_RANGE_PROFILE: RangeProfile = {
  id: "standard",
  label: "標準（Standard）",
  open: {
    UTG: "55+, A9s+, A5s-A4s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo",
    HJ: "44+, A7s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo",
    CO: "22+, A2s+, K7s+, Q9s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, A9o+, KTo+, QTo+, JTo",
    BTN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o, 98o",
    SB: "22+, A2s+, K5s+, Q7s+, J7s+, T7s+, 97s+, 86s+, 75s+, 65s, 54s, A7o+, K9o+, QTo+, JTo",
    // BB が open になるのは Limp への Raise（Iso Raise）だけ。
    BB: "77+, ATs+, KTs+, QJs, AJo+, KQo",
  },
  limp: "22+, A2s+, K8s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, A8o+, KTo+, QTo+, JTo",
  callOpen:
    "22-JJ, A2s-AQs, K9s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, ATo-AQo, KJo+, QJo",
  threeBet: "TT+, AQs+, AQo+, A5s-A4s, KQs",
  callThreeBet: "77-QQ, AJs+, KQs, AKo",
  fourBetPlus: "QQ+, AKs, AKo",
  // 暫定値: Bet / Raise した相手は上位半分、Call した相手は下位 1/4 を外す。
  postflop: { betOrRaiseKeep: 0.5, callKeep: 0.75 },
};

/** 狭い想定（Tight。標準より参加を絞る相手）。暫定値。 */
export const TIGHT_RANGE_PROFILE: RangeProfile = {
  id: "tight",
  label: "狭い想定（Tight）",
  open: {
    UTG: "77+, ATs+, KQs, AQo+",
    HJ: "66+, A9s+, KJs+, QJs, AJo+, KQo",
    CO: "44+, A7s+, A5s-A4s, KTs+, QTs+, JTs, T9s, ATo+, KJo+",
    BTN: "22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 98s, 87s, 76s, A8o+, KTo+, QTo+, JTo",
    SB: "33+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KJo+, QJo",
    BB: "99+, AJs+, KQs, AQo+",
  },
  limp: "22-99, A2s-ATs, KTs+, QTs+, JTs, T9s, 98s, AJo-AQo, KQo",
  callOpen: "55-JJ, ATs-AQs, KTs+, QTs+, JTs, T9s, AJo-AQo, KQo",
  threeBet: "QQ+, AKs, AKo",
  callThreeBet: "TT-QQ, AQs+, AKo",
  fourBetPlus: "KK+, AKs",
  postflop: { betOrRaiseKeep: 0.35, callKeep: 0.6 },
};

/** 広い想定（Loose。標準より多く参加する相手）。暫定値。 */
export const LOOSE_RANGE_PROFILE: RangeProfile = {
  id: "loose",
  label: "広い想定（Loose）",
  open: {
    UTG: "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, ATo+, KJo+, QJo",
    HJ: "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 76s, 65s, A9o+, KTo+, QTo+, JTo",
    CO: "22+, A2s+, K4s+, Q6s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 54s, A5o+, K9o+, Q9o+, J9o+, T9o",
    BTN: "22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 95s+, 84s+, 74s+, 63s+, 53s+, 43s, A2o+, K5o+, Q7o+, J7o+, T7o+, 97o+, 87o, 76o",
    SB: "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q9o+, J9o+, T9o",
    BB: "55+, A8s+, K9s+, QTs+, JTs, ATo+, KJo+",
  },
  limp: "22+, A2s+, K2s+, Q6s+, J7s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A2o+, K9o+, Q9o+, J9o+, T9o",
  callOpen:
    "22+, A2s+, K5s+, Q8s+, J8s+, T7s+, 96s+, 85s+, 75s+, 64s+, 54s, A7o+, KTo+, QTo+, JTo",
  threeBet: "88+, ATs+, KJs+, AJo+, KQo, A5s-A2s, 76s, 65s",
  callThreeBet: "55-JJ, ATs+, KTs+, QJs, JTs, AQo+",
  fourBetPlus: "TT+, AQs+, AKo",
  postflop: { betOrRaiseKeep: 0.65, callKeep: 0.9 },
};

/** 重要 Spot で比べる Range の想定（D08）。先頭が標準。 */
export const RANGE_PROFILES: readonly RangeProfile[] = [
  STANDARD_RANGE_PROFILE,
  TIGHT_RANGE_PROFILE,
  LOOSE_RANGE_PROFILE,
];
