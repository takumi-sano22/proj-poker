// Review Eval の録画（手動の Eval で実際に返った出力）と、その再生（CI。Claude を呼ばない。D87）。
// 録画は判断ごとに「渡した引数の指紋・出力・所要時間」だけを持つ。検証・Retry・漏れ検査・集計は再生のたびに今のコードでやり直す。
// 再生で引数の指紋が違えば、Evidence・Prompt・Schema・単発化の設定・KB のどれかが録画のときと変わっている（録画を取り直す）。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "../../claude/structured-query.js";
import type { ReplayClock } from "../opponent-eval/recording.js";
import type { ReviewEvalRecord } from "./harness.js";
import type { ReviewEvalSummary } from "./metrics.js";

/** 録画の置き場所（コミットする。CI はこれを再生する）。 */
export const REVIEW_RECORDING_URL = new URL(
  "./recordings/review-eval.json",
  import.meta.url,
);

export interface RecordedReviewCase {
  readonly caseId: string;
  readonly repeat: number;
  readonly attempts: readonly {
    readonly paramsHash: string;
    readonly output: unknown;
    readonly ms: number;
  }[];
}

export interface ReviewEvalRecording {
  /** 録画の形の版。 */
  readonly version: 1;
  readonly recordedAt: string;
  /** role-based config の値（MODEL_ROLES.review_standard）。 */
  readonly model: string;
  /** apps/server の package.json にある Agent SDK の版。 */
  readonly sdkVersion: string;
  /** 録画したときの KB の Version（KB を変えると Evidence が変わり、指紋が合わなくなる）。 */
  readonly kbVersion: string;
  readonly cases: readonly string[];
  readonly repeats: number;
  readonly records: readonly RecordedReviewCase[];
  /** 録画したときに集計した指標（再生で同じ値になることを CI で確かめる）。 */
  readonly summary: ReviewEvalSummary;
}

/** 判断の記録を録画の形にする（障害の判断は録画しない。呼び出し側で障害が無いことを確かめてから使う）。 */
export function toRecordedReviewCases(
  records: readonly ReviewEvalRecord[],
): RecordedReviewCase[] {
  return records.map((r) => ({
    caseId: r.caseId,
    repeat: r.repeat,
    attempts: r.attempts.map((a) => ({
      paramsHash: a.paramsHash,
      output: a.output,
      ms: a.ms,
    })),
  }));
}

/**
 * 判断ごとに、録画した出力を順に返す query()。SDK が返す result（success・structured_output）の形で流すので、
 * runStructuredQuery の message の読み方も本番と同じ経路を通る。渡された引数の指紋が録画と違えば例外にする（録画が古い）。
 */
export function replayReviewQueryFor(
  recording: Pick<ReviewEvalRecording, "records">,
  clock: ReplayClock,
  hashParams: (params: Parameters<ClaudeQuery>[0]) => string,
): (caseId: string, repeat: number) => ClaudeQuery {
  const byKey = new Map(
    recording.records.map((r) => [`${r.caseId}#${r.repeat}`, r]),
  );
  return (caseId, repeat) => {
    const key = `${caseId}#${repeat}`;
    const recorded = byKey.get(key);
    if (recorded === undefined) throw new Error(`録画に無い判断: ${key}`);
    let index = 0;
    return (params) => {
      const attempt = recorded.attempts[index++];
      if (attempt === undefined) {
        throw new Error(`録画より呼び出しが多い: ${key}#${index}`);
      }
      const hash = hashParams(params);
      if (hash !== attempt.paramsHash) {
        throw new Error(
          `${key}#${index}: 渡した引数が録画のときと違う（${hash} ≠ ${attempt.paramsHash}）。Evidence・Prompt・Schema・KB を変えたら、手動の Eval で録画を取り直す`,
        );
      }
      const message = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: attempt.output,
      } as unknown as SDKMessage;
      return (async function* () {
        await Promise.resolve();
        clock.advance(attempt.ms);
        yield message;
      })();
    };
  };
}
