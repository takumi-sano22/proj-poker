// Review の文から内部の識別子を消す（#96・D101）。Review は Hero が読む学習用の文で、`cpu3` のような playerId や
// `inAssumedRange=false` のような Evidence の項目名がそのまま出ると読みにくく、内部実装を前面に出さない方針（docs/06 §11）にも合わない。
// 対策は 3 段: ① Evidence に表示名を添える ② Prompt で識別子を書かないよう指示し、項目の説明を添える ③ 出力の文を保存の前に機械的に置換する。
// 識別子が見つかっても Retry はしない（言い直しを求めても残ることがあり、呼び出しの回数と利用枠が増えるだけのため）。置換できなかった分は
// findIdentifiers で数え、Review Eval の指標（残存率）で見る。ここで扱う表示名は Hero の画面に出ている名前だけで、Persona 等は入れない（不変条件 2）。
import type { DecisionContextEvidence } from "./types.js";

/** playerId → 表示名（Hero の画面に出ている名前）。 */
export type PlayerNames = Readonly<Record<string, string>>;

/** Evidence の項目名 → 自然な言葉の説明。boolean の項目は値ごとの言い回しを持つ。 */
interface EvidenceTerm {
  /** Evidence の項目名（ドットを含む名前は、Prompt の文や出力で使われる Evidence 内の位置）。 */
  readonly name: string;
  /** 名詞句の説明（項目名だけが書かれたときの置き換え先。Prompt の項目の説明にも使う）。 */
  readonly text: string;
  /** Prompt の項目の説明にだけ添える補足（置換には使わない。文に差し込むと長くなるため）。 */
  readonly note?: string;
  /** boolean の項目の、true / false のときの言い回し。 */
  readonly whenTrue?: string;
  readonly whenFalse?: string;
  /** 普通の英単語と同じ綴りの項目名（folded・trials・spr）。文中の語と区別できないので、`name=値` の形のときだけ置換する。 */
  readonly plain?: true;
  /** reveal は Pass B（Hand 後の答え合わせ）だけの項目。Pass A・その Follow-up の Prompt には説明も出さない。 */
  readonly pass: "decision" | "reveal";
}

/** Evidence の項目の説明（Prompt に添える説明と、出力の置換の両方がこの 1 か所を見る）。 */
export const EVIDENCE_TERMS: readonly EvidenceTerm[] = [
  { name: "heroPosition", text: "Hero の Position", pass: "decision" },
  { name: "playerCount", text: "席に座っている人数", pass: "decision" },
  {
    name: "activePlayerCount",
    text: "Fold していない人数",
    note: "Hero を含む",
    pass: "decision",
  },
  { name: "heroHoleCards", text: "Hero の札", pass: "decision" },
  { name: "currentBet", text: "その時点の最高の Bet 額", pass: "decision" },
  {
    name: "streetCommitted",
    text: "その Street にすでに出した額",
    pass: "decision",
  },
  {
    name: "totalCommitted",
    text: "この Hand で出した額の合計",
    pass: "decision",
  },
  {
    name: "isHero",
    text: "Hero の席かどうか",
    whenTrue: "Hero の席",
    whenFalse: "Hero 以外の席",
    pass: "decision",
  },
  {
    name: "folded",
    text: "Fold したかどうか",
    whenTrue: "Fold した",
    whenFalse: "Fold していない",
    plain: true,
    pass: "decision",
  },
  {
    name: "allIn",
    text: "All-in しているかどうか",
    whenTrue: "All-in している",
    whenFalse: "All-in していない",
    pass: "decision",
  },
  { name: "actionHistory", text: "ここまでの Action の履歴", pass: "decision" },
  { name: "rulingHistory", text: "裁定の履歴", pass: "decision" },
  { name: "legalActions", text: "選べた Action", pass: "decision" },
  { name: "rulingNotes", text: "裁定の記録", pass: "decision" },
  {
    name: "importantSpotReasons",
    text: "重要な Spot に選ばれた理由",
    pass: "decision",
  },
  { name: "callAmount", text: "Call に必要な額", pass: "decision" },
  { name: "potOdds", text: "Pot Odds", pass: "decision" },
  { name: "effectiveStack", text: "有効 Stack", pass: "decision" },
  {
    name: "spr",
    text: "SPR",
    note: "Stack と Pot の比",
    plain: true,
    pass: "decision",
  },
  { name: "evBasis", text: "簡易 EV の前提", pass: "decision" },
  {
    name: "trials",
    text: "Equity の試行回数",
    plain: true,
    pass: "decision",
  },
  {
    name: "math.equity.method",
    text: "Equity の算出方法",
    note: "exact は全列挙、Monte Carlo は試行による推定",
    pass: "decision",
  },
  {
    name: "math.alternatives",
    text: "他の Action の簡易 EV",
    pass: "decision",
  },
  {
    name: "solver.status",
    text: "Solver の結果があるかどうか",
    pass: "decision",
  },
  { name: "profileId", text: "Range の想定の種類", pass: "decision" },
  { name: "heroHandClass", text: "Hero の札の Hand Class", pass: "decision" },
  {
    name: "heroHandClassStrategy",
    text: "Hero の Hand Class の行動頻度",
    pass: "decision",
  },
  { name: "rangeAssumptions", text: "Range の想定", pass: "decision" },
  { name: "comboCount", text: "Combo 数", pass: "decision" },
  { name: "betTree", text: "Bet Tree", pass: "decision" },
  { name: "kbVersion", text: "KB の Version", pass: "decision" },
  { name: "kbId", text: "KB の項目", pass: "decision" },
  {
    name: "opponentObservation",
    text: "相手の Observation",
    pass: "decision",
  },
  { name: "userRead", text: "Hero 自身の読み", pass: "decision" },
  {
    name: "inAssumedRange",
    text: "実際の札が判断時点に仮定した Range に入っていたか",
    whenTrue: "実際の札は判断時点に仮定した Range に入っていた",
    whenFalse: "実際の札は判断時点に仮定した Range に入っていなかった",
    pass: "reveal",
  },
  {
    name: "activeAtDecision",
    text: "判断時点で Pot を争っていたか",
    whenTrue: "判断時点で Pot を争っていた",
    whenFalse: "判断時点で Pot を争っていなかった",
    pass: "reveal",
  },
  { name: "assumedRange", text: "判断時点に仮定した Range", pass: "reveal" },
  {
    name: "madeHandAtDecision",
    text: "判断時点の Board での実際の役",
    pass: "reveal",
  },
  {
    name: "heroMadeHandAtDecision",
    text: "判断時点の Board での Hero の役",
    pass: "reveal",
  },
  { name: "holeCards", text: "実際の札", pass: "reveal" },
  { name: "finalBoard", text: "Hand の最後の Board", pass: "reveal" },
  { name: "equity.actual", text: "実際の札に対する Equity", pass: "reveal" },
  {
    name: "equity.assumed",
    text: "仮定した Range に対する Equity",
    pass: "reveal",
  },
  { name: "aggression.rule", text: "value / bluff の基準", pass: "reveal" },
];

