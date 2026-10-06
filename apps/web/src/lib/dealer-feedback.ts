// Dealer Feedback（docs/02 §8・docs/06 §6）。Hero の操作への Dealer の裁定（公開 Event の DEALER_RULING）から、
// RULING（裁定の事実）・ETIQUETTE（進行・作法の注意）・COACHING（学習の補足）の 3 分類の文言を決定論で作る（LLM は使わない）。
// 3 分類は別の項目として返し、1 つの文に混ぜない（UI でも進行ログでも分類ごとに見た目を分ける）。
// 裁定そのものはサーバーの Ruling Engine が決めたもので、ここでは裁定の理由（notes）を文言にするだけ（裁定をクライアントで判定しない）。
// COACHING は判断時点の Hero の情報だけを使う（Hindsight Leak を防ぐ。docs/05 §7）。log の裁定より前の公開 Event だけを読み、
// 他者の Hidden Cards・未来の Card（裁定より後の Event）・system Event は読まない。
import {
  potOdds,
  type HandEvent,
  type PhysicalAction,
  type RulingCode,
} from "@proj-poker/engine";
import { formatChips, formatPercent } from "./format.js";
import type { VocabId } from "./vocabulary.js";
import { describeAction } from "./view-model.js";

/** Dealer Feedback の分類（docs/02 §8）。 */
export type FeedbackCategory = "ruling" | "etiquette" | "coaching";

/** 分類の表示名（日本語 + 標準 Term。docs/06 §7）。 */
export const FEEDBACK_CATEGORY_LABELS: Readonly<
  Record<FeedbackCategory, string>
> = {
  ruling: "裁定（Ruling）",
  etiquette: "作法（Etiquette）",
  coaching: "学習（Coaching）",
};

/** Dealer Feedback の 1 項目。terms はその場面で起きた概念（Poker Vocabulary の詳細を開ける）。 */
export interface DealerFeedbackItem {
  readonly category: FeedbackCategory;
  readonly text: string;
  readonly terms: readonly VocabId[];
}

type RulingEvent = Extract<HandEvent, { type: "DEALER_RULING" }>;
type ActionEvent = Extract<HandEvent, { type: "ACTION_TAKEN" }>;

/**
 * log の index にある Hero への裁定の Dealer Feedback（RULING → ETIQUETTE → COACHING の順）。
 * 裁定でない・viewer 以外への裁定なら空（CPU は物理的な操作をしない。D91）。
 */
export function dealerFeedbackAt(
  log: readonly HandEvent[],
  index: number,
  viewerId: string,
): DealerFeedbackItem[] {
  const ruling = log[index];
  if (ruling?.type !== "DEALER_RULING" || ruling.playerId !== viewerId) {
    return [];
  }
  const next = log[index + 1];
  const result =
    ruling.outcome === "action" &&
    next?.type === "ACTION_TAKEN" &&
    next.playerId === ruling.playerId
      ? next
      : null;
  const operations = operationsOf(log, index);
  return [
    rulingItem(ruling, result, operations),
    ...etiquetteItems(ruling.notes),
    ...coachingItems(log.slice(0, index), result),
  ];
}

/**
 * 裁定した操作（した順）。basis: operations なら同じ追記で直前に置いた同じ Player の操作の Event、
 * basis: pending_out_of_turn なら保留したときの裁定（outcome: out_of_turn）の直前の操作の Event。
 */
function operationsOf(
  log: readonly HandEvent[],
  rulingIndex: number,
): PhysicalAction[] {
  const ruling = log[rulingIndex] as RulingEvent;
  let end = rulingIndex;
  if (ruling.basis === "pending_out_of_turn") {
    end = log.findLastIndex(
      (e, i) =>
        i < rulingIndex &&
        e.type === "DEALER_RULING" &&
        e.playerId === ruling.playerId &&
        e.outcome === "out_of_turn",
    );
    if (end < 0) return [];
  }
  const operations: PhysicalAction[] = [];
  for (let i = end - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.type === "PLAYER_DECLARED" && e.playerId === ruling.playerId) {
      operations.unshift({ type: "declare", declaration: e.declaration });
    } else if (
      e?.type === "PHYSICAL_CHIP_ACTION" &&
      e.playerId === ruling.playerId
    ) {
      operations.unshift({ type: e.motion, chips: e.chips });
    } else {
      break;
    }
  }
  return operations;
}

