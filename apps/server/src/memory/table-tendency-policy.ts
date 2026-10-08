// Table Tendency の Policy（D106・#141。docs/05 §5・docs/04 §12・OI-011）。卓全体の観察可能な傾向を public の Event だけから
// 作るときの項目・範囲・十分な Sample の基準を Version 付きで置く。
// ここにある数値はすべて OI-011 の暫定値で、確定ではない。Eval / Playtest の後に変えるときは、既存の Policy を書き換えず、
// Version を上げた Policy を足す（Table Tendency は保存しない Projection なので、同じ Event Log から Version ごとに作り直せる）。
// CPU の Private Hypothesis の Policy（memory-policy.ts）・Hero の弱点の Policy（learning/）とは別物で、型も共有しない
// （Table Tendency は個々の CPU の Private Memory を集約して作らない。D106）。
import type { StatId } from "@proj-poker/engine";

/**
 * Table Tendency の項目。
 * - Engine の Stats の定義（STAT_DEFINITIONS。public の Event だけを読む）のうち割合で読む指標を、viewer 以外の卓の参加者で合算したもの
 *   （vpip: looseness / pfr: Preflop の aggression / aggression_frequency: Postflop の aggression）
 * - showdown: 数えた Hand のうち、札を比べて決めた Pot（POT_AWARDED の showdown）があった Hand の割合（Hand 単位。viewer を含む卓全体）
 */
export type TableTendencyItemId =
  Extract<StatId, "vpip" | "pfr" | "aggression_frequency"> | "showdown";

export interface TableTendencyPolicy {
  readonly version: string;
  /** 持たせる項目（この順に返す）。 */
  readonly items: readonly TableTendencyItemId[];
  /** 数える範囲: 今の Session の、viewer が座っていた保存済みの Hand のうち、論理順序（ordinals.ord）で新しいものからこの数まで。 */
  readonly windowHands: number;
  /** 十分とみなす、項目の機会があった Hand の数の下限。 */
  readonly minHands: number;
  /** 十分とみなす、項目の機会（denominator）の数の下限。 */
  readonly minOpportunities: number;
}

/**
 * phase7_table_tendency_v1（数値はすべて OI-011 の暫定値で、確定ではない）。
 * - 範囲: 今の Session の、viewer が座っていた Hand の新しい 100 Hand（重みは掛けない）
 * - 十分: 項目の機会があった Hand が 10 以上、かつ機会の数が 20 以上
 */
export const PHASE7_TABLE_TENDENCY_V1: TableTendencyPolicy = {
  version: "phase7_table_tendency_v1",
  items: ["vpip", "pfr", "aggression_frequency", "showdown"],
  windowHands: 100,
  minHands: 10,
  minOpportunities: 20,
};

/** Version → Policy。Version を変えれば同じ Event Log から作り直せる。 */
export const TABLE_TENDENCY_POLICIES: Readonly<
  Record<string, TableTendencyPolicy>
> = {
  [PHASE7_TABLE_TENDENCY_V1.version]: PHASE7_TABLE_TENDENCY_V1,
};

export const DEFAULT_TABLE_TENDENCY_POLICY = PHASE7_TABLE_TENDENCY_V1;
