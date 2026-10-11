// Presentation Controller（#222・D140・D143）の純関数のテスト。実際の Engine で Hand を進め、サーバーが配る単位
// （Command 1 回の追記ごとの HeroView）を authoritative として受け取り、displayed の進み方を確かめる。
// - seq の飛び番・重複・順不同・大量の到着・Hand の切り替え
// - 連続する CPU の Action・Flop / Turn / River の順序・Showdown・Main / Side / Split Pot・Uncalled・実額
// - 4 段階の速度・Skip（syncNow）・演出なし・Hero の手番の到来・CPU の障害の優先（flush）・ETIQUETTE の接続点（holdThroughSeq）
// - displayed と authoritative が違う間は操作を送らない（canSendFrom）
// - 2〜8 人卓・Tournament の Ante・Drill の続く Hand（新しい Hand の始まり）
import {
  applyAction,
  applyPhysicalActions,
  cardToString,
  createDeck,
  parseCards,
  PHASE1_CASH_PRESET,
  projectHeroView,
  type Card,
  type HandEvent,
  type HandState,
  type HeroView,
  type PhysicalAction,
  type PlayerAction,
  type SeatInit,
  type TableConfig,
} from "@proj-poker/engine";
import { startHand } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_HERO_TURN_SCALE,
  PRESENTATION_MAX_PENDING_STEPS,
  PRESENTATION_STEP_MS,
} from "./config.js";
import {
  INITIAL_PRESENTATION,
  PRESENTATION_SPEEDS,
  canSendFrom,
  displayedView,
  isSynced,
  nextDueAt,
  pendingSteps,
  receive,
  settle,
  settleWithoutClock,
  stepDurationMs,
  stepsOf,
  syncNow,
  type PresentationOptions,
  type PresentationSpeed,
  type PresentationState,
} from "./presentation.js";
import { lastSeqOf } from "./view-model.js";

const HERO = "hero";
const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

/** 指定の Hole Cards と Board が配布順の位置に来る Deck（Engine の配布順: Button の左から 1 枚ずつ 2 周 → Board）。 */
function stackedDeck(
  seats: readonly SeatInit[],
  button: string,
  holes: Readonly<Record<string, string>>,
  board: string,
): Card[] {
  const n = seats.length;
  const b = seats.findIndex((s) => s.playerId === button);
  const slots: (Card | undefined)[] = Array.from(
    { length: 52 },
    () => undefined,
  );
  for (let k = 0; k < n; k++) {
    const hole = holes[(seats[(b + 1 + k) % n] as SeatInit).playerId];
    if (hole === undefined) continue;
    const [first, second] = parseCards(hole);
    slots[k] = first;
    slots[n + k] = second;
  }
  parseCards(board).forEach((c, i) => {
    slots[2 * n + i] = c;
  });
  const used = new Set(
    slots.filter((c): c is Card => c !== undefined).map(cardToString),
  );
  const rest = createDeck().filter((c) => !used.has(cardToString(c)));
  return slots.map((c) => c ?? (rest.shift() as Card));
}

interface TableSetup {
  readonly handId?: string;
  readonly seats: readonly SeatInit[];
  readonly button: string;
  readonly holes?: Readonly<Record<string, string>>;
  readonly board?: string;
  readonly config?: TableConfig;
}

/** Hand を進め、サーバーが配る単位（開始と Command 1 回ごと）の Hero の View を deliveries に積む。 */
function table(setup: TableSetup) {
  const config = setup.config ?? CONFIG;
  const started = startHand({
    handId: setup.handId ?? "h1",
    seats: setup.seats,
    buttonPlayerId: setup.button,
    config,
    deal: {
      deck:
        setup.holes === undefined
          ? createDeck()
          : stackedDeck(
              setup.seats,
              setup.button,
              setup.holes,
              setup.board ?? "",
            ),
    },
  });
  if (!started.ok) throw new Error(started.error.message);
  let state: HandState = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  const deliveries: HeroView[] = [projectHeroView(events, HERO)];
  const push = () => {
    const v = projectHeroView(events, HERO);
    deliveries.push(v);
    return v;
  };
  return {
    deliveries,
    get state() {
      return state;
    },
    act(playerId: string, action: PlayerAction): HeroView {
      const r = applyAction(state, playerId, action);
      if (!r.ok) throw new Error(`${playerId}: ${r.error.kind}`);
      events.push(...r.value.events);
      state = r.value.state;
      return push();
    },
    physical(playerId: string, actions: readonly PhysicalAction[]): HeroView {
      const r = applyPhysicalActions(state, playerId, actions, config);
      if (!r.ok) throw new Error(`${playerId}: ${r.error.kind}`);
      events.push(...r.value.events);
      state = r.value.state;
      return push();
    },
    /** 手番の Player が Call / Check だけで Hand の終わりまで進める（1 Command ごとに配る）。 */
    passive(): HeroView {
      while (state.status === "in_progress" && state.actorIndex !== null) {
        const player = state.players[state.actorIndex];
        if (player === undefined) break;
        const actor = player.playerId;
        const toCall = state.currentBet - player.streetCommitted;
        this.act(actor, toCall > 0 ? { type: "call" } : { type: "check" });
      }
      return deliveries.at(-1) as HeroView;
    },
  };
}