/** 裁定の理由（RulingCode）を事実として述べる 1 文。操作の中身（出した Chip）は公開 Event から添える。 */
function reasonSentence(
  code: RulingCode,
  operations: readonly PhysicalAction[],
): string {
  switch (code) {
    case "declaration_ignored":
      return "Chip を出した後の宣言と、2 つ目以降の宣言は採りませんでした。";
    case "declaration_adjusted":
      return "宣言の種類・額を、合法な最も近い Action に合わせました。";
    case "check_facing_bet":
      return "相手の Bet があるので、Check の宣言は受けられません。";
    case "oversized_chip": {
      const chip = operations.find((o) => o.type === "chip_push")?.chips[0];
      const value = chip === undefined ? "" : `（${formatChips(chip)}）`;
      return `相手の Bet に対し、宣言なしで Call 額を超える Chip${value}を 1 枚出しました。`;
    }
    case "string_bet":
      return "2 回目以降に分けて出した Chip は数えず、Hero に返しました。";
    case "every_chip_needed":
      return "宣言なしの複数の Chip は、どれを除いても Call 額に届きません（全部が Call に要る Chip）。";
    case "half_raise_completed":
      return "宣言なしの上乗せが直前の Raise 幅の半分以上で、最小 Raise に足りませんでした。最小 Raise まで足していただきます。";
    case "under_half_raise":
      return "宣言なしの上乗せが直前の Raise 幅の半分に届きませんでした。超えた分は返しました。";
    case "under_call":
      return "Call 額に満たない Chip でした。足りない分を足していただきます。";
    case "under_min_bet":
      return "最小 Bet に満たない Chip でした。最小 Bet まで足していただきます。";
    case "raise_not_allowed":
      return "この局面では Raise できません（Action が再開していない・相手が全員 All-in）。";
    case "out_of_turn":
      return "手番ではない操作です。操作を保留し、Hero の手番が来たら裁定します。";
    case "out_of_turn_binding":
      return "保留していた手番外の操作は、その後に状況が変わらなかったので有効にします。";
    case "out_of_turn_released":
      return "保留していた手番外の操作は、その後に状況が変わった（Bet・Raise があった、または Street が進んだ）ので取り消しました。";
  }
}

/** 理由ごとに、その場面で起きた概念（Poker Vocabulary）。 */
const RULING_TERMS: Readonly<Record<RulingCode, readonly VocabId[]>> = {
  declaration_ignored: ["declaration"],
  declaration_adjusted: ["declaration"],
  check_facing_bet: ["check"],
  oversized_chip: ["oversizedChip"],
  string_bet: ["stringBet"],
  every_chip_needed: ["call"],
  half_raise_completed: ["minRaise"],
  under_half_raise: ["minRaise"],
  under_call: ["call"],
  under_min_bet: ["bet"],
  raise_not_allowed: ["raise"],
  out_of_turn: ["outOfTurn"],
  out_of_turn_binding: ["outOfTurn"],
  out_of_turn_released: ["outOfTurn"],
};

/** RULING: 裁定の事実（理由と、Game State に反映した結果）。 */
function rulingItem(
  ruling: RulingEvent,
  result: ActionEvent | null,
  operations: readonly PhysicalAction[],
): DealerFeedbackItem {
  const reasons = ruling.notes.map((c) => reasonSentence(c, operations));
  let outcome: string;
  switch (ruling.outcome) {
    case "action":
      outcome =
        result === null
          ? ""
          : `${ruling.notes.length > 0 ? "この Rule Profile では " : ""}${describeAction(result)} として扱います。`;
      break;
    case "no_action":
      outcome = "Action は決まっていません。もう一度操作してください。";
      break;
    case "out_of_turn":
      // 理由（out_of_turn）の文が結果も述べている。
      outcome = "";
      break;
  }
  const terms = unique(ruling.notes.flatMap((c) => RULING_TERMS[c]));
  return { category: "ruling", text: [...reasons, outcome].join(""), terms };
}

