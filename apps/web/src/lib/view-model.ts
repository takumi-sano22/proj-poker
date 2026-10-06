// HeroView（サーバーが Hero に見える Event だけから作った Projection）を画面の部品へ写す純粋関数。
// ここでは合法性を判定しない（D40）。Legal Action と額の範囲はサーバーが返した legalActions をそのまま使い、
// 他者の札はサーバーが公開したもの（seats[].holeCards）以外を推測・保持しない（D28）。
import type { HandEvent, HeroView, SeatView } from "@proj-poker/engine";
import type { OutageKind, OutageStatus, SessionStatus } from "./api.js";
import {
  ACTION_TERMS,
  STREET_TERMS,
  TERMS,
  cardShortLabel,
  formatChips,
  termLabel,
} from "./format.js";

/** View の log の最後の seq。REST の lastSeq と、古い View を捨てる比較に使う。 */
export function lastSeqOf(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/**
 * REST の応答と SSE の Push のどちらが先に届いても、新しい View だけを残す。
 * - 別の Hand の View（前の Hand の遅れて届いた応答）は捨てる
 * - 同じ Hand なら log の seq が進んでいる方を採る（遅れて届いた古い View で巻き戻さない）
 */
export function selectLatestView(
  current: HeroView | null,
  incoming: HeroView,
  activeHandId: string | null,
): HeroView | null {
  if (incoming.handId !== activeHandId) return current;
  if (current === null || current.handId !== activeHandId) return incoming;
  return lastSeqOf(incoming) >= lastSeqOf(current) ? incoming : current;
}

/**
 * SSE の data を HeroView として受け取ってよいかの最小検査（受け側の whitelist）。
 * 形が合わないものは黙って描画に流さず、呼び出し側で捨てる。
 */
export function parseHeroView(raw: string): HeroView | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    typeof v["handId"] === "string" &&
    typeof v["viewerId"] === "string" &&
    (v["status"] === "in_progress" || v["status"] === "complete") &&
    typeof v["pot"] === "number" &&
    typeof v["bigBlind"] === "number" &&
    Array.isArray(v["seats"]) &&
    Array.isArray(v["board"]) &&
    Array.isArray(v["log"]);
  return ok ? (value as HeroView) : null;
}

/** どの Hand から見た Session の状態か。 */
export interface HandSessionStatus {
  readonly handId: string;
  readonly status: SessionStatus;
}

/**
 * REST の応答と SSE の session イベントのどちらが先に届いても、Hand 終了後の状態を残す。
 * - 別の Hand の状態（前の Hand の遅れて届いた応答）は捨てる
 * - 同じ Hand で Hand 終了後の状態（ready_for_next_hand / ended）を受け取った後は、遅れて届いた in_hand で戻さない
 */
export function selectSessionStatus(
  current: HandSessionStatus | null,
  incoming: HandSessionStatus,
  activeHandId: string | null,
): HandSessionStatus | null {
  if (incoming.handId !== activeHandId) return current;
  if (current === null || current.handId !== activeHandId) return incoming;
  return current.status.state === "in_hand" ? incoming : current;
}

/** SSE の session イベントの data を受け取ってよいかの検査（受け側の whitelist）。知っている項目だけで組み直す。 */
export function parseSessionStatus(raw: string): SessionStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v["state"]) {
    case "in_hand":
      return { state: "in_hand" };
    case "ready_for_next_hand":
      return { state: "ready_for_next_hand" };
    case "ended":
      return v["reason"] === "hero_busted" ||
        v["reason"] === "hero_last_standing" ||
        v["reason"] === "ai_outage"
        ? { state: "ended", reason: v["reason"] }
        : null;
    default:
      return null;
  }
}

/** どの Hand から見た障害の状態か。 */
export interface HandOutageStatus {
  readonly handId: string;
  readonly status: OutageStatus;
}

/**
 * REST の応答と SSE の outage イベントのどちらが先に届いても、新しい障害の状態を残す。
 * - 別の Hand の状態（前の Hand の遅れて届いた応答）は捨てる
 * - 同じ Hand なら revision が進んでいる方を採る（遅れて届いた古い状態でダイアログを出し直さない・消さない）
 */
