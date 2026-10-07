// Hero の Note / Tag の API（D31・D112・#115）。対象は Hand と席で指定し、Server がその Hand の Session の参加者として決める
// （席の playerId を永続の Identity とみなさない。D105）。どの応答も、その対象の今の Note / Tag（SubjectNotes）を返す。
// Note / Tag は Hero だけのもので、CPU の入力・Review の Evidence には渡さない（不変条件 2）。Play 中の HUD（統計）ではない（D32）。
import type { FastifyInstance, FastifyReply } from "fastify";
import type { HandOrchestrator } from "../hand-orchestrator.js";
import {
  NOTE_BODY_MAX,
  normalizeNoteBody,
  normalizeTag,
  TAG_MAX,
  type NoteStore,
} from "../notes/note-store.js";

interface SubjectParams {
  handId: string;
  playerId: string;
}

const idSchema = { type: "string", minLength: 1, maxLength: 64 } as const;

const subjectParamsSchema = {
  type: "object",
  required: ["handId", "playerId"],
  properties: { handId: idSchema, playerId: idSchema },
} as const;

const noteParamsSchema = {
  type: "object",
  required: ["handId", "playerId", "noteId"],
  properties: { handId: idSchema, playerId: idSchema, noteId: idSchema },
} as const;

const tagParamsSchema = {
  type: "object",
  required: ["handId", "playerId", "tag"],
  properties: {
    handId: idSchema,
    playerId: idSchema,
    tag: { type: "string", minLength: 1, maxLength: TAG_MAX },
  },
} as const;

// noteId はクライアントが作る UUID（応答が失われた追加の再送を冪等にする。同じ noteId の 2 回目は行を足さない）。
const noteBodySchema = {
  type: "object",
  required: ["noteId", "body"],
  additionalProperties: false,
  properties: {
    noteId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
    body: { type: "string", minLength: 1, maxLength: NOTE_BODY_MAX },
  },
} as const;

const tagBodySchema = {
  type: "object",
  required: ["tag"],
  additionalProperties: false,
  properties: { tag: { type: "string", minLength: 1, maxLength: TAG_MAX } },
} as const;

type NoteErrorKind =
  "hand_not_found" | "invalid_input" | "not_found" | "conflict";

const STATUS_BY_ERROR: Record<NoteErrorKind, number> = {
  hand_not_found: 404,
  invalid_input: 422,
  not_found: 404,
  conflict: 409,
};

function sendError(reply: FastifyReply, kind: NoteErrorKind, message: string) {
  return reply.code(STATUS_BY_ERROR[kind]).send({ error: { kind, message } });
}

export function registerNoteRoutes(
  app: FastifyInstance,
  orchestrator: HandOrchestrator,
  store: NoteStore,
): void {
  /** Hand と席から対象を決める。決められなければ応答を返して null。 */
  const subjectOr = (reply: FastifyReply, params: SubjectParams) => {
    const result = orchestrator.subjectOf(params.handId, params.playerId);
    if (result.ok) return result.value;
    const kind =
      result.error.kind === "hand_not_found"
        ? "hand_not_found"
        : "invalid_input";
    void sendError(reply, kind, result.error.message);
    return null;
  };

  // その席（その Session の参加者）の今の Note / Tag。
  app.get<{ Params: SubjectParams }>(
    "/api/hands/:handId/players/:playerId/notes",
    { schema: { params: subjectParamsSchema } },
    (request, reply) => {
      const subject = subjectOr(reply, request.params);
      if (subject === null) return reply;
      return reply.send(store.notesOf(subject));
    },
  );

  // Note を足す（追記）。
  app.post<{ Params: SubjectParams; Body: { noteId: string; body: string } }>(
    "/api/hands/:handId/players/:playerId/notes",
    { schema: { params: subjectParamsSchema, body: noteBodySchema } },
    (request, reply) => {
      const subject = subjectOr(reply, request.params);
      if (subject === null) return reply;
      const body = normalizeNoteBody(request.body.body);
      if (body === null) {
        return sendError(reply, "invalid_input", "Note の本文が空白だけ");
      }
      if (store.addNote(subject, body, request.body.noteId) === null) {
        return sendError(reply, "conflict", "その noteId は別の席の Note");
      }
      return reply.code(201).send(store.notesOf(subject));
    },
  );

  // Note を消す（tombstone の行を足す。保存済みの行は消さない）。
  app.delete<{ Params: SubjectParams & { noteId: string } }>(
    "/api/hands/:handId/players/:playerId/notes/:noteId",
    { schema: { params: noteParamsSchema } },
    (request, reply) => {
      const subject = subjectOr(reply, request.params);
      if (subject === null) return reply;
      if (!store.deleteNote(subject, request.params.noteId)) {
        return sendError(reply, "not_found", "その席の Note に無い");
      }
      return reply.send(store.notesOf(subject));
    },
  );

  // Tag を付ける（付いていれば何もしない）。
  app.post<{ Params: SubjectParams; Body: { tag: string } }>(
    "/api/hands/:handId/players/:playerId/tags",
    { schema: { params: subjectParamsSchema, body: tagBodySchema } },
    (request, reply) => {
      const subject = subjectOr(reply, request.params);
      if (subject === null) return reply;
      const tag = normalizeTag(request.body.tag);
      if (tag === null) {
        return sendError(
          reply,
          "invalid_input",
          "Tag は空白だけ・改行を含む値にしない",
        );
      }
      store.addTag(subject, tag);
      return reply.send(store.notesOf(subject));
    },
  );

  // Tag を外す（remove の行を足す）。
  app.delete<{ Params: SubjectParams & { tag: string } }>(
    "/api/hands/:handId/players/:playerId/tags/:tag",
    { schema: { params: tagParamsSchema } },
    (request, reply) => {
      const subject = subjectOr(reply, request.params);
      if (subject === null) return reply;
      if (!store.removeTag(subject, request.params.tag)) {
        return sendError(reply, "not_found", "その席に付いていない Tag");
      }
      return reply.send(store.notesOf(subject));
    },
  );
}
