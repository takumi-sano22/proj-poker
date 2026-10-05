import type { HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import {
  blindsOf,
  describeEvent,
  lastSeqOf,
  parseHeroView,
  seatDirections,
  selectLatestView,
  sizingPresets,
} from "./view-model.js";

describe("selectLatestView（REST と SSE のどちらが先に届いても新しい View を残す）", () => {
  const older = preflopHeroToAct();
  const newer = preflopHeroToAct({
    log: [
      ...older.log,
      {
        seq: 5,
        visibility: { type: "public" },
        type: "ACTION_TAKEN",
        playerId: "hero",
        street: "preflop",
        action: "fold",
        amount: 0,
        toAmount: 0,
        allIn: false,
      },
    ],
  });

  it("seq が進んだ View を採り、遅れて届いた古い View では巻き戻さない", () => {
    expect(lastSeqOf(newer)).toBe(5);
    expect(selectLatestView(older, newer, "h1")).toBe(newer);
    expect(selectLatestView(newer, older, "h1")).toBe(newer);
  });

  it("別の Hand の View（前の Hand の遅れた応答）は捨てる", () => {
    const other = preflopHeroToAct({ handId: "h0" });
    expect(selectLatestView(older, other, "h1")).toBe(older);
    expect(selectLatestView(null, other, "h1")).toBeNull();
  });

  it("新しい Hand に切り替わった直後は、その Hand の View を採る", () => {
    const prev = preflopHeroToAct({ handId: "h0" });
    expect(selectLatestView(prev, older, "h1")).toBe(older);
  });
});

describe("parseHeroView（SSE の data の受け側 whitelist）", () => {
  it("HeroView の形なら通す", () => {
    const view = preflopHeroToAct();
    expect(parseHeroView(JSON.stringify(view))).toEqual(view);
  });

  it("JSON でない・形が違う data は null にする", () => {
    expect(parseHeroView("not json")).toBeNull();
    expect(parseHeroView("null")).toBeNull();
    expect(parseHeroView(JSON.stringify({ handId: "h1" }))).toBeNull();
    expect(
      parseHeroView(JSON.stringify({ ...preflopHeroToAct(), status: "x" })),
    ).toBeNull();
  });
});

describe("blindsOf", () => {
  it("公開 Event の BLIND_POSTED から SB / BB を読む", () => {
    const blinds = blindsOf(preflopHeroToAct());
    expect(blinds.get("cpu4")).toBe("small");
    expect(blinds.get("cpu5")).toBe("big");
    expect(blinds.has("hero")).toBe(false);
  });
});

describe("seatDirections", () => {
  it("Hero を画面下の中央に置き、席順の次の席は左側（時計回り）に来る", () => {
    const dirs = seatDirections(6, 2);
    expect(dirs[2]).toEqual({ x: 0, y: 1 });
    expect(dirs[3]?.x).toBeLessThan(0);
    expect(dirs[1]?.x).toBeGreaterThan(0);
    // 真上は Hero の向かい
    expect(dirs[5]).toEqual({ x: 0, y: -1 });
  });
});

describe("sizingPresets（Bet / Raise の Preset。to 額）", () => {
  it("Pot 比は Call 後の Pot に対する Raise 幅で出す", () => {
    const view = preflopHeroToAct();
    const presets = sizingPresets(view, 2, { type: "raise", min: 4, max: 200 });
    // Pot 3 + Call 2 = 5。½ → 2 + 3（2.5 を丸め）、¾ → 2 + 4、Pot → 2 + 5
    expect(presets.map((p) => [p.key, p.amount])).toEqual([
      ["min", 4],
      ["half", 5],
      ["three-quarters", 6],
      ["pot", 7],
    ]);
  });

  it("サーバーが返した min / max の範囲に丸める", () => {
    const view = preflopHeroToAct({ pot: 400, currentBet: 0 });
    const presets = sizingPresets(view, 0, { type: "bet", min: 2, max: 150 });
    expect(presets.map((p) => p.amount)).toEqual([2, 150, 150, 150]);
  });
});

describe("describeEvent", () => {
  const nameOf = (id: string) => (id === "cpu1" ? "CPU 1" : id);
  const action = (
    a: Partial<Extract<HandEvent, { type: "ACTION_TAKEN" }>>,
  ): HandEvent => ({
    seq: 9,
    visibility: { type: "public" },
    type: "ACTION_TAKEN",
    playerId: "cpu1",
    street: "flop",
    action: "fold",
    amount: 0,
    toAmount: 0,
    allIn: false,
    ...a,
  });

  it("Action は日本語 + 標準 Term と実額で書く", () => {
    expect(describeEvent(action({ action: "call", amount: 6 }), nameOf)).toBe(
      "CPU 1: コール（Call） 6",
    );
    expect(
      describeEvent(
        action({ action: "raise", amount: 12, toAmount: 12 }),
        nameOf,
      ),
    ).toBe("CPU 1: レイズ（Raise） 12 まで");
    expect(
      describeEvent(
        action({ action: "call", amount: 40, toAmount: 40, allIn: true }),
        nameOf,
      ),
    ).toBe("CPU 1: コール（Call） 40（All-in）");
  });

  it("Showdown で公開された札と獲得額を書く", () => {
    expect(
      describeEvent(
        {
          seq: 20,
          visibility: { type: "public" },
          type: "CARDS_TABLED",
          playerId: "cpu1",
          cards: [
            { rank: 14, suit: "s" },
            { rank: 10, suit: "d" },
          ],
        },
        nameOf,
      ),
    ).toBe("ショーダウン（Showdown） CPU 1: A♠ 10♦");
    expect(
      describeEvent(
        {
          seq: 21,
          visibility: { type: "public" },
          type: "POT_AWARDED",
          potIndex: 0,
          potTotal: 37,
          eligible: ["hero", "cpu1"],
          showdown: true,
          awards: [{ playerId: "cpu1", amount: 37 }],
        },
        nameOf,
      ),
    ).toBe("CPU 1 がポット（Pot） 37 を獲得");
  });
});
