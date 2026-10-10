// UX-11（#226）の先行技術検証。ETIQUETTE の確認（Ack）が要る裁定を、server が決定論で判定できるかを確かめる。
// 製品のコードは変えない。ここで固定するのは「今の Dealer Feedback（dealer-feedback.ts）が ETIQUETTE を出すかどうかは、
// DEALER_RULING の notes（RulingCode）だけで決まり、outcome・basis・前後の Event に依らない」という事実で、
// server へ移す候補の述語（ETIQUETTE_ACK_CODES）と今の表示が食い違わないことを全 RulingCode で網羅する。
// 設計の比較と推奨は docs/taskLog/issue-226-etiquette-ack-design.md（人間の承認前の案であり、採用済みではない）。
import type { HandEvent, RulingCode, RulingOutcome } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct } from "../testing/fixtures.js";
import { dealerFeedbackAt } from "./dealer-feedback.js";

/** 全 RulingCode（RulingCode を増やしたら、ここが型で落ちて検証の見直しを促す）。 */
const ALL_CODES = {
  declaration_ignored: true,
  declaration_adjusted: true,
  check_facing_bet: true,
  oversized_chip: true,
  string_bet: true,
  every_chip_needed: true,
  half_raise_completed: true,
  under_half_raise: true,
  under_call: true,
  under_min_bet: true,
  raise_not_allowed: true,
  out_of_turn: true,
  out_of_turn_binding: true,
  out_of_turn_released: true,
} as const satisfies Record<RulingCode, true>;

/** 候補の述語: Ack が要る RulingCode（今の dealer-feedback.ts の ETIQUETTE の表のキーと同じ集合であるべきもの）。 */
const ETIQUETTE_ACK_CODES: ReadonlySet<RulingCode> = new Set<RulingCode>([
  "out_of_turn",
  "string_bet",
  "oversized_chip",
  "declaration_ignored",
  "half_raise_completed",
  "under_half_raise",
  "check_facing_bet",
]);

const requiresAck = (notes: readonly RulingCode[]): boolean =>
  notes.some((c) => ETIQUETTE_ACK_CODES.has(c));

const base = preflopHeroToAct().log;

function rulingLog(
  outcome: RulingOutcome,
  notes: RulingCode[],
  playerId = "hero",
): HandEvent[] {
  const ruling: HandEvent = {
    seq: base.length,
    visibility: { type: "public" },
    type: "DEALER_RULING",
    playerId,
    street: "preflop",
    basis: "operations",
    outcome,
    action: null,
    notes,
  };
  return [...base, ruling];
}

const etiquetteCount = (log: readonly HandEvent[], viewer = "hero") =>
  dealerFeedbackAt(log, log.length - 1, viewer).filter(
    (i) => i.category === "etiquette",
  ).length;

describe("UX-11 検証: ETIQUETTE の要否は DEALER_RULING の notes だけで決まる", () => {
  const codes = Object.keys(ALL_CODES) as RulingCode[];
  const outcomes: RulingOutcome[] = ["action", "out_of_turn", "no_action"];

  it.each(codes)(
    "%s: 単独の notes で ETIQUETTE を出すかが候補の述語と一致し、outcome に依らない",
    (code) => {
      for (const outcome of outcomes) {
        expect(etiquetteCount(rulingLog(outcome, [code])) > 0).toBe(
          requiresAck([code]),
        );
      }
    },
  );

  it("候補の集合は 7 種で、Ack の要らない理由（拘束・撤回・額の調整など）は含まない", () => {
    expect(ETIQUETTE_ACK_CODES.size).toBe(7);
    for (const code of [
      "out_of_turn_binding",
      "out_of_turn_released",
      "declaration_adjusted",
      "every_chip_needed",
      "under_call",
      "under_min_bet",
      "raise_not_allowed",
    ] as const) {
      expect(requiresAck([code])).toBe(false);
    }
  });

  it("複数の notes は 1 つの裁定に 1 回の確認でよい（同じ注意は 1 回にまとまり、文言の数は Ack の数にしない）", () => {
    // 拘束した Out-of-Turn の Oversized Chip（resolveOutOfTurn は notes の先頭に out_of_turn_binding を足す）。
    const log = rulingLog("action", ["out_of_turn_binding", "oversized_chip"]);
    expect(requiresAck(["out_of_turn_binding", "oversized_chip"])).toBe(true);
    expect(etiquetteCount(log)).toBe(1);
    // 同じ文言の half_raise_completed / under_half_raise は 1 項目にまとまる。
    expect(
      etiquetteCount(
        rulingLog("action", ["half_raise_completed", "under_half_raise"]),
      ),
    ).toBe(1);
    // 文言が違う 2 つの注意は 2 項目だが、裁定は 1 つ（Ack の単位は裁定の seq）。
    expect(
      etiquetteCount(
        rulingLog("action", ["declaration_ignored", "string_bet"]),
      ),
    ).toBe(2);
  });

  it("Hero 以外への裁定・Hero 以外の viewer では出さない（物理的な誤操作をするのは Hero だけ。D91）", () => {
    expect(
      etiquetteCount(rulingLog("action", ["oversized_chip"], "cpu1")),
    ).toBe(0);
    expect(
      etiquetteCount(rulingLog("action", ["oversized_chip"]), "cpu1"),
    ).toBe(0);
  });
});
