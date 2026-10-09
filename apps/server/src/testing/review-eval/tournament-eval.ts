// Tournament の Review Eval（#202・D132・docs/09 §6）。#189 の Tournament の Evidence（ICM Equity・Chip EV と ICM の必要 Equity・前提・
// Solver の mode による Unsupported）と #168 の数値 Grounding（D131）を通った Review AI の出力を、実モデルで録画する。
// - Review は既存のハーネス（runReviewEval: 本番の buildReviewEvidence → generateReview）、Follow-up は本番の generateFollowUp を通す
//   （評価専用の引数組み立てを作らない。LC-050）。差し替えるのは SDK の query() だけ（手動の Eval は本物、CI は録画の再生）
// - 呼び出しの上限（D132: 8 Review + Follow-up 2 = 最大 20 回）は番人（createCallBudget）で機械的に止める
// - 指標は決定論で数えられるものだけ（Chip EV と ICM の混同は語と値の並びで見る「疑い」で、一覧を人が読んで確かめる）
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  createDeck,
  heroInformationSets,
} from "@proj-poker/engine";
import type { ClaudeQuery } from "../../claude/structured-query.js";
import { PERSONA_PRESET_IDS } from "../../opponents/persona.js";
import {
  generateFollowUp,
  type FollowUpOutputCheck,
} from "../../review/followup.js";
import { NUMERIC_GROUNDING_REASON_PREFIX } from "../../review/numeric-grounding.js";
import type { ReviewGeneratedBy } from "../../review/types.js";
import type { FollowUpTarget } from "../../review/reveal-types.js";
import type { ReviewDraft } from "../../review/types.js";
import { allowedCardsAt } from "../leaks.js";
import { hashParams } from "../opponent-eval/harness.js";
import type { ReplayClock } from "../opponent-eval/recording.js";
import {
  TOURNAMENT_REVIEW_EVAL_CASES,
  type ReviewEvalCase,
  type ReviewEvalRecord,
} from "./harness.js";
import {
  ITM_SHORT_CALL,
  TOURNAMENT_TURN_BET,
  playScriptedHand,
} from "./hands.js";
import type { ReviewEvalSummary } from "./metrics.js";
import { replayReviewQueryFor, type RecordedReviewCase } from "./recording.js";

/** 呼び出しの上限（D132）。Review 4 判断 × repeat 2 = 8 と Follow-up 2 件。呼び出しは Retry を含めてそれぞれの 2 倍。 */
export const TOURNAMENT_REVIEW_LIMITS = {
  maxReviews: 8,
  maxFollowUps: 2,
  maxCalls: 20,
} as const;

export const TOURNAMENT_REVIEW_REPEATS = 2;

/**
 * 録画する Tournament の判断（D132 の 4 つ）。Bubble の Shove・Bubble の All-in への Call（#189 の 2 つ）・In the Money の Pay Jump で
 * Short Stack の Call・All-in の関わらない通常の判断（Turn の最初の Bet。Tournament では Solver が mode で Unsupported）。
 */
export const TOURNAMENT_REVIEW_RECORDING_CASES: readonly ReviewEvalCase[] = [
  ...TOURNAMENT_REVIEW_EVAL_CASES,
  { id: "itm_short_call/d0", hand: ITM_SHORT_CALL, decisionIndex: 0 },
  { id: "tournament_turn_bet/d2", hand: TOURNAMENT_TURN_BET, decisionIndex: 2 },
];

/** Follow-up（D132: Bubble Shove と Bubble Call の 1 回目の Review に 1 問ずつ。質問文は固定）。 */
export const TOURNAMENT_FOLLOW_UPS = [
  {
    caseId: "bubble_shove/d0",
    repeat: 1,
    question:
      "この Shove で、Chip EV の必要 Equity と ICM の必要 Equity はどう違い、その差は何から来ていますか？",
  },
  {
    caseId: "bubble_call/d0",
    repeat: 1,
    question:
      "この Call は、Chip EV だけで考えたときと ICM で考えたときで結論が変わりますか？",
  },
] as const satisfies readonly {
  readonly caseId: string;
  readonly repeat: number;
  readonly question: string;
}[];