const seatsOf = (...stacks: number[]): SeatInit[] =>
  stacks.map((stack, i) => ({
    playerId: i === 0 ? HERO : `cpu${i}`,
    stack,
  }));

const OPTS: PresentationOptions = {
  speed: "standard",
  flush: false,
  holdThroughSeq: null,
};

/** 時刻を進めながら、表示が最新に追いつくまで displayed を集める（タイマーの代わり）。 */
function playOut(
  state: PresentationState,
  authoritative: HeroView,
  options: PresentationOptions = OPTS,
  start = 1_000,
): { frames: HeroView[]; state: PresentationState; elapsed: number } {
  let now = start;
  let s = settle(state, authoritative, now, options);
  const frames = [displayedView(s, authoritative)];
  for (let guard = 0; guard < 1_000 && !isSynced(s, authoritative); guard++) {
    const due = nextDueAt(s, authoritative, options);
    if (due === null) break;
    now = Math.max(now, due);
    s = settle(s, authoritative, now, options);
    frames.push(displayedView(s, authoritative));
  }
  return { frames, state: s, elapsed: now - start };
}

/** 最初の Hand を受け取った状態（そのセッションの最初の Hand は最新に合わせる）。 */
function firstHand(view: HeroView): PresentationState {
  return receive(INITIAL_PRESENTATION, view, null);
}

describe("authoritative と displayed の分離（D143）", () => {
  it("最初の Hand は最新に合わせ、表示が追いついていれば displayed は authoritative そのもの（操作を持つ）", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    t.act("cpu1", { type: "call" });
    const auth = t.act("cpu2", { type: "call" });
    const s = firstHand(auth);
    expect(isSynced(s, auth)).toBe(true);
    expect(displayedView(s, auth)).toBe(auth);
    expect(auth.legalActions).not.toBeNull();
  });

  it("途中の時点の卓は表示済みの Event の prefix から作り、操作（legalActions）を持たない", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const before = t.deliveries[0] as HeroView;
    const s = firstHand(before);
    t.act("cpu1", { type: "call" });
    const auth = t.act("cpu2", { type: "call" });
    // Hero の手番が来た View を受けても、表示はまだ前の時点（CPU 2 人の Action を出す前）。
    const received = receive(s, auth, null);
    const shown = displayedView(received, auth);
    expect(lastSeqOf(shown)).toBe(lastSeqOf(before));
    expect(shown.legalActions).toBeNull();
    expect(pendingSteps(received, auth).map((p) => p.kind)).toEqual([
      "action",
      "action",
    ]);
  });

  it("Hero に見えない Event の分の seq の飛び番は欠落として扱わず、見える step だけを順に出す", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const auth = t.passive();
    const seqs = auth.log.map((e) => e.seq);
    // 他者の HOLE_CARD_DEALT・DECK_SHUFFLED の分、Hero の seq は 1 ずつ進まない。
    expect(
      seqs.some((seq, i) => i > 0 && seq !== (seqs[i - 1] as number) + 1),
    ).toBe(true);
    const { frames } = playOut(firstHand(t.deliveries[0] as HeroView), auth);
    const shownSeqs = frames.map(lastSeqOf);
    // 表示の位置は単調に進み、最後は authoritative に一致する。
    expect([...shownSeqs].sort((a, b) => a - b)).toEqual(shownSeqs);
    expect(frames.at(-1)).toBe(auth);
  });

  it("同じ View の重複・古い View の遅着は表示の位置を動かさない（REST / SSE の両方から届いても二重に演出しない）", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    const mid = t.act("cpu1", { type: "call" });
    const latest = t.act("cpu2", { type: "call" });
    const s = settle(firstHand(first), latest, 0, OPTS);
    // 1 step 出した後に、同じ View・古い View を何度受けても、同じ状態のまま（同じ step を出し直さない）。
    expect(receive(s, latest, null)).toBe(s);
    expect(receive(receive(s, latest, null), latest, null)).toBe(s);
    // useHandSession は古い View で authoritative を巻き戻さない（selectLatestView）。仮に届いても表示は戻らない。
    expect(
      lastSeqOf(displayedView(receive(s, mid, null), mid)),
    ).toBeLessThanOrEqual(lastSeqOf(mid));
    const { frames } = playOut(s, latest);
    const steps = frames.map(lastSeqOf);
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("表示待ちが上限を超えたら古い分は動きを省いて表示済みにし（有界のキュー）、最後の卓の内容は欠けない", () => {
    const t = table({
      seats: seatsOf(200, 200, 200, 200, 200, 200, 200, 200),
      button: "cpu1",
    });
    const first = t.deliveries[0] as HeroView;
    const auth = t.passive();
    const all = stepsOf(auth).filter((s) => s.endSeq > lastSeqOf(first));
    expect(all.length).toBeGreaterThan(PRESENTATION_MAX_PENDING_STEPS);
    const r = receive(firstHand(first), auth, null);
    expect(pendingSteps(r, auth)).toHaveLength(PRESENTATION_MAX_PENDING_STEPS);
    const { frames } = playOut(r, auth);
    expect(frames.at(-1)).toBe(auth);
    expect(auth.awards.length).toBeGreaterThan(0);
  });
});

