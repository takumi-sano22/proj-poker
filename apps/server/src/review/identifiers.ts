// Review の文から内部の識別子を消す（#96・D101）。Review は Hero が読む学習用の文で、`cpu3` のような playerId や
// `inAssumedRange=false` のような Evidence の項目名がそのまま出ると読みにくく、内部実装を前面に出さない方針（docs/06 §11）にも合わない。
// 対策は 3 段: ① Evidence に表示名を添える ② Prompt で識別子を書かないよう指示し、項目の説明を添える ③ 出力の文を保存の前に機械的に置換する。
// 識別子が見つかっても Retry はしない（言い直しを求めても残ることがあり、呼び出しの回数と利用枠が増えるだけのため）。置換できなかった分は
// findIdentifiers で数え、Review Eval の指標（残存率）で見る。ここで扱う表示名は Hero の画面に出ている名前だけで、Persona 等は入れない（不変条件 2）。
import { KB_TOPICS } from "../kb/types.js";
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
  /**
   * Table Tendency（D122・#153）の項目。Evidence に Table Tendency があるときだけ説明を出す
   * （無い Evidence の Prompt を #153 より前と同じ文字列に保つ。Review Eval の録画の指紋を変えない）。置換には常に使う。
   */
  readonly tableTendency?: true;
  /**
   * Tournament の Evidence（#189）の項目。Evidence に Tournament の Evidence があるときだけ説明を出す
   * （Cash の Prompt を #189 より前と同じ文字列に保つ。Review Eval の録画の指紋を変えない）。置換には常に使う。
   */
  readonly tournament?: true;
}

