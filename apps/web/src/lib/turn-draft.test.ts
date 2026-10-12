// UX-04（#219・D146）の下書きの寿命の規則（lib/turn-draft.ts）。実際の Engine で Hand を進め、Hero に見える View（projectHeroView）
// だけで判定することを確かめる。React・API は通さない（画面と送信の結合は useHandSession と E2E の turn-draft.spec.ts）。
import {
  applyAction,
  applyPhysicalActions,
  createDeck,
  PHASE1_CASH_PRESET,
  projectHeroView,
  resolvePendingOutOfTurn,
  startHand,
  type HandEvent,
  type HandState,
  type HeroView,
  type PhysicalAction,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { pickChip, pushHand, returnHand } from "./chip-ops.js";
import {
  INITIAL_DRAFT_STATE,
  actionsToSend,
  checkSend,
  confirmChange,
  dismissDiscarded,
  edit,
  isLocked,
  markSending,
  operationOutcome,
  reconcile,
  settleSend,
  shownDraft,
  type DraftState,
} from "./turn-draft.js";
import { lastSeqOf } from "./view-model.js";

const HERO = "hero";
const CONFIG = PHASE1_CASH_PRESET;

/** 3 人卓（Button = cpu1。SB = cpu2・BB = hero）。Preflop は cpu1 → cpu2 → hero、Postflop は cpu2 → hero → cpu1。 */
function table(handId = "h1") {
  const started = startHand({
    handId,
    seats: [
      { playerId: HERO, stack: 200 },
      { playerId: "cpu1", stack: 200 },
      { playerId: "cpu2", stack: 200 },
    ],
    buttonPlayerId: "cpu1",
    config: CONFIG,
    deal: { deck: createDeck() },
  });
  if (!started.ok) throw new Error(started.error.message);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  const view = (): HeroView => projectHeroView(events, HERO);
  return {
    view,
    cpu(playerId: string, action: PlayerAction): HeroView {
      const r = applyAction(state, playerId, action);
      if (!r.ok) throw new Error(`${playerId}: ${r.error.kind}`);
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
    hero(actions: readonly PhysicalAction[]): HeroView {
      const r = applyPhysicalActions(state, HERO, actions, CONFIG);
      if (!r.ok) throw new Error(`rejected: ${r.error.kind}`);
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
    resolvePending(): HeroView {
      const r = resolvePendingOutOfTurn(state, CONFIG);
      if (!r.ok) throw new Error(r.error.kind);
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
  };
}

/** displayed = authoritative の卓で、Chip を 1 枚手に取り Betting Area に出した下書き。 */
function pushed(view: HeroView, value = 5): DraftState {
  return edit(
    edit(INITIAL_DRAFT_STATE, view, view, (d) => pickChip(d, 200, value)),
    view,
    view,
    pushHand,
  );
}

const CHIP_5: PhysicalAction = { type: "chip_push", chips: [5] };

describe("下書きの保持（同じ operationKey）", () => {
  it("CPU の Call で可視 seq が進み Hero の手番が来ても、手元・出した Chip・宣言・順番を保持し、状況が同じなら確認なしで送れる", () => {
    const t = table();
    const start = t.view();
    let s = edit(INITIAL_DRAFT_STATE, start, start, (d) => pickChip(d, 200, 1));
    s = edit(s, start, start, pushHand);
    s = edit(s, start, start, (d) => pickChip(d, 200, 25));
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "call" });
    expect(heroTurn.actorId).toBe(HERO);
    s = reconcile(s, heroTurn, heroTurn);
    expect(s.slot?.draft).toEqual({
      hand: [25],
      ops: [{ type: "chip_push", chips: [1] }],
    });
    expect(s.discarded).toBeNull();
    const check = checkSend(s, heroTurn, actionsToSend(s.slot, null));
    expect(check.kind).toBe("send");
  });

  it("ETIQUETTE の Ack は Event を足さないので、同じ View のまま下書きを保持する（Ack 待ちで送れないのは useHandSession の責務）", () => {
    const t = table();
    const view = t.view();
    const s = pushed(view);
    expect(reconcile(s, view, view)).toBe(s);
  });

  it("CPU の障害（Outage）の Dialog の間も、下書きは View だけで判定するので保持する（表示の部品が消えても状態は残る）", () => {
    const t = table();
    const view = t.view();
    const s = pushed(view);
    // 障害は Event を足さない（HAND_ABORTED を選ぶまで）。同じ View の照合は何も変えない
    expect(reconcile(reconcile(s, view, view), view, view)).toBe(s);
  });
});

describe("状況の変化の再確認（UX04-1=A。#242 の T2 の置き換え）", () => {
  it("同じ局面で CPU が Raise したら、下書きを保持したまま送らず、変化を示して再確認を待ち、確定してから送る", () => {
    const t = table();
    const start = t.view();
    let s = pushed(start, 1);
    t.cpu("cpu1", { type: "raise", amount: CONFIG.bigBlind * 4 });
    const heroTurn = t.cpu("cpu2", { type: "fold" });
    s = reconcile(s, heroTurn, heroTurn);
    // 錨の operationKey は同じなので下書きは捨てない
    expect(s.slot?.draft.ops).toEqual([{ type: "chip_push", chips: [1] }]);

    const first = checkSend(s, heroTurn, actionsToSend(s.slot, null));
    expect(first.kind).toBe("changed");
    const change = first.state.slot?.change;
    expect(change?.from).toEqual({ currentBet: 2, heroCommitted: 2 });
    expect(change?.to).toEqual({ currentBet: 8, heroCommitted: 2 });
    // client は Chip の枚数・宣言を補正しない
    expect(change?.actions).toEqual([{ type: "chip_push", chips: [1] }]);

    // 確定するまで送らない（再び送ろうとしても、まだ錨の状況のままなので同じ再確認になる）
    expect(checkSend(first.state, heroTurn, change!.actions).kind).toBe(
      "changed",
    );
    const confirmed = confirmChange(first.state, heroTurn);
    expect(confirmed.kind).toBe("send");
    expect(confirmed.actions).toEqual([{ type: "chip_push", chips: [1] }]);
    expect(confirmed.state.slot?.anchorContext).toEqual({
      currentBet: 8,
      heroCommitted: 2,
    });
    // 確定の後は、同じ状況のまま送れる
    expect(checkSend(confirmed.state, heroTurn, confirmed.actions).kind).toBe(
      "send",
    );
  });

  it("宣言だけで決まる宣言（Call）は再確認の操作にだけ入り、下書きには足さない（確定しなければ次の操作に紛れ込まない）", () => {
    const t = table();
    const start = t.view();
    let s = pushed(start, 1);
    const raised = t.cpu("cpu1", { type: "raise", amount: 8 });
    s = reconcile(s, raised, raised);
    const actions = actionsToSend(s.slot, { kind: "call" });
    const check = checkSend(s, raised, actions);
    expect(check.kind).toBe("changed");
    expect(check.state.slot?.change?.actions.at(-1)).toEqual({
      type: "declare",
      declaration: { kind: "call" },
    });
    expect(check.state.slot?.draft.ops).toEqual([
      { type: "chip_push", chips: [1] },
    ]);
    // 確定せずに下書きを変えたら、再確認は取り下げ、宣言は残らない
    const edited = edit(check.state, raised, raised, (d) =>
      pickChip(d, 200, 1),
    );
    expect(edited.slot?.change).toBeNull();
    expect(edited.slot?.draft.ops.some((op) => op.type === "declare")).toBe(
      false,
    );
  });

  it("再確認の前にさらに状況が変わったら、古い確認では送らず、新しい変化を示し直す", () => {
    const t = table();
    const start = t.view();
    let s = pushed(start, 1);
    const raised = t.cpu("cpu1", { type: "raise", amount: 8 });
    s = reconcile(s, raised, raised);
    const check = checkSend(s, raised, actionsToSend(s.slot, null));
    expect(check.state.slot?.change?.to.currentBet).toBe(8);
    const reraised = t.cpu("cpu2", { type: "raise", amount: 24 });
    const again = confirmChange(
      reconcile(check.state, reraised, reraised),
      reraised,
    );
    expect(again.kind).toBe("changed");
    expect(again.actions).toEqual([]);
    expect(again.state.slot?.change?.from.currentBet).toBe(2);
    expect(again.state.slot?.change?.to.currentBet).toBe(24);
    const confirmed = confirmChange(again.state, reraised);
    expect(confirmed.kind).toBe("send");
  });

  it("CPU の Bet / Raise が無ければ（Call・Fold だけ）状況は同じで、再確認を求めない", () => {
    const t = table();
    const start = t.view();
    const s = pushed(start);
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "fold" });
    expect(checkSend(s, heroTurn, actionsToSend(s.slot, null)).kind).toBe(
      "send",
    );
  });
});