describe("Street と Board の公開順序", () => {
  it("連続する CPU の Action のあと、Flop（3 枚を 1 step）→ Turn → River の順に出し、未来の Board を先に出さない", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    const auth = t.passive();
    const { frames } = playOut(firstHand(first), auth);
    const boards = frames.map((f) => f.board.length);
    // Board の枚数は 0 → 3 → 4 → 5 と増えるだけ（途中で減らない・飛ばさない）。
    const distinct = boards.filter((n, i) => i === 0 || n !== boards[i - 1]);
    expect(distinct).toEqual([0, 3, 4, 5]);
    // 各時点の卓の Board は、その時点までの BOARD_DEALT の札だけ（Future Cards が無い）。
    for (const f of frames) {
      const dealt = f.log
        .filter((e) => e.type === "BOARD_DEALT")
        .flatMap((e) => (e.type === "BOARD_DEALT" ? e.cards : []));
      expect(f.board.map(cardToString)).toEqual(dealt.map(cardToString));
    }
  });

  it("Hero の裁定（DEALER_RULING）とそれで決まった Action は 1 step（Replay と同じ区切り）", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    t.act("cpu1", { type: "call" });
    t.act("cpu2", { type: "call" });
    const before = t.deliveries.at(-1) as HeroView;
    const auth = t.physical(HERO, [
      { type: "declare", declaration: { kind: "check" } },
    ]);
    const steps = pendingSteps(receive(firstHand(before), auth, null), auth);
    const rulingStep = steps.find((s) =>
      s.events.some((e) => e.type === "DEALER_RULING"),
    );
    expect(rulingStep?.events.map((e) => e.type)).toEqual([
      "DEALER_RULING",
      "ACTION_TAKEN",
    ]);
    // 宣言は別の step（Replay の step と同じ）。
    expect(steps[0]?.events.map((e) => e.type)).toEqual(["PLAYER_DECLARED"]);
  });
});

