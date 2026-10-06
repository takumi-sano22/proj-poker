import type { HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import {
  blindsOf,
  describeEvent,
  heroRulingStatus,
  latestHeroRulingIndex,
  lastSeqOf,
  operationKey,
  outageReasonText,
  parseHeroView,
  parseOutageStatus,
  parseSessionStatus,
  seatDirections,
  selectLatestView,
  selectOutageStatus,
  selectSessionStatus,
  waitingMessage,
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
    expect(
      parseSessionStatus(
        JSON.stringify({ state: "ended", reason: "ai_outage" }),
      ),
    ).toEqual({ state: "ended", reason: "ai_outage" });
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

describe("parseOutageStatus（SSE の outage イベントの受け側 whitelist。#52）", () => {
  it("revision と、どの CPU の手番か・種類だけで組み直す（余分な項目は落とす）", () => {
    expect(
      parseOutageStatus(JSON.stringify({ revision: 0, current: null })),
    ).toEqual({ revision: 0, current: null });
    expect(
      parseOutageStatus(
        JSON.stringify({
          revision: 3,
          current: { playerId: "cpu2", kind: "usage_limit", message: "x" },
          extra: true,
        }),
      ),
    ).toEqual({
      revision: 3,
      current: { playerId: "cpu2", kind: "usage_limit" },
    });
  });

  it("JSON でない・revision が無い・知らない種類は null にする", () => {
    expect(parseOutageStatus("not json")).toBeNull();
    expect(parseOutageStatus("null")).toBeNull();
    expect(parseOutageStatus(JSON.stringify({ current: null }))).toBeNull();
    expect(
      parseOutageStatus(JSON.stringify({ revision: 1.5, current: null })),
    ).toBeNull();
    expect(
      parseOutageStatus(
        JSON.stringify({
          revision: 1,
          current: { playerId: "cpu1", kind: "x" },
        }),
      ),
    ).toBeNull();
    expect(
      parseOutageStatus(JSON.stringify({ revision: 1, current: "cpu1" })),
    ).toBeNull();
    expect(parseOutageStatus(JSON.stringify({ revision: 1 }))).toBeNull();
  });
});

describe("selectOutageStatus（REST と SSE のどちらが先に届いても新しい障害の状態を残す）", () => {
  const down = {
    handId: "h1",
    status: {
      revision: 1,
      current: { playerId: "cpu1", kind: "error" as const },
    },
  };
  const cleared = { handId: "h1", status: { revision: 2, current: null } };

  it("revision が進んだ状態を採り、遅れて届いた古い状態では戻さない", () => {
    expect(selectOutageStatus(down, cleared, "h1")).toBe(cleared);
    expect(selectOutageStatus(cleared, down, "h1")).toBe(cleared);
  });

  it("別の Hand の状態は捨て、新しい Hand に切り替わったらその Hand の状態を採る", () => {
    const other = { handId: "h2", status: { revision: 0, current: null } };
    expect(selectOutageStatus(down, other, "h1")).toBe(down);
    expect(selectOutageStatus(down, other, "h2")).toBe(other);
    expect(selectOutageStatus(null, down, "h1")).toBe(down);
  });
});

describe("待ちの案内と障害の説明（docs/06 §11。内部実装を前面に出さない）", () => {
  it("通常は「<CPU 名> の手番…」、長く待つときだけ遅延を補足する", () => {
    expect(waitingMessage("CPU 1", false)).toBe("CPU 1 の手番…");
    expect(waitingMessage("CPU 1", true)).toBe(
      "CPU 1 の手番…（AI応答が遅延しています）",
    );
    expect(waitingMessage(null, false)).toBe("進行中…");
  });

  it("障害の説明に使っている API・モデルの名前を出さない", () => {
    for (const kind of [
      "timeout",
      "unauthenticated",
      "usage_limit",
      "error",
    ] as const) {
      const text = outageReasonText(kind);
      expect(text).not.toMatch(/Claude|API|SDK|haiku/i);
      expect(text.length).toBeGreaterThan(0);
    }
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

describe("heroRulingStatus / latestHeroRulingIndex / operationKey（Hero への裁定を卓に反映する）", () => {
  const pub = { type: "public" } as const;
  const base = preflopHeroToAct();
  const declared: HandEvent = {
    seq: 5,
    visibility: pub,
    type: "PHYSICAL_CHIP_ACTION",
    playerId: "hero",
    street: "preflop",
    motion: "chip_push",
    chips: [25],
  };
  const ruled = (
    outcome: "action" | "out_of_turn" | "no_action",
    seq = 6,
  ): Extract<HandEvent, { type: "DEALER_RULING" }> => ({
    seq,
    visibility: pub,
    type: "DEALER_RULING",
    playerId: "hero",
    street: "preflop",
    basis: "operations",
    outcome,
    action: outcome === "action" ? { type: "call" } : null,
    notes: outcome === "action" ? ["oversized_chip"] : ["out_of_turn"],
  });
  const called: HandEvent = {
    seq: 7,
    visibility: pub,
    type: "ACTION_TAKEN",
    playerId: "hero",
    street: "preflop",
    action: "call",
    amount: 2,
    toAmount: 2,
    allIn: false,
  };

  it("裁定が無ければ何も出さない", () => {
    expect(heroRulingStatus(base)).toBeNull();
  });

  it("Action に決まった裁定は、その結果の ACTION_TAKEN（実額）で出す", () => {
    const view = preflopHeroToAct({
      log: [...base.log, declared, ruled("action"), called],
      actorId: "cpu1",
      legalActions: null,
    });
    expect(heroRulingStatus(view)).toEqual({ kind: "action", action: called });
    expect(latestHeroRulingIndex(view)).toBe(base.log.length + 1);
  });

  it("手番でない操作の保留は、Street が進んでも解けるまで出す", () => {
    const view = preflopHeroToAct({
      street: "flop",
      log: [...base.log, declared, ruled("out_of_turn")],
    });
    expect(heroRulingStatus(view)).toEqual({ kind: "pending" });
    // 保留は Hero の手番が来ても、裁定されるまで出す
    expect(
      heroRulingStatus(
        preflopHeroToAct({
          street: "flop",
          log: [...base.log, declared, ruled("out_of_turn")],
        }),
      ),
    ).toEqual({ kind: "pending" });
  });

  it("Hero の Action で Street が進んでも、次の Street で Hero の手番が来るまでは直近の裁定を出し、Hand の終了後は出さない", () => {
    const log = [...base.log, declared, ruled("action"), called];
    // 次の Street で CPU の手番を待っている間は出す（Call で Street が閉じても裁定が見える）
    expect(
      heroRulingStatus(
        preflopHeroToAct({
          log,
          street: "flop",
          actorId: "cpu4",
          legalActions: null,
        }),
      ),
    ).toEqual({
      kind: "action",
      action: called,
    });
    // 次の Street で Hero の手番が来たら、前の Street の裁定は出さない（#65 の残課題）
    expect(
      heroRulingStatus(preflopHeroToAct({ log, street: "flop" })),
    ).toBeNull();
    expect(
      latestHeroRulingIndex(preflopHeroToAct({ log, street: "flop" })),
    ).toBeNull();
    // 同じ Street のうちは、Hero の手番が戻っても直近の裁定を出す
    expect(heroRulingStatus(preflopHeroToAct({ log }))).toEqual({
      kind: "action",
      action: called,
    });
    const noAction = [...base.log, declared, ruled("no_action")];
    expect(heroRulingStatus(preflopHeroToAct({ log: noAction }))).toEqual({
      kind: "no_action",
    });
    expect(
      heroRulingStatus(preflopHeroToAct({ log, status: "complete" })),
    ).toBeNull();
  });

  it("他の Player の裁定は Hero の裁定として扱わない", () => {
    const other: HandEvent = { ...ruled("out_of_turn"), playerId: "cpu1" };
    expect(
      heroRulingStatus(preflopHeroToAct({ log: [...base.log, other] })),
    ).toBeNull();
  });

  it("下書きの単位は Hero への裁定が増えるか Street が進むと変わり、CPU の行動だけでは変わらない", () => {
    const cpuActed: HandEvent = { ...called, seq: 5, playerId: "cpu1" };
    const before = operationKey(base);
    expect(
      operationKey(preflopHeroToAct({ log: [...base.log, cpuActed] })),
    ).toBe(before);
    expect(
      operationKey(
        preflopHeroToAct({
          log: [...base.log, declared, ruled("action"), called],
        }),
      ),
    ).not.toBe(before);
    expect(operationKey(preflopHeroToAct({ street: "flop" }))).not.toBe(before);
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
