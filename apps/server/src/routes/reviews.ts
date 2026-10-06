// Review の API（#82。UI は #84）。Hand ID と Hero の判断（decisionIndex: その Hand での Hero の判断の順番。0 始まり）を指定する。
// - GET: その判断の Review の状態（最新の Version・Version の数・生成の状態）
// - POST: 新しい Version の生成を始め、待ちの状態（202）を返す。生成は裏で進み、GET で終わりを確かめる。body は JSON の
//   オブジェクト（`{}` か `{ "depth": "deep" }`）
// 返す Review は判断時点の Hero Information Set から作った Evidence と説明だけ（他者の札・Deck・seed・system の記録・Persona・
// 内部のエラー本文を含めない）。生成の失敗は種類だけを返す。
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ReviewResult,
  ReviewService,
  ReviewServiceError,
} from "../review/review-service.js";
import type { ReviewDepth } from "../review/types.js";

interface ReviewBody {
  /** standard（既定。review_standard）か deep（Hero が「詳しく」を選んだ Spot。review_deep。D97）。 */
  depth?: ReviewDepth;
}

const reviewParamsSchema = {
  type: "object",
  required: ["handId", "decisionIndex"],
  properties: {
    handId: { type: "string", minLength: 1, maxLength: 64 },
    // path の値は文字列で届くので、0 以上の整数の表記だけを受ける（型の自動変換は切ってある。app.ts）。
    decisionIndex: { type: "string", pattern: "^(0|[1-9][0-9]{0,3})$" },
  },
} as const;

const reviewBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { depth: { type: "string", enum: ["standard", "deep"] } },
} as const;

const STATUS_OF: Readonly<Record<ReviewServiceError["kind"], number>> = {
  hand_not_found: 404,
  decision_not_found: 404,
  hand_not_finished: 409,
};

export function registerReviewRoutes(
  app: FastifyInstance,
  reviews: ReviewService,
): void {
  app.get<{ Params: { handId: string; decisionIndex: string } }>(
    "/api/reviews/hands/:handId/decisions/:decisionIndex",
    { schema: { params: reviewParamsSchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      return send(reply, reviews.status(params.handId, params.decisionIndex));
    },
  );

  app.post<{
    Params: { handId: string; decisionIndex: string };
    Body: ReviewBody;
  }>(
    "/api/reviews/hands/:handId/decisions/:decisionIndex",
    { schema: { params: reviewParamsSchema, body: reviewBodySchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      const result = reviews.request(
        params.handId,
        params.decisionIndex,
        request.body.depth ?? "standard",
      );
      return send(reply, result, 202);
    },
  );
}

function parseParams(raw: { handId: string; decisionIndex: string }): {
  handId: string;
  decisionIndex: number;
} {
  return { handId: raw.handId, decisionIndex: Number(raw.decisionIndex) };
}

function send(reply: FastifyReply, result: ReviewResult, okStatus = 200) {
  if (!result.ok) {
    return reply
      .code(STATUS_OF[result.error.kind])
      .send({ error: result.error });
  }
  return reply.code(okStatus).send(result.value);
}
