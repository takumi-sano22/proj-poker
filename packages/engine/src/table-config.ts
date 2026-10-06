// 卓の設定（Blind・Rule Profile）と Phase 1 の暫定 Preset。
// Chip は「最小単位の整数（number）」で表す。Blind・Stack・Bet はすべて同じ単位で持ち、浮動小数は使わない
// （D74。Chip 総量の保存〔INV-TEST-002 / 005〕を完全一致で検証できるようにするため）。
import { DEFAULT_CHIP_DENOMINATIONS, type ChipDenomination } from "./chips.js";

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

/**
 * Hand と Hand の間で Button を進める規則（Rule Profile の設定値。docs/02 §3）。
 * - simple_moving: 前 Hand の Button から時計回りで、次 Hand に座っている（Stack が残った）最初の Player へ進める。
 *   Bust した席は飛ばし、Dead Button は使わない（前 Button 本人が Bust したときも同じ規則）
 * 値は OI-008（Live Ruling の範囲）の暫定値で、永久仕様ではない（D80）。
 */
export type ButtonRule = "simple_moving";

/**
 * Hero の物理的な操作（PhysicalAction）を Canonical Action に裁定する規則（Rule Profile の設定値。docs/02 §3・§4）。
 * 裁定するのは Ruling Engine（ruling.ts）。物理的な誤操作をするのは Hero だけ（D91）。
 * 値はすべて OI-008（Live Ruling の範囲）の暫定値で、永久仕様ではない。TDA（docs/research/01 §4〜§9）に沿う。
 */
export interface RulingRules {
  /**
   * Chip 1 枚で、その Chip を除くと何も出していない場合（Oversized Chip）。
   * - call_unless_raise_declared: 相手の Bet があれば、Raise の宣言が先に無い限り Call（Chip が Call 額を超えていても）。
   *   相手の Bet が無ければ、その Chip の額の Bet（Bet の最小額に満たなければ最小額に寄せる）。D91・TDA
   */
  readonly oversizedChip: "call_unless_raise_declared";
  /**
   * 宣言なしで Chip を複数回に分けて出した場合（String Bet / Raise）。
   * - first_motion_only: 最初の 1 回（chip_push）で出した量だけで裁定し、2 回目以降（chip_add）は Hero へ返す。D91・TDA
   */
  readonly stringBet: "first_motion_only";
  /**
   * 宣言なしで Chip を複数枚、1 回で出した場合（Multiple Chip）。
   * - tda_every_chip_and_half_raise: 相手の Bet があり、どの 1 枚を除いても Call 額に足りなくなる（全部の Chip が Call に要る）なら Call。
   *   そうでなければ上乗せ（出した後の額 − 最高額）で決める。直近の Full Raise 幅以上なら出した額の Raise、
   *   その 50% 以上なら最小 Raise まで足させる、50% 未満なら Call（相手の Bet が無い BB の Option では Check）で超過分は返す。
   *   最高額が 0（誰も Bet していない）なら出した額の Bet（最小額に満たなければ最小額に寄せる）。TDA の Multiple Chip / 50% 規則
   */
  readonly multipleChip: "tda_every_chip_and_half_raise";
  /**
   * 宣言（Declare）の扱い。
   * - declaration_first_nearest_legal: 宣言と Chip は先にした方が Action を決める（宣言が Chip より後なら Chip で裁定し、宣言は採らない）。
   *   宣言が 2 つ以上あれば最初の宣言が拘束する。宣言の額は Legal Action の最も近い Action に寄せる:
   *   最小額未満 → 最小 Bet / 最小 Raise、Stack 以上 → All-in、Raise できない局面（再開していない等）の Raise → Call、
   *   Bet と Raise の言い違いは同じ意図として扱う、Call 額 0 の Call → Check。相手の Bet があるときの Check は採らず、
   *   Action を決めないで Hero に選び直させる。額なしの Bet / Raise の宣言は、最初の 1 回の Chip（最初の 1 回がちょうど Call 額なら、
   *   続く 1 回まで）の額で決め、最小額に満たなければ最小額まで足させる。TDA（宣言の拘束・Raise の方法）
   */
  readonly declaration: "declaration_first_nearest_legal";
  /**
   * 手番でない Hero の Action（Out-of-Turn）。
   * - bind_unless_action_changes: 手番を正しい Player へ戻して警告し、OOT の操作を保留する。Hero の手番が来た時点で、
   *   同じ Street の最高額が OOT の時点から変わっていなければ（間の Player が Check・Call・Fold だけなら）保留した操作を拘束として裁定し、
   *   変わっていれば（Bet・Raise・最高額を上げる All-in があった、または Street が進んだ）撤回して Hero に選び直させる。D91・TDA
   *   TDA は「OOT の Fold は状況が変わっても拘束」とするが、D91 は「変われば撤回できる」なので、この版では Fold も撤回できる
   */
  readonly outOfTurn: "bind_unless_action_changes";
}

