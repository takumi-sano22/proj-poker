// Hand の Event 型と Visibility。Event Log が唯一の正本で、State は Event の畳み込みで作る（D37・docs/04 §1）。
// Event 種別は docs/04 §3 のうち Phase 1 で必要なものだけを持つ（統合した種別は docs/04 §3 の構成表を参照）。
import type { Card } from "./card.js";

/**
 * 誰がその Event を読めるか（docs/04 §4）。
 * - public: 卓の全員
 * - private: 指定 Player だけ（自分の Hole Cards）
 * - engine: Engine 内部専用。どの Player の Projection にも入れない（Deck の順序＝未来の Card）
 * learning_only（Review 用の開示）は Phase 1 では発行しない。
 */
export type Visibility =
  | { readonly type: "public" }
  | { readonly type: "private"; readonly playerId: string }
  | { readonly type: "engine" };

export type Street = "preflop" | "flop" | "turn" | "river";

/** Canonical Action（docs/02 §4）。 */
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

export interface SeatInit {
  readonly playerId: string;
  /** Hand 開始時の Stack（Chip の最小単位の整数。D74）。 */
  readonly stack: number;
}

export interface PlayerChips {
  readonly playerId: string;
  readonly amount: number;
}

/** Event の中身。seq と visibility は Engine が付ける。 */
export type HandEventBody =
  | {
      readonly type: "HAND_STARTED";
      readonly handId: string;
      readonly ruleProfile: string;
      readonly smallBlind: number;
      readonly bigBlind: number;
      /** 席順（時計回り）。Button の位置もここで決まる（BUTTON_ASSIGNED を統合）。 */
      readonly seats: readonly SeatInit[];
      readonly buttonPlayerId: string;
    }
  | {
      readonly type: "DECK_SHUFFLED";
      /** seed で作った Deck なら seed。積んだ Deck なら null（docs/04 §9 の Replay Metadata）。 */
      readonly seed: number | null;
      /** 配布順の 52 枚。engine Visibility なので Projection へは出ない。 */
      readonly deck: readonly Card[];
    }
  | {
      readonly type: "BLIND_POSTED";
      readonly playerId: string;
      readonly blind: "small" | "big";
      readonly amount: number;
    }
  | {
      readonly type: "HOLE_CARD_DEALT";
      readonly playerId: string;
      readonly cards: readonly Card[];
    }
  | {
      // PLAYER_FOLDED / PLAYER_ALL_IN / CHIPS_MOVED（Bet 分）を統合する。action と allIn から復元できる。
      readonly type: "ACTION_TAKEN";
      readonly playerId: string;
      readonly street: Street;
      readonly action: ActionType;
      /** この Action で Stack から出した額。 */
      readonly amount: number;
      /** この Action の後の、この Street での累計 Commit（Bet / Raise の "to" 額）。 */
      readonly toAmount: number;
      readonly allIn: boolean;
    }
  | {
      readonly type: "BOARD_DEALT";
      readonly street: Exclude<Street, "preflop">;
      readonly cards: readonly Card[];
    }
  | {
      // SHOWDOWN_STARTED を統合する（最初の CARDS_TABLED が Showdown の開始）。
      readonly type: "CARDS_TABLED";
      readonly playerId: string;
      readonly cards: readonly Card[];
    }
  | {
      readonly type: "UNCALLED_BET_RETURNED";
      readonly playerId: string;
      readonly amount: number;
    }
  | {
      readonly type: "POT_AWARDED";
      readonly potTotal: number;
      readonly awards: readonly PlayerChips[];
      readonly showdown: boolean;
    }
  | {
      readonly type: "HAND_FINISHED";
      readonly stacks: readonly PlayerChips[];
    };

export type HandEventType = HandEventBody["type"];

export type HandEvent = HandEventBody & {
  /** Hand 内の通し番号（0 始まり）。 */
  readonly seq: number;
  readonly visibility: Visibility;
};

/**
 * Event 種別ごとに Visibility を固定で決める（呼び出し側に選ばせない）。
 * 既定値を置かず全種別を列挙する。新しい種別を足したら、ここで Visibility を決めない限り型エラーになる。
 */
export function visibilityOf(body: HandEventBody): Visibility {
  switch (body.type) {
    case "HOLE_CARD_DEALT":
      return { type: "private", playerId: body.playerId };
    case "DECK_SHUFFLED":
      return { type: "engine" };
    case "HAND_STARTED":
    case "BLIND_POSTED":
    case "ACTION_TAKEN":
    case "BOARD_DEALT":
    case "CARDS_TABLED":
    case "UNCALLED_BET_RETURNED":
    case "POT_AWARDED":
    case "HAND_FINISHED":
      return { type: "public" };
  }
}

/** viewer がその Event を読めるか。public と自分宛て private だけを通す whitelist（D28・docs/04 §5）。 */
export function isVisibleTo(event: HandEvent, viewerId: string): boolean {
  const v = event.visibility;
  return (
    v.type === "public" || (v.type === "private" && v.playerId === viewerId)
  );
}
