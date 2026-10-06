// Poker Vocabulary（docs/06 §7・D45）。「日本語説明 + 標準 Poker Term」の辞書をデータとして持ち、
// 卓の上の用語から Definition・Current Hand Example・Related Concept・Advanced Detail を開けるようにする。
// Current Hand Example は Hero に見える情報（HeroView の公開された値と、log の公開 Event）だけで作る。
// 他者の Hidden Cards（seats[].holeCards の他者の値も含めて読まない）・system / engine Event・未来の Card は使わない。
// 手番中の判断の計算（Pot Odds など）は Hint（docs/06 §9。標準では非表示）の役割なので、例は済んだ判断から作る。
import type { HandEvent, HeroView, Street } from "@proj-poker/engine";
import { potBefore, potOdds } from "./dealer-feedback.js";
import {
  ACTION_TERMS,
  STREET_TERMS,
  TERMS,
  cardShortLabel,
  formatBB,
  formatChips,
  formatPercent,
  type Term,
} from "./format.js";
import { describeAction } from "./view-model.js";

export type VocabId =
  | "pot"
  | "stack"
  | "effectiveStack"
  | "button"
  | "smallBlind"
  | "bigBlind"
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "uncalledBet"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "allIn"
  | "minRaise"
  | "potOdds"
  | "declaration"
  | "oversizedChip"
  | "stringBet"
  | "outOfTurn";

/** Current Hand Example を作るときに渡す、Hero に見える情報。 */
export interface VocabularyContext {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
}

export interface VocabularyEntry extends Term {
  readonly id: VocabId;
  /** Definition: 用語の意味（1〜2 文）。 */
  readonly definition: string;
  /** Related Concept: 関連する用語。 */
  readonly related: readonly VocabId[];
  /** Advanced Detail: 細則・例外・この卓の Rule Profile での扱い。 */
  readonly advanced: string;
  /** Current Hand Example: 今の Hand での例（Hero に見える情報だけ）。 */
  readonly example: (ctx: VocabularyContext) => string;
}

/** Hero に見える公開 Event だけ（whitelist。private は Hero 自身の札だけだが、例には使わない）。 */
function publicEvents(view: HeroView): HandEvent[] {
  return view.log.filter((e) => e.visibility.type === "public");
}

function lastAction(
  view: HeroView,
  action: Extract<HandEvent, { type: "ACTION_TAKEN" }>["action"],
): Extract<HandEvent, { type: "ACTION_TAKEN" }> | undefined {
  return publicEvents(view).findLast(
    (e): e is Extract<HandEvent, { type: "ACTION_TAKEN" }> =>
      e.type === "ACTION_TAKEN" && e.action === action,
  );
}

function actionExample(
  action: Extract<HandEvent, { type: "ACTION_TAKEN" }>["action"],
) {
  return ({ view, nameOf }: VocabularyContext): string => {
    const e = lastAction(view, action);
    const label = ACTION_TERMS[action].term;
    return e === undefined
      ? `この Hand ではまだ ${label} はありません。`
      : `この Hand の直近の ${label}: ${nameOf(e.playerId)} の ${describeAction(e)}。`;
  };
}

function blindExample(blind: "small" | "big") {
  return ({ view, nameOf }: VocabularyContext): string => {
    const e = publicEvents(view).find(
      (x) => x.type === "BLIND_POSTED" && x.blind === blind,
    );
    if (e?.type !== "BLIND_POSTED") return "この Hand の Blind はまだです。";
    return `この Hand の ${blind === "small" ? "SB" : "BB"} は ${nameOf(e.playerId)}（${formatChips(e.amount)}）。`;
  };
}

function boardExample({ view }: VocabularyContext): string {
  return view.board.length === 0
    ? `今は ${STREET_TERMS[view.street].term}。Board はまだ配られていません。`
    : `今は ${STREET_TERMS[view.street].term}。Board: ${view.board.map(cardShortLabel).join(" ")}。`;
}

