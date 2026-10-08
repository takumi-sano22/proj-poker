// Replay の API（#68・D38・D93）。保存済みの Event を Hero の視点で一手ずつ再生する材料を返す（読み取りだけ）。
// 返すのは Hero に見える Event から作った値だけ（他者の Hole Cards は Showdown で公開されたものだけ・Deck・seed・
// engine / system Visibility の Event・CPU の Persona を含めない）。HAND_FINISHED の無い Hand も同じ形で返し、
// AI 障害の後に打ち切った Hand は aborted: true にする（D95）。
import type { FastifyInstance } from "fastify";
import type { ReplayService } from "../replay.js";

interface HandParams {
  handId: string;
}

const handParamsSchema = {
  type: "object",
  required: ["handId"],
  properties: { handId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

export function registerReplayRoutes(
  app: FastifyInstance,
  replay: ReplayService,
): void {
  // Hand の一覧（新しい順。進行中の Hand、続けて保存の新しい順〔論理順序。D117〕）。未完了の Hand は complete: false・heroNet: null（打ち切った Hand は aborted: true）。
  app.get("/api/replay/hands", () => ({ hands: replay.list() }));

  // 1 Hand の再生の材料。steps は Hero に見える Event の prefix ごとの Hero の視点（replaySteps）。
  app.get<{ Params: HandParams }>(
    "/api/replay/hands/:handId",
    { schema: { params: handParamsSchema } },
    (request, reply) => {
      const { handId } = request.params;
      const hand = replay.hand(handId);
      if (hand === null) {
        return reply.code(404).send({
          error: { kind: "hand_not_found", message: `Hand が無い: ${handId}` },
        });
      }
      return hand;
    },
  );
}
