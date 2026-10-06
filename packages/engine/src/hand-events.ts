// Hand の Event 型と Visibility。Event Log が唯一の正本で、State は Event の畳み込みで作る（D37・docs/04 §1）。
// Event 種別は docs/04 §3 のうち Phase 1 で必要なものと、CPU の判断の経緯（AI_ACTION_INVALID / AI_FALLBACK_USED。D83）と、
// Hero の宣言・物理的な Chip の操作・Dealer の裁定（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING。D90）と、
// Session の開始・終了、Hand の打ち切り、Emergency Bot への切り替え（SESSION_STARTED / SESSION_ENDED / HAND_ABORTED /
// EMERGENCY_BOT_ENGAGED。D95）を持つ（統合した種別は docs/04 §3 の構成表を参照）。
import type { Card } from "./card.js";
import type { CanonicalAction } from "./legal-actions.js";
import type { Declaration, RulingCode } from "./ruling.js";
import type { OddChipRule, ReopenRule } from "./table-config.js";

/**
 * 誰がその Event を読めるか（docs/04 §4）。
 * - public: 卓の全員
 * - private: 指定 Player だけ（自分の Hole Cards）
 * - engine: Engine 内部専用。どの Player の Projection にも入れない（Deck の順序＝未来の Card）
 * - system: 卓の外の運用記録（CPU の不正な出力・Fallback の利用。D83。Session の開始・終了・Hand の打ち切り・
 *   Emergency Bot への切り替え。D95）。CPU の出力の値を含みうるので、Hero・CPU（本人を含む）のどの Projection にも入れない。
 *   読むのは Server（Session の Resume・Debug・Review の集計）だけ
 * learning_only（Review 用の開示）はまだ発行しない。
 */
export type Visibility =
  | { readonly type: "public" }
  | { readonly type: "private"; readonly playerId: string }
  | { readonly type: "engine" }
  | { readonly type: "system" };

export type Street = "preflop" | "flop" | "turn" | "river";

/** Canonical Action（docs/02 §4）。 */
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

/** CPU の出力の検証で不正と判定した段（docs/03 §5 の順: Schema → Legal Action → Amount Range）。 */
export type InvalidOutputStage = "schema" | "legal_action" | "amount_range";

/**
 * CPU の判断の代わりに使った Bot の種類。
 * - automatic: 出力が Retry の後も不正だったときの自動 Fallback（RuleBot。D41）
 * - emergency_bot: 障害の後にユーザーが選んだ Emergency Bot（D86。発行は #52）
 */
export type FallbackKind = "automatic" | "emergency_bot";

/**
 * Dealer の裁定が何を対象にしたか（D90）。
 * - operations: 直前に置いた同じ Player の PLAYER_DECLARED / PHYSICAL_CHIP_ACTION（同じ追記で置く）
 * - pending_out_of_turn: 保留していた Out-of-Turn の操作（その Player の手番が来た時点で裁定した。直前に操作の Event は無い）
 */
export type RulingBasis = "operations" | "pending_out_of_turn";

/**
 * 裁定の結果の種類（ruling.ts の RulingResult.kind）。
 * - action: Canonical Action に決まった（直後の Event がその ACTION_TAKEN）
 * - out_of_turn: 手番でない操作。手番を正しい Player へ戻して警告し、操作を保留した
 * - no_action: Action を決めない（相手の Bet があるときの Check の宣言・撤回した Out-of-Turn）。その Player が選び直す
 */
export type RulingOutcome = "action" | "out_of_turn" | "no_action";

/**
 * CPU が判断を返せなかった障害の種類（D86）。Emergency Bot への切り替えのきっかけとして Event に残す。
 * - timeout: 応答時間の超過 / unauthenticated: 未ログイン / usage_limit: 利用枠の上限 / error: それ以外の例外
 */
export type OutageKind =
  "timeout" | "unauthenticated" | "usage_limit" | "error";

/**
 * Session が終わった理由（D80・D86）。
 * - hero_busted: Hero の Stack が 0 になった
 * - hero_last_standing: CPU が全員 Bust し、Hero だけが残った
 * - ai_outage: CPU の障害のダイアログで Hero が Session 終了を選んだ（その Hand は HAND_ABORTED で打ち切る）
 */
export type SessionEndReason =
  "hero_busted" | "hero_last_standing" | "ai_outage";