describe("Showdown・Side / Split Pot・Uncalled と実額", () => {
  it("All-in の Runout: 公開の札は CARDS_TABLED の step まで出さず、Main / Side Pot・Uncalled を順に出し、最後の卓の実額は authoritative と同じ", () => {
    // Hero 50・cpu1 120・cpu2 300 が Preflop で All-in。Hero が最強（AA）、cpu1 が次（KK）。
    const t = table({
      seats: seatsOf(50, 120, 300),
      button: "cpu1",
      holes: { hero: "As Ad", cpu1: "Ks Kd", cpu2: "7c 2h" },
      board: "3c 8d 9s Jh 4c",
    });
    const first = t.deliveries[0] as HeroView;
    t.act("cpu1", { type: "all_in" });
    t.act("cpu2", { type: "all_in" });
    const auth = t.act(HERO, { type: "all_in" });
    expect(auth.status).toBe("complete");
    const { frames } = playOut(firstHand(first), auth);
    const kinds = pendingSteps(receive(firstHand(first), auth, null), auth).map(
      (s) => s.kind,
    );
    expect(kinds).toContain("showdown");
    expect(kinds.filter((k) => k === "pot").length).toBeGreaterThanOrEqual(3);
    // 公開の前の時点の卓には CPU の札が無い。
    const tabledAt = frames.findIndex((f) =>
      f.log.some((e) => e.type === "CARDS_TABLED" && e.playerId === "cpu1"),
    );
    for (const f of frames.slice(0, tabledAt)) {
      expect(
        f.seats.find((s) => s.playerId === "cpu1")?.holeCards ?? null,
      ).toBeNull();
    }
    // Pot の配分は Main（Hero）→ Side（cpu1）→ 返却の順で、合計は配る前の Chip と一致する（実額）。
    const awards = auth.log.filter((e) => e.type === "POT_AWARDED");
    expect(awards.length).toBeGreaterThanOrEqual(2);
    const last = frames.at(-1) as HeroView;
    expect(last).toBe(auth);
    expect(last.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(470);
    expect(last.awards.find((a) => a.playerId === HERO)?.amount).toBe(150);
  });

  it("Split Pot（Board が役）は複数の勝者の配分を 1 つの POT_AWARDED の step で出し、内容を省かない", () => {
    const t = table({
      seats: seatsOf(100, 100, 100),
      button: "cpu1",
      holes: { hero: "2c 3d", cpu1: "2h 3s", cpu2: "4c 5d" },
      board: "As Ks Qs Js Ts",
    });
    const first = t.deliveries[0] as HeroView;
    const auth = t.passive();
    const { frames } = playOut(firstHand(first), auth);
    const potAward = auth.log.find((e) => e.type === "POT_AWARDED");
    expect(potAward?.type === "POT_AWARDED" && potAward.awards.length).toBe(3);
    expect(frames.at(-1)).toBe(auth);
  });

  it("Fold で終わる Hand は Uncalled の返却と Pot を出し、Showdown の step を作らない", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    t.act("cpu1", { type: "raise", amount: 40 });
    t.act("cpu2", { type: "fold" });
    const auth = t.act(HERO, { type: "fold" });
    const kinds = pendingSteps(receive(firstHand(first), auth, null), auth).map(
      (s) => s.kind,
    );
    expect(kinds).not.toContain("showdown");
    expect(kinds).toContain("pot");
    expect(kinds.at(-1)).toBe("finish");
  });
});

