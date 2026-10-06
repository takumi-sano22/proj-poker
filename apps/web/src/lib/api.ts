// Runtime の Hand API（D73: Hero の Action は REST、卓の状態は SSE）。ブラウザは同一 origin の /api だけを呼ぶ（D67）。
import type { HeroView, PhysicalAction } from "@proj-poker/engine";

/** 卓に座る Player の表示情報（POST /api/hands の players）。 */
export interface TablePlayer {
  readonly playerId: string;
  readonly displayName: string;
  readonly kind: "hero" | "cpu";
}

/**
 * Hand から見た Session の状態（D80。サーバーの SessionStatus と同じ形）。
 * - in_hand: Hand の途中
 * - ready_for_next_hand: Hand が終わり、Stack を持ち越して次 Hand を始められる
 * - ended: Session が終わった（hero_busted: Hero が Bust / hero_last_standing: CPU が全員 Bust し Hero が勝ち残った /
 *   ai_outage: CPU の障害のダイアログで Session 終了を選んだ。その Hand は途中で打ち切られている）
 */
export type SessionStatus =
  | { readonly state: "in_hand" }
  | { readonly state: "ready_for_next_hand" }
  | {
      readonly state: "ended";
      readonly reason: "hero_busted" | "hero_last_standing" | "ai_outage";
    };

/**
 * CPU が判断を返せなかった障害の種類（D86。サーバーの OutageKind と同じ）。
 * timeout: 時間内に返らなかった / unauthenticated: 未ログイン / usage_limit: 利用枠の上限 / error: それ以外
 */
export type OutageKind =
  "timeout" | "unauthenticated" | "usage_limit" | "error";

/**
 * CPU の障害の状態（サーバーの OutageStatus と同じ形）。どの CPU の手番か・種類だけで、内部のエラー本文は届かない。
 * revision は障害が起きる・解けるたびに進む（新しい方を残す・選択で送り返す）。
 */
export interface OutageStatus {
  readonly revision: number;
  readonly current: {
    readonly playerId: string;
    readonly kind: OutageKind;
  } | null;
}

/** 障害の後の続け方: Retry / Emergency Bot で続行 / Session 終了（D86）。 */
export type OutageChoice = "retry" | "emergency_bot" | "end_session";

export interface StartHandResponse {
  readonly handId: string;
  readonly players: readonly TablePlayer[];
  readonly view: HeroView;
  readonly session: SessionStatus;
  readonly outage: OutageStatus;
}

/** Hero の Action と、障害の続け方の選択の応答。 */
export interface HeroActionResponse {
  readonly view: HeroView;
  readonly session: SessionStatus;
  readonly outage: OutageStatus;
}

/** サーバーが返す失敗の種類。network は応答が無かった（届かなかった）場合。 */
export type ApiErrorKind =
  | "stale_view"
  | "stale_outage"
  | "not_actor"
  | "hand_complete"
  | "illegal_action"
  | "hand_not_found"
  | "invalid_input"
  | "network"
  | "unknown";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KNOWN_KINDS: readonly ApiErrorKind[] = [
  "stale_view",
  "stale_outage",
  "not_actor",
  "hand_complete",
  "illegal_action",
  "hand_not_found",
  "invalid_input",
];

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", "サーバーに届かなかった");
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, payload);
  return payload as T;
}

function toApiError(status: number, payload: unknown): ApiError {
  const error =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error: { kind?: unknown; message?: unknown } }).error
      : null;
  const kind = KNOWN_KINDS.find((k) => k === error?.kind) ?? "unknown";
  const message =
    typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  return new ApiError(kind, message);
}

/**
 * 次の Hand を始める。afterHandId は結果まで見た最後の Hand（まだ無ければ null）。
 * サーバーはそれより新しい Hand（進行中・まだ見ていない結果）があれば、新しく作らずその Hand を返す（開始の再送が冪等になる）。
 * Session が終わっていたら、サーバーが新しい Session として均等 Stack で始める。
 */
export function startHand(
  afterHandId: string | null,
): Promise<StartHandResponse> {
  return postJson<StartHandResponse>("/api/hands", { afterHandId });
}

/**
 * Hero の 1 回の手番の物理的な操作（宣言・Chip を出す・足す。した順）を送る（D90・D91）。裁定はサーバーの Ruling Engine が行い、
 * 結果は応答の view.log の DEALER_RULING に入る。手番でない操作もそのまま送る（サーバーが Out-of-Turn として保留する）。
 * lastSeq は Hero が見ていた View の log の最後の seq（古い画面・二重送信をサーバーが弾く）。
 * Canonical Action の入口（/actions）はサーバーに互換のために残っているが、画面からは使わない（docs/06 §4）。
 */
export function sendHeroPhysicalActions(
  handId: string,
  lastSeq: number,
  actions: readonly PhysicalAction[],
): Promise<HeroActionResponse> {
  return postJson<HeroActionResponse>(
    `/api/hands/${encodeURIComponent(handId)}/physical-actions`,
    { lastSeq, actions },
  );
}

/** CPU の障害の続け方を選ぶ。revision は表示していた障害の状態の revision（古いダイアログ・二重送信をサーバーが弾く）。 */
export function chooseOutage(
  handId: string,
  revision: number,
  choice: OutageChoice,
): Promise<HeroActionResponse> {
  return postJson<HeroActionResponse>(
    `/api/hands/${encodeURIComponent(handId)}/outage`,
    { revision, choice },
  );
}

export function handStreamUrl(handId: string): string {
  return `/api/hands/${encodeURIComponent(handId)}/stream`;
}
