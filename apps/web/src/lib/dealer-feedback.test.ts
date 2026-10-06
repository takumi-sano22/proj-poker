// Dealer Feedback（RULING / ETIQUETTE / COACHING）の文言と、COACHING が判断時点の Hero の情報だけを使うこと（Hindsight Leak）を確かめる。
import type { HandEvent, RulingCode } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import { dealerFeedbackAt, potBefore } from "./dealer-feedback.js";
import { VOCABULARY } from "./vocabulary.js";

const pub = { type: "public" } as const;
const base = preflopHeroToAct().log;

function action(
  playerId: string,
  a: Extract<HandEvent, { type: "ACTION_TAKEN" }>["action"],
  amount: number,
  toAmount: number,
  street: Extract<HandEvent, { type: "ACTION_TAKEN" }>["street"] = "preflop",
): HandEvent {
  return {
    seq: 0,
    visibility: pub,
    type: "ACTION_TAKEN",
    playerId,
    street,
    action: a,
    amount,
    toAmount,
    allIn: false,
  };
}

function ruling(
  outcome: "action" | "out_of_turn" | "no_action",
  notes: RulingCode[],
  extra: Partial<Extract<HandEvent, { type: "DEALER_RULING" }>> = {},
): HandEvent {
  return {
    seq: 0,
    visibility: pub,
    type: "DEALER_RULING",
    playerId: "hero",
    street: "preflop",
    basis: "operations",
    outcome,
    action: null,
    notes,
    ...extra,
  };
}

function chip(
  chips: number[],
  motion: "chip_push" | "chip_add" = "chip_push",
): HandEvent {
  return {
    seq: 0,
    visibility: pub,
    type: "PHYSICAL_CHIP_ACTION",
    playerId: "hero",
    street: "preflop",
    motion,
    chips,
  };
}

/** seq を並び順で振り直す（Event Log の順＝ seq）。 */
function seqd(events: HandEvent[]): HandEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

/** 相手の Raise 100 に、宣言なしで 500 の Chip を 1 枚出して Call 100 と裁定された Hand（docs/06 §6 の例）。 */
function oversizedLog(): HandEvent[] {
  return seqd([
    ...base,
    action("cpu1", "raise", 100, 100),
    chip([500]),
    ruling("action", ["oversized_chip"], { action: { type: "call" } }),
    action("hero", "call", 100, 100),
  ]);
}

const rulingIndex = (log: readonly HandEvent[]) =>
  log.findLastIndex((e) => e.type === "DEALER_RULING");