export function selectOutageStatus(
  current: HandOutageStatus | null,
  incoming: HandOutageStatus,
  activeHandId: string | null,
): HandOutageStatus | null {
  if (incoming.handId !== activeHandId) return current;
  if (current === null || current.handId !== activeHandId) return incoming;
  return incoming.status.revision >= current.status.revision
    ? incoming
    : current;
}

const OUTAGE_KINDS: readonly OutageKind[] = [
  "timeout",
  "unauthenticated",
  "usage_limit",
  "error",
];

/** SSE の outage イベントの data を受け取ってよいかの検査（受け側の whitelist）。知っている項目だけで組み直す。 */
export function parseOutageStatus(raw: string): OutageStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const revision = v["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
    return null;
  }
  const current = v["current"];
  if (current === null) return { revision, current: null };
  if (typeof current !== "object" || current === undefined) return null;
  const c = current as Record<string, unknown>;
  const playerId = c["playerId"];
  const kind = OUTAGE_KINDS.find((k) => k === c["kind"]);
  if (typeof playerId !== "string" || kind === undefined) return null;
  return { revision, current: { playerId, kind } };
}

/** 障害の種類ごとの、ダイアログの説明（内部実装の名前・エラー本文は出さない。docs/06 §11）。 */
export function outageReasonText(kind: OutageKind): string {
  switch (kind) {
    case "timeout":
      return "応答が時間内に返りませんでした。";
    case "unauthenticated":
      return "AI にログインしていないため、判断を受け取れませんでした。ログインし直してから「もう一度試す」を選んでください。";
    case "usage_limit":
      return "AI の利用枠の上限に達したため、判断を受け取れませんでした。枠が戻ってから「もう一度試す」か、Emergency Bot で続けてください。";
    case "error":
      return "AI の呼び出しが失敗し、判断を受け取れませんでした。";
  }
}

/**
 * CPU の手番を待っている間の案内（docs/06 §11）。通常は「<CPU 名> の手番…」だけにし、
 * 長く待っているとき（delayed）だけ「AI応答が遅延しています」を補足する。内部実装（どの API を呼んでいるか）は出さない。
 */
export function waitingMessage(
  actorName: string | null,
  delayed: boolean,
): string {
  const turn = actorName === null ? "進行中…" : `${actorName} の手番…`;
  return delayed ? `${turn}（AI応答が遅延しています）` : turn;
}

/** Blind を払った Player（公開 Event の BLIND_POSTED から読む。位置を自前で計算しない）。 */
export function blindsOf(view: HeroView): ReadonlyMap<string, "small" | "big"> {
  const blinds = new Map<string, "small" | "big">();
  for (const e of view.log) {
    if (e.type === "BLIND_POSTED") blinds.set(e.playerId, e.blind);
  }
  return blinds;
}

export function heroSeatOf(view: HeroView): SeatView | undefined {
  return view.seats.find((s) => s.playerId === view.viewerId);
}

/**
 * Fast Forward を使える局面か（D12）。Hero が Fold した後（または Hand から外れている間）の、Hand の途中だけ。
 * 判定の正本はサーバー（外れていれば not_spectating で拒否する）。ここは操作を出すかどうかの目安で、合法性の判定ではない。
 */
export function canFastForward(view: HeroView): boolean {
  if (view.status === "complete") return false;
  const hero = heroSeatOf(view);
  return hero === undefined || hero.folded;
}

/**
 * Fast Forward の説明（常に出す）。縮まるのは CPU の思考の待ち（演出）だけで、AI の応答時間そのものは縮まない（D93）。
 * 速くなると誤解させないよう、AI の判断を待つ間の案内（「<CPU 名> の手番…」）は変えずに、この文で伝える。
 */
export const FAST_FORWARD_NOTE =
  "CPU の思考の待ちを短くします。AI の応答を待つ時間そのものは短くなりません。";

