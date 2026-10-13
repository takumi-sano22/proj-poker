// UX-05（#220・D137）の狭い画面の Hero の操作パネルの自動展開の規則（lib/hero-panel.ts）。実際の Engine で Hand を進め、Hero に
// 見える View（projectHeroView）の手番で判定する。開閉の描画と下書きの保持は E2E の hero-panel.spec.ts。
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
  type PhysicalAction,
  type PlayerAction,
} from "@proj-poker/engine";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./chip-flight.js";
import {
  heroTurnKey,
  initialHeroPanel,
  nextHeroPanel,
  panelOperable,
  type HeroPanelState,
} from "./hero-panel.js";

const HERO = "hero";
const CONFIG = PHASE1_CASH_PRESET;

/** 3 人卓（Button = cpu1。SB = cpu2・BB = hero）。Preflop は cpu1 → cpu2 → hero、Postflop は cpu2 → hero → cpu1。 */
function table() {
  const started = startHand({
    handId: "h1",
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
  };
}

/** 表示中の View を順に見せたときの開閉の状態（描画のたびに nextHeroPanel を当てる HeroDock と同じ）。 */
function follow(
  state: HeroPanelState,
  ...views: readonly HeroView[]
): HeroPanelState {
  return views.reduce((s, v) => nextHeroPanel(s, heroTurnKey(v)), state);
}

describe("狭い画面の Hero の操作パネルの自動展開（D137 Q7）", () => {
  it("手番でない間に始めたら閉じ、Hero の手番が来たら開く", () => {
    const t = table();
    const start = t.view();
    expect(heroTurnKey(start)).toBeNull();
    let s = initialHeroPanel(heroTurnKey(start));
    expect(s.expanded).toBe(false);
    t.cpu("cpu1", { type: "call" });
    const turn = t.cpu("cpu2", { type: "call" });
    s = follow(s, turn);
    expect(heroTurnKey(turn)).not.toBeNull();
    expect(s.expanded).toBe(true);
  });

  it("同じ手番の間に手動で閉じたら、同じ View を何度描き直しても開き直さない", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const turn = t.cpu("cpu2", { type: "call" });
    let s = initialHeroPanel(heroTurnKey(turn));
    expect(s.expanded).toBe(true);
    s = { ...s, expanded: false };
    const again = follow(s, turn, turn, t.view());
    // 同じ状態のまま（同じ object を返すので、HeroDock は再描画で state を更新しない）
    expect(again).toBe(s);
    expect(again.expanded).toBe(false);
  });

  it("手番が終わっても自動では閉じず、次の手番（別の Street）で閉じていたら開く", () => {
    const t = table();
    t.cpu("cpu1", { type: "call" });
    const turn = t.cpu("cpu2", { type: "call" });
    let s = initialHeroPanel(heroTurnKey(turn));
    // Hero が Check して Flop へ。Flop は cpu2 が先に動く（Hero の手番でない）
    const flop = t.hero([{ type: "declare", declaration: { kind: "check" } }]);
    s = follow(s, flop);
    expect(heroTurnKey(flop)).toBeNull();
    expect(s.expanded).toBe(true);
    // 手番の外で閉じ、cpu2 の Check で Hero の手番が来たら開く
    s = { ...s, expanded: false };
    const flopTurn = t.cpu("cpu2", { type: "check" });
    s = follow(s, flopTurn);
    expect(heroTurnKey(flopTurn)).not.toBe(heroTurnKey(turn));
    expect(s.expanded).toBe(true);
  });

  it("終わった Hand は手番として扱わない", () => {
    const t = table();
    t.cpu("cpu1", { type: "fold" });
    const done = t.cpu("cpu2", { type: "fold" });
    expect(done.status).toBe("complete");
    expect(heroTurnKey(done)).toBeNull();
  });
});

describe("Chip の移動の演出の所要時間（lib/chip-flight.ts）", () => {
  it("CSS の時間をミリ秒に読み、0・読めない値は 0（演出しない。演出なし・reduced-motion）", () => {
    expect(parseDurationMs(" 260ms")).toBe(260);
    expect(parseDurationMs("0.3s")).toBe(300);
    expect(parseDurationMs("0ms")).toBe(0);
    expect(parseDurationMs("")).toBe(0);
    expect(parseDurationMs("fast")).toBe(0);
  });
});

describe("折りたたみを出す状態（操作の欄がある間だけ）", () => {
  it("Hand の途中で Hero が席にいれば出し、CPU の障害・Session の終わり・Fold の後・終わった Hand では出さない", () => {
    const t = table();
    const start = t.view();
    expect(panelOperable(start, false, false)).toBe(true);
    // 障害のダイアログ（Outage）が出ている間は、ダイアログを先に出し、折りたたまない（Hero の欄の中身は障害のダイアログ）
    expect(panelOperable(start, false, true)).toBe(false);
    expect(panelOperable(start, true, false)).toBe(false);
    t.cpu("cpu1", { type: "call" });
    t.cpu("cpu2", { type: "call" });
    const folded = t.hero([{ type: "declare", declaration: { kind: "fold" } }]);
    expect(panelOperable(folded, false, false)).toBe(false);
  });
});

describe("styles.css の契約（折りたたみ・演出の所要時間）", () => {
  // コメントは規則の一部として読まない
  const css = readFileSync(
    new URL("../styles.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("閉じたときに隠すのは Chip と宣言の操作の欄だけ（RULING / ETIQUETTE の欄・障害・結果・裁定の Feedback は隠さない）", () => {
    const rules = [
      ...css.matchAll(/([^{}]*\[data-collapsed\][^{}]*)\{([^}]*)\}/g),
    ];
    const hiding = rules.filter(([, , body]) =>
      /display:\s*none/.test(body ?? ""),
    );
    expect(hiding.map(([, selector]) => selector?.trim())).toEqual([
      ".dock[data-collapsed] .chip-controls",
    ]);
  });

  it("移動の演出の所要時間は、演出なしと reduced-motion で 0 にする", () => {
    const zero = /--duration-chip:\s*0ms/;
    const none = css.match(/\.app--presentation-none\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(none).toMatch(zero);
    const reduced =
      css.match(
        /prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(reduced).toMatch(zero);
  });
});