describe("dealerFeedbackAt（3 分類を別の項目にする）", () => {
  it("Oversized Chip: RULING は裁定の事実と結果、ETIQUETTE は作法、COACHING は Pot Odds を、分類ごとに分けて出す", () => {
    const log = oversizedLog();
    const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
    expect(items.map((i) => i.category)).toEqual([
      "ruling",
      "etiquette",
      "coaching",
    ]);
    const [r, e, c] = items;
    expect(r?.text).toBe(
      "相手の Bet に対し、宣言なしで Call 額を超える Chip（500）を 1 枚出しました。この Rule Profile では コール（Call） 100 として扱います。",
    );
    expect(r?.terms).toEqual(["oversizedChip"]);
    expect(e?.text).toContain("先に「Raise」と宣言しましょう");
    // Pot は Blind 3 + Raise 100 = 103。100 ÷（103 + 100）≒ 49%
    expect(c?.text).toContain("このときの Pot は 103、Call 額は 100");
    expect(c?.text).toContain("≒ 49%");
    expect(c?.terms).toEqual(["potOdds"]);
    // 分類をまたいで文言を混ぜない（裁定に作法・学習の文を入れない）
    expect(r?.text).not.toContain("しましょう");
    expect(r?.text).not.toContain("Pot Odds");
    expect(e?.text).not.toContain("Pot Odds");
    expect(c?.text).not.toContain("しましょう");
  });

  it("理由の無い裁定は結果だけを述べ、Rule Profile の扱いとは書かない", () => {
    const log = seqd([
      ...base,
      {
        seq: 0,
        visibility: pub,
        type: "PLAYER_DECLARED",
        playerId: "hero",
        street: "preflop",
        declaration: { kind: "call" },
      },
      ruling("action", [], { action: { type: "call" } }),
      action("hero", "call", 2, 2),
    ]);
    const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
    expect(items.map((i) => i.category)).toEqual(["ruling", "coaching"]);
    expect(items[0]?.text).toBe("コール（Call） 2 として扱います。");
    // Pot 3 に 2 を Call: 2 ÷ 5 = 40%
    expect(items[1]?.text).toContain("≒ 40%");
  });

  it("手番でない操作の保留は RULING と ETIQUETTE だけ（Action が決まっていないので COACHING は無い）", () => {
    const log = seqd([
      ...base,
      chip([5]),
      ruling("out_of_turn", ["out_of_turn"]),
    ]);
    const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
    expect(items.map((i) => i.category)).toEqual(["ruling", "etiquette"]);
    expect(items[0]?.text).toBe(
      "手番ではない操作です。操作を保留し、Hero の手番が来たら裁定します。",
    );
    expect(items[1]?.terms).toContain("outOfTurn");
  });

  it("保留した操作の拘束は、保留したときの操作を材料にして裁定の結果を述べる", () => {
    const log = seqd([
      ...base,
      chip([500]),
      ruling("out_of_turn", ["out_of_turn"]),
      action("cpu4", "fold", 0, 1),
      action("cpu5", "raise", 98, 100),
      ruling("action", ["out_of_turn_binding", "oversized_chip"], {
        basis: "pending_out_of_turn",
        action: { type: "call" },
      }),
      action("hero", "call", 100, 100),
    ]);
    const [r] = dealerFeedbackAt(log, rulingIndex(log), "hero");
    expect(r?.text).toContain("状況が変わらなかったので有効にします");
    expect(r?.text).toContain("Chip（500）を 1 枚");
    expect(r?.text).toContain("コール（Call） 100 として扱います");
  });

  it("決まらなかった裁定は、もう一度操作するよう述べる", () => {
    const log = seqd([
      ...base,
      {
        seq: 0,
        visibility: pub,
        type: "PLAYER_DECLARED",
        playerId: "hero",
        street: "preflop",
        declaration: { kind: "check" },
      },
      ruling("no_action", ["check_facing_bet"]),
    ]);
    const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
    expect(items[0]).toEqual({
      category: "ruling",
      text: "相手の Bet があるので、Check の宣言は受けられません。Action は決まっていません。もう一度操作してください。",
      terms: ["check"],
    });
    expect(items.map((i) => i.category)).toEqual(["ruling", "etiquette"]);
  });

  it("Bet の COACHING は Pot に対する大きさと、相手に求める勝率の目安を出す", () => {
    const log = seqd([
      ...base,
      action("hero", "call", 2, 2),
      action("cpu5", "check", 0, 2),
      chip([5]),
      ruling("action", [], {
        street: "flop",
        action: { type: "bet", amount: 5 },
      }),
      action("hero", "bet", 5, 5, "flop"),
    ]);
    const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
    // Pot 5 に 5 の Bet（Pot の 100%）。相手は 5 ÷（5 + 5 + 5）≒ 33%
    expect(items.at(-1)?.text).toContain(
      "Pot 5 に対して 5 の Bet（Pot の約 100%）",
    );
    expect(items.at(-1)?.text).toContain("約 33%");
  });

  it("Hero 以外への裁定・裁定でない位置は空", () => {
    const log = oversizedLog();
    expect(dealerFeedbackAt(log, 0, "hero")).toEqual([]);
    expect(dealerFeedbackAt(log, rulingIndex(log), "cpu1")).toEqual([]);
  });

  it("どの理由にも文言があり、添える用語は辞書にある", () => {
    const codes: RulingCode[] = [
      "declaration_ignored",
      "declaration_adjusted",
      "check_facing_bet",
      "oversized_chip",
      "string_bet",
      "every_chip_needed",
      "half_raise_completed",
      "under_half_raise",
      "under_call",
      "under_min_bet",
      "raise_not_allowed",
      "out_of_turn",
      "out_of_turn_binding",
      "out_of_turn_released",
    ];
    for (const code of codes) {
      const log = seqd([...base, chip([5]), ruling("no_action", [code])]);
      const items = dealerFeedbackAt(log, rulingIndex(log), "hero");
      expect(items[0]?.text.length).toBeGreaterThan(30);
      for (const item of items) {
        for (const t of item.terms) expect(VOCABULARY[t]).toBeDefined();
      }
    }
  });
});