/** ETIQUETTE: 進行・作法の注意（Game State には影響しない）。同じ注意は 1 回だけ出す。 */
const ETIQUETTE: Partial<
  Record<RulingCode, { readonly text: string; readonly terms: VocabId[] }>
> = {
  out_of_turn: {
    text: "手番が来るまで操作を待ちましょう。手番外の操作は、先に行動する Player の判断に影響します。",
    terms: ["outOfTurn"],
  },
  string_bet: {
    text: "Chip は 1 回の動作でまとめて出すか、先に額を宣言しましょう。",
    terms: ["stringBet", "declaration"],
  },
  oversized_chip: {
    text: "大きい Chip 1 枚で Raise するときは、先に「Raise」と宣言しましょう。",
    terms: ["oversizedChip", "declaration"],
  },
  declaration_ignored: {
    text: "宣言は Chip を出す前に、1 回だけはっきり行いましょう。",
    terms: ["declaration"],
  },
  half_raise_completed: {
    text: "Raise するときは額を宣言するか、最小 Raise 以上をまとめて出しましょう。",
    terms: ["minRaise", "declaration"],
  },
  under_half_raise: {
    text: "Raise するときは額を宣言するか、最小 Raise 以上をまとめて出しましょう。",
    terms: ["minRaise", "declaration"],
  },
  check_facing_bet: {
    text: "宣言の前に、相手の Bet があるかを確かめましょう。",
    terms: ["check"],
  },
};

function etiquetteItems(notes: readonly RulingCode[]): DealerFeedbackItem[] {
  const items: DealerFeedbackItem[] = [];
  for (const code of notes) {
    const e = ETIQUETTE[code];
    if (e === undefined || items.some((i) => i.text === e.text)) continue;
    items.push({ category: "etiquette", text: e.text, terms: e.terms });
  }
  return items;
}

/**
 * 判断の直前の Pot（公開 Event の Blind・Action の額の合計から、戻った Bet を引く）。
 * before は判断より前の Event だけ（呼び出し側が log を裁定の位置で切って渡す）。公開 Event だけを読む（whitelist）。
 */
export function potBefore(before: readonly HandEvent[]): number {
  let pot = 0;
  for (const e of before) {
    if (e.visibility.type !== "public") continue;
    if (e.type === "BLIND_POSTED" || e.type === "ACTION_TAKEN") {
      pot += e.amount;
    } else if (e.type === "UNCALLED_BET_RETURNED") {
      pot -= e.amount;
    }
  }
  return pot;
}

/**
 * COACHING: 判断時点の Hero の情報で作る学習の補足。before は裁定より前の Event だけ（未来の Card・裁定より後の Event を渡さない）。
 * 結果の ACTION_TAKEN は同じ判断の結果（同じ追記）なので使ってよい。今は Call の Pot Odds と、Bet の Pot に対する大きさだけを出す。
 */
function coachingItems(
  before: readonly HandEvent[],
  result: ActionEvent | null,
): DealerFeedbackItem[] {
  if (result === null) return [];
  const pot = potBefore(before);
  if (result.action === "call") {
    const odds = potOdds(result.amount, pot);
    if (odds === null) return [];
    return [
      {
        category: "coaching",
        text: `このときの Pot は ${formatChips(pot)}、Call 額は ${formatChips(result.amount)} でした。必要な勝率の目安（Pot Odds）は ${formatChips(result.amount)} ÷（${formatChips(pot)} + ${formatChips(result.amount)}）≒ ${formatPercent(odds)} です。勝率がこれを上回れば、Call は長期的に見合います。`,
        terms: ["potOdds"],
      },
    ];
  }
  if (result.action === "bet" && pot > 0) {
    // 相手は Bet 額を Call して「Pot + Bet + Call」を取り合うので、相手の Pot Odds は bet ÷（pot + 2 × bet）。
    const bet = result.toAmount;
    const facing = potOdds(bet, pot + bet) ?? 0;
    return [
      {
        category: "coaching",
        text: `Pot ${formatChips(pot)} に対して ${formatChips(bet)} の Bet（Pot の約 ${formatPercent(bet / pot)}）でした。相手が Call するのに要る勝率の目安（相手の Pot Odds）は約 ${formatPercent(facing)} です。`,
        terms: ["pot", "potOdds"],
      },
    ];
  }
  return [];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