/** Hand を途中で打ち切った理由（D95）。ai_outage: CPU の障害のダイアログで Hero が Session 終了を選んだ。 */
export type HandAbortReason = "ai_outage";

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
      /** Split Pot の端数の配り方。Event Log だけで配分を再現できるよう Rule Profile の設定値を残す。 */
      readonly oddChipRule: OddChipRule;
      /** Short All-in の後の Raise の再開規則。Event Log だけで Legal Action を再現できるよう残す（D79）。 */
      readonly reopenRule: ReopenRule;
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
      // Pot ごとに 1 つ発行する（Main Pot が先。D78）。Σ awards = potTotal。
      readonly type: "POT_AWARDED";
      /** 0 が Main Pot、1 以降が Side Pot（作られた順）。 */
      readonly potIndex: number;
      readonly potTotal: number;
      /** この Pot を争えた（Fold せず、この Pot の段まで Commit した）Player。Button の左から時計回りの順。 */
      readonly eligible: readonly string[];
      readonly awards: readonly PlayerChips[];
      /** 札を比べて決めたか。争える Player が 1 人だけの Pot（Fold で決着・Side Pot の独占）は false。 */
      readonly showdown: boolean;
    }
  | {
      readonly type: "HAND_FINISHED";
      readonly stacks: readonly PlayerChips[];
    }
  | {
      // Hero の口頭の宣言（D90）。卓の State（Chip・手番）は変えない。直後に同じ追記の操作の Event か DEALER_RULING が続く。
      readonly type: "PLAYER_DECLARED";
      readonly playerId: string;
      readonly street: Street;
      readonly declaration: Declaration;
    }
  | {
      // Hero が Chip を出した 1 回の動作（D90）。卓の State は変えない（Chip が動くのは裁定の後の ACTION_TAKEN）。
      readonly type: "PHYSICAL_CHIP_ACTION";
      readonly playerId: string;
      readonly street: Street;
      /** chip_push は最初の動作、chip_add は 2 回目以降（String Bet の判定に使う）。 */
      readonly motion: "chip_push" | "chip_add";
      /** 出した Chip の額面の列。 */
      readonly chips: readonly number[];
    }
  | {
      // Dealer の裁定（Dealer Feedback の RULING。docs/02 §8・D90）。卓の State（Chip・手番）は変えない。
      // outcome が action なら、直後の Event が同じ Player のその Canonical Action の ACTION_TAKEN（同じ追記で置く）。
      readonly type: "DEALER_RULING";
      readonly playerId: string;
      readonly street: Street;
      readonly basis: RulingBasis;
      readonly outcome: RulingOutcome;
      /** outcome が action のときの Canonical Action。それ以外は null。 */
      readonly action: CanonicalAction | null;
      /** 裁定の理由（表示の文言は呼び出し側が持つ）。 */
      readonly notes: readonly RulingCode[];
    }
  | {
      // CPU の出力を検証で不正と判定した（D41・D83）。Retry で正常に戻った不正も残す。卓の State は変えない。
      // その手番の Action（ACTION_TAKEN）より前に置く（seq は Event 自身の seq）。
      readonly type: "AI_ACTION_INVALID";
      readonly playerId: string;
      /** 何回目の要求の出力か（1 始まり。2 は Correction 付きの再要求）。 */
      readonly attempt: number;
      readonly stage: InvalidOutputStage;
      /** 不正と判定した理由。CPU の出力の値を含みうる。 */
      readonly reason: string;
    }
  | {
      // CPU の判断の代わりに Bot の判断を使った（docs/03 §6 の Flag。D83）。卓の State は変えない。
      // 直後の Event が、同じ Player の Fallback で決めた ACTION_TAKEN（同じ追記で置く）。
      readonly type: "AI_FALLBACK_USED";
      readonly playerId: string;
      readonly fallbackKind: FallbackKind;
      /** Fallback した理由（automatic は最後に不正と判定した段と理由）。CPU の出力の値を含みうる。 */
      readonly reason: string;
    }
  | {
      // Session の開始（D95）。Session の最初の Hand の、開始の Event（startHand の結果）に続けて同じ追記で置く。
      // 卓の State は変えない。席・Stack・Button は HAND_STARTED に残る。
      readonly type: "SESSION_STARTED";
      readonly sessionId: string;
    }
  | {
      // Session の終了（D80・D86・D95）。Session の最後の Hand の終わり（HAND_FINISHED か HAND_ABORTED）の直後に、同じ追記で置く。
      // Hand の終わりより後ろに置ける唯一の Event。卓の State は変えない。
      readonly type: "SESSION_ENDED";
      readonly sessionId: string;
      readonly reason: SessionEndReason;
    }
  | {
      // Hand を途中で打ち切った（D95。D88 の Event 化）。HAND_FINISHED の代わりに Hand を終える。Pot は配分せず、
      // Chip は動かさない（Session も一緒に終えるので、Stack を次の Hand へ持ち越さない）。
      readonly type: "HAND_ABORTED";
      readonly reason: HandAbortReason;
    }
  | {
      // 障害の後に Hero が Emergency Bot を選んだ（D86・D95。D88 の Event 化）。その CPU は Session の終わりまで RuleBot で動く。
      // 障害で止まったその CPU の手番に置く。卓の State は変えない。以降の手番ごとの記録は AI_FALLBACK_USED（emergency_bot）。
      readonly type: "EMERGENCY_BOT_ENGAGED";
      readonly playerId: string;
      /** 切り替えのきっかけの障害の種類（内部のエラー本文は入れない）。 */
      readonly cause: OutageKind;
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
    // CPU の判断の経緯（D83）と、Session・Hand の運用の記録（D95）。Hero の View・CPU の KnowledgeState・Replay には入れない
    // （Hero へは Session の状態を API が別に返す）。
    case "AI_ACTION_INVALID":
    case "AI_FALLBACK_USED":
    case "SESSION_STARTED":
    case "SESSION_ENDED":
    case "HAND_ABORTED":
    case "EMERGENCY_BOT_ENGAGED":
      return { type: "system" };
    // Hero の宣言・Chip の操作・Dealer の裁定は、卓の全員が見聞きする事実（D90）。
    case "PLAYER_DECLARED":
    case "PHYSICAL_CHIP_ACTION":
    case "DEALER_RULING":
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
