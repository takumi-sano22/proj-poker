// Hand の API（D73: Hero の Action は REST の POST、卓の状態は SSE で Push）。
// Hero の Action の入口は 2 つ: Canonical Action（/actions。Ruling を通さない互換の入口）と、
// 物理的な操作（/physical-actions。Ruling Engine で裁定し、操作と裁定も Event Log に残す。D90・D91）。
// 入力の形は JSON Schema で検証し、合法性（手番・Action の種類・額）は Engine が判定する（D40）。
// 返す・Push するのは projectHeroView の結果と、Session の状態（Hero 自身の結果と次 Hand の有無）と、
// CPU の障害の状態（どの CPU の手番か・障害の種類だけ。D86）だけ
// （他者の Hole Cards・Deck・seed・CPU の Persona・内部のエラー本文を含めない）。
import {
  TOURNAMENT_PRESET_IDS,
  USER_READ_TEXT_MAX,
  type HeroView,
  type PhysicalAction,
  type PlayerAction,
} from "@proj-poker/engine";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  HandOrchestrator,
  OrchestratorError,
  OutageChoice,
  OutageStatus,
  SessionRequest,
  SessionStatus,
  StartHandError,
} from "../hand-orchestrator.js";

interface HandParams {
  handId: string;
}

interface StartHandBody {
  /** クライアントが結果まで見た最後の Hand（まだ無ければ null）。開始の再送と「次の Hand」を区別する。 */
  afterHandId: string | null;
  /**
   * 新しい Session の設定（mode と Tournament の Preset。#183）。省略すると、続く Session はそのまま続け、新しい Session は cash。
   * 今の Session が続いているときに違う設定を求めたら 409（session_mode_mismatch）。
   */
  session?: SessionRequest;
}

interface HeroActionBody {
  /** クライアントが見ていた HeroView の log の最後の seq（古い画面・二重送信の検出に使う）。 */
  lastSeq: number;
  action: PlayerAction;
}

interface HeroPhysicalActionBody {
  /** クライアントが見ていた HeroView の log の最後の seq（古い画面・二重送信の検出に使う）。 */
  lastSeq: number;
  /** 1 回の手番の操作（した順）。 */
  actions: PhysicalAction[];
}

interface UserReadBody {
  /** クライアントが見ていた HeroView の log の最後の seq（応答が失われた記録の再送・古い画面の検出に使う）。 */
  lastSeq: number;
  /** 読みの対象の席（この Hand の playerId）。相手を特定しない読み・意図は null。 */
  targetPlayerId: string | null;
  text: string;
}

interface FastForwardBody {
  /** true で Fast Forward を入れる（Hero が Fold した後だけ）。false で通常の速さに戻す。 */
  enabled: boolean;
}

interface OutageChoiceBody {
  /** クライアントが見ていた障害の状態の revision（古いダイアログ・二重送信の検出に使う）。 */
  revision: number;
  choice: OutageChoice;
}

const handParamsSchema = {
  type: "object",
  required: ["handId"],
  properties: { handId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const startHandBodySchema = {
  type: "object",
  required: ["afterHandId"],
  additionalProperties: false,
  properties: {
    afterHandId: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 64 },
        { type: "null" },
      ],
    },
    session: {
      anyOf: [
        {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: { mode: { const: "cash" } },
        },
        {
          type: "object",
          required: ["mode", "presetId"],
          additionalProperties: false,
          properties: {
            mode: { const: "tournament" },
            presetId: { enum: TOURNAMENT_PRESET_IDS },
          },
        },
      ],
    },
  },
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

// Hero の物理的な操作（docs/02 §4）の形。合法性・額面に有るか・Stack を超えないかは Engine（Ruling Engine）が判定する。
// 列の長さの上限は、1 回の手番の操作として十分な数で、入力の大きさを抑えるための値。
const declarationSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: { kind: { enum: ["fold", "check", "call", "all_in"] } },
    },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { enum: ["bet", "raise"] },
        // この Street の累計（to 額）。省略すると Chip の量で決める。
        amount: { type: "integer", minimum: 0 },
      },
    },
  ],
} as const;

const heroPhysicalActionBodySchema = {
  type: "object",
  required: ["lastSeq", "actions"],
  additionalProperties: false,
  properties: {
    lastSeq: { type: "integer", minimum: 0 },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        oneOf: [
          {
            type: "object",
            required: ["type", "declaration"],
            additionalProperties: false,
            properties: {
              type: { enum: ["declare"] },
              declaration: declarationSchema,
            },
          },
          {
            type: "object",
            required: ["type", "chips"],
            additionalProperties: false,
            properties: {
              type: { enum: ["chip_push", "chip_add"] },
              chips: {
                type: "array",
                minItems: 1,
                maxItems: 100,
                items: { type: "integer", minimum: 1 },
              },
            },
          },
        ],
      },
    },
  },
} as const;

