// Review の文の中の数値の Grounding（#168・D131）。Pass A（Decision Review）と、その Follow-up が使う。
// 1. Evidence から決定論で「数値表」を作る。各行は参照キー（N1, N2…）・人が読む説明・表示用に整形した値を持つ。
//    書式は UI（apps/web の formatPercent・formatChips・equityText 等）と揃える（比率は整数の %、額は Chip の実額、ICM は pt と小数第 1 位の %）。
// 2. Prompt で「数値は参照 {N3} で書く」と指示し、数値表の節を添える。
// 3. 出力の検証（grounding 段）で、未知の参照キーと、参照ではない生の数値のうち % / pt / BB が付いたもので表の値と
//    （表示の丸めの範囲で）一致しないものを不正にする。単位の無い数（3-Bet・人数・札・Level 等）は検査しない。
// 4. 検証を通った文は、保存の前に参照を表の値へ置き換える（sanitizeOutput と同じ位置）。
// Retry の上限は増やさない（既存の 2 回の枠の中で直させる）。Pass B（Reveal Review）は範囲外。
import type { ActionType, Street } from "@proj-poker/engine";
import type { ReviewEvidence } from "./types.js";

/** grounding 段の不正のうち、数値の照合による不正の理由の先頭（Eval の集計で数える）。 */
export const NUMERIC_GROUNDING_REASON_PREFIX = "数値の根拠";

/** 数値表の 1 行。照合に使う値は丸める前の値（単位ごと。無い単位では照合しない）。 */
export interface NumericRow {
  /** 参照キー（N1, N2…。表の中の順で採番する）。 */
  readonly key: string;
  readonly label: string;
  /** 参照を置き換える文字列（単位を含む。額は Chip の実額だけで、BB 換算は含まない）。 */
  readonly display: string;
  /** 額の行の BB 換算の表示（Prompt に参考として出すだけ。置換には使わない）。 */
  readonly bbHint?: string;
  /** % で照合する値（比率なら 100 倍した値）。 */
  readonly percent?: number;
  readonly pt?: number;
  /** BB で照合する値（額の行は 額 ÷ Big Blind）。 */
  readonly bb?: number;
}

export interface NumericTable {
  readonly rows: readonly NumericRow[];
  /** 表の行ではないが、Evidence の文（前提・注記・KB の本文等）に書かれた単位付きの値。照合で一致として扱う。 */
  readonly literals: UnitValues;
  /** 席の表示名（照合の前に文から外す。"CPU 3 BB" の 3 を数値として読まない）。 */
  readonly seatNames: readonly string[];
}

interface UnitValues {
  readonly percent: readonly number[];
  readonly pt: readonly number[];
  readonly bb: readonly number[];
}

// 表示の書式（apps/web/src/lib/format.ts・tournament.ts と同じ）。
const chipFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const bbFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const oneDecimalFormat = new Intl.NumberFormat("ja-JP", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const ACTION_WORDS: Readonly<Record<ActionType, string>> = {
  fold: "Fold",
  check: "Check",
  call: "Call",
  bet: "Bet",
  raise: "Raise",
  all_in: "All-in",
};

const STREET_WORDS: Readonly<Record<Street, string>> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
};