describe("速度・Skip・演出なし・Hero の手番の到来", () => {
  function longHand() {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    return { first, auth: t.passive() };
  }

  it("4 段階の速度は所要時間だけを変え、どの速度でも最後の卓は authoritative と同じ（演出なしは 1 回で追いつく）", () => {
    const { first, auth } = longHand();
    const elapsed: Record<string, number> = {};
    for (const speed of PRESENTATION_SPEEDS) {
      const run = playOut(firstHand(first), auth, { ...OPTS, speed });
      expect(run.frames.at(-1)).toBe(auth);
      elapsed[speed] = run.elapsed;
    }
    expect(elapsed["standard"]).toBeGreaterThan(elapsed["fast"] as number);
    expect(elapsed["fast"]).toBeGreaterThan(elapsed["turbo"] as number);
    expect(elapsed["none"]).toBe(0);
    const instant = settle(firstHand(first), auth, 0, {
      ...OPTS,
      speed: "none",
    });
    expect(isSynced(instant, auth)).toBe(true);
  });

  it("Skip（syncNow）は残りの演出を省いて最新の公開状態（Showdown・Pot の配分を含む）に合わせる", () => {
    const { first, auth } = longHand();
    const midway = settle(receive(firstHand(first), auth, null), auth, 0, OPTS);
    expect(isSynced(midway, auth)).toBe(false);
    const skipped = syncNow(midway, auth, null);
    expect(displayedView(skipped, auth)).toBe(auth);
    expect(displayedView(skipped, auth).awards).toEqual(auth.awards);
  });

  it("Hero の手番が来ていれば通常の演出を速め、Showdown の公開と Pot の配分は速めない", () => {
    const { auth } = longHand();
    const steps = stepsOf(auth);
    const action = steps.find((s) => s.kind === "action");
    const pot = steps.find((s) => s.kind === "pot");
    if (action === undefined || pot === undefined) throw new Error("step");
    expect(stepDurationMs(action, "standard", true)).toBe(
      Math.round(PRESENTATION_STEP_MS.action * PRESENTATION_HERO_TURN_SCALE),
    );
    expect(stepDurationMs(pot, "standard", true)).toBe(
      PRESENTATION_STEP_MS.pot,
    );
    for (const speed of PRESENTATION_SPEEDS) {
      expect(stepDurationMs(action, speed, true)).toBeLessThanOrEqual(
        stepDurationMs(action, speed, false),
      );
    }
  });

  it("連続する CPU の Action の後に Hero の手番が来ると、通常の速さより早く追いつき、順序は保つ", () => {
    const t = table({
      seats: seatsOf(200, 200, 200, 200, 200, 200),
      button: "cpu1",
    });
    const first = t.deliveries[0] as HeroView;
    // 6 人卓（Button = cpu1）。Hero（BB の 1 つ後ろ以外）まで CPU が続けて Call する。
    let auth = first;
    while (auth.legalActions === null && auth.status === "in_progress") {
      const actor = auth.actorId as string;
      auth = t.act(actor, { type: "call" });
    }
    expect(auth.legalActions).not.toBeNull();
    const boosted = playOut(firstHand(first), auth);
    const normal = playOut(firstHand(first), { ...auth, legalActions: null });
    expect(boosted.frames.map(lastSeqOf)).toEqual(normal.frames.map(lastSeqOf));
    expect(boosted.elapsed).toBeLessThan(normal.elapsed);
    expect(boosted.frames.at(-1)).toBe(auth);
  });
});

describe("優先する表示と ETIQUETTE の接続点", () => {
  it("CPU の障害のダイアログ（flush）が出ている間は、残りの演出を省いて最新に合わせる", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    t.act("cpu1", { type: "call" });
    const auth = t.act("cpu2", { type: "raise", amount: 40 });
    const s = settle(firstHand(first), auth, 0, { ...OPTS, flush: true });
    expect(isSynced(s, auth)).toBe(true);
  });

  it("holdThroughSeq の step までは出し、それより先は止める（Skip・同期も越えない）。外せば続きを出す", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    t.act("cpu1", { type: "call" });
    t.act("cpu2", { type: "call" });
    const before = t.deliveries.at(-1) as HeroView;
    t.physical(HERO, [{ type: "declare", declaration: { kind: "check" } }]);
    const auth = t.passive();
    const ruling = auth.log.find((e) => e.type === "DEALER_RULING");
    if (ruling === undefined) throw new Error("ruling");
    const hold = { ...OPTS, holdThroughSeq: ruling.seq };
    const held = playOut(firstHand(before), auth, hold);
    const shown = held.frames.at(-1) as HeroView;
    // 裁定とそれで決まった Action の step まで出し、Flop は出さない。
    expect(shown.log.some((e) => e.seq === ruling.seq)).toBe(true);
    expect(shown.board).toHaveLength(0);
    expect(isSynced(syncNow(held.state, auth, ruling.seq), auth)).toBe(false);
    expect(nextDueAt(held.state, auth, hold)).toBeNull();
    // 確認されたら（hold を外す）続きを出す。
    expect(isSynced(syncNow(held.state, auth, null), auth)).toBe(true);
  });
});

describe("Hero の送信前の整合性（D143・D146）", () => {
  it("Hero が見ている卓（displayed）が最新と同じ Hand・同じ lastSeq のときだけ送れる", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    const mid = t.act("cpu1", { type: "call" });
    const latest = t.act("cpu2", { type: "call" });
    expect(canSendFrom(latest, latest)).toBe(true);
    // 演出の途中の卓から送ろうとした（未表示の最新の lastSeq を先取りしない）。
    const midway = receive(
      settle(firstHand(first), mid, 0, OPTS),
      latest,
      null,
    );
    expect(canSendFrom(displayedView(midway, latest), latest)).toBe(false);
    expect(canSendFrom(first, latest)).toBe(false);
    expect(canSendFrom(latest, null)).toBe(false);
    const other = table({
      handId: "h2",
      seats: seatsOf(200, 200, 200),
      button: "cpu1",
    });
    expect(canSendFrom(other.deliveries[0] as HeroView, latest)).toBe(false);
    // 同期の後は、表示中の卓（= 最新）の lastSeq で送れる。
    const synced = syncNow(midway, latest, null);
    expect(canSendFrom(displayedView(synced, latest), latest)).toBe(true);
  });
});