/** 英字と _ の値（enum）→ 文での書き方。 */
const VALUE_TERMS: Readonly<Record<string, string>> = {
  monte_carlo: "Monte Carlo",
  heads_up: "Heads-Up",
  all_in: "All-in",
  insufficient_evidence: "根拠不足",
  general_theory: "一般的な理論",
};

/** 卓の Player（SeatPlayer）から、playerId → 表示名の対応を作る。 */
export function toPlayerNames(
  players: readonly {
    readonly playerId: string;
    readonly displayName: string;
  }[],
): PlayerNames {
  return Object.fromEntries(players.map((p) => [p.playerId, p.displayName]));
}

/** Hero を含む席の表示名の対応（Hero の画面に出ている名前）。Evidence の席から作る。古い Evidence（displayName 無し）は対応が空になる。 */
export function playerNamesOf(context: DecisionContextEvidence): PlayerNames {
  const names: Record<string, string> = {};
  for (const seat of context.seats) {
    if (seat.displayName !== undefined) names[seat.playerId] = seat.displayName;
  }
  return names;
}

/** Prompt に添える「Evidence の項目の説明」。Pass A（decision）と Pass B（reveal）で出す項目を分ける（Pass A の Prompt に Hand 後の項目の名前を出さない）。 */
export function evidenceGlossary(pass: "decision" | "reveal"): string {
  const terms = EVIDENCE_TERMS.filter(
    (t) => pass === "reveal" || t.pass === "decision",
  );
  return [
    "## Evidence の項目の説明（文では項目名や id を書かず、説明の言葉で書く。席は displayName で書く）",
    ...terms.map(
      (t) =>
        `- ${t.name}: ${t.text}${t.note === undefined ? "" : `（${t.note}）`}`,
    ),
  ].join("\n");
}