describe("無効化と通知（D146・UX04-3=A）", () => {
  it("Street が変わると捨て、中身があれば通知する", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    t.hero([{ type: "declare", declaration: { kind: "check" } }]);
    const flop = t.cpu("cpu2", { type: "check" });
    const s = pushed(flop);
    t.hero([{ type: "declare", declaration: { kind: "check" } }]);
    // 送った下書きではなく、別に組んだ下書きを想定するため、Hero の Check の後の卓で組み直す
    const afterHero = t.view();
    const s2 = pushed(afterHero);
    const turn = t.cpu("cpu1", { type: "check" });
    expect(turn.street).toBe("turn");
    const r = reconcile(s2, turn, turn);
    expect(r.slot).toBeNull();
    expect(r.discarded?.reason).toBe("street");
    expect(s.slot).not.toBeNull();
  });

  it("空の下書き（手に取って戻した）は持たず、捨てても通知しない", () => {
    const t = table();
    const start = t.view();
    const picked = edit(INITIAL_DRAFT_STATE, start, start, (d) =>
      pickChip(d, 200, 5),
    );
    const returned = edit(picked, start, start, returnHand);
    expect(returned.slot).toBeNull();
    const other = table("h2").view();
    expect(reconcile(returned, other, other).discarded).toBeNull();
  });

  it("Hand が変わると捨てる（理由は hand）", () => {
    const s = pushed(table("h1").view());
    const next = table("h2").view();
    const r = reconcile(s, next, next);
    expect(r.slot).toBeNull();
    expect(r.discarded?.reason).toBe("hand");
  });

  it("Hero の裁定が増えないまま Hand が終わったら（CPU の Fold で Hero が勝つ）、Hand の完了で捨てて通知する", () => {
    const t = table();
    const s = pushed(t.view());
    t.cpu("cpu1", { type: "fold" });
    const done = t.cpu("cpu2", { type: "fold" });
    expect(done.status).toBe("complete");
    const r = reconcile(s, done, done);
    expect(r.slot).toBeNull();
    expect(r.discarded?.reason).toBe("hand_complete");
  });

  it("保留した Out-of-Turn の解決（Hero への新しい裁定）では捨てる（理由は ruling）", () => {
    const t = table();
    const start = t.view();
    // 手番外の宣言を送り、保留の裁定で消費した後に…
    let s = markSending(INITIAL_DRAFT_STATE, start, lastSeqOf(start), [
      { type: "declare", declaration: { kind: "call" } },
    ]);
    const pending = t.hero([
      { type: "declare", declaration: { kind: "call" } },
    ]);
    s = reconcile(s, pending, pending);
    expect(s.slot).toBeNull();
    expect(s.discarded).toBeNull();
    // 保留中に組んだ下書き（UI は保留中は押せないが、規則として）は、保留の解決の裁定で捨てる
    const held = pushed(pending);
    // cpu1 の Raise で状況が変わり、保留した Call は撤回（no_action）になる。Street は Preflop のまま
    t.cpu("cpu1", { type: "raise", amount: 8 });
    t.cpu("cpu2", { type: "call" });
    const resolved = t.resolvePending();
    expect(resolved.street).toBe("preflop");
    const r = reconcile(held, resolved, resolved);
    expect(r.slot).toBeNull();
    expect(r.discarded?.reason).toBe("ruling");
  });

  it("演出が Street の変わり目より前の卓で組んだ下書きは、表示が追いついた時点で捨てる（錨は displayed）", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    t.hero([{ type: "declare", declaration: { kind: "check" } }]);
    t.cpu("cpu2", { type: "check" });
    t.hero([{ type: "declare", declaration: { kind: "check" } }]);
    const authoritative = t.cpu("cpu1", { type: "check" });
    const lastFlop = authoritative.log.findLastIndex(
      (e) => e.type === "ACTION_TAKEN" && e.street === "flop",
    );
    const displayed = projectHeroView(
      authoritative.log.slice(0, lastFlop),
      HERO,
    );
    const s = pushed(displayed);
    // 演出の途中（displayed は Flop のまま）は保持
    expect(reconcile(s, displayed, authoritative).slot).not.toBeNull();
    // 送る前の照合（同期の後の最新の卓）で錨の key と違えば捨てる
    const check = checkSend(s, authoritative, actionsToSend(s.slot, null));
    expect(check.kind).toBe("discarded");
    expect(check.state.discarded?.reason).toBe("street");
  });

  it("通知は id ごとに閉じる（別の通知に変わっていれば閉じない）", () => {
    const s = pushed(table("h1").view());
    const next = table("h2").view();
    const r = reconcile(s, next, next);
    const id = r.discarded!.id;
    expect(dismissDiscarded(r, id + 1)).toBe(r);
    expect(dismissDiscarded(r, id).discarded).toBeNull();
  });
});