/** 行を順に積む（キーは積んだ順に N1 から採番するので、同じ Evidence なら同じ表になる）。 */
function createRows(bigBlind: number) {
  const rows: NumericRow[] = [];
  const push = (row: Omit<NumericRow, "key">) =>
    rows.push({ key: `N${rows.length + 1}`, ...row });
  const bbOf = (amount: number) =>
    bigBlind > 0 ? { bb: amount / bigBlind } : {};
  const bbHintOf = (amount: number) =>
    bigBlind > 0 ? { bbHint: `${bbFormat.format(amount / bigBlind)} BB` } : {};
  return {
    rows,
    /** Chip の実額（整数）。 */
    chips(label: string, amount: number) {
      push({
        label,
        display: chipFormat.format(amount),
        ...bbOf(amount),
        ...bbHintOf(amount),
      });
    },
    /** 符号付きの額（簡易 EV。UI の SignedAmount と同じく整数に丸め、+ / − / ± を付ける）。 */
    signedChips(label: string, amount: number) {
      const rounded = Math.round(amount);
      const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
      push({
        label,
        display: `${sign}${chipFormat.format(Math.abs(rounded))}`,
        // 照合は絶対値で行う（「1 BB の損」のように符号を言葉で書くことがある）。参考の BB 換算には符号を付ける。
        ...bbOf(Math.abs(amount)),
        ...(bigBlind > 0
          ? {
              bbHint: `${sign}${bbFormat.format(Math.abs(amount) / bigBlind)} BB`,
            }
          : {}),
      });
    },
    /** 0〜1 の比率（UI の formatPercent と同じく整数の %）。 */
    ratio(label: string, value: number) {
      push({
        label,
        display: `${Math.round(value * 100)}%`,
        percent: value * 100,
      });
    },
    /** すでに % の値（Tournament の Evidence。小数第 1 位に丸め済み）。 */
    percent1(label: string, value: number) {
      push({ label, display: `${value.toFixed(1)}%`, percent: value });
    },
    /** ICM Equity 等の pt（小数第 1 位）。 */
    pt1(label: string, value: number) {
      push({
        label,
        display: `${oneDecimalFormat.format(value)}pt`,
        pt: value,
      });
    },
    /** 賞金の額（整数の pt）。割合（%）も持たせる（50 / 30 / 20 の書き方を許す）。 */
    payout(label: string, value: number, prizePool: number) {
      push({
        label,
        display: `${chipFormat.format(value)}pt`,
        pt: value,
        ...(prizePool > 0 ? { percent: (value / prizePool) * 100 } : {}),
      });
    },
    /** BB 換算の値そのもの（Tournament の stackBb）。 */
    bb1(label: string, value: number) {
      push({ label, display: `${bbFormat.format(value)} BB`, bb: value });
    },
    /** 単位の無い数（回数・人数・Combo 数・SPR 等）。照合はしないが、参照で書けるように表に入れる。 */
    plain(label: string, display: string) {
      push({ label, display });
    },
  };
}

