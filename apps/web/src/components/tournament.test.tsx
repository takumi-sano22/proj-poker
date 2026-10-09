// Tournament の UI（#190・docs/06 §15・D49・D128〜D130）の静的な描画と表示の規則。DOM 環境を足さず、react-dom/server の文字列で見る。
// - 新しい Session の選択肢は Cash（既定）と標準 Preset（hand-count・time-base）で、値と送る設定が往復する
// - Tournament の欄: Level・Blind・Ante・次の Level までの残り・残人数を出し、続いている間は Bust した Player だけ、終わったら
//   Hero の順位と Payout・確定した順位と「未決」を出す。Payout は pt で Chip（実額）と書き分ける
// - Review の Tournament の根拠: ICM Equity と、Chip EV / ICM の必要 Equity を別の列で出し、Shove は条件付きの前提を出す
import type { HeroView, TournamentResult } from "@proj-poker/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TournamentTableStatus } from "../lib/api.js";
import { IMPORTANT_SPOT_REASON_LABELS } from "../lib/review.js";
import type { TournamentEvidence } from "../lib/review-api.js";
import {
  SESSION_CHOICES,
  handLevelOf,
  orderedPlacements,
  payoutText,
  placeText,
  sessionChoiceOf,
  sessionChoiceValue,
  tournamentEndMessage,
  untilNextLevelText,
} from "../lib/tournament.js";
import { preflopHeroToAct } from "../testing/fixtures.js";
import { TournamentEvidenceView } from "./ReviewEvidence.js";
import { SessionModePicker, TournamentPanel } from "./TournamentPanel.js";

const nameOf = (id: string) => id.toUpperCase();

function result(overrides: Partial<TournamentResult> = {}): TournamentResult {
  return {
    status: "in_progress",
    entrants: 6,
    remaining: 6,
    entryFee: 100,
    prizePool: 600,
    payoutPolicyVersion: "phase8_provisional_v1",
    payoutsByPlace: [300, 180, 120],
    placements: ["hero", "cpu1", "cpu2", "cpu3", "cpu4", "cpu5"].map(
      (playerId) => ({
        playerId,
        place: null,
        eliminatedInHandId: null,
        payout: null,
      }),
    ),
    ...overrides,
  };
}

function status(
  overrides: Partial<TournamentTableStatus> = {},
): TournamentTableStatus {
  return {
    handId: "h1",
    presetId: "stt6_hand_count",
    schedule: { kind: "hand_count", handsPerLevel: 10 },
    level: 1,
    levelCount: 12,
    handNumber: 3,
    smallBlind: 10,
    bigBlind: 20,
    anteKind: "big_blind_ante",
    ante: 20,
    nextLevel: {
      level: 2,
      smallBlind: 15,
      bigBlind: 30,
      ante: 30,
      until: { kind: "hand_count", handNumber: 11 },
    },
    result: result(),
    ...overrides,
  };
}

/** Hero の Bust（Heads-Up）で終えた Result: Hero 2 位・CPU1 は未決・ほかは 3〜6 位。 */
const HERO_BUSTED = result({
  status: "finished",
  remaining: 1,
  placements: [
    { playerId: "hero", place: 2, eliminatedInHandId: "h9", payout: 180 },
    { playerId: "cpu1", place: null, eliminatedInHandId: null, payout: null },
    { playerId: "cpu2", place: 3, eliminatedInHandId: "h7", payout: 120 },
    { playerId: "cpu3", place: 4, eliminatedInHandId: "h5", payout: 0 },
    { playerId: "cpu4", place: 5, eliminatedInHandId: "h2", payout: 0 },
    { playerId: "cpu5", place: 5, eliminatedInHandId: "h2", payout: 0 },
  ],
});