/**
 * 卓の中心から見た席の向き（単位円上の x / y。画面座標なので y は下向きが正）。
 * Hero を画面下の中央に置き、そこから席順（時計回り）に並べる。半径は画面幅ごとに CSS が決める。
 */
export interface SeatDirection {
  readonly x: number;
  readonly y: number;
}

export function seatDirections(
  seatCount: number,
  heroIndex: number,
): SeatDirection[] {
  const directions: SeatDirection[] = [];
  for (let i = 0; i < seatCount; i++) {
    const offset = (i - heroIndex + seatCount) % seatCount;
    // 90° が画面の真下。席順（時計回り）に角度を増やすと、画面上では下 → 左 → 上 → 右と回る。
    const angle = ((90 + (offset * 360) / seatCount) * Math.PI) / 180;
    directions.push({ x: round3(Math.cos(angle)), y: round3(Math.sin(angle)) });
  }
  return directions;
}

function round3(n: number): number {
  // -0 を 0 に揃える（表示・比較で紛らわしいため）
  return Math.round(n * 1000) / 1000 + 0;
}

/**
 * Hero の操作への Dealer の裁定のうち、卓に反映して見せるもの（docs/06 §6 の RULING の状態。文言は dealer-feedback.ts）。
 * - pending: 手番でない操作として保留中（Hero の手番が来たら拘束か撤回かを裁定する。保留中は次の操作を送れない）
 * - action: Canonical Action に決まった。action はその結果の ACTION_TAKEN（額を含む）
 * - no_action: Action は決まらなかった（相手の Bet があるときの Check の宣言・撤回した Out-of-Turn）。Hero が選び直す
 */
export type HeroRulingStatus =
  | { readonly kind: "pending" }
  | {
      readonly kind: "action";
      readonly action: Extract<HandEvent, { type: "ACTION_TAKEN" }>;
    }
  | { readonly kind: "no_action" };

/**
 * Hero 欄に出す直近の Hero への裁定の、log の中の位置（公開 Event の DEALER_RULING から読む。裁定をクライアントで判定しない）。
 * 出さないときは null。
 * - Hand の終了後は出さない
 * - 保留（out_of_turn）は、Street が進んでも裁定されるまで出す（保留中は次の操作を送れないので、理由が見えている必要がある）
 * - それ以外は、Hero の Action で Street が進んでも、次の Street で Hero の手番が来るまでは出す
 *   （Call で Street が閉じると、Street で絞ると裁定が見える前に消えてしまうため）。次の Street で Hero の手番が来たら、
 *   前の Street の裁定は新しい判断の邪魔になるので消す（進行ログには残る）
 */
export function latestHeroRulingIndex(view: HeroView): number | null {
  if (view.status !== "in_progress") return null;
  const index = view.log.findLastIndex(
    (e) => e.type === "DEALER_RULING" && e.playerId === view.viewerId,
  );
  const ruling = view.log[index];
  if (ruling?.type !== "DEALER_RULING") return null;
  if (
    ruling.outcome !== "out_of_turn" &&
    ruling.street !== view.street &&
    view.legalActions !== null
  ) {
    return null;
  }
  return index;
}

/** 直近の Hero への裁定の状態（出す位置は latestHeroRulingIndex と同じ）。 */
export function heroRulingStatus(view: HeroView): HeroRulingStatus | null {
  const index = latestHeroRulingIndex(view);
  if (index === null) return null;
  const ruling = view.log[index];
  if (ruling?.type !== "DEALER_RULING") return null;
  // 保留が解けるのは同じ Player の次の DEALER_RULING（basis: pending_out_of_turn）だけなので、最後の裁定で分かる。
  if (ruling.outcome === "out_of_turn") return { kind: "pending" };
  if (ruling.outcome === "no_action") return { kind: "no_action" };
  // outcome が action なら、同じ追記の直後の Event がその ACTION_TAKEN。
  const next = view.log[index + 1];
  return next?.type === "ACTION_TAKEN" && next.playerId === ruling.playerId
    ? { kind: "action", action: next }
    : null;
}

