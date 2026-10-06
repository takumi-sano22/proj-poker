// Local Knowledge Base（Curated KB。D23・D98）の型と、Metadata の語彙。
// KB は docs/research から Review で使う粒度の要点を抜き出した「1 項目 = 1 ファイル」の Markdown で、数値の根拠は Engine（Math Evidence）が持つ。
// ここの項目は概念・Practical な指針で、Math を置き換えない（docs/03 §9）。
import type { PositionName, PreflopSpot, Street } from "@proj-poker/engine";

/**
 * Topic の一覧（閉じた語彙）。docs/research/06 §1 の Directory 案のうち Phase 5 の Review で使うものだけを置く。
 * 未知の Topic は KB の読み込みで弾く（綴りの揺れで検索から漏れるのを防ぐため）。足すときは項目と一緒にここへ足す。
 */
export const KB_TOPICS = [
  "pot_odds",
  "outs_equity",
  "equity",
  "expected_value",
  "implied_odds",
  "spr",
  "position",
  "preflop_open",
  "preflop_3bet",
  "blind_defense",
  "rake",
  "range_thinking",
  "range_advantage",
  "cbet",
  "value_betting",
  "bluffing",
  "bet_sizing",
  "river_decision",
  "multiway",
  "exploit",
  "solver_usage",
  "review_principle",
] as const;
export type KbTopic = (typeof KB_TOPICS)[number];

/**
 * Knowledge Label（docs/research/README.md §2）。Review AI が経験則を普遍的ルールとして断定しないよう、項目ごとに種類を持つ。
 * HEURISTIC / EXPLOIT / UNCERTAIN を無条件の Product Rule にしない（SOURCES.md「Source利用ポリシー」）。
 */
export const KB_LABELS = [
  "RULE",
  "FACT",
  "THEORY_BASELINE",
  "HEURISTIC",
  "EXPLOIT",
  "HOUSE_RULE",
  "UNCERTAIN",
] as const;
export type KbLabel = (typeof KB_LABELS)[number];

export const KB_FORMATS = ["cash", "tournament"] as const;
export type KbFormat = (typeof KB_FORMATS)[number];

/** Player 数の区分（docs/research/02 §14: player_count を First-class Parameter にする）。 */
export const KB_PLAYER_GROUPS = ["heads_up", "multiway"] as const;
export type KbPlayerGroup = (typeof KB_PLAYER_GROUPS)[number];

/**
 * Spot の種類（Hero の判断が「どういう場面か」）。
 * - preflop_open: Preflop で、まだ誰も Raise していない（Hero が最初に Raise できる）
 * - preflop_facing_raise: Preflop で、Raise に直面している（Call・3-bet・Fold の判断）
 * - postflop_aggressor: Postflop で、Hero が Preflop の最後の Raiser として Bet できる（C-bet の場面）
 * - postflop_checked_to: Postflop で、全員が Check して Hero に回ってきた（Preflop の Aggressor ではない）
 * - postflop_facing_bet: Postflop で、Bet / Raise に直面している
 */
export const KB_SPOT_KINDS = [
  "preflop_open",
  "preflop_facing_raise",
  "postflop_aggressor",
  "postflop_checked_to",
  "postflop_facing_bet",
] as const;
export type KbSpotKind = (typeof KB_SPOT_KINDS)[number];

export const KB_STREETS = ["preflop", "flop", "turn", "river"] as const;
export const KB_POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export const KB_PREFLOP_ACTIONS = [
  "open",
  "limp",
  "call_open",
  "three_bet",
  "call_three_bet",
  "four_bet_plus",
  "check_option",
  "not_acted",
] as const;

// 上の 3 つは engine の Street / PositionName / PreflopSpot と同じ値を過不足なく並べる。
// 余分な値・足りない値のどちらがあっても、下の型が false になって typecheck で落ちる（Engine に値が増えたときの取りこぼし防止）。
type SameValues<A extends string, B extends string> = [
  Exclude<A, B>,
  Exclude<B, A>,
] extends [never, never]
  ? true
  : false;