// Hero の User Read（D112）。対象の席が卓にいるか・手番か・本文の空白だけでないかは Engine（recordUserRead）が判定する。
const userReadBodySchema = {
  type: "object",
  required: ["lastSeq", "targetPlayerId", "text"],
  additionalProperties: false,
  properties: {
    lastSeq: { type: "integer", minimum: 0 },
    targetPlayerId: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 64 },
        { type: "null" },
      ],
    },
    text: { type: "string", minLength: 1, maxLength: USER_READ_TEXT_MAX },
  },
} as const;

const fastForwardBodySchema = {
  type: "object",
  required: ["enabled"],
  additionalProperties: false,
  properties: { enabled: { type: "boolean" } },
} as const;

const outageChoiceBodySchema = {
  type: "object",
  required: ["revision", "choice"],
  additionalProperties: false,
  properties: {
    revision: { type: "integer", minimum: 0 },
    choice: { enum: ["retry", "emergency_bot", "end_session"] },
  },
} as const;

/** 失敗の種類を HTTP Status へ写す。 */
const STATUS_BY_ERROR: Record<StartHandError["kind"], number> = {
  hand_not_found: 404,
  session_mode_mismatch: 409,
  tournament_unavailable: 422,
  stale_view: 409,
  stale_outage: 409,
  not_spectating: 409,
  not_actor: 409,
  hand_complete: 409,
  illegal_action: 422,
  invalid_input: 422,
};

function sendError(
  reply: FastifyReply,
  error: OrchestratorError | StartHandError,
) {
  return reply
    .code(STATUS_BY_ERROR[error.kind])
    .send({ error: { kind: error.kind, message: error.message } });
}

