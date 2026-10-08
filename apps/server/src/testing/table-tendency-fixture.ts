// Review の Evidence に入れる Table Tendency（D122・#153）のテスト用の固定値。memory/table-tendency.ts が返す形をそのまま作る。
// 十分な項目（vpip・pfr）と保留の項目（aggression_frequency・showdown）を両方持つ。
import type { TableTendency } from "../memory/table-tendency.js";
import { PHASE7_TABLE_TENDENCY_V1 } from "../memory/table-tendency-policy.js";

const V = PHASE7_TABLE_TENDENCY_V1.version;

export const SAMPLE_TABLE_TENDENCY: TableTendency = {
  policyVersion: V,
  hands: 12,
  items: [
    {
      item: "vpip",
      policyVersion: V,
      numerator: 18,
      denominator: 60,
      hands: 12,
      sufficient: true,
    },
    {
      item: "pfr",
      policyVersion: V,
      numerator: 7,
      denominator: 60,
      hands: 12,
      sufficient: true,
    },
    {
      item: "aggression_frequency",
      policyVersion: V,
      numerator: 5,
      denominator: 15,
      hands: 6,
      sufficient: false,
    },
    {
      item: "showdown",
      policyVersion: V,
      numerator: 4,
      denominator: 12,
      hands: 12,
      sufficient: false,
    },
  ],
};

/** 項目をすべて保留にした Table Tendency（Evidence には入らない）。 */
export const INSUFFICIENT_TABLE_TENDENCY: TableTendency = {
  ...SAMPLE_TABLE_TENDENCY,
  items: SAMPLE_TABLE_TENDENCY.items.map((i) => ({ ...i, sufficient: false })),
};

/** 数えた Hand が 0 の Table Tendency（Session の最初の Hand）。 */
export const EMPTY_TABLE_TENDENCY: TableTendency = {
  policyVersion: V,
  hands: 0,
  items: SAMPLE_TABLE_TENDENCY.items.map((i) => ({
    ...i,
    numerator: 0,
    denominator: 0,
    hands: 0,
    sufficient: false,
  })),
};