describe("COACHING は判断時点の Hero の情報だけを使う（Hindsight Leak を防ぐ）", () => {
  it("裁定より後の Event（未来の Card・他者の札の公開・Hand の終了）を足しても文言は変わらない", () => {
    const log = oversizedLog();
    const index = rulingIndex(log);
    const before = dealerFeedbackAt(log, index, "hero");
    const later = seqd([
      ...log,
      action("cpu1", "call", 0, 100),
      {
        seq: 0,
        visibility: pub,
        type: "BOARD_DEALT",
        street: "flop",
        cards: [
          { rank: 2, suit: "c" },
          { rank: 7, suit: "d" },
          { rank: 9, suit: "h" },
        ],
      },
      {
        seq: 0,
        visibility: pub,
        type: "CARDS_TABLED",
        playerId: "cpu1",
        cards: [
          { rank: 12, suit: "c" },
          { rank: 12, suit: "d" },
        ],
      },
      {
        seq: 0,
        visibility: pub,
        type: "POT_AWARDED",
        potIndex: 0,
        potTotal: 203,
        eligible: ["hero", "cpu1"],
        awards: [{ playerId: "cpu1", amount: 203 }],
        showdown: true,
      },
    ]);
    expect(dealerFeedbackAt(later, index, "hero")).toEqual(before);
  });

  it("他者の Hidden Cards・Deck・system Event が log に紛れても、公開 Event だけを読む", () => {
    const log = oversizedLog();
    const index = rulingIndex(log);
    const expected = dealerFeedbackAt(log, index, "hero");
    // Hero の View には入らない種別をわざと判断より前に混ぜる（受け側でも whitelist で読む）
    const leaked = seqd([
      ...log.slice(0, 4),
      {
        seq: 0,
        visibility: { type: "private", playerId: "cpu1" },
        type: "HOLE_CARD_DEALT",
        playerId: "cpu1",
        cards: [
          { rank: 12, suit: "c" },
          { rank: 12, suit: "d" },
        ],
      },
      {
        seq: 0,
        visibility: { type: "engine" },
        type: "DECK_SHUFFLED",
        seed: 1,
        deck: [{ rank: 2, suit: "c" }],
      },
      {
        seq: 0,
        visibility: { type: "system" },
        type: "AI_FALLBACK_USED",
        playerId: "cpu1",
        fallbackKind: "automatic",
        reason: "SECRET_REASON",
      },
      // 公開でない Chip の動き（ありえないが、Pot の計算が公開 Event だけを読むことを確かめる）
      { ...action("cpu2", "raise", 999, 999), visibility: { type: "system" } },
      ...log.slice(4),
    ]);
    const items = dealerFeedbackAt(leaked, rulingIndex(leaked), "hero");
    expect(items).toEqual(expected);
    const text = items.map((i) => i.text).join("\n");
    expect(text).not.toContain("SECRET_REASON");
    expect(text).not.toContain("Q");
    expect(text).not.toContain("999");
  });

  it("potBefore は Blind と Action の額を足し、戻った Bet を引く（公開 Event だけ）", () => {
    const log = seqd([
      ...base,
      action("cpu1", "raise", 10, 10),
      {
        seq: 0,
        visibility: pub,
        type: "UNCALLED_BET_RETURNED",
        playerId: "cpu1",
        amount: 8,
      },
    ]);
    expect(potBefore(log)).toBe(1 + 2 + 10 - 8);
  });
});
