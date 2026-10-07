// Targeted Drill の API（#117・docs/07 §7・D105・D110・D116）。
// - `POST /api/drills`: body `{ handId, decisionIndex }`。元の Hand の Hero の判断（Pass A の Review があるもの）から、一要素だけ変えた
//   Drill を決定論で選び、Drill の Hand（専用の Session の通常の Hand）を始める。応答は POST /api/hands と同じ形に Drill の説明（drill）を足したもの。
//   以降の Hero の操作・SSE・Review は通常の Hand と同じ API（/api/hands/:handId/…・/api/reviews/…）を Drill の handId で使う
// - `GET /api/drills`: Drill の一覧と、Drill の系列の集計（通常の Score と別。D105）
// 返すのは Hero に見える値だけ（Drill の Hand の HeroView・元の Hand の公開の事実と Drill の設定）。他者の札・Deck・seed・
// 元の CPU の Hidden Persona を含めない（seed は drills テーブルにだけ残す）。
import type { FastifyInstance } from "fastify";
import type {
  DrillService,
  DrillServiceError,
} from "../drill/drill-service.js";
import type { HandOrchestrator } from "../hand-orchestrator.js";

interface StartDrillBody {
  handId: string;
  decisionIndex: number;
}

const startDrillBodySchema = {
  type: "object",
  required: ["handId", "decisionIndex"],
  additionalProperties: false,
  properties: {
    handId: { type: "string", minLength: 1, maxLength: 64 },
    decisionIndex: { type: "integer", minimum: 0, maximum: 9999 },
  },
} as const;

/** 失敗の種類を HTTP Status へ写す。 */
const STATUS_OF: Record<DrillServiceError["kind"], number> = {
  hand_not_found: 404,
  decision_not_found: 404,
  hand_not_finished: 409,
  review_required: 409,
  drill_unavailable: 422,
  stale_view: 409,
  stale_outage: 409,
  not_spectating: 409,
  not_actor: 409,
  hand_complete: 409,
  illegal_action: 422,
  invalid_input: 422,
};

export function registerDrillRoutes(
  app: FastifyInstance,
  drills: DrillService,
  orchestrator: HandOrchestrator,
): void {
  app.post<{ Body: StartDrillBody }>(
    "/api/drills",
    { schema: { body: startDrillBodySchema } },
    async (request, reply) => {
      const { handId, decisionIndex } = request.body;
      const result = await drills.start(handId, decisionIndex);
      if (!result.ok) {
        return reply.code(STATUS_OF[result.error.kind]).send({
          error: { kind: result.error.kind, message: result.error.message },
        });
      }
      const started = result.value.handId;
      return reply.code(201).send({
        drill: result.value.drill,
        handId: started,
        players: orchestrator.players,
        view: result.value.view,
        session: orchestrator.sessionStatus(started),
        outage: orchestrator.outageStatus(started),
        fastForward: orchestrator.fastForwardOf(started) ?? false,
      });
    },
  );

  app.get("/api/drills", () => drills.results());
}