type AssertTrue<T extends true> = T;
export type KbVocabularyMatchesEngine = [
  AssertTrue<SameValues<Street, (typeof KB_STREETS)[number]>>,
  AssertTrue<SameValues<PositionName, (typeof KB_POSITIONS)[number]>>,
  AssertTrue<SameValues<PreflopSpot, (typeof KB_PREFLOP_ACTIONS)[number]>>,
];

/** KB の項目 1 つの Metadata（Markdown の先頭の front matter）。空の配列は「条件なし（どれにも当てはまる）」。 */
export interface KbEntryMeta {
  /** 項目の ID。ファイル名（拡張子を除く）と同じ。Review の Evidence ID に使う。 */
  readonly id: string;
  readonly title: string;
  readonly topic: KbTopic;
  readonly label: KbLabel;
  readonly formats: readonly KbFormat[];
  readonly streets: readonly Street[];
  readonly positions: readonly PositionName[];
  readonly players: readonly KbPlayerGroup[];
  readonly spots: readonly KbSpotKind[];
  /** 相手の Preflop の Action 列の分類（engine の PreflopSpot）。 */
  readonly actions: readonly PreflopSpot[];
  /** 全文検索の補助（Topic / Keyword Index。docs/research/06 §4）。 */
  readonly keywords: readonly string[];
  /** 出典。`docs/research/<file>.md §<節> | <元の出典の名前>`（`| …` は省略可。元の出典は SOURCES.md の見出しの名前）。 */
  readonly source: readonly string[];
  /** 項目を書いた（確認した）日。YYYY-MM-DD。 */
  readonly date: string;
  /** 項目の Version（1 から。内容を変えたら上げる）。 */
  readonly version: number;
}

export interface KbEntry extends KbEntryMeta {
  /** Metadata を除いた Markdown の本文。Review AI へ渡す対象。 */
  readonly body: string;
}

/** Evidence に残す参照（KB 全体の Version と項目の ID・Version）。Review の Evidence ID（#82）はこれから作る。 */
export interface KbRef {
  readonly kbVersion: string;
  readonly id: string;
  readonly version: number;
}

/**
 * Spot の特徴。渡した特徴だけで絞り込み・加点する（渡さなかった特徴は見ない）。
 * 呼ぶ側（Review）は、判断時点の Hero Information Set だけから作る（判断より後の Board・Action・相手の実際の札を入れない。不変条件 3）。
 */
export interface KbSpot {
  readonly street?: Street;
  readonly position?: PositionName;
  readonly players?: KbPlayerGroup;
  readonly spotKind?: KbSpotKind;
  /** Pot に残っている相手ごとの Preflop の Action 列の分類（engine の classifyPreflop の結果）。 */
  readonly actions?: readonly PreflopSpot[];
}

export interface KbQuery {
  readonly spot?: KbSpot;
  /** 直接指定する Topic（Review が論点を決めているとき）。 */
  readonly topics?: readonly KbTopic[];
  /** 全文検索の語（空白・句読点区切り）。 */
  readonly text?: string;
  /** 返す最大件数（既定 5）。 */
  readonly limit?: number;
}

export interface KbHit extends KbRef {
  /** `kbEvidenceId` の値。 */
  readonly evidenceId: string;
  readonly topic: KbTopic;
  readonly title: string;
  readonly label: KbLabel;
  readonly source: readonly string[];
  readonly score: number;
  /** どの特徴・語に当たったか（決まった順。例 `spotKind:postflop_facing_bet`）。 */
  readonly matched: readonly string[];
  readonly body: string;
}

export interface KbSearchResult {
  readonly kbVersion: string;
  readonly hits: readonly KbHit[];
}

/** Evidence に残す文字列。KB の Version を含めるので、KB が更新された後でも Review がどの版を根拠にしたか分かる。 */
export function kbEvidenceId(ref: KbRef): string {
  return `kb:${ref.kbVersion}:${ref.id}@${ref.version}`;
}
