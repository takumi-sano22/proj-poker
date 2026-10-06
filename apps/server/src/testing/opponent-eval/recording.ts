// AI Opponent Eval の録画（手動の Eval で実際に返った出力）と、その再生（CI。Claude を呼ばない。D87）。
// 録画は判断ごとに「渡した引数の指紋・出力・所要時間」だけを持つ。検証・Retry・漏れ検査・集計は再生のたびに今のコードでやり直す。
// 再生で引数の指紋が違えば、Prompt・Persona・Schema・単発化の設定のどれかが録画のときと変わっている（録画を取り直す）。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "../../opponents/claude-opponent.js";
import type { PersonaPresetId } from "../../opponents/persona.js";
import { hashParams, type EvalCase, type EvalRecord } from "./harness.js";
import { caseKey, type OpponentEvalSummary } from "./metrics.js";

/** 録画の置き場所（コミットする。CI はこれを再生する）。 */
export const RECORDING_URL = new URL(
  "./recordings/opponent-eval.json",
  import.meta.url,
);

export interface RecordedAttempt {
  readonly paramsHash: string;
  readonly output: unknown;
  readonly ms: number;
}

export interface RecordedCase extends EvalCase {
  readonly attempts: readonly RecordedAttempt[];
}

export interface OpponentEvalRecording {
  /** 録画の形の版。 */
  readonly version: 1;
  readonly recordedAt: string;
  /** role-based config の値（MODEL_ROLES.opponent_fast）。 */
  readonly model: string;
  /** apps/server の package.json にある Agent SDK の版。 */
  readonly sdkVersion: string;
  readonly spots: readonly string[];
  readonly personas: readonly PersonaPresetId[];
  readonly repeats: number;
  readonly concurrency: number;
  readonly cases: readonly RecordedCase[];
  /** 録画したときに集計した指標（再生で同じ値になることを CI で確かめる）。 */
  readonly summary: OpponentEvalSummary;
}

/** 判断の記録を録画の形にする（障害の判断は録画しない。呼び出し側で障害が無いことを確かめてから使う）。 */
export function toRecordedCases(
  records: readonly EvalRecord[],
): RecordedCase[] {
  return records.map((r) => ({
    spotId: r.spotId,
    personaId: r.personaId,
    repeat: r.repeat,
    attempts: r.attempts.map((a) => ({
      paramsHash: a.paramsHash,
      output: a.output,
      ms: a.ms,
    })),
  }));
}

/** 録画を再生する仮想の時計。再生する query が録画した所要時間だけ進める。 */
export interface ReplayClock {
  readonly now: () => number;
  advance(ms: number): void;
}

export function createReplayClock(): ReplayClock {
  let t = 0;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/**
 * 判断ごとに、録画した出力を順に返す query()。SDK が返す result（success・structured_output）の形で流すので、
 * ClaudeOpponent の message の読み方も本番と同じ経路を通る。渡された引数の指紋が録画と違えば例外にする（録画が古い）。
 */
export function replayQueryFor(
  recording: OpponentEvalRecording,
  clock: ReplayClock,
): (c: EvalCase) => ClaudeQuery {
  const byKey = new Map(recording.cases.map((c) => [caseKey(c), c]));
  return (c) => {
    const recorded = byKey.get(caseKey(c));
    if (recorded === undefined) {
      throw new Error(`録画に無い判断: ${caseKey(c)}`);
    }
    let index = 0;
    return (params) => {
      const attempt = recorded.attempts[index++];
      if (attempt === undefined) {
        throw new Error(`録画より呼び出しが多い: ${caseKey(c)}#${index}`);
      }
      const hash = hashParams(params);
      if (hash !== attempt.paramsHash) {
        throw new Error(
          `${caseKey(c)}#${index}: 渡した引数が録画のときと違う（${hash} ≠ ${attempt.paramsHash}）。Prompt・Persona・Schema・単発化の設定を変えたら、手動の Eval で録画を取り直す`,
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