/** Evidence から数値表を作る（決定論。同じ Evidence なら同じ表）。 */
export function buildNumericTable(evidence: ReviewEvidence): NumericTable {
  const { context, math, range } = evidence;
  const t = createRows(context.bigBlind);
  const names = new Map(
    context.seats.map((s) => [
      s.playerId,
      s.displayName ?? (s.isHero ? "Hero" : s.playerId),
    ]),
  );
  const nameOf = (playerId: string) => names.get(playerId) ?? playerId;

  // 判断時点の卓（Blind・Stack・Action の額）。
  t.chips("Small Blind", context.smallBlind);
  t.chips("Big Blind", context.bigBlind);
  for (const seat of context.seats) {
    t.chips(`${nameOf(seat.playerId)} の判断時点の Stack`, seat.stack);
  }
  for (const a of context.actionHistory) {
    const label = `${nameOf(a.playerId)} の ${STREET_WORDS[a.street]} の ${ACTION_WORDS[a.action]}`;
    if (a.action === "call" && a.amount > 0) {
      t.chips(`${label} の額`, a.amount);
    } else if (
      (a.action === "bet" || a.action === "raise" || a.action === "all_in") &&
      a.toAmount > 0
    ) {
      t.chips(`${label}（その Street の累計の額）`, a.toAmount);
    }
  }
  if (context.currentBet > 0) {
    t.chips(
      "判断時点の最高の Bet 額（その Street の累計）",
      context.currentBet,
    );
  }
  for (const legal of context.legalActions) {
    if (legal.type === "bet" || legal.type === "raise") {
      const word = ACTION_WORDS[legal.type];
      t.chips(`選べた ${word} の最小（その Street の累計）`, legal.min);
      t.chips(`選べた ${word} の最大（その Street の累計）`, legal.max);
    }
  }
  if (context.decision.amount > 0) {
    t.chips(
      `Hero が選んだ ${ACTION_WORDS[context.decision.action]} で出した額`,
      context.decision.amount,
    );
  }

  // Math Evidence（Engine の analyzeDecision が作った値）。
  t.chips("判断時点の Pot", math.pot);
  t.chips("Call に必要な額", math.callAmount);
  if (math.potOdds !== null) t.ratio("Pot Odds", math.potOdds);
  t.chips("有効 Stack", math.effectiveStack);
  if (math.spr !== null) t.plain("SPR", math.spr.toFixed(1));
  if (math.equity !== null) {
    t.ratio("仮定した Range に対する Equity", math.equity.equity);
    t.ratio("Equity のうち勝ち", math.equity.win);
    t.ratio("Equity のうち引き分け", math.equity.tie);
    t.plain(
      math.equity.method === "exact"
        ? "Equity の全列挙で数えた組の数"
        : "Equity の Monte Carlo の試行回数",
      chipFormat.format(math.equity.trials),
    );
    if (math.potOdds !== null) {
      // 「必要 Equity を X% 上回る」と書けるよう、差も決定論で出す（Review AI に引き算させない）。
      t.ratio(
        "Equity と Pot Odds の差（Equity − Pot Odds）",
        math.equity.equity - math.potOdds,
      );
    }
  }
  for (const alt of math.alternatives) {
    const word = ACTION_WORDS[alt.action];
    const name =
      alt.toAmount === null
        ? word
        : `${word}（その Street の累計 ${chipFormat.format(alt.toAmount)}）`;
    if (alt.risk > 0) t.chips(`${name} で出す額`, alt.risk);
    if (alt.winnablePot > 0) t.chips(`${name} で取りうる Pot`, alt.winnablePot);
    if (alt.requiredEquity !== null) {
      t.ratio(`${name} の必要 Equity`, alt.requiredEquity);
    }
    if (alt.breakEvenFoldFrequency !== null) {
      t.ratio(`${name} の損をしない Fold 率`, alt.breakEvenFoldFrequency);
    }
    if (alt.ev !== null) t.signedChips(`${name} の簡易 EV`, alt.ev);
  }

  // Range Evidence（仮定した Range の Combo 数・絞り込み・想定ごとの Equity）。
  for (const v of range.villains) {
    const who = nameOf(v.playerId);
    t.plain(`${who} の仮定した Range の Combo 数`, String(v.comboCount));
    for (const n of v.postflop) {
      const step = `${who} の ${STREET_WORDS[n.street]} の絞り込み`;
      t.ratio(`${step}で残した割合`, n.keep);
      t.plain(`${step}の前の Combo 数`, String(n.combosBefore));
      t.plain(`${step}の後の Combo 数`, String(n.combosAfter));
    }
  }
  for (const c of range.comparisons ?? []) {
    if (c.equity !== null)
      t.ratio(`Range の想定「${c.label}」の Equity`, c.equity);
  }

  // 卓の傾向（D122）。割合・回数・機会の数・Hand の数。
  const observation = evidence.opponentObservation;
  if (observation.status === "available") {
    const tendency = observation.tableTendency;
    t.plain("卓の傾向で数えた Hand の数", String(tendency.hands));
    for (const item of tendency.items) {
      const what = `卓の傾向の ${TENDENCY_WORDS[item.item] ?? item.item}`;
      if (item.rate !== null) t.ratio(`${what}の割合`, item.rate);
      t.plain(`${what}の回数`, String(item.numerator));
      t.plain(`${what}の機会の数`, String(item.denominator));
      t.plain(`${what}の機会があった Hand の数`, String(item.hands));
    }
  }

  // Solver の結果（supported のときだけ。HU の近似）。
  const solver = evidence.solver;
  if (solver.status === "supported") {
    t.chips("Solver に渡した Pot", solver.spot.pot);
    t.chips("Solver に渡した有効 Stack", solver.spot.effectiveStack);
    for (const fraction of solver.betTree.betPotFractions) {
      t.ratio(
        "Solver の Bet Tree の Bet の大きさ（Pot に対する割合）",
        fraction,
      );
    }
    for (const f of solver.strategy) {
      t.ratio(
        `Solver の Range 全体の ${solverActionWord(f.action)} の頻度`,
        f.frequency,
      );
    }
    if (solver.heroHandClassStrategy !== null) {
      for (const f of solver.strategy) {
        const freq = solver.heroHandClassStrategy[f.key];
        if (freq !== undefined) {
          t.ratio(
            `Solver の Hero の Hand Class の ${solverActionWord(f.action)} の頻度`,
            freq,
          );
        }
      }
    }
    t.plain(
      "Solver の Iteration 数",
      chipFormat.format(solver.convergence.iterations),
    );
    t.plain(
      "Solver の OOP 側の Range の Combo 数",
      String(solver.rangeAssumptions.oop.comboCount),
    );
    t.plain(
      "Solver の IP 側の Range の Combo 数",
      String(solver.rangeAssumptions.ip.comboCount),
    );
  }

  // Tournament（D109・D130）。残人数・賞金・ICM Equity・必要 Equity。
  const tournament = evidence.tournament;
  if (tournament !== undefined) {
    t.plain("参加人数", String(tournament.entrants));
    t.plain("残人数", String(tournament.remaining));
    if (tournament.level !== null)
      t.plain("Blind の Level", String(tournament.level));
    if (tournament.ante > 0) t.chips("Ante の額", tournament.ante);
    t.payout(
      "賞金の総額（Prize Pool）",
      tournament.prizePool,
      tournament.prizePool,
    );
    tournament.payoutsByPlace.forEach((amount, i) => {
      t.payout(`${i + 1} 位の賞金`, amount, tournament.prizePool);
    });
    for (const seat of tournament.icm.seats) {
      const who = nameOf(seat.playerId);
      t.chips(`${who} の ICM の計算に使った Stack`, seat.icmStack);
      t.bb1(`${who} の Stack の BB 換算`, seat.stackBb);
      t.pt1(`${who} の ICM Equity`, seat.icmEquity);
      t.percent1(
        `${who} の ICM Equity（賞金の総額に対する割合）`,
        seat.icmEquityPercent,
      );
    }
    const allIn = tournament.allIn;
    if (allIn?.status === "available") {
      for (const r of allIn.requirements) {
        const who =
          allIn.decision === "shove"
            ? `${nameOf(r.villainId)} に Call された場合`
            : `${nameOf(r.villainId)} の All-in への Call`;
        t.percent1(
          `${who}の Chip EV の必要 Equity`,
          r.chipEv.requiredEquityPercent,
        );
        if (r.icm.requiredEquityPercent !== null) {
          t.percent1(`${who}の ICM の必要 Equity`, r.icm.requiredEquityPercent);
        }
        t.chips(`${who}の Hero の Stack（Fold）`, r.chipEv.heroStack.fold);
        t.chips(`${who}の Hero の Stack（勝ち）`, r.chipEv.heroStack.win);
        t.chips(`${who}の Hero の Stack（負け）`, r.chipEv.heroStack.lose);
        t.pt1(`${who}の Hero の ICM Equity（Fold）`, r.icm.heroIcmEquity.fold);
        t.pt1(`${who}の Hero の ICM Equity（勝ち）`, r.icm.heroIcmEquity.win);
        t.pt1(`${who}の Hero の ICM Equity（負け）`, r.icm.heroIcmEquity.lose);
      }
    }
  }

  return {
    rows: t.rows,
    literals: unitValuesInStrings(evidence),
    seatNames: [...names.values()].filter((n) => /\d/.test(n)),
  };
}

