// UX-04（#219）の技術検証: Hero の操作の下書き（TurnDraft）の寿命を決める鍵（operationKey / lastSeqOf）が、
// 実際の Engine の進行でどう変わるかを固定する。製品のコードは変えない検証テスト。
// 結果の整理と推奨の契約（人間の承認前の案であり、採用済みではない）は docs/taskLog/issue-219-draft-lifecycle-design.md。
// 確かめること:
// - CPU の Action で可視 seq が進んだだけ・Hero の手番が来ただけでは operationKey は変わらない（下書きを保持できる）
// - Street の変化・Hand の変化・Hero への裁定（action / no_action / 保留した Out-of-Turn とその解決）では必ず変わる
// - Hero の物理的な操作が受理されると、必ず Hero への DEALER_RULING が 1 つ増える（送った下書きは key の変化で必ず捨てられる）
// - Engine が拒否した操作は Event を足さないので key も lastSeq も変わらない（下書きは残る）
// - CPU の Raise で Hero の Call の額が変わっても operationKey は変わらない（今の key では「状況の変化」を検知できない）
// - 演出の途中（displayed = prefix）と最新（authoritative）で operationKey / lastSeq が食い違う局面がある（D143 の同期・再検証が要る）
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
import { lastSeqOf, operationKey } from "./view-model.js";

const HERO = "hero";
const CONFIG = PHASE1_CASH_PRESET;

/**
 * 3 人卓（Button = cpu1 なので SB = cpu2・BB = hero）。Preflop は cpu1 → cpu2 → hero、Postflop は cpu2 → hero → cpu1。
 * Card の並びは問わないので、Deck は新品の順のまま配る。
 */
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
    events,
    /** CPU の Canonical Action（サーバーの runCpuTurns が置く ACTION_TAKEN と同じ）。 */
    cpu(playerId: string, action: PlayerAction): HeroView {
      const r = applyAction(state, playerId, action);
      if (!r.ok) throw new Error(`${playerId}: ${r.error.kind}`);
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
    /** Hero の物理的な操作（受理されなければ Event を足さず、拒否の理由を返す）。 */
    hero(actions: readonly PhysicalAction[]): HeroView | { rejected: string } {
      const r = applyPhysicalActions(state, HERO, actions, CONFIG);
      if (!r.ok) return { rejected: r.error.kind };
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
    /** Hero の手番が来た時点で、保留した Out-of-Turn を裁定する（サーバーの resolveHeroOutOfTurn と同じ）。 */
    resolvePending(): HeroView {
      const r = resolvePendingOutOfTurn(state, CONFIG);
      if (!r.ok) throw new Error(r.error.kind);
      events.push(...r.value.events);
      state = r.value.state;
      return view();
    },
  };
}

const declare = (
  declaration: Extract<PhysicalAction, { type: "declare" }>["declaration"],
): PhysicalAction[] => [{ type: "declare", declaration }];

const heroRulings = (view: HeroView) =>
  view.log.filter(
    (e) => e.type === "DEALER_RULING" && e.playerId === view.viewerId,
  );

/** Hero が Call に要る額（View の公開情報だけから。下書きの「状況」の候補）。 */
const toCallOf = (view: HeroView) => {
  const me = view.seats.find((s) => s.playerId === HERO);
  return view.currentBet - (me?.streetCommitted ?? 0);
};

function accepted(v: HeroView | { rejected: string }): HeroView {
  if ("rejected" in v) throw new Error(`rejected: ${v.rejected}`);
  return v;
}

describe("UX-04 検証: CPU の進行と Hero の手番の到来", () => {
  it("CPU の Action で可視 seq が進み Hero の手番が来ても、operationKey は変わらない", () => {
    const t = table();
    const start = t.view();
    expect(start.actorId).toBe("cpu1");
    expect(start.legalActions).toBeNull();

    const afterCpu1 = t.cpu("cpu1", { type: "call" });
    const afterCpu2 = t.cpu("cpu2", { type: "call" });
    expect(afterCpu2.actorId).toBe(HERO);
    expect(afterCpu2.legalActions).not.toBeNull();

    // seq は進むが、下書きの単位は同じ（手番を待つ間に組んだ下書きを手番の到来で失わない）。
    expect(lastSeqOf(afterCpu1)).toBeGreaterThan(lastSeqOf(start));
    expect(lastSeqOf(afterCpu2)).toBeGreaterThan(lastSeqOf(afterCpu1));
    expect(new Set([start, afterCpu1, afterCpu2].map(operationKey)).size).toBe(
      1,
    );
  });

  it("CPU の Raise で Hero の Call の額が変わっても operationKey は変わらない（今の key は Hero の状況の変化を検知しない）", () => {
    const t = table();
    const before = t.view();
    const toCallBefore = toCallOf(before);
    const afterRaise = t.cpu("cpu1", {
      type: "raise",
      amount: CONFIG.bigBlind * 4,
    });
    // Hero が Call に要る額は増えたが、key は同じ。手番外に組んだ下書き（例: BB 分の Chip）はそのまま残り、送ると額の足りない操作になる。
    expect(toCallOf(afterRaise)).toBeGreaterThan(toCallBefore);
    expect(operationKey(afterRaise)).toBe(operationKey(before));
  });

  it("Street が変わると operationKey は変わる（CPU の Action で Street が閉じる場合も）", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    const preflop = t.view();
    const flop = accepted(t.hero(declare({ kind: "check" })));
    expect(flop.street).toBe("flop");
    expect(operationKey(flop)).not.toBe(operationKey(preflop));

    // Postflop は cpu2 → hero → cpu1。最後の cpu1 の Check（CPU の Action）で Flop が閉じ、Turn になる。
    t.cpu("cpu2", { type: "check" });
    const heroChecked = accepted(t.hero(declare({ kind: "check" })));
    const turn = t.cpu("cpu1", { type: "check" });
    expect(turn.street).toBe("turn");
    expect(operationKey(turn)).not.toBe(operationKey(heroChecked));
  });

  it("Hand が変わると operationKey は変わる（同じ Street・同じ裁定の数でも）", () => {
    expect(operationKey(table("h1").view())).not.toBe(
      operationKey(table("h2").view()),
    );
  });
});

