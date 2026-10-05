import type { HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import {
  blindsOf,
  describeEvent,
  lastSeqOf,
  parseHeroView,
  parseSessionStatus,
  seatDirections,
  selectLatestView,
  selectSessionStatus,
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

describe("selectSessionStatus（Hand 終了後の Session の状態を残す）", () => {
  const inHand = { handId: "h1", status: { state: "in_hand" } } as const;
  const ready = {
    handId: "h1",
    status: { state: "ready_for_next_hand" },
  } as const;
  const ended = {
    handId: "h1",
    status: { state: "ended", reason: "hero_busted" },
  } as const;

  it("Hand 終了後の状態を採り、遅れて届いた in_hand では戻さない", () => {
    expect(selectSessionStatus(inHand, ended, "h1")).toBe(ended);
    expect(selectSessionStatus(ended, inHand, "h1")).toBe(ended);
    expect(selectSessionStatus(ready, inHand, "h1")).toBe(ready);
  });

  it("別の Hand の状態は捨て、新しい Hand に切り替わったらその Hand の状態を採る", () => {
    const other = { ...ended, handId: "h0" };
    expect(selectSessionStatus(inHand, other, "h1")).toBe(inHand);
    expect(selectSessionStatus(null, other, "h1")).toBeNull();
    expect(selectSessionStatus(other, inHand, "h1")).toBe(inHand);
  });
});

describe("parseSessionStatus（SSE の session イベントの受け側 whitelist）", () => {
  it("知っている状態と理由だけを通し、余分な項目は落とす", () => {
    expect(parseSessionStatus(JSON.stringify({ state: "in_hand" }))).toEqual({
      state: "in_hand",
    });
    expect(
      parseSessionStatus(
        JSON.stringify({ state: "ready_for_next_hand", extra: 1 }),
      ),
    ).toEqual({ state: "ready_for_next_hand" });
    expect(
      parseSessionStatus(
        JSON.stringify({ state: "ended", reason: "hero_last_standing" }),
      ),
    ).toEqual({ state: "ended", reason: "hero_last_standing" });
  });

  it("JSON でない・知らない状態・理由の無い終了は null にする", () => {
    expect(parseSessionStatus("not json")).toBeNull();
    expect(parseSessionStatus("null")).toBeNull();
    expect(parseSessionStatus(JSON.stringify({ state: "paused" }))).toBeNull();
    expect(parseSessionStatus(JSON.stringify({ state: "ended" }))).toBeNull();
    expect(
      parseSessionStatus(JSON.stringify({ state: "ended", reason: "x" })),
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

  it.each([2, 3, 4, 5, 6, 7, 8])(
    "%i 席: Hero がどの席でも真下に来て、全席が単位円上の別の位置に並ぶ",
    (n) => {
      for (let hero = 0; hero < n; hero++) {
        const dirs = seatDirections(n, hero);
        expect(dirs).toHaveLength(n);
        expect(dirs[hero]).toEqual({ x: 0, y: 1 });
        for (const d of dirs) expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 2);
        expect(new Set(dirs.map((d) => `${d.x},${d.y}`)).size).toBe(n);
      }
    },
  );

  it("2 人卓は相手が真上、8 人卓は Hero の次の席が左下・向かいが真上", () => {
    expect(seatDirections(2, 0)[1]).toEqual({ x: 0, y: -1 });
    const eight = seatDirections(8, 0);
    expect(eight[1]?.x).toBeLessThan(0);
    expect(eight[1]?.y).toBeGreaterThan(0);
    expect(eight[4]).toEqual({ x: 0, y: -1 });
    // 時計回り: 下 → 左 → 上 → 右 の順に x が減ってから増える
    expect(eight[2]?.x).toBe(-1);
    expect(eight[6]?.x).toBe(1);
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
