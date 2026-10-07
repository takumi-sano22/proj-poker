// Learning の API（#116・#118・docs/07 §4〜§6・docs/04 §11）。どれも Review を作らない（D115）。
// - `GET /api/learning/session-review/:handId`: その Hand が属する Session の Session Review（Session の終わった Hand から都度計算）
// - `GET /api/learning/profile`: Recent / Long-term の Player Profile（終わった Hand から都度計算。Learning Reset の区切りつき）
// - `POST /api/learning/resets`: Learning Reset（D114）。区切りの行を足すだけで、Event Log・reviews・Note / Tag は消さない
// 返すのは Hero 自身の Stats・Pass A の Review 済みの判断から作った Score / Profile / Hypothesis だけで、Hidden Persona・
// CPU の Private な状態・他者の Hidden Cards・Pass B（Learning-only Reveal）・他 Player の Stats を含めない。
import type { FastifyInstance } from "fastify";
import {
  LEARNING_RESET_CATEGORIES,
  type LearningResetCategory,
} from "../learning/learning-reset.js";
import type { LearningService } from "../learning/learning-service.js";

interface HandParams {
  handId: string;
}

const handParamsSchema = {
  type: "object",
  required: ["handId"],
  properties: { handId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

interface ResetBody {
  categories: LearningResetCategory[];
}

const resetBodySchema = {
  type: "object",
  required: ["categories"],
  additionalProperties: false,
  properties: {
    categories: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: [...LEARNING_RESET_CATEGORIES] },
    },
  },
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

  // Learning Reset。取り消しはできないが、消すのは計算の範囲だけで、正本は残る（区切りの行の追記）。
  app.post<{ Body: ResetBody }>(
    "/api/learning/resets",
    { schema: { body: resetBodySchema } },
    (request, reply) =>
      reply.code(201).send(learning.reset(request.body.categories)),
  );
}
