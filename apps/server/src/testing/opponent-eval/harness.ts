// AI Opponent Eval のハーネス（docs/09 §5・Issue #53）。代表 Spot × Persona × 繰り返しの単発の判断を集め、指標を集計する。
// 本番と同じ経路で呼ぶ（LC-050・llm-quality-improvement の鉄則 9）: CPU は createClaudeOpponentFactory（本番の Factory）で作り、
// 出力の検証は checkOpponentOutput → applyAction、Retry は Orchestrator の cpuTurn と同じ「不正なら理由を付けて 1 回だけ再要求、
// 2 回続けて不正なら Fallback」。差し替えるのは SDK の query() だけ（手動の Eval は本物、CI は録画済み応答の再生）。
import { createHash } from "node:crypto";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  applyAction,
  cardToString,
  createDeck,
  type PlayerAction,
} from "@proj-poker/engine";
import {
  createClaudeOpponentFactory,
  type ClaudeQuery,
} from "../../opponents/claude-opponent.js";
import type {
  InvalidOutputStage,
  OpponentInput,
} from "../../opponents/opponent-agent.js";
import { checkOpponentOutput } from "../../opponents/opponent-output.js";
import {
  PERSONA_PRESETS,
  type PersonaPresetId,
} from "../../opponents/persona.js";
import { allowedCardsAt, forbiddenKeys, leakedCards } from "../leaks.js";
import { buildSpot, type EvalSpot, type SpotFixture } from "./spots.js";

/** 1 回の判断（Spot × Persona × 何回目）。 */
export interface EvalCase {
  readonly spotId: string;
  readonly personaId: PersonaPresetId;
  readonly repeat: number;
}

/** 1 回の呼び出し（Retry を含めて 1 判断に最大 2 回）。 */
export interface EvalAttempt {
  /** 実際に渡した Prompt・Options の指紋（録画の再生で、本番の引数組み立てが録画時と同じかを確かめる）。 */
  readonly paramsHash: string;
  /** Claude の構造化出力そのもの（検証前）。 */
  readonly output: unknown;
  /** decide の所要時間（子プロセスの起動を含む）。ミリ秒の整数。 */
  readonly ms: number;
  /** 検証の結果。Engine が拒否した場合も legal_action（Orchestrator と同じ）。 */
  readonly check:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly stage: InvalidOutputStage;
        readonly reason: string;
      };
}

export type EvalFinal =
  /** Claude の判断を Engine が受け付けた。 */
  | { readonly kind: "claude"; readonly action: PlayerAction }
  /** 2 回続けて不正で、本番なら RuleBot の Fallback（D41）になる。 */
  | { readonly kind: "fallback" }
  /** 例外（障害。D86）。本番なら Hand が止まる。 */
  | { readonly kind: "outage"; readonly message: string };

export interface EvalRecord extends EvalCase {
  readonly attempts: readonly EvalAttempt[];
  readonly final: EvalFinal;
  /** その CPU に渡した入力・Prompt に、知ってはいけない情報が入っていた箇所（空なら漏れなし）。 */
  readonly leaks: readonly string[];
}

export interface RunOptions {
  readonly spots: readonly EvalSpot[];
  readonly personas: readonly PersonaPresetId[];
  readonly repeats: number;
  /** role-based config（MODEL_ROLES.opponent_fast）の値。 */
  readonly model: string;
  /** 子プロセスの環境（buildClaudeEnv の結果）。 */
  readonly env: Record<string, string>;
  /** その判断で使う query()。手動の Eval は SDK の query、CI は録画の再生。 */
  readonly queryFor: (c: EvalCase) => ClaudeQuery;
  /** 同時に進める判断の数（既定 1）。録画の再生は 1 にする（仮想の時計を共有するため）。 */
  readonly concurrency?: number;
  /** 1 回の呼び出しの上限（ミリ秒）。超えたら障害として扱う。 */
  readonly timeoutMs?: number;
  /** 時計（既定は performance.now）。録画の再生では録画した所要時間で進める。 */
  readonly clock?: () => number;
  /** 1 判断が終わるたびに呼ぶ（進捗の表示）。 */
  readonly onRecord?: (record: EvalRecord, done: number, total: number) => void;
}

/** 全 Spot × Persona × 繰り返しの判断を集める。結果は Spot・Persona・何回目の順に並べて返す。 */
export async function runOpponentEval(
  options: RunOptions,
): Promise<EvalRecord[]> {
  const cases: EvalCase[] = [];
  for (const spot of options.spots) {
    for (const personaId of options.personas) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        cases.push({ spotId: spot.id, personaId, repeat });
      }
    }
  }
  const spotById = new Map(options.spots.map((s) => [s.id, s]));
  const records: EvalRecord[] = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++] as EvalCase;
      const record = await runCase(
        c,
        spotById.get(c.spotId) as EvalSpot,
        options,
      );
      records.push(record);
      options.onRecord?.(record, records.length, cases.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker),
  );
  return records.sort((a, b) => caseOrder(cases, a) - caseOrder(cases, b));
}

