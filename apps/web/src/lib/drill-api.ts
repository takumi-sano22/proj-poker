// Targeted Drill の API（#117・docs/07 §7・D105・D110・D116）。型はサーバーの応答のうち、画面が使う項目だけを写す。
// - startDrill: 元の Hand の Hero の判断（Pass A の Review があるもの）から Drill の Hand を始める。応答は Hand の開始と同じ形に
//   Drill の説明（drill）を足したもの。以降の操作・SSE・Review は通常の Hand の API を Drill の handId で使う
// - fetchDrills: Drill の一覧と、通常の Score と別の系列の集計（D105）
// 値は元の Hand の公開の事実と Drill の設定だけ（他者の札・Deck・seed・元の CPU の Hidden Persona は届かない）。
import { getJson, postJson, type StartHandResponse } from "./api.js";
import type { AbilityScore, ScoreValue } from "./learning-api.js";
import type { Assessment } from "./review-api.js";

/** 変形（一要素だけ変える）。opponent_tendency の presetId は Drill の設定（元の CPU の Persona ではない）。 */
export type DrillVariant =
  | { readonly kind: "effective_stack"; readonly factor: number }
  | { readonly kind: "bet_size"; readonly potFraction: number }
  | { readonly kind: "opponent_tendency"; readonly presetId: string };

/** 変形で変わった値（元 → Drill）。作り直せないときは null。 */
export type DrillChange =
  | {
      readonly kind: "effective_stack";
      readonly factor: number;
      readonly heroStackFrom: number;
      readonly heroStackTo: number;
    }
  | {
      readonly kind: "bet_size";
      readonly potFraction: number;
      readonly bettorId: string;
      readonly betFrom: number;
      readonly betTo: number;
    }
  | { readonly kind: "opponent_tendency"; readonly presetLabel: string }
  | null;

export interface DrillView {
  readonly drillId: string;
  readonly createdAt: string;
  readonly policyVersion: string;
  readonly source: { readonly handId: string; readonly decisionIndex: number };
  readonly variant: DrillVariant;
  readonly change: DrillChange;
  readonly drillHandId: string;
  /** 練習する判断の番号（Review の decisionIndex）。 */
  readonly decisionIndex: number;
}

export interface DrillSummary extends DrillView {
  readonly finished: boolean;
  readonly assessment: Assessment | null;
}

export interface DrillResults {
  readonly policyVersion: string;
  readonly drills: readonly DrillSummary[];
  /** 通常の Score と別の系列（練習した判断だけ）。 */
  readonly score: {
    readonly policyVersion: string;
    /** score の Learning Reset の時刻（無ければ null）。これより後に終わった Drill の Hand だけを数える。 */
    readonly since: string | null;
    readonly decisions: { readonly total: number; readonly reviewed: number };
    readonly overall: ScoreValue;
    readonly abilities: readonly AbilityScore[];
  };
}

export interface StartDrillResponse extends StartHandResponse {
  readonly drill: DrillView;
}

export function startDrill(
  handId: string,
  decisionIndex: number,
): Promise<StartDrillResponse> {
  return postJson<StartDrillResponse>("/api/drills", {
    handId,
    decisionIndex,
  });
}

export function fetchDrills(): Promise<DrillResults> {
  return getJson<DrillResults>("/api/drills");
}