describe("Hand の切り替え・人数・Session の種類", () => {
  it("続く Hand（次の Hand・次の Drill）は Hand の始まり（Blind・Hero の札）までを出してから、続きの CPU の Action を演出する", () => {
    const h1 = table({
      handId: "h1",
      seats: seatsOf(200, 200, 200),
      button: "cpu1",
    });
    const end1 = h1.passive();
    const shown1 = firstHand(end1);
    const h2 = table({
      handId: "h2",
      seats: seatsOf(200, 200, 200),
      button: "cpu2",
    });
    const auth2 = h2.act((h2.deliveries[0] as HeroView).actorId as string, {
      type: "call",
    });
    const r = receive(shown1, auth2, null);
    const shown = displayedView(r, auth2);
    expect(shown.handId).toBe("h2");
    expect(
      shown.seats.find((s) => s.playerId === HERO)?.holeCards,
    ).toHaveLength(2);
    expect(shown.log.some((e) => e.type === "ACTION_TAKEN")).toBe(false);
    expect(pendingSteps(r, auth2).map((s) => s.kind)).toEqual(["action"]);
  });

  it("Tournament の Ante（per_player / big_blind_ante）は Hand の始まりとして一度に出し、Pot の実額は authoritative と同じ", () => {
    for (const kind of ["per_player", "big_blind_ante"] as const) {
      const config: TableConfig = {
        ...CONFIG,
        ante: { kind, amount: kind === "per_player" ? 2 : 10 },
      };
      const prev = table({
        handId: "p",
        seats: seatsOf(200, 200, 200),
        button: "cpu1",
      });
      const t = table({
        seats: seatsOf(200, 200, 200),
        button: "cpu1",
        config,
      });
      const auth = t.act("cpu1", { type: "call" });
      const r = receive(firstHand(prev.passive()), auth, null);
      const shown = displayedView(r, auth);
      expect(shown.log.some((e) => e.type === "ANTE_POSTED")).toBe(true);
      expect(pendingSteps(r, auth).map((s) => s.kind)).toEqual(["action"]);
      const { frames } = playOut(r, auth);
      expect(frames.at(-1)).toBe(auth);
    }
  });

  it.each([2, 3, 4, 5, 6, 7, 8])(
    "%i 人卓の Hand を最後まで演出しても、順序を保って authoritative に一致し、どの時点も Chip の総量が変わらない",
    (n) => {
      const stacks = Array.from({ length: n }, () => 300);
      const t = table({ seats: seatsOf(...stacks), button: "cpu1" });
      const first = t.deliveries[0] as HeroView;
      const auth = t.passive();
      // 1 Command ごとに届いた View を順に受けながら演出する（大量の到着を含む）。
      let s = firstHand(first);
      let now = 0;
      const frames: HeroView[] = [];
      for (const view of t.deliveries) {
        s = settle(s, view, now, OPTS);
        frames.push(displayedView(s, view));
        now += 100;
      }
      const run = playOut(s, auth, OPTS, now);
      frames.push(...run.frames);
      expect(frames.at(-1)).toBe(auth);
      const seqs = frames.map(lastSeqOf);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      for (const f of frames) {
        const committed = f.seats.reduce((sum, x) => sum + x.stack, 0) + f.pot;
        const inPlay =
          f.status === "complete"
            ? f.seats.reduce((sum, x) => sum + x.stack, 0)
            : committed;
        expect(inPlay).toBe(300 * n);
      }
    },
  );
});

describe("speed の一覧", () => {
  it("標準 / 高速 / 超高速 / 演出なし の 4 段階", () => {
    const speeds: PresentationSpeed[] = ["standard", "fast", "turbo", "none"];
    expect(PRESENTATION_SPEEDS).toEqual(speeds);
  });
});

