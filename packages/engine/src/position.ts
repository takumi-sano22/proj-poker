// Position Engine: 前 Hand の結果から、次 Hand の席と Button を決める（docs/02 §5 Heads-Up Button/SB・3 人→Heads-Up 移行）。
// 純粋関数で、Event を発行しない。結果は次 Hand の startHand の入力（seats・buttonPlayerId）になり、
// HAND_STARTED に残るので、Hand と Hand の間の判断を Event Log から追える（D37）。
// SB・BB の位置は startHand が Button から決める（Heads-Up は Button = SB。docs/02 §7）ので、ここでは Button だけを決める。
import type { EngineResult } from "./hand-engine.js";
import type { PlayerChips, SeatInit } from "./hand-events.js";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  isChipAmount,
  type TableConfig,
} from "./table-config.js";

/** 前 Hand の結果。HAND_STARTED の席順と buttonPlayerId、HAND_FINISHED の stacks から作る。 */
export interface PreviousHandResult {
  /** 前 Hand の席順（時計回り。HAND_STARTED の seats の順）。 */
  readonly seatOrder: readonly string[];
  /** 前 Hand の終了時の Stack（HAND_FINISHED の stacks）。 */
  readonly stacks: readonly PlayerChips[];
  readonly buttonPlayerId: string;
}

/**
 * 次 Hand の席。
 * - next_hand: Stack が残った Player を前 Hand の席順のまま並べ、Button を決めたもの（startHand にそのまま渡せる）
 * - no_next_hand: Stack が残った Player が 1 人以下で、次 Hand を始められない（remaining は残った Player。0〜1 人）
 */
export type NextHandSeating =
  | {
      readonly kind: "next_hand";
      readonly seats: readonly SeatInit[];
      readonly buttonPlayerId: string;
    }
  | {
      readonly kind: "no_next_hand";
      readonly remaining: readonly SeatInit[];
    };

/**
 * 次 Hand の席と Button を決める。Stack 0 の Player（Bust）は次 Hand に座らせない（D80）。
 * Button は Rule Profile の buttonRule に従って進める。
 */
export function nextHandSeating(
  previous: PreviousHandResult,
  config: Pick<TableConfig, "buttonRule">,
): EngineResult<NextHandSeating> {
  const invalid = validatePrevious(previous, config);
  if (invalid !== null) {
    return { ok: false, error: { kind: "invalid_input", message: invalid } };
  }
  const stackOf = new Map(
    previous.stacks.map((s) => [s.playerId, s.amount] as const),
  );
  // 席順は前 Hand のまま保ち、Bust した Player だけを抜く。
  const seats: SeatInit[] = previous.seatOrder.flatMap((playerId) => {
    const stack = stackOf.get(playerId) ?? 0;
    return stack > 0 ? [{ playerId, stack }] : [];
  });
  if (seats.length < MIN_PLAYERS) {
    return { ok: true, value: { kind: "no_next_hand", remaining: seats } };
  }
  return {
    ok: true,
    value: {
      kind: "next_hand",
      seats,
      buttonPlayerId: simpleMovingButton(previous, stackOf),
    },
  };
}

/**
 * simple_moving: 前 Button の次の席から時計回りに見て、次 Hand に座っている最初の Player。
 * 前 Button 本人が Bust していても同じ規則で進める（Dead Button なし）。呼ぶのは 2 人以上が残るときだけなので必ず見つかる。
 */
function simpleMovingButton(
  previous: PreviousHandResult,
  stackOf: ReadonlyMap<string, number>,
): string {
  const order = previous.seatOrder;
  const n = order.length;
  const button = order.indexOf(previous.buttonPlayerId);
  for (let k = 1; k <= n; k++) {
    const playerId = order[(button + k) % n] as string;
    if ((stackOf.get(playerId) ?? 0) > 0) return playerId;
  }
  throw new RangeError("次 Hand に座っている Player がいない");
}

/** 前 Hand の結果の検証。問題があれば理由を返す。 */
function validatePrevious(
  previous: PreviousHandResult,
  config: Pick<TableConfig, "buttonRule">,
): string | null {
  const { seatOrder, stacks } = previous;
  if (config.buttonRule !== "simple_moving") {
    return `未対応の buttonRule: ${String(config.buttonRule)}`;
  }
  if (seatOrder.length < MIN_PLAYERS || seatOrder.length > MAX_PLAYERS) {
    return `人数は ${MIN_PLAYERS}〜${MAX_PLAYERS}: ${seatOrder.length}`;
  }
  const ids = new Set(seatOrder);
  if (ids.size !== seatOrder.length || ids.has("")) {
    return "playerId が空または重複している";
  }
  if (!ids.has(previous.buttonPlayerId)) {
    return `Button が卓にいない: ${previous.buttonPlayerId}`;
  }
  // stacks は席の全員を 1 回ずつ持つ（HAND_FINISHED は全員の Stack を残す）。
  const stackIds = new Set(stacks.map((s) => s.playerId));
  if (
    stacks.length !== seatOrder.length ||
    stackIds.size !== stacks.length ||
    seatOrder.some((id) => !stackIds.has(id))
  ) {
    return "stacks が席の Player と一致しない";
  }
  // Chip はすべて最小単位の整数（D74）。
  if (stacks.some((s) => !isChipAmount(s.amount))) {
    return "Stack は 0 以上の整数";
  }
  return null;
}