function heroStack(view: HeroView): number | null {
  return view.seats.find((s) => s.playerId === view.viewerId)?.stack ?? null;
}

/** Hero が操作した中で、最後に特定の理由が付いた裁定（済んだ判断の例に使う）。 */
function lastHeroRulingWith(
  view: HeroView,
  code: Extract<HandEvent, { type: "DEALER_RULING" }>["notes"][number],
): Extract<HandEvent, { type: "DEALER_RULING" }> | undefined {
  return publicEvents(view).findLast(
    (e): e is Extract<HandEvent, { type: "DEALER_RULING" }> =>
      e.type === "DEALER_RULING" &&
      e.playerId === view.viewerId &&
      e.notes.includes(code),
  );
}

function rulingExample(
  code: Extract<HandEvent, { type: "DEALER_RULING" }>["notes"][number],
  none: string,
) {
  return ({ view }: VocabularyContext): string => {
    const e = lastHeroRulingWith(view, code);
    return e === undefined
      ? none
      : `この Hand の ${STREET_TERMS[e.street].term} で、Hero の操作がこの扱いになりました（進行ログの「裁定」を参照）。`;
  };
}

const STREET_ADVANCED =
  "Preflop は BB の左隣から（Heads-Up では Button = SB から）、Flop 以降は Button の左隣から順に行動します。Street ごとに全員の Bet が揃うか、1 人を残して全員が Fold すると次へ進みます。";

function streetEntry(
  id: Street,
  definition: string,
  related: readonly VocabId[],
): VocabularyEntry {
  return {
    id,
    ...STREET_TERMS[id],
    definition,
    related,
    advanced: STREET_ADVANCED,
    example: boardExample,
  };
}