/** 最悪（全部が Retry する）の呼び出しの数。上限を超えるなら呼ぶ前に例外。 */
export function assertTournamentReviewLimit(
  cases: readonly ReviewEvalCase[],
  repeats: number,
  followUps: readonly unknown[],
): number {
  const reviews = cases.length * repeats;
  const worst = (reviews + followUps.length) * 2;
  const l = TOURNAMENT_REVIEW_LIMITS;
  if (
    reviews > l.maxReviews ||
    followUps.length > l.maxFollowUps ||
    worst > l.maxCalls
  ) {
    throw new RangeError(
      `Review ${reviews}・Follow-up ${followUps.length}（最悪 ${worst} 回）は上限（Review ${l.maxReviews}・Follow-up ${l.maxFollowUps}・${l.maxCalls} 回）を超える（D132）`,
    );
  }
  return worst;
}

export const followUpKey = (f: {
  readonly caseId: string;
  readonly repeat: number;
}): string => `followup:${f.caseId}#${f.repeat}`;

/** Follow-up の 1 回の呼び出し（Review Eval の呼び出しと同じ形）。 */
export interface FollowUpEvalAttempt {
  readonly paramsHash: string;
  readonly output: unknown;
  readonly ms: number;
  readonly check:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly stage: Exclude<FollowUpOutputCheck, { ok: true }>["stage"];
        readonly reason: string;
      };
}

export interface FollowUpEvalRecord {
  readonly caseId: string;
  readonly repeat: number;
  readonly question: string;
  readonly attempts: readonly FollowUpEvalAttempt[];
  readonly final:
    | {
        readonly kind: "answer";
        readonly generatedBy: Exclude<ReviewGeneratedBy, "sufficiency_gate">;
        readonly scope: string;
        readonly text: string;
        readonly evidenceIds: readonly string[];
      }
    | { readonly kind: "outage"; readonly message: string };
  /** Prompt に、判断時点の Hero が知り得ない札・CPU の Private な情報が入っていた箇所（空なら漏れなし）。 */
  readonly leaks: readonly string[];
}

