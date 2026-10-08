// Opponent Memory Reset の API（#143・D64・D120・docs/04 §11）。Learning Reset（POST /api/learning/resets）とは別の経路・別の表。
// - `POST /api/opponents/memory-resets`: 全 CPU（`{ scope: "all" }`）か 1 つの Fixed CPU（`{ scope: "cpu_profile", cpuProfileId }`）の
//   Memory の区切りを足す。区切りの行を足すだけで、Event Log・reviews・User Read / Note / Tag・Learning Reset の区切りは変えない
// 応答は区切りの時刻と対象だけで、Hidden Persona・Hypothesis / Memory の中身・Pool の名前を返さない。
import type { FastifyInstance } from "fastify";
import type {
  OpponentMemoryResetStore,
  OpponentMemoryResetTarget,
} from "../memory/memory-reset.js";

type ResetBody =
  { scope: "all" } | { scope: "cpu_profile"; cpuProfileId: string };

// scope が cpu_profile のときだけ cpuProfileId を持つ（all に id を付けた・cpu_profile に id が無い要求は形の不正）。
const resetBodySchema = {
  type: "object",
  required: ["scope"],
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: ["all", "cpu_profile"] },
    cpuProfileId: { type: "string", minLength: 1, maxLength: 64 },
  },
  if: { properties: { scope: { const: "cpu_profile" } } },
  then: { required: ["cpuProfileId"] },
  else: { not: { required: ["cpuProfileId"] } },
} as const;

export function registerOpponentRoutes(
  app: FastifyInstance,
  resets: OpponentMemoryResetStore,
  /** Reset できる Fixed CPU の cpuProfileId（Fixed Pool。知らない id の区切りを足さない）。 */
  knownCpuProfileIds: ReadonlySet<string>,
): void {
  // 取り消しはできないが、消すのは CPU の Memory の計算の範囲だけで、正本は残る（区切りの行の追記）。
  app.post<{ Body: ResetBody }>(
    "/api/opponents/memory-resets",
    { schema: { body: resetBodySchema } },
    (request, reply) => {
      const body = request.body;
      if (
        body.scope === "cpu_profile" &&
        !knownCpuProfileIds.has(body.cpuProfileId)
      ) {
        return reply.code(404).send({
          error: {
            kind: "cpu_profile_not_found",
            message: "その CPU は無い",
          },
        });
      }
      const target: OpponentMemoryResetTarget =
        body.scope === "all"
          ? { scope: "all" }
          : { scope: "cpu_profile", cpuProfileId: body.cpuProfileId };
      return reply.code(201).send({ reset: resets.add(target) });
    },
  );
}
