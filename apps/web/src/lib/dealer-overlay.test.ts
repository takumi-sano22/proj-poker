// RULING → ETIQUETTE の欄の順序（#226・D142・D145）。実際の Engine で、Hero が Call 額のある局面で Check を宣言した
// 裁定（check_facing_bet）を作り、dealerOverlayOf が決定論で欄を選ぶことを確かめる。
import {
  applyAction,
  applyPhysicalActions,
  createDeck,
  PHASE1_CASH_PRESET,
  projectHeroView,
  startHand,
  type HandEvent,
  type HandState,
  type HeroView,
  type TableConfig,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { dealerOverlayOf, type DealerOverlayInput } from "./dealer-overlay.js";

const HERO = "hero";
const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

/** 3 人卓（Button = cpu2 なので Hero が SB）。cpu2 が Call して、Hero は Call 額 5 を払う局面で Check を宣言する。 */
function rulingView(): { view: HeroView; rulingSeq: number } {
  const started = startHand({
    handId: "h1",
    seats: [
      { playerId: HERO, stack: 200 },
      { playerId: "cpu1", stack: 200 },
      { playerId: "cpu2", stack: 200 },
    ],
    buttonPlayerId: "cpu2",
    config: CONFIG,
    deal: { deck: createDeck() },
  });
  if (!started.ok) throw new Error(started.error.message);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  const call = applyAction(state, "cpu2", { type: "call" });
  if (!call.ok) throw new Error(call.error.kind);
  state = call.value.state;
  events.push(...call.value.events);
  const declared = applyPhysicalActions(
    state,
    HERO,
    [{ type: "declare", declaration: { kind: "check" } }],
    CONFIG,
  );
  if (!declared.ok) throw new Error(declared.error.kind);
  events.push(...declared.value.events);
  const view = projectHeroView(events, HERO);
  const ruling = view.log.find((e) => e.type === "DEALER_RULING");
  if (ruling === undefined) throw new Error("裁定が無い");
  return { view, rulingSeq: ruling.seq };
}

describe("dealerOverlayOf（RULING → ETIQUETTE の順序。#226）", () => {
  const { view, rulingSeq } = rulingView();
  const base: DealerOverlayInput = {
    displayed: view,
    pendingRulingSeq: null,
    rulingClosedThrough: -1,
    baselineSeq: -1,
    outageActive: false,
  };

  it("前提: 実 Engine の裁定は notes に check_facing_bet を持つ", () => {
    const e = view.log.find((x) => x.seq === rulingSeq);
    expect(e).toMatchObject({
      type: "DEALER_RULING",
      playerId: HERO,
      notes: ["check_facing_bet"],
    });
  });

  it("まだ閉じていない裁定は RULING を先に出す（category は ruling だけ）", () => {
    const o = dealerOverlayOf(base);
    expect(o?.kind).toBe("ruling");
    expect(o?.rulingSeq).toBe(rulingSeq);
    expect(o?.items.length).toBeGreaterThan(0);
    expect(o?.items.every((i) => i.category === "ruling")).toBe(true);
  });

  it("RULING を閉じた後（rulingClosedThrough を進める）は、確認待ちがあれば ETIQUETTE を出す", () => {
    const o = dealerOverlayOf({
      ...base,
      pendingRulingSeq: rulingSeq,
      rulingClosedThrough: rulingSeq,
    });
    expect(o?.kind).toBe("etiquette");
    expect(o?.rulingSeq).toBe(rulingSeq);
    expect(o?.items.length).toBeGreaterThan(0);
    expect(o?.items.every((i) => i.category === "etiquette")).toBe(true);
  });

  it("確認待ちが無ければ、RULING を閉じた後は何も出さない（COACHING も出さない）", () => {
    expect(
      dealerOverlayOf({ ...base, rulingClosedThrough: rulingSeq }),
    ).toBeNull();
  });

  it("notes の無い裁定（通常の Action の裁定）は RULING を出さない", () => {
    const noNotes: HeroView = {
      ...view,
      log: view.log.map((e) =>
        e.type === "DEALER_RULING" ? { ...e, notes: [] } : e,
      ),
    };
    expect(dealerOverlayOf({ ...base, displayed: noNotes })).toBeNull();
  });

  it("CPU の障害のダイアログが出ている間は何も出さない", () => {
    expect(dealerOverlayOf({ ...base, outageActive: true })).toBeNull();
    expect(
      dealerOverlayOf({
        ...base,
        outageActive: true,
        pendingRulingSeq: rulingSeq,
        rulingClosedThrough: rulingSeq,
      }),
    ).toBeNull();
  });

  it("baselineSeq 以前の裁定の RULING は出し直さない", () => {
    expect(dealerOverlayOf({ ...base, baselineSeq: rulingSeq })).toBeNull();
  });

  it("確認待ちの裁定は baselineSeq 以前でも RULING から出す（RULING → ETIQUETTE の順で復元）", () => {
    const o = dealerOverlayOf({
      ...base,
      baselineSeq: rulingSeq,
      pendingRulingSeq: rulingSeq,
    });
    expect(o?.kind).toBe("ruling");
    expect(o?.rulingSeq).toBe(rulingSeq);
    const after = dealerOverlayOf({
      ...base,
      baselineSeq: rulingSeq,
      pendingRulingSeq: rulingSeq,
      rulingClosedThrough: rulingSeq,
    });
    expect(after?.kind).toBe("etiquette");
  });

  it("確認待ちの裁定がまだ displayed に出ていない（演出の途中）なら null", () => {
    expect(
      dealerOverlayOf({
        ...base,
        pendingRulingSeq: rulingSeq + 100,
        rulingClosedThrough: rulingSeq,
      }),
    ).toBeNull();
  });

  it("確認待ちの seq が Log に無い（形の合わない応答）なら FALLBACK の ETIQUETTE を出して確認を求め続ける", () => {
    // Log の最後より後ろではなく、途中の欠番（Hero に見えない Event の seq）を指す。
    const seqs = new Set(view.log.map((e) => e.seq));
    let missing = 0;
    while (seqs.has(missing)) missing++;
    expect(missing).toBeLessThan(view.log.at(-1)?.seq ?? 0);
    const o = dealerOverlayOf({
      ...base,
      pendingRulingSeq: missing,
      rulingClosedThrough: rulingSeq,
    });
    expect(o?.kind).toBe("etiquette");
    expect(o?.rulingSeq).toBe(missing);
    expect(o?.items).toHaveLength(1);
    expect(o?.items[0]?.category).toBe("etiquette");
  });
});