/**
 * 卓の Betting 設定。Rule Profile は ID と、Engine が分岐に使う設定値を持つ（docs/02 §3）。
 * Hand の中で使う設定値（Blind・oddChipRule・reopenRule）は HAND_STARTED に残す。buttonRule は Hand と Hand の間
 * （nextHandSeating）でだけ使い、その結果は次 Hand の HAND_STARTED の席順・buttonPlayerId に残るので Event には持たせない。
 * chipDenominations は Chip の額面と色（D92）。Pot・Stack の額の計算には使わず、Event にも持たせない
 * （Ruling Engine が、Hero が出した Chip が額面にあるかと Oversized Chip の判定に使う）。
 * ruling は Hero の物理的な操作の裁定規則。裁定の結果は Canonical Action（ACTION_TAKEN）として残り、Rule Profile の ID
 * （ruleProfile）で版が分かるので、Event には項目を足さない（buttonRule と同じ扱い。裁定ごとの記録は DEALER_RULING。D90）。
 */
export interface TableConfig {
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly oddChipRule: OddChipRule;
  readonly reopenRule: ReopenRule;
  readonly buttonRule: ButtonRule;
  readonly chipDenominations: readonly ChipDenomination[];
  readonly ruling: RulingRules;
}

/**
 * 暫定の Cash Preset。ruleProfile は Rule Profile の版つき ID で、Ruling の規則を足したので phase1_provisional_v0 から
 * phase4_provisional_v1 に上げた（#63。phase1_provisional_v0 で保存済みの Hand は Ruling を使っていない）。
 * startingStack は Session 開始時に全員へ配る Stack（100BB）で、
 * 2 Hand 目以降は前 Hand の Stack を持ち越す（Bust した Player は退席。D80）。
 * 値は OI-004（Chip Preset。額面は D92）・OI-008（Rule Profile の範囲）の暫定値で、永久仕様ではない（Chip を整数で持つこと自体は D74）。
 */
export const PHASE1_CASH_PRESET: TableConfig & {
  readonly startingStack: number;
} = {
  ruleProfile: "phase4_provisional_v1",
  smallBlind: 1,
  bigBlind: 2,
  oddChipRule: "first_left_of_button",
  reopenRule: "cumulative_full_raise",
  buttonRule: "simple_moving",
  chipDenominations: DEFAULT_CHIP_DENOMINATIONS,
  ruling: {
    oversizedChip: "call_unless_raise_declared",
    stringBet: "first_motion_only",
    multipleChip: "tda_every_chip_and_half_raise",
    declaration: "declaration_first_nearest_legal",
    outOfTurn: "bind_unless_action_changes",
  },
  startingStack: 200,
};

/** 1 Hand に座れる人数。NLHE Cash の 2〜8 人（#33）で、Heads-Up も同じ規則で扱う。標準 Preset は 6-max（docs/08 §3）。 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** Chip 金額として妥当か（0 以上の安全な整数。D74）。 */
export function isChipAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
