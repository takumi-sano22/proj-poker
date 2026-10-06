// Session Projection（docs/04 §1・§10・D95）。Session の最後に終わった Hand の時点の、Session の状態・各席の Stack・
// Persona の割り当て・Emergency Bot に切り替えた CPU。再起動後の Resume（D62）の入口に使う。
// Event Log（正本。D37）から作る派生データで、Event Store が Hand の保存と同じトランザクションで書く。
// Persona の割り当てだけは Event に入れない（他 CPU の Secret Persona。#51）ので、Session の開始時の設定から引き継ぐ。
import type {
  HandEvent,
  OutageKind,
  PlayerChips,
  SessionEndReason,
} from "@proj-poker/engine";

/** Emergency Bot に切り替えた CPU（D86）。 */
export interface EmergencyBotRecord {
  readonly playerId: string;
  /** 切り替えのきっかけの障害の種類。 */
  readonly cause: OutageKind;
}

export interface SessionProjection {
  readonly sessionId: string;
  /** Session で最後に終わった（HAND_FINISHED か HAND_ABORTED まで済んだ）Hand。 */
  readonly lastHandId: string;
  /** ready_for_next_hand: 次の Hand を始められる（Resume できる）/ ended: Session は終わった。 */
  readonly state: "ready_for_next_hand" | "ended";
  /** ended の理由（SESSION_ENDED の reason）。ready_for_next_hand なら null。 */
  readonly endReason: SessionEndReason | null;
  /** 最後に確定した各席の Stack（席順）。HAND_FINISHED の stacks、打ち切った Hand は開始時の Stack（Pot は配分しない）。 */
  readonly stacks: readonly PlayerChips[];
  /** CPU の playerId → Persona の Preset ID（Session の開始時の割り当て）。Hero への応答・KnowledgeState には入れない。 */
  readonly personas: Readonly<Record<string, string>>;
  /** Emergency Bot に切り替えた CPU（切り替えた順）。Session の終わりまで続く。 */
  readonly emergencyBots: readonly EmergencyBotRecord[];
  /** 最後の Hand の終わりを記録した時刻（ISO 8601・UTC）。 */
  readonly updatedAt: string;
}

/** Projection に畳み込む、終わった Hand 1 つ。 */
export interface FinishedSessionHand {
  readonly sessionId: string;
  readonly handId: string;
  /** その Hand の全 Event（seq 順。HAND_FINISHED か HAND_ABORTED まで済んでいる）。 */
  readonly events: readonly HandEvent[];
  /** Session の開始時の Persona の割り当て。Session の最初の Hand（前の Projection が無い）でだけ使う。 */
  readonly personas: Readonly<Record<string, string>>;
  /** Hand の終わりを記録した時刻。 */
  readonly recordedAt: string;
}

/**
 * 同じ Session の 1 つ前の Projection（前の Hand まで。Session の最初の Hand なら null）に、終わった Hand を 1 つ畳み込む。
 * Session の最初の Hand（SESSION_STARTED を持つ）では前の値を引き継がない。
 * Session の全 Hand を順に畳み込めば、Event Log から作り直せる（D37）。
 */
export function nextSessionProjection(
  previous: SessionProjection | null,
  hand: FinishedSessionHand,
): SessionProjection {
  const fresh =
    previous === null || hand.events.some((e) => e.type === "SESSION_STARTED");
  const emergencyBots = [...(fresh ? [] : previous.emergencyBots)];
  let endReason: SessionEndReason | null = null;
  let stacks: readonly PlayerChips[] = [];
  for (const e of hand.events) {
    switch (e.type) {
      case "HAND_STARTED":
        // 打ち切った Hand は HAND_FINISHED を持たないので、開始時の Stack を最後に確定した値として残す。
        stacks = e.seats.map((s) => ({
          playerId: s.playerId,
          amount: s.stack,
        }));
        break;
      case "HAND_FINISHED":
        stacks = e.stacks;
        break;
      case "EMERGENCY_BOT_ENGAGED":
        if (!emergencyBots.some((b) => b.playerId === e.playerId)) {
          emergencyBots.push({ playerId: e.playerId, cause: e.cause });
        }
        break;
      case "SESSION_ENDED":
        endReason = e.reason;
        break;
      default:
        break;
    }
  }
  return {
    sessionId: hand.sessionId,
    lastHandId: hand.handId,
    state: endReason === null ? "ready_for_next_hand" : "ended",
    endReason,
    stacks,
    personas: fresh ? hand.personas : previous.personas,
    emergencyBots,
    updatedAt: hand.recordedAt,
  };
}
