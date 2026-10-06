// Poker Vocabulary の辞書（データ）の整合と、Current Hand Example が Hero に見える情報だけで作られることを確かめる。
import type { HandEvent, HeroView } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct, seat } from "../testing/fixtures.js";
import { VOCABULARY, VOCABULARY_ENTRIES, type VocabId } from "./vocabulary.js";

const nameOf = (id: string) => id.toUpperCase();
const pub = { type: "public" } as const;

function examples(view: HeroView): Record<string, string> {
  return Object.fromEntries(
    VOCABULARY_ENTRIES.map((e) => [e.id, e.example({ view, nameOf })]),
  );
}

describe("辞書のデータ", () => {
  it("どの用語も日本語・標準 Term・Definition・Related Concept・Advanced Detail を持ち、関連は辞書にある別の用語", () => {
    expect(VOCABULARY_ENTRIES.length).toBeGreaterThanOrEqual(20);
    for (const entry of VOCABULARY_ENTRIES) {
      expect(VOCABULARY[entry.id]).toBe(entry);
      expect(entry.ja).not.toBe("");
      expect(entry.term).not.toBe("");
      expect(entry.definition.length).toBeGreaterThan(10);
      expect(entry.advanced.length).toBeGreaterThan(10);
      expect(entry.related.length).toBeGreaterThan(0);
      for (const r of entry.related) {
        expect(VOCABULARY[r]).toBeDefined();
        expect(r).not.toBe(entry.id);
      }
    }
  });

  it("用語の id は重複しない", () => {
    const ids = VOCABULARY_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Current Hand Example（Hero に見える情報だけ）", () => {
  it("今の Hand の公開された値で例を作る（実額を正本に BB を添える）", () => {
    const view = preflopHeroToAct();
    const ex = examples(view);
    expect(ex["pot"]).toBe("今の Pot は 3（1.5 BB）。");
    expect(ex["stack"]).toBe("Hero の Stack は 200（100 BB）。");
    expect(ex["button"]).toBe("この Hand の Button は CPU3。");
    expect(ex["smallBlind"]).toBe("この Hand の SB は CPU4（1）。");
    expect(ex["bigBlind"]).toBe("この Hand の BB は CPU5（2）。");
    expect(ex["preflop"]).toBe("今は Preflop。Board はまだ配られていません。");
    expect(ex["effectiveStack"]).toBe(
      "今の Hero の有効スタックは 200（100 BB）。",
    );
  });

  it("他者の Hidden Cards・Deck・system Event が紛れても、例は変わらず、その中身を出さない", () => {
    const clean = preflopHeroToAct();
    const leakedEvents: HandEvent[] = [
      {
        seq: 90,
        visibility: { type: "private", playerId: "cpu1" },
        type: "HOLE_CARD_DEALT",
        playerId: "cpu1",
        cards: [
          { rank: 12, suit: "c" },
          { rank: 12, suit: "d" },
        ],
      },
      {
        seq: 91,
        visibility: { type: "engine" },
        type: "DECK_SHUFFLED",
        seed: 7,
        deck: [{ rank: 12, suit: "s" }],
      },
      {
        seq: 92,
        visibility: { type: "system" },
        type: "AI_ACTION_INVALID",
        playerId: "cpu1",
        attempt: 1,
        stage: "schema",
        reason: "SECRET_REASON",
      },
      {
        seq: 93,
        visibility: { type: "system" },
        type: "ACTION_TAKEN",
        playerId: "cpu1",
        street: "preflop",
        action: "raise",
        amount: 999,
        toAmount: 999,
        allIn: false,
      },
    ];
    const leaked = preflopHeroToAct({
      log: [...clean.log, ...leakedEvents],
      // seats の他者の札も、例には使わない（公開されていても読まない）
      seats: clean.seats.map((s) =>
        s.playerId === "cpu1"
          ? seat("cpu1", {
              holeCards: [
                { rank: 12, suit: "c" },
                { rank: 12, suit: "d" },
              ],
            })
          : s,
      ),
    });
    const ex = examples(leaked);
    expect(ex).toEqual(examples(clean));
    const text = Object.values(ex).join("\n");
    expect(text).not.toContain("Q");
    expect(text).not.toContain("SECRET_REASON");
    expect(text).not.toContain("999");
  });

  it("Pot Odds の例は手番中の計算を出さず（Hint の役割）、済んだ Hero の Call の判断時点の Pot から作る", () => {
    const facing = preflopHeroToAct();
    expect(facing.legalActions?.toCall).toBe(2);
    expect(VOCABULARY.potOdds.example({ view: facing, nameOf })).toContain(
      "まだ Call していません",
    );
    const called: HandEvent = {
      seq: 5,
      visibility: pub,
      type: "ACTION_TAKEN",
      playerId: "hero",
      street: "preflop",
      action: "call",
      amount: 2,
      toAmount: 2,
      allIn: false,
    };
    const after = preflopHeroToAct({
      log: [...facing.log, called],
      actorId: "cpu1",
      legalActions: null,
    });
    const text = VOCABULARY.potOdds.example({ view: after, nameOf });
    // 判断時点の Pot は 3（Call の後の 5 ではない）。2 ÷（3 + 2）= 40%
    expect(text).toBe(
      "Hero の直近の Call: Pot 3 に 2 を Call → 必要な勝率の目安は 40%。",
    );
    // 後から Pot が大きくなっても、判断時点の例は変わらない
    const later = preflopHeroToAct({
      log: [
        ...after.log,
        {
          ...called,
          seq: 6,
          playerId: "cpu1",
          action: "raise",
          amount: 50,
          toAmount: 50,
        },
      ],
      pot: 55,
    });
    expect(VOCABULARY.potOdds.example({ view: later, nameOf })).toBe(text);
  });

  it("Action の例は公開された直近の Action を実額で出す", () => {
    const view = preflopHeroToAct({
      log: [
        ...preflopHeroToAct().log,
        {
          seq: 5,
          visibility: pub,
          type: "ACTION_TAKEN",
          playerId: "cpu1",
          street: "preflop",
          action: "raise",
          amount: 6,
          toAmount: 6,
          allIn: false,
        },
      ],
    });
    const ex = examples(view);
    expect(ex["raise"]).toBe(
      "この Hand の直近の Raise: CPU1 の レイズ（Raise） 6 まで。",
    );
    expect(ex["check"]).toBe("この Hand ではまだ Check はありません。");
    const ids: VocabId[] = ["fold", "call", "bet", "allIn", "showdown"];
    for (const id of ids) expect(ex[id]).not.toBe("");
  });
});