const TENDENCY_WORDS: Readonly<Record<string, string>> = {
  vpip: "VPIP",
  pfr: "PFR",
  aggression_frequency: "Postflop の Aggression の頻度",
  showdown: "Showdown",
};

function solverActionWord(action: ReviewEvidenceSolverAction): string {
  if (action.kind === "check") return "Check";
  if (action.kind === "all_in") return "All-in";
  return `Bet（Pot の ${Math.round(action.potFraction * 100)}%）`;
}

type ReviewEvidenceSolverAction = Extract<
  ReviewEvidence["solver"],
  { status: "supported" }
>["strategy"][number]["action"];

/** Prompt に添える数値表の節。 */
export function numericTableSection(table: NumericTable): string {
  return [
    "## 数値表（文に数値を書くときは、この表の参照で書く）",
    "- 文に数値を書くときは、値を書き写さずに参照（例: {N3}）を書いてください。参照は保存のときに「=」の右の値に置き換わります（括弧の BB 換算は置き換わる値に含みません）。",
    "- 参照の後ろに %・pt・BB を書き足さないでください。BB 換算を添えるときは、表の括弧の値をそのまま「12 BB」のように書いてください。",
    "- %・pt・BB の付いた数値を参照を使わずに書くと、表の値と照合します。表に無い値（自分で計算した差・比・BB 換算など）を書くと、答えを使えません。",
    "- 単位の無い数（人数・3-Bet の 3 など）は、表に無くてもそのまま書いてかまいません。",
    ...table.rows.map(
      (r) =>
        `- {${r.key}} ${r.label} = ${r.display}${r.bbHint === undefined ? "" : `（${r.bbHint}）`}`,
    ),
  ].join("\n");
}

