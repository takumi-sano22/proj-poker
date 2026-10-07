// Learning の API（#116・docs/07 §4〜§6）。どちらも読み取りだけで、Review を作らない（D115）。
// - `GET /api/learning/session-review/:handId`: その Hand が属する Session の Session Review（Session の終わった Hand から都度計算）
// - `GET /api/learning/profile`: Recent / Long-term の Player Profile（全期間の終わった Hand から都度計算）
// 返すのは Hero 自身の Stats・Pass A の Review 済みの判断から作った Score / Profile / Hypothesis だけで、Hidden Persona・
// CPU の Private な状態・他者の Hidden Cards・Pass B（Learning-only Reveal）・他 Player の Stats を含めない。
import type { FastifyInstance } from "fastify";
import type { LearningService } from "../learning/learning-service.js";

interface HandParams {
  handId: string;
}

const handParamsSchema = {
  type: "object",
  required: ["handId"],
  properties: { handId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

export function registerLearningRoutes(
  app: FastifyInstance,
  learning: LearningService,
): void {
  app.get<{ Params: HandParams }>(
    "/api/learning/session-review/:handId",
    { schema: { params: handParamsSchema } },
    (request, reply) => {
      const { handId } = request.params;
      const review = learning.sessionReview(handId);
      if (review === null) {
        return reply.code(404).send({
          error: { kind: "hand_not_found", message: `Hand が無い: ${handId}` },
        });
      }
      return review;
    },
  );

  app.get("/api/learning/profile", () => learning.profile());
}
