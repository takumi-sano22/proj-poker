// Review Eval のハーネス（docs/09 §6 の最小形・Issue #82）。固定 Hand の Hero の判断ごとに Pass A の Review を作り、指標を集計する。
// 本番と同じ経路で作る（LC-050・llm-quality-improvement 鉄則 9）: Evidence は buildReviewEvidence、生成（Gate → Review AI → 検証 →
// Retry → Insufficient Evidence）は generateReview（ReviewService と同じ関数）。差し替えるのは SDK の query() だけ
// （手動の Eval は本物、CI は録画済み応答の再生）。Solver は録画の再生で結果が揃うよう、既定は未導入（solver_not_installed）に固定する。
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  createDeck,
  heroInformationSets,
} from "@proj-poker/engine";
import type { ClaudeQuery } from "../../claude/structured-query.js";
import { PHASE1_TABLE_SETUP } from "../../config.js";
import type { LoadedKb } from "../../kb/index.js";
import {
  buildReviewEvidence,
  reviewSpotReasons,
} from "../../review/evidence.js";
import { generateReview } from "../../review/generate.js";
import {
  findIdentifiers,
  outputTexts,
  toPlayerNames,
} from "../../review/identifiers.js";
import type { ReviewInvalidStage } from "../../review/review-ai.js";
import type {
  Assessment,
  ReviewDepth,
  ReviewEvidence,
  ReviewGeneratedBy,
} from "../../review/types.js";
import type { SolverAdapter } from "../../solver/types.js";
import { allowedCardsAt, forbiddenKeys, leakedCards } from "../leaks.js";
// 引数の指紋は AI Opponent Eval と同じ作り方（Prompt と、実行環境で変わらない Options）。
import { hashParams } from "../opponent-eval/harness.js";
import {
  BTN_VS_UTG,
  BUBBLE_CALL,
  BUBBLE_SHOVE,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
  tournamentSessionOf,
  type ScriptedHand,
} from "./hands.js";

/** Review する判断（固定 Hand × Hero の判断の順番）。 */
export interface ReviewEvalCase {
  /** 録画・集計のキー。変えると録画が使えなくなる。 */
  readonly id: string;
  readonly hand: ScriptedHand;
  readonly decisionIndex: number;
}

/**
 * 代表の判断（Issue #82 の最小形）。Preflop の Call・River の大きい Bet への Call（Important Spot）・HU の Turn で最初の Bet
 * （Solver の Root。録画では未導入）・Multiway の Flop の Call（Solver は player_count）。
 */
export const REVIEW_EVAL_CASES: readonly ReviewEvalCase[] = [
  { id: "btn_vs_utg/d0", hand: BTN_VS_UTG, decisionIndex: 0 },
  { id: "btn_vs_utg/d3", hand: BTN_VS_UTG, decisionIndex: 3 },
  { id: "sb_vs_btn/d2", hand: SB_VS_BTN, decisionIndex: 2 },
  { id: "multiway_flop/d1", hand: MULTIWAY_FLOP, decisionIndex: 1 },
];

/**
 * Tournament の代表の判断（#189）。Bubble の Shove と、Bubble の All-in への Call（ICM と Chip EV の必要 Equity を並べる Spot）。
 * 実モデルの録画はまだ無い（Claude の利用枠を使う録画は人間判断）ので、REVIEW_EVAL_CASES（録画を再生する CI の母集団）とは分け、
 * 固定の応答（Fake）で本番と同じ経路を通す（harness.test.ts）。録画を取るときに REVIEW_EVAL_CASES へ入れる。
 */
export const TOURNAMENT_REVIEW_EVAL_CASES: readonly ReviewEvalCase[] = [
  { id: "bubble_shove/d0", hand: BUBBLE_SHOVE, decisionIndex: 0 },
  { id: "bubble_call/d0", hand: BUBBLE_CALL, decisionIndex: 0 },
];

export interface ReviewEvalAttempt {
  /** 実際に渡した Prompt・Options の指紋（録画の再生で、本番の引数組み立てが録画時と同じかを確かめる）。 */
  readonly paramsHash: string;
  /** Claude の構造化出力そのもの（検証前）。 */
  readonly output: unknown;
  /** 呼び出しの所要時間（子プロセスの起動を含む）。ミリ秒の整数。 */
  readonly ms: number;
  readonly check:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly stage: ReviewInvalidStage;
        readonly reason: string;
      };
}

export type ReviewEvalFinal =
  | {
      readonly kind: "review";
      readonly generatedBy: ReviewGeneratedBy;
      readonly assessment: Assessment;
      readonly cited: readonly string[];
      /** 説明の文（Practical・Theory・Exploit を順につないだもの。表示と語の検査に使う）。 */
      readonly text: string;
      /** 内部の識別子の疑い（#96）。raw は Review AI の出力（置換の前）、residual は保存する Review（置換の後）に残っているもの。 */
      readonly identifiers: {
        readonly raw: readonly string[];
        readonly residual: readonly string[];
      };
    }
  /** Claude の呼び出しの失敗（本番なら Review を作らずに再実行を待つ）。 */
  | { readonly kind: "outage"; readonly message: string };

export interface ReviewEvalRecord {
  readonly caseId: string;
  readonly repeat: number;
  /** Solver Evidence の状態（supported / unsupported / not_applicable / failed）。 */
  readonly solverStatus: ReviewEvidence["solver"]["status"];
  readonly attempts: readonly ReviewEvalAttempt[];
  readonly final: ReviewEvalFinal;
  /** Evidence・Prompt に、判断時点の Hero が知り得ない情報が入っていた箇所（空なら漏れなし）。 */
  readonly leaks: readonly string[];
}

