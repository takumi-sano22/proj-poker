// Review の API（#82・#83。UI は #84）。Hand ID と Hero の判断（decisionIndex: その Hand での Hero の判断の順番。0 始まり）を指定する。
// - `/decisions/:decisionIndex`: Pass A（Decision Review）。GET は状態（最新の Version・Version の数・生成の状態）、POST は新しい
//   Version の生成を始めて待ちの状態（202）を返す。生成は裏で進み、GET で終わりを確かめる。body は `{}` か `{ "depth": "deep" }`
// - `/decisions/:decisionIndex/reveal`: Pass B（Reveal Review。Hand 後の Learning-only Full Reveal で答え合わせ）。GET / POST は Pass A と同じ作法
// - `/decisions/:decisionIndex/passes/:pass/versions/:version/followups`: Pass（decision / reveal）と Version で指定した Review への
//   Follow-up。GET は履歴（全ターン）と生成の状態、POST は `{ "question": "...", "depth"?: "deep" }` で答えの生成を始める（202）
// Pass A とその Follow-up の応答は判断時点の Hero Information Set から作った Evidence と説明だけ（他者の札・Deck・seed・system の記録・
// Persona・内部のエラー本文を含めない）。全員の札は Pass B とその Follow-up の応答にだけ入る（Hand 後の学習用。CPU には渡さない）。
// 生成の失敗は種類だけを返す。
import type { FastifyInstance, FastifyReply } from "fastify";
import { FOLLOWUP_QUESTION_MAX } from "../review/followup.js";
import type {
  ReviewService,
  ReviewServiceError,
  ServiceResult,
} from "../review/review-service.js";
import type { ReviewDepth, ReviewPass } from "../review/types.js";

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

interface FollowUpParams {
  handId: string;
  decisionIndex: string;
  pass: ReviewPass;
  version: string;
}

interface FollowUpBody extends ReviewBody {
  question: string;
}

const followUpParamsSchema = {
  type: "object",
  required: ["handId", "decisionIndex", "pass", "version"],
  properties: {
    ...reviewParamsSchema.properties,
    pass: { type: "string", enum: ["decision", "reveal"] },
    // Version は 1 以上の整数の表記だけ。
    version: { type: "string", pattern: "^[1-9][0-9]{0,3}$" },
  },
} as const;

const followUpBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    ...reviewBodySchema.properties,
    // 空白だけの質問は受けない（空白以外の文字を 1 つ以上含む）。
    question: {
      type: "string",
      minLength: 1,
      maxLength: FOLLOWUP_QUESTION_MAX,
      pattern: "\\S",
    },
  },
} as const;

const STATUS_OF: Readonly<Record<ReviewServiceError["kind"], number>> = {
  hand_not_found: 404,
  decision_not_found: 404,
  review_not_found: 404,
  hand_not_finished: 409,
  followup_in_progress: 409,
  followup_limit: 409,
  invalid_question: 400,
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

  app.get<{ Params: { handId: string; decisionIndex: string } }>(
    "/api/reviews/hands/:handId/decisions/:decisionIndex/reveal",
    { schema: { params: reviewParamsSchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      return send(
        reply,
        reviews.revealStatus(params.handId, params.decisionIndex),
      );
    },
  );

  app.post<{
    Params: { handId: string; decisionIndex: string };
    Body: ReviewBody;
  }>(
    "/api/reviews/hands/:handId/decisions/:decisionIndex/reveal",
    { schema: { params: reviewParamsSchema, body: reviewBodySchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      const result = reviews.requestReveal(
        params.handId,
        params.decisionIndex,
        request.body.depth ?? "standard",
      );
      return send(reply, result, 202);
    },
  );

  const followUpUrl =
    "/api/reviews/hands/:handId/decisions/:decisionIndex/passes/:pass/versions/:version/followups";

  app.get<{ Params: FollowUpParams }>(
    followUpUrl,
    { schema: { params: followUpParamsSchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      return send(
        reply,
        reviews.followUpStatus(
          params.handId,
          params.decisionIndex,
          request.params.pass,
          Number(request.params.version),
        ),
      );
    },
  );

  app.post<{ Params: FollowUpParams; Body: FollowUpBody }>(
    followUpUrl,
    { schema: { params: followUpParamsSchema, body: followUpBodySchema } },
    (request, reply) => {
      const params = parseParams(request.params);
      const result = reviews.askFollowUp(
        params.handId,
        params.decisionIndex,
        request.params.pass,
        Number(request.params.version),
        request.body.question,
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

function send<T>(
  reply: FastifyReply,
  result: ServiceResult<T>,
  okStatus = 200,
) {
  if (!result.ok) {
    return reply
      .code(STATUS_OF[result.error.kind])
      .send({ error: result.error });
  }
  return reply.code(okStatus).send(result.value);
}