/** 参照トークン（{N3}。全角の括弧も読む）。 */
const TOKEN_PATTERN = /[{｛]\s*(N\d+)\s*[}｝]/g;

/** 単位付きの数値（NFKC で正規化した文に対して使う）。"1,500" の桁区切りと小数を読む。 */
const UNIT_NUMBER_PATTERN =
  /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|パーセント|pt|BB)(?![A-Za-z])/g;

/** 概数を表す語（直前・直後）。付いていれば照合の幅を 1 桁分に広げる。 */
const APPROX_BEFORE = /(?:約|およそ|ほぼ|概ね|大体|おおよそ)\s*$/;
const APPROX_AFTER = /^\s*(?:前後|程度|ほど|くらい|ぐらい|強|弱)/;

type Unit = "percent" | "pt" | "bb";

function unitOf(symbol: string): Unit {
  if (symbol === "pt") return "pt";
  if (symbol === "BB") return "bb";
  return "percent";
}

interface UnitNumber {
  readonly text: string;
  readonly unit: Unit;
  readonly value: number;
  readonly decimals: number;
  readonly approx: boolean;
}

/** 文の中の単位付きの数値（全角の数字・％ は NFKC で半角にしてから読む）。 */
function unitNumbersIn(text: string): UnitNumber[] {
  const normalized = text.normalize("NFKC");
  const found: UnitNumber[] = [];
  for (const m of normalized.matchAll(UNIT_NUMBER_PATTERN)) {
    const integer = (m[1] as string).replaceAll(",", "");
    const fraction = m[2] ?? "";
    const start = m.index;
    const before = normalized.slice(Math.max(0, start - 6), start);
    const after = normalized.slice(
      start + m[0].length,
      start + m[0].length + 6,
    );
    found.push({
      text: m[0],
      unit: unitOf(m[3] as string),
      value: Number(fraction === "" ? integer : `${integer}.${fraction}`),
      decimals: fraction.length,
      approx: APPROX_BEFORE.test(before) || APPROX_AFTER.test(after),
    });
  }
  return found;
}

/** Evidence の文（string の値すべて）に書かれた単位付きの値。 */
function unitValuesInStrings(value: unknown): UnitValues {
  const values: Record<Unit, number[]> = { percent: [], pt: [], bb: [] };
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const n of unitNumbersIn(v)) values[n.unit].push(n.value);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "object" && v !== null) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return values;
}

/**
 * 表示の丸めの範囲で一致するか。書かれた桁（小数の桁数）で丸めた差を許す（30.4% と 0.3038 は一致、30% と 0.3038 も一致）。
 * 「約」等が付いた概数は 1 桁分まで許す。符号は文の言い回し（「1 BB の損」）で表すことがあるので絶対値で比べる。
 */
function matchesAny(n: UnitNumber, candidates: readonly number[]): boolean {
  const step = 10 ** -n.decimals;
  const tolerance = (n.approx ? 1 : 0.5) * step + 1e-9;
  return candidates.some(
    (c) => Math.abs(Math.abs(n.value) - Math.abs(c)) <= tolerance,
  );
}

function candidatesOf(table: NumericTable, unit: Unit, extra: UnitValues) {
  const fromRows = table.rows.flatMap((r) => {
    const v = r[unit];
    return v === undefined ? [] : [v];
  });
  return [...fromRows, ...table.literals[unit], ...extra[unit]];
}

/** 参照を表の値へ置き換えた文（未知のキーはそのまま残す。未知のキーは検証で先に不正にする）。 */
export function resolveNumericText(text: string, table: NumericTable): string {
  const byKey = new Map(table.rows.map((r) => [r.key, r.display]));
  return text.replace(
    TOKEN_PATTERN,
    (all, key: string) => byKey.get(key) ?? all,
  );
}

/**
 * N の無い波括弧の数値（"{481}"・"{1,200}"・"{0.5}"。全角の括弧・数字も読む）。参照ではないので grounding 段は通すが、
 * 保存する文に波括弧が残ると表示が崩れる（#208）。検査は変えず（録画の出力を不正にしない）、保存の前に括弧だけ外す。
 */
