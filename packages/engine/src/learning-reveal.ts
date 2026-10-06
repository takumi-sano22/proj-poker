// Learning-only Full Reveal の Projection（docs/05 §7 Pass B・docs/04 §4 の learning_only・INV-INFO-002）。
// Hand が終わった後に、学習のため全員の札（Fold した Player・Showdown で見せなかった Player を含む）を Hero に見せる情報。
// ゲーム世界の Observation ではないので、Hero の View・CPU の KnowledgeState・Pass A の入力（hand-summary.ts）とは別の関数にし、
// それらの Projection からは参照しない（Pass B の情報で Pass A を変えない。CPU Memory へ入れない＝INV-TEST-008）。
// Event の Visibility は増やさない（Event Log の形は変えない）。Projection の値にだけ learning_only の印を付ける。
import type { Card } from "./card.js";
import type { HandEvent } from "./hand-events.js";

/** 配られた札（HOLE_CARD_DEALT 1 つ）。 */
export interface RevealedHoleCards {
  readonly playerId: string;
  readonly cards: readonly Card[];
}

export interface LearningReveal {
  /** 学習用の開示であることの印（Pass A・CPU の入力に混ぜない値）。 */
  readonly visibility: "learning_only";
  readonly handId: string;
  /** 配られた全員の札（配った順）。Deck の残り（配られなかった Card）は含まない。 */
  readonly holeCards: readonly RevealedHoleCards[];
}

/**
 * Hand が終わった（HAND_FINISHED、または HAND_ABORTED で打ち切った）後だけ、全員の札を返す。進行中の Hand は null
 * （Hand の途中で他者の札を見せない）。
 */
export function projectLearningReveal(
  events: readonly HandEvent[],
): LearningReveal | null {
  const started = events[0];
  if (started?.type !== "HAND_STARTED") {
    throw new RangeError("Event 列の先頭が HAND_STARTED ではない");
  }
  const ended = events.some(
    (e) => e.type === "HAND_FINISHED" || e.type === "HAND_ABORTED",
  );
  if (!ended) return null;
  const holeCards: RevealedHoleCards[] = [];
  for (const e of events) {
    if (e.type === "HOLE_CARD_DEALT") {
      holeCards.push({ playerId: e.playerId, cards: e.cards });
    }
  }
  return { visibility: "learning_only", handId: started.handId, holeCards };
}