describe("UX-04 検証: Hero の操作・裁定と下書き", () => {
  it("受理された物理的な操作は必ず Hero への DEALER_RULING を 1 つ足し、operationKey を変える（送った下書きは必ず捨てられる）", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    const before = t.view();
    // 宣言なしで額面 25 の Chip を 1 枚出す（Chip だけの操作）。宣言だけ・Chip だけのどの操作でも、裁定は 1 つ。
    const after = accepted(t.hero([{ type: "chip_push", chips: [25] }]));
    expect(heroRulings(after).length - heroRulings(before).length).toBe(1);
    expect(operationKey(after)).not.toBe(operationKey(before));
  });

  it("手番外の操作（Out-of-Turn）は保留の裁定で key が変わり、手番の到来で保留を解く裁定でもう一度変わる", () => {
    const t = table();
    const start = t.view();
    const pending = accepted(t.hero(declare({ kind: "call" })));
    const ruling = heroRulings(pending).at(-1);
    expect(ruling).toMatchObject({ outcome: "out_of_turn" });
    expect(operationKey(pending)).not.toBe(operationKey(start));

    // 保留中の CPU の Action では変わらない（保留中の UI は全ボタンを無効にする。App.tsx の heroRulingStatus）。
    t.cpu("cpu1", { type: "call" });
    const heroTurn = t.cpu("cpu2", { type: "call" });
    expect(operationKey(heroTurn)).toBe(operationKey(pending));

    // 手番が来て保留を裁定する（拘束 or 撤回）と Hero への裁定が増える。
    const resolved = t.resolvePending();
    expect(heroRulings(resolved).at(-1)).toMatchObject({
      basis: "pending_out_of_turn",
    });
    expect(operationKey(resolved)).not.toBe(operationKey(heroTurn));
  });

  it("保留中にもう一度操作すると Engine が拒否し、Event も key も lastSeq も変わらない（下書きは残る）", () => {
    const t = table();
    const pending = accepted(t.hero(declare({ kind: "call" })));
    const again = t.hero(declare({ kind: "fold" }));
    expect(again).toEqual({ rejected: "not_actor" });
    const now = t.view();
    expect(operationKey(now)).toBe(operationKey(pending));
    expect(lastSeqOf(now)).toBe(lastSeqOf(pending));
  });
});

describe("UX-04 検証: 演出中（displayed）と最新（authoritative）の食い違い（D143）", () => {
  it("CPU の Action だけを演出している間は key が同じで lastSeq だけが違う（同期すれば下書きはそのまま送れる）", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const authoritative = t.cpu("cpu2", { type: "call" });
    // 演出がまだ 1 つ前の Event までしか出していない時点の卓（prefix の Projection）。
    const displayed = projectHeroView(authoritative.log.slice(0, -1), HERO);
    expect(operationKey(displayed)).toBe(operationKey(authoritative));
    expect(lastSeqOf(displayed)).toBeLessThan(lastSeqOf(authoritative));
    // 演出の途中の卓では Hero の手番がまだ見えない（displayed で操作の可否を決めない）。
    expect(displayed.actorId).not.toBe(HERO);
    expect(authoritative.actorId).toBe(HERO);
  });

  it("演出が Street の変わり目より前にあると、displayed と authoritative の key が違う（同期の後に下書きを再検証して捨てる）", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    accepted(t.hero(declare({ kind: "check" })));
    t.cpu("cpu2", { type: "check" });
    accepted(t.hero(declare({ kind: "check" })));
    const authoritative = t.cpu("cpu1", { type: "check" });
    expect(authoritative.street).toBe("turn");

    // Flop の最後の Action（cpu1 の Check）の前までを演出している時点。
    const lastFlopIndex = authoritative.log.findLastIndex(
      (e) => e.type === "ACTION_TAKEN" && e.street === "flop",
    );
    const displayed = projectHeroView(
      authoritative.log.slice(0, lastFlopIndex),
      HERO,
    );
    expect(displayed.street).toBe("flop");
    expect(operationKey(displayed)).not.toBe(operationKey(authoritative));
  });
});