export interface ReviewEvalOptions {
  readonly cases: readonly ReviewEvalCase[];
  readonly repeats: number;
  readonly depth?: ReviewDepth;
  readonly kb: LoadedKb;
  readonly solver: SolverAdapter;
  readonly env: Record<string, string>;
  /** その判断で使う query()。手動の Eval は SDK の query、CI は録画の再生。 */
  readonly queryFor: (caseId: string, repeat: number) => ClaudeQuery;
  /** 1 回の呼び出しの上限（ミリ秒）。 */
  readonly timeoutMs?: number;
  /** 時計（既定は performance.now）。録画の再生では録画した所要時間で進める。 */
  readonly clock?: () => number;
  readonly onRecord?: (
    record: ReviewEvalRecord,
    done: number,
    total: number,
  ) => void;
}

/** 全判断 × 繰り返しを順に Review する（Claude の子プロセスを同時に複数動かさない。本番の ReviewService と同じ）。 */
export async function runReviewEval(
  options: ReviewEvalOptions,
): Promise<ReviewEvalRecord[]> {
  const records: ReviewEvalRecord[] = [];
  const total = options.cases.length * options.repeats;
  for (const c of options.cases) {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      const record = await runCase(c, repeat, options);
      records.push(record);
      options.onRecord?.(record, records.length, total);
    }
  }
  return records;
}

async function runCase(
  c: ReviewEvalCase,
  repeat: number,
  options: ReviewEvalOptions,
): Promise<ReviewEvalRecord> {
  const events = playScriptedHand(c.hand);
  const sets = heroInformationSets(events, "hero");
  const set = sets[c.decisionIndex];
  if (set === undefined) throw new Error(`${c.id}: Hero の判断が無い`);
  // Tournament の Hand は本番（ReviewService）と同じく Session の情報を渡す（Important Spot の理由と ICM の Evidence。#189）。
  const tournament = tournamentSessionOf(c.hand);
  const reasons = reviewSpotReasons(sets, c.decisionIndex, tournament);
  const evidence = await buildReviewEvidence(set, reasons, {
    playerNames: toPlayerNames(PHASE1_TABLE_SETUP.players),
    kb: options.kb,
    solver: options.solver,
    ...(tournament === undefined ? {} : { tournament }),
  });
  const upto = set.decision.decisionPointSeq;
  const allowed = allowedCardsAt(events, "hero", upto);
  const leaks = new Set<string>([
    ...leakedCards(evidence, events, "hero", upto).map(
      (card) => `evidence: ${card}`,
    ),
    // KB の本文は静的な Curated KB（Hidden Information ではない）なので、語の検査から外す。
    ...forbiddenKeys(withoutKbBodies(evidence)).map(
      (key) => `evidence: ${key}`,
    ),
  ]);

  const clock = options.clock ?? (() => performance.now());
  const inner = options.queryFor(c.id, repeat);
  const sent: { prompt: string; options: Options }[] = [];
  let startedAt = 0;
  const query: ClaudeQuery = (params) => {
    sent.push(params);
    startedAt = clock();
    return inner(params);
  };
  const attempts: ReviewEvalAttempt[] = [];
  // 検証を通った出力の、置換の前の文（識別子の出方を見る）。
  let rawTexts: string[] = [];
  try {
    const draft = await generateReview(evidence, {
      depth: options.depth ?? "standard",
      actionSeq: set.decision.actionSeq,
      env: options.env,
      query,
      signalFor: () =>
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs),
      onAttempt: ({ prompt, output, check }) => {
        const params = sent.at(-1);
        if (check.ok) rawTexts = outputTexts(check.value);
        // 実際に送った Prompt に、判断時点の Hero が知り得ない札の表記が無いか。
        createDeck()
          .map(cardToString)
          .filter((card) => !allowed.has(card) && prompt.includes(`"${card}"`))
          .forEach((card) => leaks.add(`prompt: ${card}`));
        attempts.push({
          paramsHash: params === undefined ? "" : hashParams(params),
          output,
          ms: Math.round(clock() - startedAt),
          check: check.ok
            ? { ok: true }
            : { ok: false, stage: check.stage, reason: check.reason },
        });
      },
    });
    return {
      caseId: c.id,
      repeat,
      solverStatus: evidence.solver.status,
      attempts,
      final: {
        kind: "review",
        generatedBy: draft.generatedBy,
        assessment: draft.assessment,
        cited: draft.evidenceIds.cited,
        text: [
          draft.explanation.practical,
          draft.explanation.theory.text,
          draft.explanation.exploit.text,
        ].join("\n"),
        identifiers: {
          raw: [...new Set(rawTexts.flatMap(findIdentifiers))],
          residual: [
            ...new Set(
              outputTexts([draft.explanation, draft.assumptions]).flatMap(
                findIdentifiers,
              ),
            ),
          ],
        },
      },
      leaks: [...leaks],
    };
  } catch (error) {
    return {
      caseId: c.id,
      repeat,
      solverStatus: evidence.solver.status,
      attempts,
      final: { kind: "outage", message: String(error) },
      leaks: [...leaks],
    };
  }
}

/** KB の本文（静的な Curated KB。Hidden Information ではない）を除いた Evidence。語の検査（forbiddenKeys）に使う。 */
export function withoutKbBodies(evidence: ReviewEvidence): ReviewEvidence {
  return {
    ...evidence,
    knowledge: {
      ...evidence.knowledge,
      items: evidence.knowledge.items.map((i) => ({ ...i, body: "" })),
    },
  };
}