describe("送信の状態（sent は受理の確定ではない）", () => {
  it("送り始めただけでは下書きを捨てず、編集もさせない。受理（Hero への裁定）が見えたら黙って捨てる", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "call" });
    const s = pushed(heroTurn);
    const actions = actionsToSend(s.slot, null);
    const sending = markSending(s, heroTurn, lastSeqOf(heroTurn), actions);
    expect(isLocked(sending)).toBe(true);
    expect(edit(sending, heroTurn, heroTurn, (d) => pickChip(d, 200, 1))).toBe(
      sending,
    );
    expect(shownDraft(sending.slot).ops).toEqual(actions);
    // SSE で受理の裁定が先に届いても、応答が先でも、黙って捨てる（通知しない）
    const after = t.hero(actions);
    expect(operationOutcome(after, lastSeqOf(heroTurn))).toBe("accepted");
    const viaView = reconcile(sending, heroTurn, after);
    expect(viaView.slot).toBeNull();
    expect(viaView.discarded).toBeNull();
    const viaResponse = settleSend(sending, lastSeqOf(heroTurn), {
      kind: "accepted",
    });
    expect(viaResponse.slot).toBeNull();
    expect(viaResponse.discarded).toBeNull();
  });

  it("stale_view 等の拒否では、送った宣言（Fold / Check / Call / All-in）を外して元の下書きに戻す", () => {
    const t = table();
    const start = t.view();
    const s = pushed(start, 1);
    const actions = actionsToSend(s.slot, { kind: "fold" });
    const sending = markSending(s, start, lastSeqOf(start), actions);
    const rejected = settleSend(sending, lastSeqOf(start), {
      kind: "rejected",
    });
    expect(isLocked(rejected)).toBe(false);
    expect(rejected.slot?.draft.ops).toEqual([
      { type: "chip_push", chips: [1] },
    ]);
    expect(shownDraft(rejected.slot).ops).not.toContainEqual({
      type: "declare",
      declaration: { kind: "fold" },
    });
  });

  it("応答が届かなければ結果不明として固定し、同じ lastSeq・同じ操作の再送だけを許す。最新の View で受理が見えたら捨てる", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "call" });
    const s = pushed(heroTurn);
    const lastSeq = lastSeqOf(heroTurn);
    const sending = markSending(s, heroTurn, lastSeq, [CHIP_5]);
    const unknown = settleSend(sending, lastSeq, { kind: "unknown" });
    expect(unknown.slot?.inFlight).toMatchObject({
      phase: "unknown",
      lastSeq,
      actions: [CHIP_5],
    });
    expect(isLocked(unknown)).toBe(true);
    // 応答は失われたが server は受理していた（応答の消失）
    const after = t.hero([CHIP_5]);
    const resolved = reconcile(unknown, heroTurn, after);
    expect(resolved.slot).toBeNull();
    expect(resolved.discarded).toBeNull();
  });

  it("結果不明のまま CPU の Action が先に足されたら、その送信は受理されていない（stale_view）と分かり、下書きを戻す", () => {
    const t = table();
    const start = t.view();
    const s = pushed(start);
    const lastSeq = lastSeqOf(start);
    const unknown = settleSend(
      markSending(s, start, lastSeq, [CHIP_5]),
      lastSeq,
      { kind: "unknown" },
    );
    const moved = t.cpu("cpu1", { type: "call" });
    expect(operationOutcome(moved, lastSeq)).toBe("rejected");
    const r = reconcile(unknown, moved, moved);
    expect(isLocked(r)).toBe(false);
    expect(r.slot?.draft.ops).toEqual([CHIP_5]);
  });

  it("結果不明の後の再送が拒否されても、前の送信の結果が分かるまでは固定を解かない", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "call" });
    const s = pushed(heroTurn);
    const lastSeq = lastSeqOf(heroTurn);
    const unknown = settleSend(
      markSending(s, heroTurn, lastSeq, [CHIP_5]),
      lastSeq,
      { kind: "unknown" },
    );
    const retried = markSending(unknown, heroTurn, lastSeq, [CHIP_5]);
    expect(retried.slot?.inFlight?.uncertain).toBe(true);
    const rejected = settleSend(retried, lastSeq, { kind: "rejected" });
    expect(isLocked(rejected)).toBe(true);
    expect(rejected.slot?.inFlight?.phase).toBe("unknown");
  });

  it("結果不明のまま別の Hand に移ったら、別の Hand の log で結果を判定せずに捨てる", () => {
    const start = table("h1").view();
    const lastSeq = lastSeqOf(start);
    const unknown = settleSend(
      markSending(pushed(start), start, lastSeq, [CHIP_5]),
      lastSeq,
      { kind: "unknown" },
    );
    const next = table("h2").view();
    const r = reconcile(unknown, next, next);
    expect(r.slot).toBeNull();
    expect(r.discarded?.reason).toBe("hand");
  });

  it("別の送信（lastSeq の違う）の応答では何も変えない", () => {
    const t = table();
    const start = t.view();
    const sending = markSending(pushed(start), start, lastSeqOf(start), [
      CHIP_5,
    ]);
    expect(
      settleSend(sending, lastSeqOf(start) + 1, { kind: "accepted" }),
    ).toBe(sending);
  });
});