/** Evidence の項目の説明（Prompt に添える説明と、出力の置換の両方がこの 1 か所を見る）。 */
export const EVIDENCE_TERMS: readonly EvidenceTerm[] = [
  { name: "playerId", text: "席", pass: "decision" },
  { name: "displayName", text: "表示名", pass: "decision" },
  { name: "heroId", text: "Hero の席", pass: "decision" },
  { name: "handId", text: "Hand の ID", pass: "decision" },
  { name: "decisionIndex", text: "判断の番号", pass: "decision" },
  { name: "smallBlind", text: "Small Blind", pass: "decision" },
  { name: "bigBlind", text: "Big Blind", pass: "decision" },
  { name: "toAmount", text: "その Street の累計の額", pass: "decision" },
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
  { name: "winnablePot", text: "取りうる Pot", pass: "decision" },
  { name: "requiredEquity", text: "必要 Equity", pass: "decision" },
  {
    name: "breakEvenFoldFrequency",
    text: "損をしない Fold 率",
    pass: "decision",
  },
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
  { name: "preflopSpot", text: "相手の Preflop の動き", pass: "decision" },
  {
    name: "preflopNotation",
    text: "仮定した Preflop の Range の表記",
    pass: "decision",
  },
  { name: "combosBefore", text: "絞り込み前の Combo 数", pass: "decision" },
  { name: "combosAfter", text: "絞り込み後の Combo 数", pass: "decision" },
  { name: "heroHandClass", text: "Hero の札の Hand Class", pass: "decision" },
  {
    name: "heroHandClassStrategy",
    text: "Hero の Hand Class の行動頻度",
    pass: "decision",
  },
  { name: "rangeAssumptions", text: "Range の想定", pass: "decision" },
  { name: "comboCount", text: "Combo 数", pass: "decision" },
  { name: "betTree", text: "Bet Tree", pass: "decision" },
  {
    name: "betPotFractions",
    text: "Bet の大きさ（Pot に対する割合）",
    pass: "decision",
  },
  { name: "raiseMultipliers", text: "Raise の倍率", pass: "decision" },
  { name: "raiseCap", text: "Bet / Raise の回数の上限", pass: "decision" },
  { name: "pinnedCommit", text: "Solver の版の固定", pass: "decision" },
  { name: "kbVersion", text: "KB の Version", pass: "decision" },
  { name: "kbId", text: "KB の項目", pass: "decision" },
  {
    name: "opponentObservation",
    text: "相手の Observation",
    pass: "decision",
  },
  { name: "userRead", text: "Hero 自身の読み", pass: "decision" },
  {
    name: "tableTendency",
    text: "卓の傾向",
    note: "この Hand より前に Hero が見た Hand の公開された Action だけから数えた、Hero 以外の卓全体の傾向",
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "policyVersion",
    text: "卓の傾向の数え方の版",
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "rate",
    text: "割合",
    note: "回数 ÷ 機会の数",
    plain: true,
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "numerator",
    text: "回数",
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "denominator",
    text: "機会の数",
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "hands",
    text: "数えた Hand の数",
    plain: true,
    pass: "decision",
    tableTendency: true,
  },
  {
    name: "sufficient",
    text: "サンプルが十分か",
    whenTrue: "サンプルが十分",
    whenFalse: "サンプルが足りない（保留）",
    plain: true,
    pass: "decision",
    tableTendency: true,
  },
  // Tournament（#189）。普通の英単語と同じ綴りの項目名は plain（`name=値` の形のときだけ置換する）。
  {
    name: "tournament",
    text: "トーナメントの状況",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "tournamentPolicyVersion",
    text: "トーナメントの Evidence の作り方の版",
    pass: "decision",
    tournament: true,
  },
  {
    name: "payoutPolicyVersion",
    text: "賞金の端数の配り方の版",
    pass: "decision",
    tournament: true,
  },
  {
    name: "entrants",
    text: "参加人数",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "remaining",
    text: "残人数",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "level",
    text: "Blind の Level",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "handNumber",
    text: "トーナメントの何 Hand 目か",
    pass: "decision",
    tournament: true,
  },
  { name: "anteKind", text: "Ante の種類", pass: "decision", tournament: true },
  {
    name: "ante",
    text: "Ante の額",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "prizePool",
    text: "賞金の総額（pt）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "payoutsByPlace",
    text: "順位ごとの賞金（pt）",
    note: "1 位から入賞の数だけ",
    pass: "decision",
    tournament: true,
  },
  {
    name: "stage",
    text: "トーナメントの段階",
    note: "before_bubble は Bubble より前、bubble は次に Bust する 1 人だけが入賞しない、in_the_money は残りの全員が入賞、heads_up は残り 2 人",
    plain: true,
    pass: "decision",
    tournament: true,
  },
  {
    name: "icmPolicyVersion",
    text: "ICM の計算の版",
    pass: "decision",
    tournament: true,
  },
  {
    name: "stackBasis",
    text: "ICM の Stack を取った時点",
    note: "decision_point は判断時点の手元の Stack とこの Hand で出した額の合計",
    pass: "decision",
    tournament: true,
  },
  {
    name: "icmStack",
    text: "ICM の計算に使った Stack",
    pass: "decision",
    tournament: true,
  },
  {
    name: "stackBb",
    text: "Stack の BB 換算",
    pass: "decision",
    tournament: true,
  },
  {
    name: "icmEquity",
    text: "ICM Equity（賞金の期待値。pt）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "icmEquityPercent",
    text: "賞金の総額に対する ICM Equity の割合（%）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "villainId",
    text: "相手の席",
    pass: "decision",
    tournament: true,
  },
  {
    name: "chipEv",
    text: "Chip EV の必要 Equity",
    note: "Chip の損益分岐の勝率。All-in への Call では Pot Odds と同じ",
    pass: "decision",
    tournament: true,
  },
  {
    name: "requiredEquityPercent",
    text: "必要 Equity（%）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "heroStack",
    text: "Hero の Stack（Fold・勝ち・負け）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "heroIcmEquity",
    text: "Hero の ICM Equity（Fold・勝ち・負け。pt）",
    pass: "decision",
    tournament: true,
  },
  {
    name: "othersFold",
    text: "ほかの Player は Fold する前提",
    pass: "decision",
    tournament: true,
  },
  {
    name: "foldEquityIncluded",
    text: "Fold Equity を含むか",
    whenTrue: "Fold Equity を含む",
    whenFalse: "Fold Equity を含まない",
    pass: "decision",
    tournament: true,
  },
  {
    name: "callFrequencyIncluded",
    text: "Call の頻度を含むか",
    whenTrue: "Call の頻度を含む",
    whenFalse: "Call の頻度を含まない",
    pass: "decision",
    tournament: true,
  },
  {
    name: "potWinnerIfHeroFolds",
    text: "Hero が Fold したときに今の Pot を取る Player",
    pass: "decision",
    tournament: true,
  },
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
  {
    name: "isDecision",
    text: "Review の対象の判断かどうか",
    whenTrue: "Review の対象の判断",
    whenFalse: "Review の対象の判断ではない",
    pass: "reveal",
  },
  { name: "playersInPot", text: "Pot を争っていた人数", pass: "reveal" },
  { name: "actorEquity", text: "Action した本人の Equity", pass: "reveal" },
  { name: "finalBoard", text: "Hand の最後の Board", pass: "reveal" },
  { name: "equity.actual", text: "実際の札に対する Equity", pass: "reveal" },
  {
    name: "equity.assumed",
    text: "仮定した Range に対する Equity",
    pass: "reveal",
  },
  { name: "aggression.rule", text: "value / bluff の基準", pass: "reveal" },
];