/** SSE の 1 メッセージ。data は JSON（改行を含まない）。 */
function formatSseEvent(
  name: "view" | "session" | "outage",
  data: HeroView | SessionStatus | OutageStatus,
): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
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
  // Session が続いていれば Stack を持ち越し、終わっていれば新しい Session として均等 Stack で始める（D80）。
  // afterHandId（クライアントが結果まで見た最後の Hand）が今の Session の最後の Hand と違う、またはその Hand が進行中なら、
  // 新しく作らずその Hand を 200 で返す（応答が失われた開始の再送で、結果を見ないまま次へ進めない・Session を捨てない）。
  // Hand が開始直後に終わることもあるので、Session の状態も一緒に返す。
  app.post<{ Body: StartHandBody }>(
    "/api/hands",
    { schema: { body: startHandBodySchema } },
    async (request, reply) => {
      const result = await orchestrator.startHand(
        request.body.afterHandId,
        request.body.session,
      );
      if (!result.ok) return sendError(reply, result.error);
      const { handId, view, created } = result.value;
      return reply.code(created ? 201 : 200).send({
        handId,
        players: orchestrator.players,
        view,
        session: orchestrator.sessionStatus(handId),
        outage: orchestrator.outageStatus(handId),
        fastForward: orchestrator.fastForwardOf(handId) ?? false,
      });
    },
  );

  // Hero の Action。適用後、次の Hero の手番か Hand の終了まで CPU を進めた時点の View を返す
  // （CPU の思考待ちがある設定では、CPU の行動は SSE で後から届く）。
  app.post<{ Params: HandParams; Body: HeroActionBody }>(
    "/api/hands/:handId/actions",
    { schema: { params: handParamsSchema, body: heroActionBodySchema } },
    async (request, reply) => {
      const { handId } = request.params;
      const { lastSeq, action } = request.body;
      const result = await orchestrator.heroAction(handId, lastSeq, action);
      if (!result.ok) return sendError(reply, result.error);
      return reply.send({
        view: result.value,
        session: orchestrator.sessionStatus(handId),
        outage: orchestrator.outageStatus(handId),
      });
    },
  );

  // Hero の物理的な操作（宣言・Chip を出す・足す）。Ruling Engine で裁定し、操作・裁定・決まった Action を Event Log に残す（D90）。
  // 手番でなければ Out-of-Turn として保留し、Hero の手番が来た時点で拘束か撤回かを裁定する（D91）。
  // 応答は /actions と同じ形（裁定は view.log の DEALER_RULING に入る）。
  app.post<{ Params: HandParams; Body: HeroPhysicalActionBody }>(
    "/api/hands/:handId/physical-actions",
    {
      schema: { params: handParamsSchema, body: heroPhysicalActionBodySchema },
    },
    async (request, reply) => {
      const { handId } = request.params;
      const { lastSeq, actions } = request.body;
      const result = await orchestrator.heroPhysicalAction(
        handId,
        lastSeq,
        actions,
      );
      if (!result.ok) return sendError(reply, result.error);
      return reply.send({
        view: result.value,
        session: orchestrator.sessionStatus(handId),
        outage: orchestrator.outageStatus(handId),
      });
    },
  );

  // Hero の User Read（判断の前の読み・意図。D33・D112）。Hero の手番の間だけ記録でき、USER_READ_RECORDED（Hero だけの private）として
  // Event Log に残す。卓の状態は変えないので CPU は進めず、更新した View を返す（SSE にも同じ View が届く）。
  // 読みの当たり外れ（CPU の Persona・相手の札との照合）は Play 中に返さない（D105）。
  app.post<{ Params: HandParams; Body: UserReadBody }>(
    "/api/hands/:handId/reads",
    { schema: { params: handParamsSchema, body: userReadBodySchema } },
    (request, reply) => {
      const { handId } = request.params;
      const { lastSeq, targetPlayerId, text } = request.body;
      const result = orchestrator.heroUserRead(handId, lastSeq, {
        targetPlayerId,
        text,
      });
      if (!result.ok) return sendError(reply, result.error);
      return reply.send({ view: result.value });
    },
  );

  // Fast Forward を入れる・切る（D12・D15・D93）。Hero が Fold した後だけ入れられ、その Hand の残りの CPU の思考待ち（演出）を縮める。
  // Claude の応答時間そのものは縮まない。Hand が終われば自動で切れる。運用の状態で、Event には残さない。
  app.post<{ Params: HandParams; Body: FastForwardBody }>(
    "/api/hands/:handId/fast-forward",
    { schema: { params: handParamsSchema, body: fastForwardBodySchema } },
    async (request, reply) => {
      const result = orchestrator.setFastForward(
        request.params.handId,
        request.body.enabled,
      );
      if (!result.ok) return sendError(reply, result.error);
      return reply.send(result.value);
    },
  );

  // CPU の障害で止まった Hand の続け方（Retry / Emergency Bot / Session 終了。D86）。
  // 選んだ後、次の Hero の手番か Hand の終了まで CPU を進めた時点の View を返す（思考待ちがある設定では、CPU の行動は SSE で後から届く）。
  app.post<{ Params: HandParams; Body: OutageChoiceBody }>(
    "/api/hands/:handId/outage",
    { schema: { params: handParamsSchema, body: outageChoiceBodySchema } },
    async (request, reply) => {
      const { handId } = request.params;
      const { revision, choice } = request.body;
      const result = await orchestrator.resolveOutage(handId, revision, choice);
      if (!result.ok) return sendError(reply, result.error);
      return reply.send({
        view: result.value,
        session: orchestrator.sessionStatus(handId),
        outage: orchestrator.outageStatus(handId),
      });
    },
  );

  // 卓の状態の SSE。接続時に現在の障害の状態（outage イベント）と View を 1 回ずつ送り、以後は Log が進むたびに View を、
  // 障害が起きる・解けるたびに障害の状態を送る。
  // Hand が終わった View の直前に Session の状態（session イベント）を送り、View を送ったらサーバー側から閉じる
  // （クライアントは status が complete の View を受けたら閉じて再接続しないので、Session の状態を先に届ける）。
  // 障害の後に Session 終了が選ばれたら、障害の状態の直後に Session の状態を送る（Hand は途中なので閉じない）。
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
      let unsubscribeOutage: (() => void) | null = null;
      const end = () => {
        unsubscribe?.();
        unsubscribe = null;
        unsubscribeOutage?.();
        unsubscribeOutage = null;
        openStreams.delete(end);
        if (!res.writableEnded) res.end();
      };
      const sendOutage = (status: OutageStatus) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(formatSseEvent("outage", status));
        // Hand の途中で Session が終わるのは、障害の後に Session 終了が選ばれたときだけ（Hand の終了時は send が送る）。
        const session = orchestrator.sessionStatus(handId);
        if (session?.state === "ended" && session.reason === "ai_outage") {
          res.write(formatSseEvent("session", session));
        }
      };
      const send = (view: HeroView) => {
        // 切断済みの接続へは書かない（close の通知より先に配信が来ることがある）。
        if (res.writableEnded || res.destroyed) return;
        if (view.status === "complete") {
          const session = orchestrator.sessionStatus(handId);
          if (session !== null) res.write(formatSseEvent("session", session));
        }
        res.write(formatSseEvent("view", view));
        if (view.status === "complete") end();
      };

      // req の close は本文を読み終えた時点でも発火するため、接続の終了は res の close で見る。
      res.on("close", end);
      openStreams.add(end);
      const initialOutage = orchestrator.outageStatus(handId);
      if (initialOutage !== null) sendOutage(initialOutage);
      send(initial);
      if (!res.writableEnded) {
        unsubscribe = orchestrator.subscribe(handId, send);
        unsubscribeOutage = orchestrator.subscribeOutage(handId, sendOutage);
      }
    },
  );
}