const BARE_BRACE_NUMBER_PATTERN =
  /[{｛]\s*([0-9０-９]+(?:[,，][0-9０-９]{3})*(?:[.．][0-9０-９]+)?)\s*[}｝]/g;

/** 波括弧だけを外す（値は変えない）。単位の無い数は D131 で照合の対象外なので、平文にしても扱いは変わらない。 */
function stripBareBraceNumbers(text: string): string {
  return text.replace(BARE_BRACE_NUMBER_PATTERN, "$1");
}

/** 出力（検証済みの値）の文の参照を置き換える。根拠の id（evidenceIds）は触らない。 */
export function resolveNumericRefs<T>(value: T, table: NumericTable): T {
  const map = (v: unknown): unknown => {
    if (typeof v === "string") {
      return stripBareBraceNumbers(resolveNumericText(v, table));
    }
    if (Array.isArray(v)) return v.map(map);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          k === "evidenceIds" ? x : map(x),
        ]),
      );
    }
    return v;
  };
  return map(value) as T;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 文の中の数値を数値表と照合する。問題が無ければ null、あれば不正の理由（NUMERIC_GROUNDING_REASON_PREFIX で始まる）。
 * extraTexts は、表の外で照合に使ってよい文（Follow-up の Hero の質問など。Hero が書いた値をそのまま繰り返すのは作り話ではない）。
 */
export function checkNumericGrounding(
  texts: readonly string[],
  table: NumericTable,
  extraTexts: readonly string[] = [],
): string | null {
  const known = new Map(table.rows.map((r) => [r.key, r]));
  const unknownKeys = new Set<string>();
  const unitAfterRef = new Set<string>();
  const bareKeys = new Set<string>();
  const ungrounded = new Set<string>();
  const extra = unitValuesInStrings(extraTexts);
  for (const text of texts) {
    for (const m of text.matchAll(TOKEN_PATTERN)) {
      const row = known.get(m[1] as string);
      if (row === undefined) {
        unknownKeys.add(m[0]);
        continue;
      }
      // 値に単位が含まれる行の参照の後ろに単位を重ねない（"{N5}%" → "30%%"）。
      const after = text.slice(m.index + m[0].length).normalize("NFKC");
      if (
        /(?:%|pt|BB)$/.test(row.display) &&
        /^\s*(?:%|パーセント|pt|BB)/.test(after)
      ) {
        unitAfterRef.add(m[0]);
      }
    }
    // {} の無い参照キー（"N3"）は置き換わらずに文に残る。
    for (const m of text
      .replace(TOKEN_PATTERN, " ")
      .matchAll(/(?<![A-Za-z0-9_])N\d+(?![A-Za-z0-9_])/g)) {
      if (known.has(m[0])) bareKeys.add(m[0]);
    }
    // 参照を置き換えた後の文で、単位付きの数値を照合する（参照の後ろに "BB" を書いた等も、ここで値として照合される）。
    let resolved = resolveNumericText(text, table);
    for (const name of table.seatNames) {
      // 後ろに数字が続くもの（"CPU 1" に対する "CPU 12"）は別の名前なので外さない。
      resolved = resolved.replace(
        new RegExp(`${escapeRegExp(name)}(?![0-9０-９])`, "g"),
        "席",
      );
    }
    for (const n of unitNumbersIn(resolved)) {
      if (!matchesAny(n, candidatesOf(table, n.unit, extra))) {
        ungrounded.add(n.text);
      }
    }
  }
  const problems: string[] = [];
  if (unknownKeys.size > 0) {
    problems.push(`数値表に無い参照 ${[...unknownKeys].join(" ")}`);
  }
  if (bareKeys.size > 0) {
    problems.push(
      `参照は {} で囲んで書く（${[...bareKeys].map((k) => `{${k}}`).join(" ")}）`,
    );
  }
  if (unitAfterRef.size > 0) {
    problems.push(
      `参照の後ろに単位を重ねない（${[...unitAfterRef].join(" ")} は単位を含む値に置き換わる）`,
    );
  }
  if (ungrounded.size > 0) {
    problems.push(
      `数値表の値と一致しない数値「${[...ungrounded].slice(0, 6).join("」「")}」（数値は表の参照 {N3} の形で書き、計算し直した値・表に無い値を書かない）`,
    );
  }
  return problems.length === 0
    ? null
    : `${NUMERIC_GROUNDING_REASON_PREFIX}: ${problems.join("。")}`;
}
