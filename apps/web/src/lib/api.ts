// Runtime の Hand API（D73: Hero の Action は REST、卓の状態は SSE）。ブラウザは同一 origin の /api だけを呼ぶ（D67）。
import type { HeroView, PlayerAction } from "@proj-poker/engine";

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
 * - ended: Session が終わった（hero_busted: Hero が Bust / hero_last_standing: CPU が全員 Bust し Hero が勝ち残った）
 */
export type SessionStatus =
  | { readonly state: "in_hand" }
  | { readonly state: "ready_for_next_hand" }
  | {
      readonly state: "ended";
      readonly reason: "hero_busted" | "hero_last_standing";
    };

export interface StartHandResponse {
  readonly handId: string;
  readonly players: readonly TablePlayer[];
  readonly view: HeroView;
  readonly session: SessionStatus;
}

export interface HeroActionResponse {
  readonly view: HeroView;
  readonly session: SessionStatus;
}

/** サーバーが返す失敗の種類。network は応答が無かった（届かなかった）場合。 */
export type ApiErrorKind =
  | "stale_view"
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

/** lastSeq は Hero が見ていた View の log の最後の seq（古い画面・二重送信をサーバーが弾く）。 */
export function sendHeroAction(
  handId: string,
  lastSeq: number,
  action: PlayerAction,
): Promise<HeroActionResponse> {
  return postJson<HeroActionResponse>(
    `/api/hands/${encodeURIComponent(handId)}/actions`,
    { lastSeq, action },
  );
}

export function handStreamUrl(handId: string): string {
  return `/api/hands/${encodeURIComponent(handId)}/stream`;
}