/** 英字と _ の値（enum）→ 文での書き方。Evidence と出力に出る enum の値（網羅は identifiers.test.ts が実際の Evidence で確かめる）。 */
const VALUE_TERMS: Readonly<Record<string, string>> = {
  // Equity の算出方法・Solver
  monte_carlo: "Monte Carlo",
  bet_or_raise: "Bet / Raise",
  heads_up: "Heads-Up",
  not_applicable: "当てはまらない",
  not_root_node: "Root の判断ではない",
  not_collected: "未収集",
  player_count: "人数",
  side_pot: "Side Pot",
  bet_tree: "Bet Tree",
  solver_not_installed: "Solver 未導入",
  invalid_input: "不正な入力",
  process_failed: "Solver の異常終了",
  parse_failure: "Solver の出力の読み取り失敗",
  // Table Tendency の項目と Policy の版（D122・#153）
  aggression_frequency: "Postflop の Aggression の頻度",
  phase7_table_tendency_v1: "卓の傾向の数え方の版",
  // Tournament の Evidence（#189）の値と版
  before_bubble: "Bubble より前",
  in_the_money: "入賞圏",
  big_blind_ante: "Big Blind Ante",
  per_player: "全員の Ante",
  call_all_in: "All-in への Call",
  out_of_scope: "計算の範囲外",
  decision_point: "判断時点",
  malmuth_harville: "Malmuth-Harville",
  pay_jump: "Pay Jump",
  short_stack: "Short Stack",
  phase8_review_tournament_v1: "トーナメントの Evidence の作り方の版",
  phase8_icm_provisional_v1: "ICM の計算の版",
  phase8_provisional_v1: "賞金の端数の配り方の版",
  // 段階評価・理論の根拠
  mixed_marginal: "僅差",
  improvement_suggested: "改善の余地あり",
  major_leak: "大きな損失につながる判断",
  insufficient_evidence: "根拠不足",
  general_theory: "一般的な理論",
  // Action・Preflop の Spot・役
  all_in: "All-in",
  call_open: "Open への Call",
  three_bet: "3-bet",
  call_three_bet: "3-bet への Call",
  four_bet_plus: "4-bet 以上",
  check_option: "BB の Check Option",
  not_acted: "まだ Action していない",
  high_card: "High Card",
  two_pair: "Two Pair",
  three_of_a_kind: "Three of a Kind",
  full_house: "Full House",
  four_of_a_kind: "Four of a Kind",
  straight_flush: "Straight Flush",
  // Important Spot の理由・Reveal・裁定
  big_pot: "大きい Pot",
  river_big_bet: "River の大きい Bet",
  learning_only: "答え合わせのために見せた情報",
  pending_out_of_turn: "保留した手番外の操作",
  out_of_turn: "手番外の操作",
  out_of_turn_binding: "手番外の操作の拘束",
  out_of_turn_released: "手番外の操作の撤回",
  no_action: "Action なし",
  declaration_ignored: "宣言を採らなかった裁定",
  declaration_adjusted: "宣言を合法な Action に寄せた裁定",
  check_facing_bet: "Bet に対する Check の宣言",
  oversized_chip: "Oversized Chip",
  string_bet: "String Bet",
  every_chip_needed: "Chip がすべて Call に必要だった裁定",
  half_raise_completed: "Half Raise の補完",
  under_half_raise: "Half Raise に満たない上乗せ",
  under_call: "Call に満たない額",
  under_min_bet: "最小 Bet に満たない額",
  raise_not_allowed: "Raise できない操作",
  chip_push: "Chip を出す操作",
  chip_add: "Chip を足す操作",
  // KB の Topic（snake_case をそのまま語に開く）
  ...Object.fromEntries(
    KB_TOPICS.filter((t) => t.includes("_")).map((t) => [
      t,
      t.replaceAll("_", " "),
    ]),
  ),
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

/**
 * 置換に使う「Evidence の id → 文での名前」の対応を、Evidence 自身から作る（Evidence に無い名前は使わない）。
 * 席の playerId → 表示名（Hero の画面に出ている名前）と、KB の項目の id → タイトル（Pass A の Evidence だけが持つ）。
 * 古い Evidence（displayName 無し）は、その分の対応が空になる。
 */
export function replacementNamesOf(evidence: {
  readonly context: DecisionContextEvidence;
  readonly knowledge?: {
    readonly items: readonly {
      readonly kbId: string;
      readonly title: string;
    }[];
  };
}): PlayerNames {
  const names: Record<string, string> = {};
  for (const seat of evidence.context.seats) {
    if (seat.displayName !== undefined) names[seat.playerId] = seat.displayName;
  }
  for (const item of evidence.knowledge?.items ?? []) {
    names[item.kbId] = item.title;
  }
  return names;
}

/**
 * Prompt に添える「Evidence の項目の説明」。Pass A（decision）と Pass B（reveal）で出す項目を分ける（Pass A の Prompt に Hand 後の項目の名前を出さない）。
 * Table Tendency の項目は、Evidence に Table Tendency があるとき（options.tableTendency）だけ出す（構造ゲート）。
 */
export function evidenceGlossary(
  pass: "decision" | "reveal",
  options: {
    readonly tableTendency?: boolean;
    /** Tournament の Evidence（#189）があるときだけ、その項目の説明を出す（構造ゲート）。 */
    readonly tournament?: boolean;
  } = {},
): string {
  const terms = EVIDENCE_TERMS.filter(
    (t) =>
      (pass === "reveal" || t.pass === "decision") &&
      (t.tableTendency !== true || options.tableTendency === true) &&
      (t.tournament !== true || options.tournament === true),
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
  /(?<![A-Za-z0-9_.])(?:math|range|solver|context|knowledge|reveal|equity|aggression|decision|tournament)\.[a-zA-Z]+(?:\.[a-zA-Z]+)*/g,
  // Evidence の id（math:review-... 等）
  /(?<![A-Za-z0-9_])(?:ctx|math|range|solver|kb|reveal|equity|aggression|tendency|tournament|icm|icmreq|chipev):[^\s,、。）)」]+/g,
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