describe("描画の中で時刻に依らずに反映する分（settleWithoutClock）", () => {
  it("標準の速度では受け取るだけ（step は時刻で出す）・演出なしと障害の優先では最新に合わせる", () => {
    const t = table({ seats: seatsOf(200, 200, 200), button: "cpu1" });
    const first = t.deliveries[0] as HeroView;
    const auth = t.act("cpu1", { type: "call" });
    const s = firstHand(first);
    expect(isSynced(settleWithoutClock(s, auth, OPTS), auth)).toBe(false);
    expect(
      isSynced(settleWithoutClock(s, auth, { ...OPTS, speed: "none" }), auth),
    ).toBe(true);
    expect(
      isSynced(settleWithoutClock(s, auth, { ...OPTS, flush: true }), auth),
    ).toBe(true);
  });
});

// #226 client: ETIQUETTE の確認（Ack）を待つ裁定より先を、どの経路でも出さない（有界のキュー・最初の Hand・続く Hand・Skip・
// 演出なし・障害の優先）。Ack の要る裁定（check_facing_bet）の後に、24 step を超える公開 Event（CPU の Action・Board・Showdown・
// Pot の配分）が一度に届く 8 人卓で確かめる（server は Ack まで CPU を進めないが、Hero の手番で Engine が決定論で置く Event や、
// 再接続・初回の受信で溜まった分は届きうる）。
describe("ETIQUETTE の確認待ち（holdThroughSeq）と有界のキュー（#226）", () => {
  /** 8 人卓で、Hero が Call 額のある局面で Check を宣言して check_facing_bet の裁定を受け、Call してから Hand の終わりまで進める。 */
  function heldHand(handId = "h1") {
    const t = table({
      handId,
      seats: seatsOf(200, 200, 200, 200, 200, 200, 200, 200),
      button: "cpu1",
    });
    const first = t.deliveries[0] as HeroView;
    while (t.state.players[t.state.actorIndex ?? -1]?.playerId !== HERO) {
      const actor = t.state.players[t.state.actorIndex ?? -1]?.playerId;
      if (actor === undefined) throw new Error("actor");
      t.act(actor, { type: "call" });
    }
    t.physical(HERO, [{ type: "declare", declaration: { kind: "check" } }]);
    t.act(HERO, { type: "call" });
    const auth = t.passive();
    const ruling = auth.log.find(
      (e) => e.type === "DEALER_RULING" && e.playerId === HERO,
    );
    if (ruling?.type !== "DEALER_RULING") throw new Error("ruling");
    expect(ruling.notes).toContain("check_facing_bet");
    return { t, first, auth, hold: ruling.seq };
  }

  /** 表示が hold の裁定の step まで（裁定は見える・それより後の Board・Showdown・Pot の配分は見えない）。 */
  function expectHeldAt(
    s: PresentationState,
    auth: HeroView,
    hold: number,
  ): void {
    const shown = displayedView(s, auth);
    expect(shown.log.some((e) => e.seq === hold)).toBe(true);
    expect(shown.log.every((e) => e.seq <= hold || isSameStep(e))).toBe(true);
    expect(shown.board).toHaveLength(0);
    expect(shown.status).toBe("in_progress");
    expect(shown.awards).toHaveLength(0);
    expect(isSynced(s, auth)).toBe(false);
    function isSameStep(e: HandEvent): boolean {
      const step = stepsOf(auth).find((st) =>
        st.events.some((x) => x.seq === hold),
      );
      return step?.events.some((x) => x.seq === e.seq) ?? false;
    }
  }

  /** 表示済みの位置が、hold の裁定を含む step の終わりより先に無い。 */
  function expectNotBeyond(
    s: PresentationState,
    auth: HeroView,
    hold: number,
  ): void {
    const holdStep = stepsOf(auth).find((st) =>
      st.events.some((e) => e.seq === hold),
    );
    const next = stepsOf(auth).find((st) => (st.events[0]?.seq ?? 0) > hold);
    expect(holdStep).toBeDefined();
    expect(s.shownSeq).toBeLessThan(next?.events[0]?.seq ?? Infinity);
  }

  it("前提: 裁定の後の未表示の step は上限（24）を超え、裁定は古い側にある", () => {
    const { first, auth, hold } = heldHand();
    const pending = stepsOf(auth).filter((s) => s.endSeq > lastSeqOf(first));
    expect(pending.length).toBeGreaterThan(PRESENTATION_MAX_PENDING_STEPS + 5);
    const index = pending.findIndex((s) =>
      s.events.some((e) => e.seq === hold),
    );
    expect(index).toBeLessThan(pending.length - PRESENTATION_MAX_PENDING_STEPS);
    expect(auth.status).toBe("complete");
  });

  it("同じ Hand の receive（有界のキュー）は、古い step を省いても hold の裁定より先へ進めない", () => {
    const { first, auth, hold } = heldHand();
    const r = receive(firstHand(first), auth, hold);
    // 裁定より前の step は省かれてもよいが、裁定の step より先は表示済みにしない。
    expectNotBeyond(r, auth, hold);
    const held = playOut(r, auth, { ...OPTS, holdThroughSeq: hold });
    expectHeldAt(held.state, auth, hold);
  });

  it("settle / syncNow（Skip）/ settleWithoutClock（演出なし）/ 障害の優先（flush）のどれでも hold を越えない", () => {
    const { first, auth, hold } = heldHand();
    const s0 = firstHand(first);
    const options = { ...OPTS, holdThroughSeq: hold };
    expectHeldAt(settle(s0, auth, 10_000_000, options), auth, hold);
    expectHeldAt(syncNow(s0, auth, hold), auth, hold);
    for (const speed of PRESENTATION_SPEEDS) {
      const o = { ...options, speed };
      const s = settleWithoutClock(s0, auth, o);
      if (speed === "none") expectHeldAt(s, auth, hold);
      else expectNotBeyond(s, auth, hold);
      expectHeldAt(playOut(s, auth, o).state, auth, hold);
    }
    // 障害のダイアログ（flush）と確認待ちが同時: 最新へ寄せるのは hold の裁定まで（障害を先に出し、確認は解決の後）。
    const flushed = settle(s0, auth, 0, { ...options, flush: true });
    expectHeldAt(flushed, auth, hold);
    expectHeldAt(
      settleWithoutClock(s0, auth, { ...options, flush: true }),
      auth,
      hold,
    );
    expect(nextDueAt(flushed, auth, options)).toBeNull();
  });

  it("このセッションで最初の Hand（再読み込み・初回の受信: handId が null）でも、最新ではなく hold の裁定の step までに合わせる", () => {
    const { auth, hold } = heldHand();
    const s = receive(INITIAL_PRESENTATION, auth, hold);
    expectHeldAt(s, auth, hold);
    expectHeldAt(syncNow(INITIAL_PRESENTATION, auth, hold), auth, hold);
    // 確認待ちが無ければ従来どおり最新に合わせる（D140）。
    expect(isSynced(receive(INITIAL_PRESENTATION, auth, null), auth)).toBe(
      true,
    );
  });

  it("続く Hand（次の Hand・Drill の Hand）を受け取ったときも、Hand の始まりの後の切り詰めで hold を越えない", () => {
    const prev = table({
      handId: "h0",
      seats: seatsOf(200, 200, 200, 200, 200, 200, 200, 200),
      button: "cpu2",
    });
    const shown0 = firstHand(prev.passive());
    const { auth, hold } = heldHand("h1");
    const r = receive(shown0, auth, hold);
    expect(r.handId).toBe("h1");
    expectNotBeyond(r, auth, hold);
    expectHeldAt(syncNow(shown0, auth, hold), auth, hold);
  });

  it("確認（hold を外す）の後は、残りを演出して最新（Board・Showdown・Pot の配分）に追いつく。有界のキューもそこから効く", () => {
    const { first, auth, hold } = heldHand();
    const held = syncNow(firstHand(first), auth, hold);
    const released = receive(held, auth, null);
    expect(pendingSteps(released, auth).length).toBeLessThanOrEqual(
      PRESENTATION_MAX_PENDING_STEPS,
    );
    const { frames } = playOut(released, auth);
    expect(frames.at(-1)).toBe(auth);
    expect(auth.awards.length).toBeGreaterThan(0);
    // 表示の位置は単調に進む（hold の前へ戻らない）。
    const seqs = frames.map(lastSeqOf);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(seqs[0]).toBeGreaterThanOrEqual(hold);
  });

  it("hold の裁定がまだ届いていない（etiquette の状態が View より先に届いた）ときは、その seq までを出す", () => {
    const { first, auth, hold } = heldHand();
    const beforeRuling = {
      ...auth,
      log: auth.log.filter((e) => e.seq < hold),
    } as HeroView;
    const s = syncNow(firstHand(first), beforeRuling, hold);
    expect(isSynced(s, beforeRuling)).toBe(true);
    expectHeldAt(syncNow(s, auth, hold), auth, hold);
  });
});
