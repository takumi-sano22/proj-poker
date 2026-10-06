import type { HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import type { ReplayHandSummary } from "./api.js";
import {
  formatHeroNet,
  formatStartedAt,
  heroCardsLabel,
  nextStepIndex,
  playStartIndex,
  previousStepIndex,
  stepCaption,
} from "./replay.js";

const nameOf = (id: string) => (id === "hero" ? "Hero" : id.toUpperCase());
const pub = { type: "public" } as const;

/** 最後に event を足した step（Hero の視点）。 */
function stepEndingWith(event: HandEvent) {
  const base = preflopHeroToAct({ legalActions: null });
  return { ...base, log: [...base.log, event] };
}

describe("step の移動", () => {
  it("前後は端で止まり、Play は最後の step からなら最初に戻る", () => {
    expect(nextStepIndex(0, 3)).toBe(1);
    expect(nextStepIndex(2, 3)).toBe(2);
    expect(nextStepIndex(0, 0)).toBe(0);
    expect(previousStepIndex(1)).toBe(0);
    expect(previousStepIndex(0)).toBe(0);
    expect(playStartIndex(1, 3)).toBe(1);
    expect(playStartIndex(2, 3)).toBe(0);
  });
});

describe("stepCaption（その step で起きたこと）", () => {
  it("進行ログと同じ文言を使い、Hero の宣言・Chip の操作・裁定も 1 行にする", () => {
    expect(stepCaption(preflopHeroToAct(), nameOf)).toBe(
      "Hero に配られた札: A♠ K♥",
    );
    expect(
      stepCaption(
        stepEndingWith({
          seq: 5,
          visibility: pub,
          type: "PLAYER_DECLARED",
          playerId: "hero",
          street: "preflop",
          declaration: { kind: "raise", amount: 6 },
        }),
        nameOf,
      ),
    ).toBe("Hero: 宣言（Declaration）「レイズ（Raise） 6」");
    expect(
      stepCaption(
        stepEndingWith({
          seq: 5,
          visibility: pub,
          type: "PHYSICAL_CHIP_ACTION",
          playerId: "hero",
          street: "preflop",
          motion: "chip_add",
          chips: [5, 1],
        }),
        nameOf,
      ),
    ).toBe("Hero: Chip を足した（2 枚・合計 6）");
    expect(
      stepCaption(
        stepEndingWith({
          seq: 5,
          visibility: pub,
          type: "DEALER_RULING",
          playerId: "hero",
          street: "preflop",
          basis: "operations",
          outcome: "no_action",
          action: null,
          notes: ["check_facing_bet"],
        }),
        nameOf,
      ),
    ).toBe("Dealer が Hero の操作を裁定");
  });
});

describe("一覧の 1 行", () => {
  const summary: ReplayHandSummary = {
    handId: "h1",
    startedAt: "2026-10-06T08:25:00.000Z",
    finishedAt: "2026-10-06T08:26:00.000Z",
    complete: true,
    bigBlind: 2,
    heroHoleCards: [
      { rank: 14, suit: "s" },
      { rank: 13, suit: "h" },
    ],
    heroNet: 12,
  };

  it("収支は実額に符号を付け、BB は補助（OFF なら実額だけ）。未完了の Hand は null", () => {
    expect(formatHeroNet(summary, true)).toBe("+12（6 BB）");
    expect(formatHeroNet({ ...summary, heroNet: -3 }, false)).toBe("−3");
    expect(formatHeroNet({ ...summary, heroNet: 0 }, false)).toBe("±0");
    expect(formatHeroNet({ ...summary, heroNet: null }, true)).toBeNull();
  });

  it("Hero の札は短い表記、配られる前に打ち切った Hand は「札なし」", () => {
    expect(heroCardsLabel(summary)).toBe("A♠ K♥");
    expect(heroCardsLabel({ ...summary, heroHoleCards: null })).toBe("札なし");
  });

  it("開始時刻は 月/日 時:分 で、読めない値はそのまま返す", () => {
    expect(formatStartedAt(summary.startedAt)).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2}$/,
    );
    expect(formatStartedAt("not-a-date")).toBe("not-a-date");
  });
});
