// Hero の Note / Tag の対象（Subject）の参照（D105・#115）。席の playerId（cpu1 等）は Hand・Session ごとに別の CPU が座りうるので、
// 永続の Identity として扱わない。Phase 6 では「その Session の中の参加者（Session ID と席の playerId の組）」として持つ。
// Phase 7（D106・D118・#136）で CPU が永続の cpuProfileId を持ったので、kind に cpu_profile を足した（同じ列に入る）。
// 既存の session_player の参照は、Session の席と cpuProfileId の対応（session_participants。v10）から永続の CPU へ引く
// （persistentSubjectOf。保存済みの行は書き換えない）。
import type { SessionParticipant } from "../opponents/cpu-pool.js";

/** その Session の中の参加者（Phase 6 の Subject）。 */
export interface SessionPlayerSubject {
  readonly kind: "session_player";
  readonly sessionId: string;
  /** その Session の席の playerId（Hand の Event の playerId と同じ値）。 */
  readonly playerId: string;
}

/** Session を跨いで同じ Fixed CPU（Phase 7。D106・D118）。Guest は Session 限りなので、この kind では表さない。 */
export interface CpuProfileSubject {
  readonly kind: "cpu_profile";
  readonly cpuProfileId: string;
}

/** Note / Tag の対象。種類（kind）を足して広げる。 */
export type SubjectRef = SessionPlayerSubject | CpuProfileSubject;

/**
 * 同じ対象を 1 つの文字列にした検索の鍵（保存の subject_key 列）。kind を先頭に置き、種類を足しても衝突しない。
 * session_player の鍵は #115 の形のまま（保存済みの行の subject_key とバイト単位で同じ。変えると既存の Note / Tag を引けなくなる）。
 */
export function subjectKey(subject: SubjectRef): string {
  switch (subject.kind) {
    case "session_player":
      return JSON.stringify([
        subject.kind,
        subject.sessionId,
        subject.playerId,
      ]);
    case "cpu_profile":
      return JSON.stringify([subject.kind, subject.cpuProfileId]);
  }
}

/**
 * session_player の対象を、その Session の参加者（EventStore.sessionParticipants）から永続の CPU へ引く。
 * その席が Fixed CPU なら cpu_profile の対象、Guest（Session 限り）・参加者の無い席（Hero・v10 より前の Session）なら null。
 */
export function persistentSubjectOf(
  subject: SessionPlayerSubject,
  participants: readonly SessionParticipant[],
): CpuProfileSubject | null {
  const participant = participants.find((p) => p.playerId === subject.playerId);
  return participant?.kind === "fixed"
    ? { kind: "cpu_profile", cpuProfileId: participant.cpuProfileId }
    : null;
}
