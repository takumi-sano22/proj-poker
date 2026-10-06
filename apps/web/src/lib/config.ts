// 画面の表示の設定。値は暫定値（Open Item。永久仕様ではない）。
import { PHASE1_CASH_PRESET } from "@proj-poker/engine";

/**
 * Chip の額面と色の対応（Table Config の Preset。D92・OI-004 の暫定値）。額面・色は Config 側が持ち、
 * 表示コンポーネントには書かない。色の名前に対応する実際の色は styles.css のトークン（`--color-chip-<名前>`）が持つ。
 */
export const CHIP_DENOMINATIONS = PHASE1_CASH_PRESET.chipDenominations;

/**
 * CPU の手番がこれより長く続いたら「AI応答が遅延しています」を補足する（ミリ秒。docs/06 §11・D86）。
 * 暫定値（OI-001 の Latency Policy が決まるまでの仮置き）。#50 の実測（Claude の 1 回の判断は中央値 約 7.2 秒・p90 約 8.6 秒）で、
 * 普段の待ちでは出ず、p90 を超えて待つときに出る値にした。障害として止める上限（サーバーの OPPONENT_TIMEOUT_MS。30 秒）より短い。
 */
export const AI_DELAY_NOTICE_MS = 10_000;