describe("新しい Session の選択肢（D128）", () => {
  it("Cash を既定（先頭）に、標準 Preset の hand-count・time-base を並べ、値と設定が往復する", () => {
    expect(SESSION_CHOICES.map((c) => c.value)).toEqual([
      "cash",
      "stt6_hand_count",
      "stt6_time_base",
    ]);
    for (const c of SESSION_CHOICES) {
      expect(sessionChoiceOf(c.value)).toEqual(c.request);
      expect(sessionChoiceValue(c.request)).toBe(c.value);
    }
    expect(sessionChoiceOf("unknown")).toEqual({ mode: "cash" });
    expect(SESSION_CHOICES[1]?.label).toBe("Tournament（10 Hand ごと）");
    expect(SESSION_CHOICES[2]?.label).toBe("Tournament（10 分ごと）");
  });

  it("選択の部品は今の設定を選び、compact では見出しの文字を出さず名前を aria-label で付ける", () => {
    const html = renderToStaticMarkup(
      <SessionModePicker
        value={{ mode: "tournament", presetId: "stt6_time_base" }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("新しい Session の種類");
    expect(html).toMatch(/<option value="stt6_time_base" selected="">/);
    const compact = renderToStaticMarkup(
      <SessionModePicker
        value={{ mode: "cash" }}
        onChange={() => {}}
        compact
      />,
    );
    expect(compact).not.toContain("session-pick__label");
    expect(compact).toContain('aria-label="新しい Session の種類"');
  });
});

describe("Tournament の表示の規則", () => {
  it("見出しの Level と Ante は HeroView の公開の HAND_STARTED から読み、Cash の Hand は null", () => {
    const cash = preflopHeroToAct();
    expect(handLevelOf(cash)).toBeNull();
    const [started, ...rest] = cash.log;
    if (started?.type !== "HAND_STARTED")
      throw new Error("HAND_STARTED が無い");
    const tournament: HeroView = {
      ...cash,
      log: [
        {
          ...started,
          ante: { kind: "big_blind_ante", amount: 20 },
          tournament: { level: 2, handNumber: 12, playTimeMs: 0 },
        },
        ...rest,
      ],
    };
    expect(handLevelOf(tournament)).toEqual({ level: 2, ante: "BB Ante 20" });
  });

  it("次の Level までの残り: hand-count は始まる Hand の番号、time-base は分（過ぎていれば次の Hand から）、最後の Level は null", () => {
    expect(untilNextLevelText(status())).toBe("11 Hand 目から（今 3 Hand 目）");
    const timeBase = (remainingPlayMs: number) =>
      status({
        presetId: "stt6_time_base",
        schedule: { kind: "time_base", levelDurationMs: 600_000 },
        nextLevel: {
          level: 2,
          smallBlind: 15,
          bigBlind: 30,
          ante: 30,
          until: { kind: "time_base", remainingPlayMs },
        },
      });
    expect(untilNextLevelText(timeBase(6 * 60_000 + 1))).toBe(
      "プレイ時間であと約 7 分",
    );
    expect(untilNextLevelText(timeBase(20_000))).toBe(
      "プレイ時間であと約 1 分",
    );
    expect(untilNextLevelText(timeBase(0))).toBe("次の Hand から");
    expect(untilNextLevelText(status({ nextLevel: null }))).toBeNull();
  });

  it("順位は未決を先に、決まった順位を上から並べ、未決は「未決」・Payout は「未確定」と書く", () => {
    expect(orderedPlacements(HERO_BUSTED).map((p) => p.playerId)).toEqual([
      "cpu1",
      "hero",
      "cpu2",
      "cpu3",
      "cpu4",
      "cpu5",
    ]);
    expect(placeText(null)).toBe("未決");
    expect(payoutText(null)).toBe("未確定");
    expect(payoutText(1200)).toBe("1,200pt");
  });

  it("終わった Tournament の案内は Hero の順位と Payout、優勝、打ち切りを書き分け、続いている間は null", () => {
    expect(tournamentEndMessage(HERO_BUSTED, "hero")).toBe(
      "Hero は 2 位で Tournament を終えました（Payout 180pt）。",
    );
    const won = result({
      status: "finished",
      remaining: 1,
      placements: [
        { playerId: "hero", place: 1, eliminatedInHandId: null, payout: 300 },
      ],
    });
    expect(tournamentEndMessage(won, "hero")).toContain("Hero が優勝しました");
    expect(
      tournamentEndMessage(result({ status: "abandoned" }), "hero"),
    ).toContain("打ち切りました");
    expect(tournamentEndMessage(result(), "hero")).toBeNull();
  });

  it("Important Spot の Tournament の理由に表記がある", () => {
    expect(IMPORTANT_SPOT_REASON_LABELS.bubble).toContain("Bubble");
    expect(IMPORTANT_SPOT_REASON_LABELS.pay_jump).toContain("Pay Jump");
    expect(IMPORTANT_SPOT_REASON_LABELS.short_stack).toBe(
      "Short Stack（10 BB 以下）",
    );
  });
});

describe("TournamentPanel（卓の Tournament の欄）", () => {
  it("続いている間: Level・Blind・Ante・次の Level・残人数・Prize Pool と Payout を出し、Bust した Player だけを並べる", () => {
    const html = renderToStaticMarkup(
      <TournamentPanel
        status={status({
          result: result({
            remaining: 5,
            placements: [
              ...result().placements.slice(0, 5),
              {
                playerId: "cpu5",
                place: 6,
                eliminatedInHandId: "h2",
                payout: 0,
              },
            ],
          }),
        })}
        heroId="hero"
        nameOf={nameOf}
      />,
    );
    expect(html).toContain('data-tournament-status="in_progress"');
    expect(html).toContain("Level 1");
    expect(html).toContain("10 / 20 · BB Ante 20");
    expect(html).toContain("15 / 30 · BB Ante 30");
    expect(html).toContain("11 Hand 目から（今 3 Hand 目）");
    expect(html).toContain("5 / 6 人");
    expect(html).toContain("Prize Pool 600pt");
    expect(html).toContain("1 位 300pt・2 位 180pt・3 位 120pt");
    // 続いている間は Bust した Player だけ（未決の行は出さない）。Payout の欄は畳んでおく。
    expect(html).toContain('data-place="6"');
    expect(html).not.toContain('data-place="undecided"');
    expect(html).toMatch(/<details class="tournament__more">/);
    // Payout は pt で、Chip と別の量だと書く。
    expect(html).toContain("Chip とは別の量です");
  });

  it("Hero の Bust で終わったら Result を開いて出し、Hero の順位と Payout・確定した順位・残った CPU の「未決」を出す（D129）", () => {
    const html = renderToStaticMarkup(
      <TournamentPanel
        status={status({ result: HERO_BUSTED })}
        heroId="hero"
        nameOf={nameOf}
      />,
    );
    expect(html).toContain("Tournament の結果（Result）");
    expect(html).toMatch(/<details class="tournament__more" open="">/);
    expect(html).toMatch(
      /tournament__place tournament__place--hero" data-place="2">.*2 位.*HERO.*180pt/,
    );
    expect(html).toMatch(/data-place="undecided">.*未決.*CPU1.*未確定/);
    expect(html).toContain("残った CPU の順位は決めていません（未決）");
  });

  it("打ち切った Tournament は、残っていた Player の順位が決まらないことを書く", () => {
    const html = renderToStaticMarkup(
      <TournamentPanel
        status={status({ result: result({ status: "abandoned" }) })}
        heroId="hero"
        nameOf={nameOf}
      />,
    );
    expect(html).toContain("Tournament の結果（打ち切り）");
    expect(html).toContain(
      "残っていた Player の順位と Payout は決まっていません",
    );
  });
});

function evidence(allIn: TournamentEvidence["allIn"]): TournamentEvidence {
  return {
    id: "tournament:h/d0",
    entrants: 6,
    remaining: 4,
    level: 5,
    handNumber: 41,
    anteKind: "big_blind_ante",
    ante: 150,
    prizePool: 600,
    payoutsByPlace: [300, 180, 120],
    stage: "bubble",
    icm: {
      id: "icm:h/d0",
      icmPolicyVersion: "phase8_icm_provisional_v1",
      method: "malmuth_harville",
      seats: [
        {
          playerId: "hero",
          isHero: true,
          icmStack: 1500,
          stackBb: 10,
          icmEquity: 98.2,
          icmEquityPercent: 16.4,
        },
        {
          playerId: "cpu1",
          isHero: false,
          icmStack: 3000,
          stackBb: 20,
          icmEquity: 175.3,
          icmEquityPercent: 29.2,
        },
      ],
    },
    allIn,
  };
}

const SHOVE: TournamentEvidence["allIn"] = {
  status: "available",
  decision: "shove",
  assumptions: {
    potWinnerIfHeroFolds: "cpu2",
    notes: [
      "Shove: 相手ごとに「その 1 人に Call され、ほかは Fold した場合」の条件付きの値。",
    ],
  },
  requirements: [
    {
      villainId: "cpu1",
      chipEv: {
        id: "chipev:h/d0/cpu1",
        requiredEquityPercent: 41.3,
        heroStack: { fold: 1300, win: 3150, lose: 0 },
      },
      icm: {
        id: "icmreq:h/d0/cpu1",
        requiredEquityPercent: 52.6,
        heroIcmEquity: { fold: 90, win: 170, lose: 0 },
      },
    },
  ],
};

describe("TournamentEvidenceView（Review の Tournament の根拠。D130）", () => {
  it("ICM Equity は pt と % で、Stack は実額（BB は補助）で出す", () => {
    const html = renderToStaticMarkup(
      <TournamentEvidenceView
        tournament={evidence(null)}
        bigBlind={150}
        nameOf={nameOf}
        cited={["icm:h/d0"]}
      />,
    );
    expect(html).toContain("Bubble（あと 1 人の脱落で入賞）");
    expect(html).toContain("4 / 6 人");
    expect(html).toContain("98.2pt（16.4%）");
    expect(html).toContain('amount__real">1,500<');
    expect(html).toContain("10 BB");
    expect(html).toContain("説明の根拠");
    // All-in の関わらない判断には必要 Equity の表を出さない。
    expect(html).not.toContain('data-evidence="all-in"');
  });

  it("Shove: 相手ごとに条件付き（Call された場合）で、Chip EV と ICM の必要 Equity を別の列に出し、前提を出す", () => {
    const html = renderToStaticMarkup(
      <TournamentEvidenceView
        tournament={evidence(SHOVE)}
        bigBlind={150}
        nameOf={nameOf}
        cited={["icmreq:h/d0/cpu1"]}
      />,
    );
    expect(html).toContain("CPU1 に Call された場合");
    expect(html).toMatch(/data-requirement="chip-ev">41\.3%</);
    expect(html).toMatch(/data-requirement="icm">52\.6%/);
    expect(html).toContain("前提（Shove の値は条件付き）");
    expect(html).toContain("ほかは Fold した場合」の条件付きの値");
    expect(html).toContain("混同せずに見比べてください");
  });

  it("範囲外（Multiway の All-in 等）は理由を出し、必要 Equity の表を出さない", () => {
    const html = renderToStaticMarkup(
      <TournamentEvidenceView
        tournament={evidence({
          status: "out_of_scope",
          decision: "shove",
          reason: "ICM の必要 Equity を計算できる範囲の外",
        })}
        bigBlind={150}
        nameOf={nameOf}
        cited={[]}
      />,
    );
    expect(html).toContain('data-evidence="all-in-out-of-scope"');
    expect(html).not.toContain('data-evidence="all-in"');
  });
});