function caseOrder(cases: readonly EvalCase[], r: EvalCase): number {
  return cases.findIndex(
    (c) =>
      c.spotId === r.spotId &&
      c.personaId === r.personaId &&
      c.repeat === r.repeat,
  );
}

/** 1 判断を本番の cpuTurn と同じ手順で進める。 */
async function runCase(
  c: EvalCase,
  spot: EvalSpot,
  options: RunOptions,
): Promise<EvalRecord> {
  const fixture = buildSpot(spot);
  const clock = options.clock ?? (() => performance.now());
  // 実際に渡った引数を記録するため、query() を包む（引数・応答は変えない）。
  const sent: { prompt: string; options: Options }[] = [];
  const inner = options.queryFor(c);
  const query: ClaudeQuery = (params) => {
    sent.push(params);
    return inner(params);
  };
  // 本番の Factory で、その CPU 自身の Persona だけを入れた Agent を作る（seed は Claude では使わない）。
  const agent = createClaudeOpponentFactory({
    model: options.model,
    env: options.env,
    query,
  })(0, fixture.actorId, PERSONA_PRESETS[c.personaId]);

  const base: OpponentInput = fixture.input;
  const uptoSeq = fixture.events.at(-1)?.seq ?? -1;
  const leaks = new Set<string>([
    ...leakedCards(base, fixture.events, fixture.actorId, uptoSeq).map(
      (card) => `input: ${card}`,
    ),
    ...forbiddenKeys(base).map((key) => `input: ${key}`),
  ]);
  const attempts: EvalAttempt[] = [];
  let input = base;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const start = clock();
    let output: unknown;
    try {
      output = await agent.decide(
        input,
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs),
      );
    } catch (error) {
      return {
        ...c,
        attempts,
        final: { kind: "outage", message: String(error) },
        leaks: [...leaks],
      };
    }
    const ms = Math.round(clock() - start);
    const params = sent.at(-1);
    if (params !== undefined) {
      promptLeaks(params.prompt, fixture, c.personaId).forEach((l) =>
        leaks.add(`prompt: ${l}`),
      );
    }
    const paramsHash = params === undefined ? "" : hashParams(params);
    const checked = checkOpponentOutput(output, base.legal);
    const applied = checked.ok
      ? applyAction(fixture.state, fixture.actorId, checked.action)
      : null;
    if (checked.ok && applied?.ok === true) {
      attempts.push({ paramsHash, output, ms, check: { ok: true } });
      return {
        ...c,
        attempts,
        final: { kind: "claude", action: checked.action },
        leaks: [...leaks],
      };
    }
    // 検証は通ったのに Engine が拒否した場合も不正な出力として扱う（Orchestrator と同じ。D40）。
    const { stage, reason } = checked.ok
      ? {
          stage: "legal_action" as const,
          reason: applied?.ok === false ? applied.error.message : "不明",
        }
      : checked;
    attempts.push({
      paramsHash,
      output,
      ms,
      check: { ok: false, stage, reason },
    });
    input = { ...base, correction: { stage, reason } };
  }
  return { ...c, attempts, final: { kind: "fallback" }, leaks: [...leaks] };
}

/**
 * 実際に送った Prompt に、知ってはいけない情報が入っていないか（Hidden Information Leakage）。
 * - Card: Prompt の JSON は Card を "As" 形式の文字列にするので、その CPU が知ってよい札以外の "Xx" が無いかを見る。
 * - Persona: 他の Preset の名前（他 CPU の Secret Persona）が無いか。自分の Persona は Prompt に入ってよい。
 */
function promptLeaks(
  prompt: string,
  fixture: SpotFixture,
  personaId: PersonaPresetId,
): string[] {
  const allowed = allowedCardsAt(
    fixture.events,
    fixture.actorId,
    fixture.events.at(-1)?.seq ?? -1,
  );
  const cards = createDeck()
    .map(cardToString)
    .filter((card) => !allowed.has(card) && prompt.includes(`"${card}"`));
  const personas = Object.values(PERSONA_PRESETS)
    .filter((p) => p.id !== personaId && prompt.includes(p.label))
    .map((p) => p.label);
  return [...cards, ...personas];
}

const VOLATILE_OPTION_KEYS = new Set(["env", "abortController", "cwd"]);

/**
 * 呼び出しの指紋。Prompt と、モデル・System Prompt・構造化出力の Schema・単発化の設定を含む Options から作る。
 * 環境・中断用の Controller・作業ディレクトリ（OS の一時ディレクトリ）は実行環境で変わるので外す。
 */
export function hashParams(params: {
  prompt: string;
  options: Options;
}): string {
  const stable = Object.fromEntries(
    Object.entries(params.options).filter(
      ([key]) => !VOLATILE_OPTION_KEYS.has(key),
    ),
  );
  return createHash("sha256")
    .update(JSON.stringify({ prompt: params.prompt, options: stable }))
    .digest("hex")
    .slice(0, 16);
}
