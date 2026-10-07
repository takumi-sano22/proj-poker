// Hero の Note / Tag の API（D31・D112・#115）。対象は Hand と席で指定し、サーバーがその Hand の Session の参加者として決める
// （席の playerId を永続の Identity とみなさない。D105）。どの応答もその対象の今の Note / Tag を返す。
import { deleteJson, getJson, postJson } from "./api.js";

/** Note の本文・Tag の上限（字）。サーバーの NOTE_BODY_MAX / TAG_MAX と同じ値。 */
export const NOTE_BODY_MAX = 500;
export const TAG_MAX = 20;

export interface SubjectNote {
  readonly noteId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** ある席（その Session の参加者）の今の Note（書いた順）と Tag（付けた順）。 */
export interface SubjectNotes {
  readonly notes: readonly SubjectNote[];
  readonly tags: readonly string[];
}

function base(handId: string, playerId: string): string {
  return `/api/hands/${encodeURIComponent(handId)}/players/${encodeURIComponent(playerId)}`;
}

export function fetchSubjectNotes(
  handId: string,
  playerId: string,
): Promise<SubjectNotes> {
  return getJson<SubjectNotes>(`${base(handId, playerId)}/notes`);
}

export function addNote(
  handId: string,
  playerId: string,
  body: string,
): Promise<SubjectNotes> {
  return postJson<SubjectNotes>(`${base(handId, playerId)}/notes`, { body });
}

export function deleteNote(
  handId: string,
  playerId: string,
  noteId: string,
): Promise<SubjectNotes> {
  return deleteJson<SubjectNotes>(
    `${base(handId, playerId)}/notes/${encodeURIComponent(noteId)}`,
  );
}

export function addTag(
  handId: string,
  playerId: string,
  tag: string,
): Promise<SubjectNotes> {
  return postJson<SubjectNotes>(`${base(handId, playerId)}/tags`, { tag });
}

export function removeTag(
  handId: string,
  playerId: string,
  tag: string,
): Promise<SubjectNotes> {
  return deleteJson<SubjectNotes>(
    `${base(handId, playerId)}/tags/${encodeURIComponent(tag)}`,
  );
}
