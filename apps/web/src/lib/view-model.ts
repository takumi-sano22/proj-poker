// HeroView（サーバーが Hero に見える Event だけから作った Projection）を画面の部品へ写す純粋関数。
// ここでは合法性を判定しない（D40）。Legal Action と額の範囲はサーバーが返した legalActions をそのまま使い、
// 他者の札はサーバーが公開したもの（seats[].holeCards）以外を推測・保持しない（D28）。
import type {
  HandEvent,
  HeroView,
  LegalAction,
  SeatView,
} from "@proj-poker/engine";
import type { SessionStatus } from "./api.js";
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
        v["reason"] === "hero_last_standing"
        ? { state: "ended", reason: v["reason"] }
        : null;
    default:
      return null;
  }
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

/** Bet / Raise の額の候補（Preset）。amount はこの Street の合計額（to 額）。 */
export interface SizingPreset {
  readonly key: string;
  readonly label: string;
  readonly amount: number;
}

/**
 * Preset の額を出す。Pot 比は「Call した後の Pot」に対する Raise 幅で、to 額 = currentBet + 比率 × (pot + toCall)。
 * サーバーが返した min / max に丸めるだけで、範囲そのものはクライアントで決めない。
 */
export function sizingPresets(
  view: HeroView,
  toCall: number,
  range: Extract<LegalAction, { type: "bet" | "raise" }>,
): SizingPreset[] {
  const potAfterCall = view.pot + toCall;
  const clamp = (n: number) => Math.min(range.max, Math.max(range.min, n));
  const byPot = (ratio: number) =>
    clamp(view.currentBet + Math.round(potAfterCall * ratio));
  return [
    { key: "min", label: "最小（Min）", amount: range.min },
    { key: "half", label: "½ Pot", amount: byPot(0.5) },
    { key: "three-quarters", label: "¾ Pot", amount: byPot(0.75) },
    { key: "pot", label: "Pot", amount: byPot(1) },
  ];
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
      // engine Visibility の Event。Hero の View には入らない（届いても表示しない）。
      return null;
  }
}

function describeAction(
  event: Extract<HandEvent, { type: "ACTION_TAKEN" }>,
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
