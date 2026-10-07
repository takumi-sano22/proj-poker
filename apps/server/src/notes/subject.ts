// Hero の Note / Tag の対象（Subject）の参照（D105・#115）。席の playerId（cpu1 等）は Hand・Session ごとに別の CPU が座りうるので、
// 永続の Identity として扱わない。Phase 6 では「その Session の中の参加者（Session ID と席の playerId の組）」として持つ。
// Phase 7（D106）で CPU が永続の cpuProfileId を持ったら、kind を足して（例: { kind: "cpu_profile", cpuProfileId }）同じ列に入れ、
// 既存の session_player の参照は Session の席と cpuProfileId の対応から永続の CPU へ引く（保存済みの行は書き換えない）。

/** その Session の中の参加者（Phase 6 の Subject）。 */
export interface SessionPlayerSubject {
  readonly kind: "session_player";
  readonly sessionId: string;
  /** その Session の席の playerId（Hand の Event の playerId と同じ値）。 */
  readonly playerId: string;
}

/** Note / Tag の対象。種類（kind）を足して広げる。 */
export type SubjectRef = SessionPlayerSubject;

/** 同じ対象を 1 つの文字列にした検索の鍵（保存の subject_key 列）。kind を先頭に置き、種類を足しても衝突しない。 */
export function subjectKey(subject: SubjectRef): string {
  return JSON.stringify([subject.kind, subject.sessionId, subject.playerId]);
}