/**
 * Hero の操作の下書きを作り直す単位。Hand・Street が変わるか、Hero への裁定が 1 つ増える（送った操作が裁定された）たびに変わる。
 * CPU の行動だけでは変わらないので、手番を待つ間に組んだ操作は CPU が動いても消えない。
 */
export function operationKey(view: HeroView): string {
  const rulings = view.log.filter(
    (e) => e.type === "DEALER_RULING" && e.playerId === view.viewerId,
  ).length;
  return `${view.handId}:${view.street}:${rulings}`;
}

/** Hand のログ 1 行。読めない Event（Hero に届かない種別）は null。 */
export function describeEvent(
  event: HandEvent,
  nameOf: (playerId: string) => string,
): string | null {
  switch (event.type) {
    case "HAND_STARTED":
      return `Hand 開始（ブラインド ${formatChips(event.smallBlind)} / ${formatChips(event.bigBlind)}）`;
    case "BLIND_POSTED": {
      const term = event.blind === "small" ? TERMS.smallBlind : TERMS.bigBlind;
      return `${nameOf(event.playerId)}: ${termLabel(term)} ${formatChips(event.amount)}`;
    }
    case "HOLE_CARD_DEALT":
      return `${nameOf(event.playerId)} に配られた札: ${event.cards.map(cardShortLabel).join(" ")}`;
    case "ACTION_TAKEN":
      return `${nameOf(event.playerId)}: ${describeAction(event)}`;
    case "BOARD_DEALT":
      return `${termLabel(STREET_TERMS[event.street])}: ${event.cards.map(cardShortLabel).join(" ")}`;
    case "CARDS_TABLED":
      return `${termLabel(TERMS.showdown)} ${nameOf(event.playerId)}: ${event.cards.map(cardShortLabel).join(" ")}`;
    case "UNCALLED_BET_RETURNED":
      return `${nameOf(event.playerId)} に${termLabel(TERMS.uncalledBet)} ${formatChips(event.amount)} を返却`;
    case "POT_AWARDED":
      return event.awards
        .map(
          (a) =>
            `${nameOf(a.playerId)} が${termLabel(TERMS.pot)} ${formatChips(a.amount)} を獲得`,
        )
        .join(" / ");
    case "HAND_FINISHED":
      return "Hand 終了";
    case "DECK_SHUFFLED":
    case "AI_ACTION_INVALID":
    case "AI_FALLBACK_USED":
    case "SESSION_STARTED":
    case "SESSION_ENDED":
    case "HAND_ABORTED":
    case "EMERGENCY_BOT_ENGAGED":
      // engine / system Visibility の Event。Hero の View には入らない（届いても表示しない）。
      return null;
    case "PLAYER_DECLARED":
    case "PHYSICAL_CHIP_ACTION":
    case "DEALER_RULING":
      // Hero の操作と Dealer の裁定（#64）。裁定は Dealer Feedback（dealer-feedback.ts）として分類ごとに別の行にするので、
      // ここでは行にしない（HandLog が DEALER_RULING の位置で dealerFeedbackAt を呼ぶ）。操作は裁定の文言に含める。
      // 裁定の結果の Chip の動きは、続く ACTION_TAKEN の行に出る。
      return null;
  }
}

/** Action を「日本語（標準 Term） 実額」の 1 句にする（例: 「レイズ（Raise） 30 まで」）。 */
export function describeAction(
  event: Pick<
    Extract<HandEvent, { type: "ACTION_TAKEN" }>,
    "action" | "amount" | "toAmount" | "allIn"
  >,
): string {
  const label = termLabel(ACTION_TERMS[event.action]);
  // All-in になった Call / Bet / Raise には印を付ける（all_in 自体はラベルが表す）。
  const allInMark =
    event.allIn && event.action !== "all_in" ? "（All-in）" : "";
  switch (event.action) {
    case "fold":
    case "check":
      return label;
    case "call":
      return `${label} ${formatChips(event.amount)}${allInMark}`;
    case "bet":
      return `${label} ${formatChips(event.toAmount)}${allInMark}`;
    case "raise":
    case "all_in":
      return `${label} ${formatChips(event.toAmount)} まで${allInMark}`;
  }
}
