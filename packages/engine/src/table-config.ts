// 卓の設定（Blind・Rule Profile）と Phase 1 の暫定 Preset。
// Chip は「最小単位の整数（number）」で表す。Blind・Stack・Bet はすべて同じ単位で持ち、浮動小数は使わない
// （暫定。docs/11 OI-011。Chip 総量の保存〔INV-TEST-002 / 005〕を完全一致で検証できるようにするため）。

/** 卓の Betting 設定。Rule Profile は ID だけを持ち、HAND_STARTED に残す（docs/02 §3）。 */
export interface TableConfig {
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

/**
 * Phase 1 の暫定 Preset。全員 100BB の均等 Stack を前提にする（D70）。
 * 値は OI-004（Chip Preset）・OI-008（Rule Profile の範囲）・OI-011（Chip の数値表現）の暫定値で、永久仕様ではない。
 */
export const PHASE1_CASH_PRESET: TableConfig & {
  readonly startingStack: number;
} = {
  ruleProfile: "phase1_provisional_v0",
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
};

/** 1 Hand に座れる人数。Phase 1 は 6-max（docs/08 §3）で、Heads-Up も同じ規則で扱う。 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Chip 金額として妥当か（0 以上の安全な整数。OI-011）。 */
export function isChipAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