const ENTRIES: readonly VocabularyEntry[] = [
  {
    id: "pot",
    ...TERMS.pot,
    definition:
      "その Hand で全員が出した Chip の合計です。Hand の終わりに、勝った Player が受け取ります。",
    related: ["potOdds", "uncalledBet", "showdown"],
    advanced:
      "Stack の違う Player が All-in すると、その Player が争える Main Pot と、残りの Player だけが争う Side Pot に分かれます。卓の Pot の表示は全部の合計です。",
    example: ({ view }) =>
      `今の Pot は ${formatChips(view.pot)}（${formatBB(view.pot, view.bigBlind)}）。`,
  },
  {
    id: "stack",
    ...TERMS.stack,
    definition:
      "各 Player が卓の上に持っている Chip のうち、まだ Pot に出していない分です。",
    related: ["effectiveStack", "allIn", "bigBlind"],
    advanced:
      "Stack の深さは BB の何倍かで測ると比べやすくなります。この卓では実額が正本で、BB 換算は補助として添えています。",
    example: ({ view }) => {
      const stack = heroStack(view);
      return stack === null
        ? "Hero は卓にいません。"
        : `Hero の Stack は ${formatChips(stack)}（${formatBB(stack, view.bigBlind)}）。`;
    },
  },
  {
    id: "effectiveStack",
    ja: "有効スタック",
    term: "Effective Stack",
    definition:
      "自分と相手の Stack のうち小さい方です。その相手との間で実際に動きうる最大の額になります。",
    related: ["stack", "allIn", "potOdds"],
    advanced:
      "Multiway では相手ごとに有効スタックが違います。ここでの例は、Fold していない他者のうち最も大きい Stack と比べた値です。有効スタック ÷ Pot（SPR）は、どこまで Pot を大きくできるかの目安になります。",
    example: ({ view }) => {
      const stack = heroStack(view);
      const others = view.seats
        .filter((s) => s.playerId !== view.viewerId && !s.folded)
        .map((s) => s.stack);
      if (stack === null || others.length === 0) {
        return "有効スタックを比べる相手がいません。";
      }
      const effective = Math.min(stack, Math.max(...others));
      return `今の Hero の有効スタックは ${formatChips(effective)}（${formatBB(effective, view.bigBlind)}）。`;
    },
  },
  {
    id: "button",
    ...TERMS.button,
    definition:
      "Dealer Button を置いた席です。Flop 以降は最後に行動できる、有利な Position です。",
    related: ["smallBlind", "bigBlind"],
    advanced:
      "Button は Hand ごとに時計回りに 1 席進みます。Heads-Up（2 人）では Button が SB を兼ね、Preflop は先に、Flop 以降は後に行動します。",
    example: ({ view, nameOf }) => {
      const button = view.seats.find((s) => s.isButton);
      return button === undefined
        ? "この Hand の Button はまだ決まっていません。"
        : `この Hand の Button は ${nameOf(button.playerId)}。`;
    },
  },
  {
    id: "smallBlind",
    ...TERMS.smallBlind,
    definition:
      "Button の左隣の Player が、札が配られる前に強制で出す小さい額です。",
    related: ["bigBlind", "button"],
    advanced: "Heads-Up では Button が SB を出します。",
    example: blindExample("small"),
  },
  {
    id: "bigBlind",
    ...TERMS.bigBlind,
    definition:
      "SB の左隣の Player が、札が配られる前に強制で出す額です。最小の Bet の額であり、Stack や Pot を測る単位（BB）にもなります。",
    related: ["smallBlind", "stack", "minRaise"],
    advanced:
      "Preflop で誰も Raise していなければ、BB は最後に Check か Raise を選べます（Option）。",
    example: blindExample("big"),
  },
  streetEntry(
    "preflop",
    "札が 2 枚ずつ配られた後、Board が出る前の Betting Round です。",
    ["flop", "bigBlind"],
  ),
  streetEntry(
    "flop",
    "Board に最初の 3 枚が表向きで出た後の Betting Round です。",
    ["preflop", "turn"],
  ),
  streetEntry("turn", "Board に 4 枚目が出た後の Betting Round です。", [
    "flop",
    "river",
  ]),
  streetEntry(
    "river",
    "Board に 5 枚目が出た後の、最後の Betting Round です。",
    ["turn", "showdown"],
  ),
  {
    id: "showdown",
    ...TERMS.showdown,
    definition:
      "最後の Betting Round が終わって 2 人以上が残ったとき、札を見せて勝者を決めることです。",
    related: ["river", "pot"],
    advanced:
      "手札 2 枚と Board 5 枚から最も強い 5 枚の組み合わせで比べます。同じ強さなら Pot を分けます（割り切れない端数は Rule Profile の規則で配ります）。",
    example: ({ view, nameOf }) => {
      const tabled = publicEvents(view).flatMap((e) =>
        e.type === "CARDS_TABLED" ? [nameOf(e.playerId)] : [],
      );
      return tabled.length === 0
        ? "この Hand ではまだ Showdown していません。"
        : `この Hand では ${tabled.join("・")} が札を見せました。`;
    },
  },
  {
    id: "uncalledBet",
    ...TERMS.uncalledBet,
    definition:
      "誰にも Call されなかった Bet の超えた分です。Pot には入らず、出した Player に戻ります。",
    related: ["pot", "allIn"],
    advanced:
      "全員が Fold したときや、相手の All-in が自分の Bet より小さいときに起きます。",
    example: ({ view, nameOf }) => {
      const e = publicEvents(view).findLast(
        (x) => x.type === "UNCALLED_BET_RETURNED",
      );
      return e?.type === "UNCALLED_BET_RETURNED"
        ? `この Hand では ${nameOf(e.playerId)} に ${formatChips(e.amount)} が戻りました。`
        : "この Hand ではまだ戻った Bet はありません。";
    },
  },
  {
    id: "fold",
    ...ACTION_TERMS.fold,
    definition: "札を捨てて、この Hand を降りることです。",
    related: ["check", "call"],
    advanced:
      "相手の Bet が無いときも Fold はできますが、Check できるので普通は Check します。",
    example: ({ view, nameOf }) => {
      const folded = view.seats
        .filter((s) => s.folded)
        .map((s) => nameOf(s.playerId));
      return folded.length === 0
        ? "この Hand ではまだ誰も Fold していません。"
        : `この Hand で Fold したのは ${folded.join("・")}。`;
    },
  },
  {
    id: "check",
    ...ACTION_TERMS.check,
    definition:
      "相手の Bet が無いとき、Chip を出さずに次の Player へ手番を回すことです。",
    related: ["bet", "fold"],
    advanced:
      "相手の Bet があるときは Check できません（Call・Raise・Fold から選びます）。",
    example: actionExample("check"),
  },
  {
    id: "call",
    ...ACTION_TERMS.call,
    definition: "相手の Bet と同じ額まで Chip を出すことです。",
    related: ["potOdds", "raise", "fold"],
    advanced:
      "Stack が Call 額に足りないときは、持っている全部で Call します（All-in）。その場合、届かない分は Side Pot になります。",
    example: actionExample("call"),
  },
  {
    id: "bet",
    ...ACTION_TERMS.bet,
    definition: "その Betting Round で最初に Chip を出すことです。",
    related: ["raise", "check", "pot"],
    advanced:
      "最小の Bet は BB の額です。Bet の大きさは Pot との比（Pot の何 %）で考えると、相手に求める勝率が分かります。",
    example: actionExample("bet"),
  },
  {
    id: "raise",
    ...ACTION_TERMS.raise,
    definition: "相手の Bet より大きい額に上げることです。",
    related: ["minRaise", "bet", "call"],
    advanced:
      "Raise の額は「この Street で合計いくらにするか（to 額）」で表します。この卓のログも to 額（例: 「30 まで」）です。",
    example: actionExample("raise"),
  },
  {
    id: "allIn",
    ...ACTION_TERMS.all_in,
    definition: "持っている Stack の全部を出すことです。",
    related: ["stack", "effectiveStack", "uncalledBet"],
    advanced:
      "All-in の額が最小 Raise に届かないとき（Short All-in）、すでに行動した Player に Raise の権利が戻らないことがあります。",
    example: ({ view, nameOf }) => {
      // All-in は action: all_in だけでなく、Stack が足りない Call・Bet・Raise（allIn: true）でも起きる。
      const e = publicEvents(view).findLast(
        (x): x is Extract<HandEvent, { type: "ACTION_TAKEN" }> =>
          x.type === "ACTION_TAKEN" && x.allIn,
      );
      return e === undefined
        ? "この Hand ではまだ All-in はありません。"
        : `この Hand の直近の All-in: ${nameOf(e.playerId)} の ${describeAction(e)}。`;
    },
  },
  {
    id: "minRaise",
    ja: "最小レイズ",
    term: "Min Raise",
    definition:
      "Raise できる最小の額です。直前の Bet・Raise の上げ幅以上を上乗せする必要があります。",
    related: ["raise", "bigBlind", "declaration"],
    advanced:
      "この卓の Rule Profile（暫定）では、宣言なしで出した上乗せが直前の上げ幅の半分以上なら最小 Raise まで足させ、半分未満なら Call として扱います。",
    example: ({ view, nameOf }) => {
      const raise = lastAction(view, "raise");
      return raise === undefined
        ? `この Hand ではまだ Raise がありません。最初の Raise の上げ幅は BB（${formatChips(view.bigBlind)}）以上です。`
        : `この Hand の直近の Raise は ${nameOf(raise.playerId)} の ${formatChips(raise.toAmount)} まで。次の Raise は、その上げ幅以上を上乗せします。`;
    },
  },
  {
    id: "potOdds",
    ja: "ポットオッズ",
    term: "Pot Odds",
    definition:
      "Call 額 ÷（Pot + Call 額）。Call が長期的に見合うのに必要な勝率の目安です。",
    related: ["pot", "call", "effectiveStack"],
    advanced:
      "後の Street で得られる見込み（Implied Odds）や Rake は含みません。必要な勝率と、自分の手が勝つ見込み（Equity）を比べて判断します。",
    example: ({ view }) => {
      // 手番中の計算は Hint の役割なので、済んだ Hero の Call（判断時点の Pot）から例を作る。
      const log = view.log;
      const index = log.findLastIndex(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.visibility.type === "public" &&
          e.playerId === view.viewerId &&
          e.action === "call",
      );
      const call = log[index];
      if (call?.type !== "ACTION_TAKEN") {
        return "この Hand で Hero はまだ Call していません（Call した後に、そのときの Pot Odds を例として出します）。";
      }
      const pot = potBefore(log.slice(0, index));
      const odds = potOdds(call.amount, pot);
      return odds === null
        ? "この Hand で Hero はまだ Call していません。"
        : `Hero の直近の Call: Pot ${formatChips(pot)} に ${formatChips(call.amount)} を Call → 必要な勝率の目安は ${formatPercent(odds)}。`;
    },
  },
  {
    id: "declaration",
    ja: "宣言",
    term: "Declaration",
    definition:
      "口頭で Action を伝えることです。この卓では宣言 Button で行います。",
    related: ["oversizedChip", "stringBet", "raise"],
    advanced:
      "宣言と Chip は先にした方が Action を決めます。宣言した Action は拘束され、合法でない額は最も近い合法な Action に合わせます（この卓の Rule Profile・暫定）。",
    example: ({ view }) => {
      const count = publicEvents(view).filter(
        (e) => e.type === "PLAYER_DECLARED" && e.playerId === view.viewerId,
      ).length;
      return count === 0
        ? "この Hand で Hero はまだ宣言していません。"
        : `この Hand で Hero は ${count} 回宣言しました。`;
    },
  },
  {
    id: "oversizedChip",
    ja: "オーバーサイズチップ",
    term: "Oversized Chip",
    definition:
      "相手の Bet に対し、宣言せずに Call 額を超える Chip を 1 枚だけ出すことです。Call として扱われます。",
    related: ["declaration", "raise", "stringBet"],
    advanced:
      "Raise したいときは、先に Raise を宣言してから出します。相手の Bet が無い局面では、1 枚の Chip はその額の Bet になります。",
    example: rulingExample(
      "oversized_chip",
      "この Hand ではまだ起きていません。",
    ),
  },
  {
    id: "stringBet",
    ja: "ストリングベット",
    term: "String Bet",
    definition:
      "宣言せずに Chip を何回かに分けて出すことです。最初の動作の分だけが数えられます。",
    related: ["declaration", "oversizedChip", "raise"],
    advanced:
      "Raise を宣言して額を言わないときは、最初の 1 回の Chip（その額がちょうど Call 額なら、続く 1 回まで）で額が決まります。",
    example: rulingExample("string_bet", "この Hand ではまだ起きていません。"),
  },
  {
    id: "outOfTurn",
    ja: "手番外の行動",
    term: "Out of Turn",
    definition: "自分の手番より前に Action することです。",
    related: ["declaration", "button"],
    advanced:
      "この卓の Rule Profile（暫定）では、間の Player が Check・Call・Fold だけなら保留した操作を有効にし、Bet・Raise があれば取り消します。TDA は Fold を拘束しますが、この卓では Fold も取り消せます。",
    example: rulingExample("out_of_turn", "この Hand ではまだ起きていません。"),
  },
];

/** id から引く辞書。 */
export const VOCABULARY: Readonly<Record<VocabId, VocabularyEntry>> =
  Object.fromEntries(ENTRIES.map((e) => [e.id, e])) as Record<
    VocabId,
    VocabularyEntry
  >;

/** 辞書の全項目（並び順はデータの順）。 */
export const VOCABULARY_ENTRIES: readonly VocabularyEntry[] = ENTRIES;
