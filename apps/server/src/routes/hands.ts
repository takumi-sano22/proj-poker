// Hand の API（D73: Hero の Action は REST の POST、卓の状態は SSE で Push）。
// 入力の形は JSON Schema で検証し、合法性（手番・Action の種類・額）は Engine が判定する（D40）。
// 返す・Push するのは projectHeroView の結果だけ（他者の Hole Cards・Deck・seed を含めない）。
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  HandOrchestrator,
  OrchestratorError,
} from "../hand-orchestrator.js";

interface HandParams {
  handId: string;
}

interface HeroActionBody {
  /** クライアントが見ていた HeroView の log の最後の seq（古い画面・二重送信の検出に使う）。 */
  lastSeq: number;
  action: PlayerAction;
}

const handParamsSchema = {
  type: "object",
  required: ["handId"],
  properties: { handId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

// Canonical Action（docs/02 §4）の形。bet / raise だけが amount（この Street の累計＝to 額）を持つ。
const heroActionBodySchema = {
  type: "object",
  required: ["lastSeq", "action"],
  additionalProperties: false,
  properties: {
    lastSeq: { type: "integer", minimum: 0 },
    action: {
      oneOf: [
        {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: {
            type: { enum: ["fold", "check", "call", "all_in"] },
          },
        },
        {
          type: "object",
          required: ["type", "amount"],
          additionalProperties: false,
          properties: {
            type: { enum: ["bet", "raise"] },
            amount: { type: "integer", minimum: 0 },
          },
        },
      ],
    },
  },
} as const;

/** 失敗の種類を HTTP Status へ写す。 */
const STATUS_BY_ERROR: Record<OrchestratorError["kind"], number> = {
  hand_not_found: 404,
  stale_view: 409,
  not_actor: 409,
  hand_complete: 409,
  illegal_action: 422,
  invalid_input: 422,
};

function sendError(reply: FastifyReply, error: OrchestratorError) {
  return reply
    .code(STATUS_BY_ERROR[error.kind])
    .send({ error: { kind: error.kind, message: error.message } });
}

/** SSE の 1 メッセージ。event 名は view だけで、data は HeroView の JSON（改行を含まない）。 */
function formatViewEvent(view: HeroView): string {
  return `event: view\ndata: ${JSON.stringify(view)}\n\n`;
}

export function registerHandRoutes(
  app: FastifyInstance,
  orchestrator: HandOrchestrator,
): void {
  // 開いている SSE。アプリ終了時に閉じる（開いたままだと close が接続の終了を待ち続ける）。
  const openStreams = new Set<() => void>();
  app.addHook("preClose", (done) => {
    for (const end of [...openStreams]) end();
    done();
  });

  // Hand を開始する。Hero の手番か Hand の終了まで CPU を進めた時点の View を返す。
  app.post("/api/hands", (_request, reply) => {
    const result = orchestrator.startHand();
    if (!result.ok) return sendError(reply, result.error);
    return reply.code(201).send({
      handId: result.value.handId,
      players: orchestrator.players,
      view: result.value.view,
    });
  });

  // Hero の Action。適用後、次の Hero の手番か Hand の終了まで CPU を進めた時点の View を返す
  // （CPU の思考待ちがある設定では、CPU の行動は SSE で後から届く）。
  app.post<{ Params: HandParams; Body: HeroActionBody }>(
    "/api/hands/:handId/actions",
    { schema: { params: handParamsSchema, body: heroActionBodySchema } },
    (request, reply) => {
      const { lastSeq, action } = request.body;
      const result = orchestrator.heroAction(
        request.params.handId,
        lastSeq,
        action,
      );
      if (!result.ok) return sendError(reply, result.error);
      return reply.send({ view: result.value });
    },
  );

  // 卓の状態の SSE。接続時に現在の View を 1 回送り、以後は Log が進むたびに送る。
  // Hand が終わった View を送ったらサーバー側から閉じる（クライアントは status が complete なら再接続しない）。
  app.get<{ Params: HandParams }>(
    "/api/hands/:handId/stream",
    { schema: { params: handParamsSchema } },
    (request, reply) => {
      const { handId } = request.params;
      const initial = orchestrator.heroView(handId);
      if (initial === null) {
        return sendError(reply, {
          kind: "hand_not_found",
          message: `Hand が無い: ${handId}`,
        });
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      let unsubscribe: (() => void) | null = null;
      const end = () => {
        unsubscribe?.();
        unsubscribe = null;
        openStreams.delete(end);
        if (!res.writableEnded) res.end();
      };
      const send = (view: HeroView) => {
        // 切断済みの接続へは書かない（close の通知より先に配信が来ることがある）。
        if (res.writableEnded || res.destroyed) return;
        res.write(formatViewEvent(view));
        if (view.status === "complete") end();
      };

      // req の close は本文を読み終えた時点でも発火するため、接続の終了は res の close で見る。
      res.on("close", end);
      openStreams.add(end);
      send(initial);
      if (!res.writableEnded) {
        unsubscribe = orchestrator.subscribe(handId, send);
      }
    },
  );
}