export interface FollowUpEvalOptions {
  readonly env: Record<string, string>;
  /** その Follow-up で使う query()（手動の Eval は SDK の query、CI は録画の再生）。 */
  readonly queryFor: (key: string) => ClaudeQuery;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

/**
 * Follow-up を本番の generateFollowUp で作る。対象は ReviewService と同じく、保存した Review の Evidence と説明（ここでは Draft）。
 * drafts のキーは `<caseId>#<repeat>`。対象の Review が無い（障害だった）なら呼ばずに障害として残す。
 */
export async function runTournamentFollowUps(
  drafts: ReadonlyMap<string, ReviewDraft>,
  options: FollowUpEvalOptions,
): Promise<FollowUpEvalRecord[]> {
  const records: FollowUpEvalRecord[] = [];
  for (const f of TOURNAMENT_FOLLOW_UPS) {
    const draft = drafts.get(`${f.caseId}#${f.repeat}`);
    if (draft === undefined) {
      records.push({
        ...f,
        attempts: [],
        final: { kind: "outage", message: "対象の Review が無い" },
        leaks: [],
      });
      continue;
    }
    records.push(await runFollowUp(f, draft, options));
  }
  return records;
}

async function runFollowUp(
  f: (typeof TOURNAMENT_FOLLOW_UPS)[number],
  draft: ReviewDraft,
  options: FollowUpEvalOptions,
): Promise<FollowUpEvalRecord> {
  const c = TOURNAMENT_REVIEW_RECORDING_CASES.find((x) => x.id === f.caseId);
  if (c === undefined) throw new Error(`判断が無い: ${f.caseId}`);
  // 判断時点の Hero が知ってよい札（Review Eval の漏れ検査と同じ基準）。
  const events = playScriptedHand(c.hand);
  const set = heroInformationSets(events, "hero")[c.decisionIndex];
  if (set === undefined) throw new Error(`${c.id}: Hero の判断が無い`);
  const allowed = allowedCardsAt(events, "hero", set.decision.decisionPointSeq);
  const target: FollowUpTarget = {
    pass: "decision",
    reviewId: `eval-${f.caseId}#${f.repeat}`,
    handId: draft.handId,
    decisionIndex: draft.decisionIndex,
    version: 1,
    evidence: draft.evidence,
    explanation: draft.explanation,
  };
  const clock = options.clock ?? (() => performance.now());
  const inner = options.queryFor(followUpKey(f));
  const sent: { prompt: string; options: Options }[] = [];
  let startedAt = 0;
  const query: ClaudeQuery = (params) => {
    sent.push(params);
    startedAt = clock();
    return inner(params);
  };
  const attempts: FollowUpEvalAttempt[] = [];
  const leaks = new Set<string>();
  try {
    const answer = await generateFollowUp(target, [], f.question, {
      depth: "standard",
      env: options.env,
      query,
      signalFor: () =>
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs),
      onAttempt: ({ prompt, output, check }) => {
        const params = sent.at(-1);
        for (const leak of promptLeaks(prompt, allowed)) leaks.add(leak);
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
      ...f,
      attempts,
      final: {
        kind: "answer",
        generatedBy: answer.generatedBy,
        scope: answer.answer.scope,
        text: answer.answer.text,
        evidenceIds: answer.answer.evidenceIds,
      },
      leaks: [...leaks],
    };
  } catch (error) {
    return {
      ...f,
      attempts,
      final: { kind: "outage", message: String(error) },
      leaks: [...leaks],
    };
  }
}

/**
 * Prompt に入ってはいけないもの（Review AI の側）。判断時点の Hero が知り得ない札の表記と、CPU の Private な情報
 * （CPU の Prompt の節の見出し・Memory の Subject の項目名・Persona の Preset の ID と特性の項目名）。
 * Persona の名前（"LAG" 等）は Curated KB の本文に一般語として出うるので、ここでは JSON の値の形（"nit" 等）と項目名だけを見る。
 */
export function promptLeaks(
  prompt: string,
  allowed: ReadonlySet<string>,
): string[] {
  const cards = createDeck()
    .map(cardToString)
    .filter((card) => !allowed.has(card) && prompt.includes(`"${card}"`))
    .map((card) => `prompt: ${card}`);
  const terms = [
    "## あなたの性格",
    "## あなたの記憶",
    "## あなたの今の状態",
    "cpuProfileId",
    "riskTolerance",
    "preflopLooseness",
    ...PERSONA_PRESET_IDS.map((id) => `"${id}"`),
  ]
    .filter((t) => prompt.includes(t))
    .map((t) => `prompt: ${t}`);
  return [...cards, ...terms];
}

/** Review の Prompt の CPU の Private な情報の検査（runReviewEval の query() を包んで、送った Prompt を判断ごとに集める）。 */
export function capturePrompts(
  queryFor: (caseId: string, repeat: number) => ClaudeQuery,
): {
  readonly queryFor: (caseId: string, repeat: number) => ClaudeQuery;
  readonly prompts: ReadonlyMap<string, readonly string[]>;
} {
  const prompts = new Map<string, string[]>();
  return {
    prompts,
    queryFor: (caseId, repeat) => {
      const inner = queryFor(caseId, repeat);
      return (params) => {
        const key = `${caseId}#${repeat}`;
        prompts.set(key, [...(prompts.get(key) ?? []), params.prompt]);
        return inner(params);
      };
    },
  };
}

/** Tournament の Review の指標（ReviewEvalSummary に足すもの。数値はここで機械的に出す）。 */
export interface TournamentReviewReport {
  /** Review の数値 Grounding の不正（#168・D131）の一覧（"判断#何回目#呼び出し: 理由"）。 */
  readonly numericGroundingReasons: readonly string[];
  /**
   * Chip EV と ICM の混同の疑い: 文の中の必要 Equity の値の直前（同じ文の中）にある語が、その値の種類（Chip EV / ICM）と逆だった箇所。
   * 語と値の並びで見る近似なので、一覧を人が読んで確かめる。
   */
  readonly chipIcmConfusions: readonly string[];
  /** Shove の条件付きの前提（その 1 人に Call され、ほかは Fold。Fold Equity を含まない）を assumptions に書いたか。 */
  readonly shovePremise: {
    readonly reviews: number;
    readonly withPremise: number;
    readonly missing: readonly string[];
  };
  /** Solver が Unsupported の判断の Review の文で GTO に触れた箇所（否定でも数える。人が読んで確かめる）。 */
  readonly unsupportedSolverGtoMentions: readonly string[];
  /** Review の Prompt に入った CPU の Private な情報（空なら漏れなし）。 */
  readonly privateLeaks: readonly string[];
  readonly followUps: {
    readonly answered: number;
    readonly outOfScope: number;
    readonly fallbacks: number;
    readonly outages: number;
    readonly calls: number;
    readonly numericGroundingInvalids: number;
    readonly invalidOutputs: readonly string[];
    readonly chipIcmConfusions: readonly string[];
    readonly leaks: readonly string[];
  };
}

/** Shove の前提を書いた文とみなす語（Evidence の前提の文の言い換えを広めに拾う）。 */
const SHOVE_PREMISE =
  /Fold Equity|フォールド・?エクイティ|条件付き|その\s*1\s*人|1\s*人に\s*Call|ほか(の相手)?は\s*Fold|他(の相手)?は\s*Fold/i;

export function tournamentReviewReport(input: {
  readonly summary: ReviewEvalSummary;
  readonly records: readonly ReviewEvalRecord[];
  readonly drafts: ReadonlyMap<string, ReviewDraft>;
  readonly prompts: ReadonlyMap<string, readonly string[]>;
  readonly followUps: readonly FollowUpEvalRecord[];
}): TournamentReviewReport {
  const { summary, records, drafts, prompts, followUps } = input;
  const confusions: string[] = [];
  const missingPremise: string[] = [];
  let shoveReviews = 0;
  const gto: string[] = [];
  for (const r of records) {
    const key = `${r.caseId}#${r.repeat}`;
    const draft = drafts.get(key);
    if (draft === undefined || draft.generatedBy !== "review_ai") continue;
    const texts = [
      draft.explanation.practical,
      draft.explanation.theory.text,
      draft.explanation.exploit.text,
      ...draft.explanation.conclusionChangers,
      ...draft.assumptions,
    ];
    confusions.push(
      ...chipIcmConfusionsOf(texts, draft).map((c) => `${key}: ${c}`),
    );
    const allIn = draft.evidence.tournament?.allIn;
    if (allIn?.status === "available" && allIn.decision === "shove") {
      shoveReviews++;
      if (!draft.assumptions.some((a) => SHOVE_PREMISE.test(a))) {
        missingPremise.push(key);
      }
    }
    if (r.solverStatus === "unsupported") {
      texts
        .filter((t) => /GTO/i.test(t))
        .forEach((t) => gto.push(`${key}: ${t}`));
    }
  }
  const privateLeaks = [...prompts].flatMap(([key, list]) =>
    [...new Set(list.flatMap((p) => promptLeaks(p, ALL_CARDS)))].map(
      (l) => `${key}: ${l}`,
    ),
  );
  const fAttempts = followUps.flatMap((f) => f.attempts);
  return {
    numericGroundingReasons: summary.invalidOutputs.filter((s) =>
      s.includes(`grounding: ${NUMERIC_GROUNDING_REASON_PREFIX}`),
    ),
    chipIcmConfusions: confusions,
    shovePremise: {
      reviews: shoveReviews,
      withPremise: shoveReviews - missingPremise.length,
      missing: missingPremise,
    },
    unsupportedSolverGtoMentions: gto,
    privateLeaks,
    followUps: {
      answered: followUps.filter(
        (f) => f.final.kind === "answer" && f.final.scope === "answered",
      ).length,
      outOfScope: followUps.filter(
        (f) => f.final.kind === "answer" && f.final.scope === "out_of_scope",
      ).length,
      fallbacks: followUps.filter(
        (f) =>
          f.final.kind === "answer" &&
          f.final.generatedBy === "invalid_output_fallback",
      ).length,
      outages: followUps.filter((f) => f.final.kind === "outage").length,
      calls: fAttempts.length,
      numericGroundingInvalids: fAttempts.filter(
        (a) =>
          !a.check.ok &&
          a.check.stage === "grounding" &&
          a.check.reason.startsWith(NUMERIC_GROUNDING_REASON_PREFIX),
      ).length,
      invalidOutputs: followUps.flatMap((f) =>
        f.attempts.flatMap((a, i) =>
          a.check.ok
            ? []
            : [
                `${followUpKey(f)}#${i + 1}: ${a.check.stage}: ${a.check.reason}`,
              ],
        ),
      ),
      chipIcmConfusions: followUps.flatMap((f) => {
        const draft = drafts.get(`${f.caseId}#${f.repeat}`);
        return f.final.kind === "answer" && draft !== undefined
          ? chipIcmConfusionsOf([f.final.text], draft).map(
              (c) => `${followUpKey(f)}: ${c}`,
            )
          : [];
      }),
      leaks: followUps.flatMap((f) =>
        f.leaks.map((l) => `${followUpKey(f)}: ${l}`),
      ),
    },
  };
}

/**
 * Review の Prompt の CPU の Private な情報だけを見るときに渡す「知ってよい札」（札の漏れは runReviewEval の leaks が判断時点の基準で
 * 見るので、ここでは札を数えない）。
 */
const ALL_CARDS: ReadonlySet<string> = new Set(createDeck().map(cardToString));

/**
 * Chip EV と ICM の混同の疑い。必要 Equity の値（Evidence の Chip EV と ICM の requiredEquityPercent）を文の中で見つけ、その値の前の
 * 同じ文の中で最も近い語（"Chip EV" か "ICM"）が値の種類と逆なら疑いとして返す。2 つの値が表示の丸めで区別できないときは見ない。
 */
export function chipIcmConfusionsOf(
  texts: readonly string[],
  draft: Pick<ReviewDraft, "evidence">,
): string[] {
  const allIn = draft.evidence.tournament?.allIn;
  if (allIn?.status !== "available") return [];
  const values: { kind: "chip" | "icm"; value: number }[] = [];
  for (const r of allIn.requirements) {
    values.push({ kind: "chip", value: r.chipEv.requiredEquityPercent });
    if (r.icm.requiredEquityPercent !== null) {
      values.push({ kind: "icm", value: r.icm.requiredEquityPercent });
    }
  }
  const found: string[] = [];
  for (const text of texts) {
    for (const sentence of text.split(/[。\n]/)) {
      for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
        const v = Number(m[1]);
        // 小数第 1 位で書いた値は同じ値、整数で書いた値は丸めの範囲（±0.5）で当てる。
        const tolerance = m[1]?.includes(".") === true ? 0.05 : 0.5;
        const kinds = new Set(
          values
            .filter((x) => Math.abs(x.value - v) <= tolerance)
            .map((x) => x.kind),
        );
        if (kinds.size !== 1) continue;
        const kind = [...kinds][0];
        const before = sentence.slice(0, m.index);
        const chipAt = Math.max(
          before.lastIndexOf("Chip EV"),
          before.lastIndexOf("チップ EV"),
          before.lastIndexOf("Chip の損得"),
        );
        const icmAt = before.lastIndexOf("ICM");
        if (chipAt < 0 && icmAt < 0) continue;
        const nearest = chipAt > icmAt ? "chip" : "icm";
        if (nearest !== kind) {
          found.push(
            `${kind === "chip" ? "Chip EV" : "ICM"} の値 ${m[0]} の直前の語が ${nearest === "chip" ? "Chip EV" : "ICM"}: ${sentence.trim()}`,
          );
        }
      }
    }
  }
  return found;
}

/** 録画の置き場所（Cash の review-eval.json とは別。CI はこれも再生する）。 */
export const TOURNAMENT_REVIEW_RECORDING_URL = new URL(
  "./recordings/review-tournament-eval.json",
  import.meta.url,
);

export interface TournamentReviewRecording {
  readonly version: 1;
  readonly recordedAt: string;
  /** role-based config の値（MODEL_ROLES.review_standard）。 */
  readonly model: string;
  readonly sdkVersion: string;
  readonly kbVersion: string;
  readonly cases: readonly string[];
  readonly repeats: number;
  readonly limits: typeof TOURNAMENT_REVIEW_LIMITS;
  /** 録画のために実際にモデルを呼んだ回数（Review と Follow-up の合計）。 */
  readonly modelCalls: number;
  readonly records: readonly RecordedReviewCase[];
  /** Follow-up の呼び出し（caseId は followUpKey の値。repeat は 1）。 */
  readonly followUps: readonly RecordedReviewCase[];
  readonly summary: ReviewEvalSummary;
  readonly report: TournamentReviewReport;
}

/** Follow-up の記録を録画の形にする（Review の録画と同じ形。caseId に followUpKey を入れる）。 */
export function toRecordedFollowUps(
  records: readonly FollowUpEvalRecord[],
): RecordedReviewCase[] {
  return records.map((f) => ({
    caseId: followUpKey(f),
    repeat: 1,
    attempts: f.attempts.map((a) => ({
      paramsHash: a.paramsHash,
      output: a.output,
      ms: a.ms,
    })),
  }));
}

/** Follow-up の録画を再生する query()（Review の再生と同じ関数。キーは followUpKey）。 */
export function replayFollowUpQueryFor(
  recorded: readonly RecordedReviewCase[],
  clock: ReplayClock,
): (key: string) => ClaudeQuery {
  const queryFor = replayReviewQueryFor(
    { records: recorded },
    clock,
    hashParams,
  );
  return (key) => queryFor(key, 1);
}
