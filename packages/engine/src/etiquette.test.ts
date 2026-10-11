// ETIQUETTE の確認（Ack）が要る裁定の判定（UX-11 #226・D145）の Unit Test。
// 全 RulingCode を網羅して承認済みの 7 種と一致すること、1 つの裁定の notes が複数でも Ack の単位は裁定の seq 1 つであること、
// Hero 以外への裁定・Hero 以外の viewer では Ack の対象にならないことを確かめる。
import { describe, expect, it } from "vitest";
import {
  ETIQUETTE_ACK_CODES,
  etiquetteAckRulingSeqs,
  requiresEtiquetteAck,
} from "./etiquette.js";
import type { HandEvent } from "./hand-events.js";
import { applyAction, applyPhysicalActions, startHand } from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import type { PlayerAction } from "./legal-actions.js";
import type { RulingCode } from "./ruling.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";

// 全 RulingCode の期待値（型で網羅する。RulingCode が増えたらここで要否を決めないとコンパイルできない）。
const EXPECTED: Record<RulingCode, boolean> = {
  declaration_ignored: true,
  declaration_adjusted: false,
  check_facing_bet: true,
  oversized_chip: true,
  string_bet: true,
  every_chip_needed: false,
  half_raise_completed: true,
  under_half_raise: true,
  under_call: false,
  under_min_bet: false,
  raise_not_allowed: false,
  out_of_turn: true,
  out_of_turn_binding: false,
  out_of_turn_released: false,
};

const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

/** Heads-Up（cpu が Button）で Flop まで進め、cpu が 100 を Bet した Log。 */
function facingBet100(): { events: HandEvent[]; state: HandState } {
  const started = startHand({
    handId: "etiquette",
    seats: [
      { playerId: "cpu", stack: 1000 },
      { playerId: "hero", stack: 1000 },
    ],
    buttonPlayerId: "cpu",
    config: CONFIG,
    deal: { seed: 1 },
  });
  if (!started.ok) throw new Error(started.error.message);
  const log = { events: [...started.value.events], state: started.value.state };
  const actions: (readonly [string, PlayerAction])[] = [
    ["cpu", { type: "call" }],
    ["hero", { type: "check" }],
    ["hero", { type: "check" }],
    ["cpu", { type: "bet", amount: 100 }],
  ];
  for (const [player, action] of actions) {
    const r = applyAction(log.state, player, action);
    if (!r.ok) throw new Error(r.error.message);
    log.events.push(...r.value.events);
    log.state = r.value.state;
  }
  return log;
}

describe("requiresEtiquetteAck / ETIQUETTE_ACK_CODES", () => {
  it("全 RulingCode のうち、承認済みの 7 種だけが Ack を要る（D145）", () => {
    for (const [code, expected] of Object.entries(EXPECTED)) {
      expect(requiresEtiquetteAck([code as RulingCode]), code).toBe(expected);
    }
    expect([...ETIQUETTE_ACK_CODES].sort()).toEqual(
      Object.entries(EXPECTED)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort(),
    );
  });

  it("notes が複数でも、1 つでも Ack の要る理由があれば Ack を要る（拘束 + Oversized Chip）。拘束だけ・空は要らない", () => {
    expect(
      requiresEtiquetteAck(["out_of_turn_binding", "oversized_chip"]),
    ).toBe(true);
    expect(requiresEtiquetteAck(["out_of_turn_binding"])).toBe(false);
    expect(requiresEtiquetteAck([])).toBe(false);
  });
});

describe("etiquetteAckRulingSeqs", () => {
  it("Hero への Ack の要る裁定の seq を返す（Oversized Chip → Call）。Hero 以外の viewer には返さない", () => {
    const log = facingBet100();
    expect(etiquetteAckRulingSeqs(log.events, "hero")).toEqual([]);
    const r = applyPhysicalActions(
      log.state,
      "hero",
      [{ type: "chip_push", chips: [500] }],
      CONFIG,
    );
    if (!r.ok) throw new Error(r.error.message);
    const events = [...log.events, ...r.value.events];
    const ruling = r.value.events.find((e) => e.type === "DEALER_RULING");
    expect(ruling).toMatchObject({ notes: ["oversized_chip"] });
    expect(etiquetteAckRulingSeqs(events, "hero")).toEqual([ruling?.seq]);
    // 裁定は Hero への裁定なので、CPU を viewer にしても Ack の対象にならない。
    expect(etiquetteAckRulingSeqs(events, "cpu")).toEqual([]);
  });

  it("Ack の要らない裁定（宣言どおりの Call は裁定なし・不足の Chip の Call は under_call）は返さない", () => {
    const log = facingBet100();
    const r = applyPhysicalActions(
      log.state,
      "hero",
      [{ type: "chip_push", chips: [25] }],
      CONFIG,
    );
    if (!r.ok) throw new Error(r.error.message);
    const ruling = r.value.events.find((e) => e.type === "DEALER_RULING");
    expect(ruling).toBeDefined();
    expect(
      etiquetteAckRulingSeqs([...log.events, ...r.value.events], "hero"),
    ).toEqual([]);
  });
});
