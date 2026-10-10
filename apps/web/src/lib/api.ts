// Runtime の Hand API（D73: Hero の Action は REST、卓の状態は SSE）。ブラウザは同一 origin の /api だけを呼ぶ（D67）。
import { parseCurrentSession } from "./view-model.js";
import type {
  ActionType,
  AnteKind,
  BlindSchedule,
  Card,
  HeroView,
  ImportantSpotReason,
  PhysicalAction,
  Street,
  TournamentPresetId,
  TournamentResult,
} from "@proj-poker/engine";

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
  /** Fast Forward が入っているか（開始の再送・「卓に戻る」で、進行中の Hand の状態を画面へ戻すため）。 */
  readonly fastForward: boolean;
  /**
   * 開いた Hand の Session の種類（#190）。まだ結果を見ていない Hand・続いている Session は、求めた設定と違っても新しく作らずに
   * 返る（開始の再送を冪等にするため）ので、選んだ種類と比べて違えば Hero に伝える。Drill の応答には無い。
   */
  readonly sessionKind?: SessionRequest;
}

/**
 * 新しい Session に求める設定（サーバーの SessionRequest と同じ形。#183・D128）。Cash か、Tournament の Preset
 * （stt6_hand_count: 標準の 6-max STT〔Hand 数で Level が上がる〕/ stt6_time_base: プレイ時間で Level が上がる）。
 */
export type SessionRequest =
  | { readonly mode: "cash" }
  | { readonly mode: "tournament"; readonly presetId: TournamentPresetId };

/**
 * Home の照会（GET /api/session/current。D136・D144）の今の Session。状態と Session の種類だけ（Session ID・Hand ID・Stack は来ない）。
 * - in_hand: Hand の途中 / ready_for_next_hand: 次の Hand を始められる（再起動後の Resume を含む）
 * - ended: このプロセスで Session が終わった（再起動後は来ない）
 * 「続きから遊ぶ」は Hero の操作で startHand（POST /api/hands）を呼ぶ。照会の結果で自動的に開始しない。
 */
export interface CurrentSession {
  readonly state: "in_hand" | "ready_for_next_hand" | "ended";
  readonly kind: SessionRequest;
}

/**
 * 卓に出す Tournament の状況（サーバーの TournamentTableStatus と同じ形。#190）。この Hand の Level・Blind・Ante と次の Level、
 * この Hand までの Result（残人数・Elimination・順位・Payout）。値はすべて公開の情報で、Event Log からサーバーが都度計算したもの。
 */
export interface TournamentTableStatus {
  /** どの Hand の状況か（表示中の Hand と照らし合わせる）。 */
  readonly handId: string;
  readonly presetId: TournamentPresetId;
  readonly schedule: BlindSchedule;
  readonly level: number;
  readonly levelCount: number;
  readonly handNumber: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly anteKind: AnteKind;
  readonly ante: number;
  readonly nextLevel: {
    readonly level: number;
    readonly smallBlind: number;
    readonly bigBlind: number;
    readonly ante: number;
    /** hand_count は次の Level が始まる Hand の番号、time_base は要求の時点の残りのプレイ時間（ms。0 なら次の Hand から）。 */
    readonly until:
      | { readonly kind: "hand_count"; readonly handNumber: number }
      | { readonly kind: "time_base"; readonly remainingPlayMs: number };
  } | null;
  readonly result: TournamentResult;
}

/** 卓の Tournament の状況（GET）の URL。cash の Hand は { tournament: null }。 */
export function tournamentPath(handId: string): string {
  return `/api/hands/${encodeURIComponent(handId)}/tournament`;
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
  | "not_spectating"
  | "not_actor"
  | "hand_complete"
  | "illegal_action"
  | "hand_not_found"
  | "invalid_input"
  // Session の開始（#183）: 続く Session と違う設定・卓の人数に合わない Tournament の Preset
  | "session_mode_mismatch"
  | "tournament_unavailable"
  // Review の API（#84）
  | "hand_not_finished"
  | "decision_not_found"
  | "review_not_found"
  | "followup_in_progress"
  | "followup_limit"
  | "invalid_question"
  // Note / Tag の API（#115）
  | "not_found"
  // Drill の API（#117）
  | "review_required"
  | "drill_unavailable"
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
  "not_spectating",
  "not_actor",
  "hand_complete",
  "illegal_action",
  "hand_not_found",
  "invalid_input",
  "session_mode_mismatch",
  "tournament_unavailable",
  "hand_not_finished",
  "decision_not_found",
  "review_not_found",
  "followup_in_progress",
  "followup_limit",
  "invalid_question",
  "not_found",
  "review_required",
  "drill_unavailable",
];

export async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new ApiError("network", "サーバーに届かなかった");
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, payload);
  return payload as T;
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return sendJson<T>("POST", path, body);
}

export function deleteJson<T>(path: string): Promise<T> {
  return sendJson<T>("DELETE", path);
}

