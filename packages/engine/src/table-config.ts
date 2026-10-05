// 卓の設定（Blind・Rule Profile）と Phase 1 の暫定 Preset。
// Chip は「最小単位の整数（number）」で表す。Blind・Stack・Bet はすべて同じ単位で持ち、浮動小数は使わない
// （D74。Chip 総量の保存〔INV-TEST-002 / 005〕を完全一致で検証できるようにするため）。

/**
 * Split Pot で割り切れない端数（Odd Chip）の配り方（Rule Profile の設定値。docs/02 §5）。
 * - first_left_of_button: Button の左から時計回りで最初の勝者から 1 Chip ずつ配る（Live Cash の一般的な規則）
 * 値は OI-008（Live Ruling の範囲）の暫定値で、永久仕様ではない（D75）。
 */
export type OddChipRule = "first_left_of_button";

/**
 * Short All-in の後に、行動済みの Player へ Raise を再開（Reopen）する規則（Rule Profile の設定値。docs/02 §3・§5）。
 * - cumulative_full_raise: TDA 準拠。Full Raise 未満の All-in だけでは再開しない。ただし、その Player が最後に
 *   行動した時点の最高額からの上乗せの合計が、直近の Full Raise 幅以上になったら再開する（累積 Short All-in）
 * 値は OI-008（Live Ruling の範囲）の暫定値で、永久仕様ではない（D79）。
 */
export type ReopenRule = "cumulative_full_raise";

/** 卓の Betting 設定。Rule Profile は ID と、Engine が分岐に使う設定値を持ち、HAND_STARTED に残す（docs/02 §3）。 */
export interface TableConfig {
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly oddChipRule: OddChipRule;
  readonly reopenRule: ReopenRule;
}

/**
 * Phase 1 の暫定 Preset。全員 100BB の均等 Stack を前提にする（D70）。
 * 値は OI-004（Chip Preset）・OI-008（Rule Profile の範囲）の暫定値で、永久仕様ではない（Chip を整数で持つこと自体は D74）。
 */
export const PHASE1_CASH_PRESET: TableConfig & {
  readonly startingStack: number;
} = {
  ruleProfile: "phase1_provisional_v0",
  smallBlind: 1,
  bigBlind: 2,
  oddChipRule: "first_left_of_button",
  reopenRule: "cumulative_full_raise",
  startingStack: 200,
};

/** 1 Hand に座れる人数。NLHE Cash の 2〜8 人（#33）で、Heads-Up も同じ規則で扱う。標準 Preset は 6-max（docs/08 §3）。 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** Chip 金額として妥当か（0 以上の安全な整数。D74）。 */
export function isChipAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