/** 識別子の疑いがある書き方（置換の後に残っていないかの検査と、Eval の指標に使う）。 */
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  // playerId（cpu1 等）
  /(?<![A-Za-z0-9_])cpu\d+(?![A-Za-z0-9_])/gi,
  // Evidence の項目名（camelCase）
  /(?<![A-Za-z0-9_])[a-z]+(?:[A-Z][a-z0-9]*)+(?![A-Za-z0-9_])/g,
  // 英字と _ の値（snake_case）
  /(?<![A-Za-z0-9_])[a-z]+(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g,
  // Evidence 内の位置（math.equity.method 等）
  /(?<![A-Za-z0-9_.])(?:math|range|solver|context|knowledge|reveal|equity|aggression|decision)\.[a-zA-Z]+(?:\.[a-zA-Z]+)*/g,
  // Evidence の id（math:review-... 等）
  /(?<![A-Za-z0-9_])(?:ctx|math|range|solver|kb|reveal|equity|aggression):[^\s,、。）)」]+/g,
];

/** 文に残っている識別子の疑い（重複なし）。 */
export function findIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.add(m[0]);
  }
  return [...found];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 項目名の前後が英数字・_ でないことを要求して（別の語の一部を置換しない）、`で囲まれていればその `も取る。 */
function termRegExp(name: string, valueSuffix = ""): RegExp {
  return new RegExp(
    `\`?(?<![A-Za-z0-9_.])${escapeRegExp(name)}(?![A-Za-z0-9_])\`?${valueSuffix}`,
    "g",
  );
}

/** 項目名の直後に付く値。`=` `:` の後は何でも、`が` `は` の後は true / false だけ（「は 〜」の普通の文を壊さない）。 */
const VALUE_SUFFIX =
  "(?:\\s*(?:=|＝|:|：)\\s*([-\\w%]+(?:\\.\\d+)?)|\\s*(?:が|は)\\s*(true|false))";

/** 普通の英単語と同じ綴りの項目名に付く値は、`=` か `:` だけを見る。 */
const PLAIN_SUFFIX =
  "(?:\\s*(?:=|＝|:|：)\\s*(true|false|[-\\w%]+(?:\\.\\d+)?))";

const TERMS_LONGEST_FIRST = [...EVIDENCE_TERMS].sort(
  (a, b) => b.name.length - a.name.length,
);

/**
 * 文の中の既知の識別子を自然な言葉に置き換える。置き換えるのは既知のものだけ（playerId → 表示名・Evidence の項目名 → 説明・
 * 英字と _ の値 → 書き方）。未知の識別子は残る（findIdentifiers で数える）。
 */
export function sanitizeText(text: string, names: PlayerNames): string {
  let result = text;
  // playerId → 表示名。大文字小文字だけが違う名前（hero → Hero）は、普通の語と区別できないので置換しない。
  for (const [playerId, displayName] of Object.entries(names)) {
    if (playerId.toLowerCase() === displayName.toLowerCase()) continue;
    result = result.replace(
      new RegExp(
        `\`?(?<![A-Za-z0-9_])${escapeRegExp(playerId)}(?![A-Za-z0-9_])\`?`,
        "gi",
      ),
      () => displayName,
    );
  }
  // Evidence の項目名 → 説明。値が付いているもの（name=value）を先に、次に項目名だけ。
  for (const term of TERMS_LONGEST_FIRST) {
    result = result.replace(
      termRegExp(term.name, term.plain === true ? PLAIN_SUFFIX : VALUE_SUFFIX),
      (_all, v1: string | undefined, v2: string | undefined) => {
        const value = (v1 ?? v2) as string;
        if (value === "true" && term.whenTrue !== undefined)
          return term.whenTrue;
        if (value === "false" && term.whenFalse !== undefined)
          return term.whenFalse;
        return `${term.text} ${value}`;
      },
    );
    if (term.plain !== true) {
      result = result.replace(termRegExp(term.name), () => term.text);
    }
  }
  for (const [value, replacement] of Object.entries(VALUE_TERMS)) {
    result = result.replace(termRegExp(value), () => replacement);
  }
  return result;
}

/** 値は文でなく enum / id のもの（置換しない）。 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "assessment",
  "confidence",
  "basis",
  "scope",
  "evidenceIds",
]);

/** 出力（Review・Reveal・Follow-up の検証済みの値）の文を置換する。文でない項目（enum・根拠の id）は触らない。 */
export function sanitizeOutput<T>(value: T, names: PlayerNames): T {
  return mapStrings(value, names) as T;
}

function mapStrings(value: unknown, names: PlayerNames): unknown {
  if (typeof value === "string") return sanitizeText(value, names);
  if (Array.isArray(value)) {
    return value.map((v: unknown) => mapStrings(v, names));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        STRUCTURAL_KEYS.has(k) ? v : mapStrings(v, names),
      ]),
    );
  }
  return value;
}

/** 出力の文（enum・根拠の id を除く）をすべて集める。残存する識別子の検査（Eval）に使う。 */
export function outputTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.flatMap((v: unknown) => outputTexts(v));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      STRUCTURAL_KEYS.has(k) ? [] : outputTexts(v),
    );
  }
  return [];
}