async function sendJson<T>(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
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
 * session は新しい Session に求める設定（#183。省略すると続く Session はそのまま、新しい Session は cash）。続く Session と違う設定は
 * session_mode_mismatch で拒否される。
 */
export function startHand(
  afterHandId: string | null,
  session?: SessionRequest,
): Promise<StartHandResponse> {
  return postJson<StartHandResponse>(
    "/api/hands",
    session === undefined ? { afterHandId } : { afterHandId, session },
  );
}

/**
 * 今の Session の状態を読む（D144。読むだけで Hand を始めない・進めない）。続けられる Session が無い、または知らない state・形の
 * 合わない応答（#230 で足す paused 等を含む）は null（「続きから遊ぶ」を出さない安全側。parseCurrentSession）。
 */
export async function fetchCurrentSession(): Promise<CurrentSession | null> {
  const body = await getJson<unknown>("/api/session/current");
  const session =
    typeof body === "object" && body !== null && "session" in body
      ? body.session
      : null;
  return parseCurrentSession(session);
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

/**
 * Fast Forward を入れる・切る（D12・D15・D93）。入れられるのは Hero が Fold した後の Hand の途中だけ（それ以外は not_spectating）。
 * 縮まるのは CPU の思考の待ち（演出）で、AI（Claude）の応答時間そのものは縮まない。Hand が終わるとサーバーが切る。
 */
export function setFastForward(
  handId: string,
  enabled: boolean,
): Promise<{ readonly fastForward: boolean }> {
  return postJson<{ readonly fastForward: boolean }>(
    `/api/hands/${encodeURIComponent(handId)}/fast-forward`,
    { enabled },
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

/**
 * Hero の User Read（判断の前の読み・意図。D112）を記録する。Hero の手番の間だけ受け付けられる（それ以外は not_actor）。
 * targetPlayerId は読みの対象の席。相手を特定しない読み・意図は null。卓の状態は変わらず、読みは view.log に入る。
 * lastSeq は最初に送ったときに見ていた View の値（応答だけが失われた記録の再送を、サーバーが stale_view で弾く）。
 */
export function recordUserRead(
  handId: string,
  lastSeq: number,
  targetPlayerId: string | null,
  text: string,
): Promise<{ readonly view: HeroView }> {
  return postJson<{ readonly view: HeroView }>(
    `/api/hands/${encodeURIComponent(handId)}/reads`,
    { lastSeq, targetPlayerId, text },
  );
}

export function handStreamUrl(handId: string): string {
  return `/api/hands/${encodeURIComponent(handId)}/stream`;
}

/** Replay の Hand 一覧の 1 行（サーバーの ReplayHandSummary と同じ形。値は Hero に見える Event だけから作られる）。 */
export interface ReplayHandSummary {
  readonly handId: string;
  readonly startedAt: string;
  /** HAND_FINISHED の無い Hand（進行中・内部エラーで止まった・打ち切った Hand）は null。 */
  readonly finishedAt: string | null;
  readonly complete: boolean;
  /** AI 障害の後に Session 終了を選んで打ち切った Hand（再起動後も残る）。 */
  readonly aborted: boolean;
  readonly bigBlind: number;
  readonly heroHoleCards: readonly Card[] | null;
  /** Hero の収支（実額）。未完了の Hand は null。 */
  readonly heroNet: number | null;
}

/** Hero の判断 1 つ（サーバーの ReplayDecision と同じ形）。stepIndex の step が判断の直前（Hero に手番が来た時点）の卓。 */
export interface ReplayDecision {
  readonly stepIndex: number;
  /** この Hand での Hero の判断の順番（0 始まり。Review の API の decisionIndex）。 */
  readonly decisionIndex: number;
  readonly street: Street;
  readonly action: ActionType;
  /** この Action で Stack から出した額。 */
  readonly amount: number;
  readonly toAmount: number;
  readonly allIn: boolean;
}

/** Jump to Important Spot の飛び先（サーバーの ReplayImportantSpot と同じ形。判断時点の情報だけから選ばれる）。 */
export interface ReplayImportantSpot {
  readonly stepIndex: number;
  readonly decisionIndex: number;
  readonly street: Street;
  readonly reasons: readonly ImportantSpotReason[];
}

/** 再生する 1 Hand。steps[i] は Hero に見える Event の先頭 i + 1 件までの Hero の視点（legalActions は常に null）。 */
export interface ReplayHand {
  readonly handId: string;
  readonly complete: boolean;
  /** AI 障害の後に Session 終了を選んで打ち切った Hand。 */
  readonly aborted: boolean;
  readonly players: readonly TablePlayer[];
  readonly steps: readonly HeroView[];
  /** Important Spot（判断の順）。 */
  readonly importantSpots: readonly ReplayImportantSpot[];
  /** Hero の判断のすべて（判断の順）。 */
  readonly decisions: readonly ReplayDecision[];
}

/** Replay の Hand 一覧（新しい順。進行中の Hand、続けて保存の新しい順〔論理順序。D117〕）。保存済みの Event だけから作られ、AI で作り直さない（D38）。 */
export async function fetchReplayHands(): Promise<
  readonly ReplayHandSummary[]
> {
  const body = await getJson<{ hands: readonly ReplayHandSummary[] }>(
    "/api/replay/hands",
  );
  return body.hands;
}

/** 1 Hand の再生の材料（Hero の視点の step の列）。 */
export function fetchReplayHand(handId: string): Promise<ReplayHand> {
  return getJson<ReplayHand>(`/api/replay/hands/${encodeURIComponent(handId)}`);
}
