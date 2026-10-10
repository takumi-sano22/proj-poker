// UX-06（#221）の技術検証: Live の演出（D140・docs/06 §16.4）の時系列を、Hero に見える HeroView.log だけから復元できるか。
// 製品のコードは変えない検証テスト。表示側の手順（pendingEvents / stepViews / consume）はこのファイルの中だけに置いた参照実装で、
// UX-07（#222）の Presentation Controller が守る契約の下敷きにする（結果の整理は docs/taskLog/issue-221-live-presentation-verification.md）。
// 確かめること:
// - サーバーが配る単位（Command 1 回の追記 = 1 通の View）は複数の Event をまとめて運ぶので、表示側が seq で分けて 1 つずつ演出できる
// - 連続する CPU Action・Flop / Turn / River・通常の Showdown・All-in の後の Runout・Main / Side / Split Pot・Fold で終わる Hand で、
//   演出に要る事実（誰が・何を・いくら・どの札・どの Pot を誰に）が Hero に見える Event にそろっている
// - 途中の時点の卓（prefix の Projection）にも、他者の Hidden Cards・Future Cards・engine / system の Event が入らない
// - 重複・順不同・途中の View の欠落があっても、最後の View を受け取れば同じ時系列になる（View は毎回、見える Event の全量を運ぶ）
import { describe, expect, it } from "vitest";
import type { HandEvent, HandEventType, SeatInit } from "./hand-events.js";
import {
  applyAction,
  applyPhysicalActions,
  startHand,
  type HandProgress,
  type PhysicalProgress,
} from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import type { PlayerAction } from "./legal-actions.js";
import { projectHeroView, type HeroView } from "./projection.js";
import type { PhysicalAction } from "./ruling.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";
import { stackedDeck } from "./testing/stacked-deck.js";
import {
  hiddenMarkers,
  leakedCards,
  tamperHiddenEvents,
  testMetadata,
} from "./testing/view-leaks.js";

const HERO = "hero";
const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

// 3 人卓。Button は cpu1 なので SB = cpu2・BB = hero。Preflop は cpu1 → cpu2 → hero、Postflop は cpu2 → hero → cpu1 の順。
const BUTTON = "cpu1";
function seatsOf(hero: number, cpu1: number, cpu2: number): SeatInit[] {
  return [
    { playerId: HERO, stack: hero },
    { playerId: "cpu1", stack: cpu1 },
    { playerId: "cpu2", stack: cpu2 },
  ];
}

type Step =
  | readonly [player: string, action: PlayerAction]
  | readonly [player: string, physical: readonly PhysicalAction[]];

/**
 * Hand を進め、サーバーが配る単位（Hand の開始と、Command 1 回の追記ごと）の Hero の View を返す。
 * Orchestrator は追記のたびに projectHeroView の結果を 1 通配る（hand-orchestrator.ts の commit）ので、それと同じ粒度。
 * Metadata（system の Event）も置き、Hero から見た seq に穴が開く状況で確かめる。
 */
function playHand(
  seats: readonly SeatInit[],
  holes: Readonly<Record<string, string>>,
  board: string,
  steps: readonly Step[],
): { events: HandEvent[]; deliveries: HeroView[] } {
  const started = startHand({
    handId: "presentation",
    seats,
    buttonPlayerId: BUTTON,
    config: CONFIG,
    deal: { deck: stackedDeck(seats, BUTTON, holes, board) },
    metadata: testMetadata(seats),
  });
  if (!started.ok) throw new Error(started.error.message);
  const events = [...started.value.events];
  let state: HandState = started.value.state;
  const deliveries = [projectHeroView(events, HERO)];
  for (const [player, input] of steps) {
    const result:
      | { ok: true; value: HandProgress | PhysicalProgress }
      | { ok: false; error: { message: string } } = Array.isArray(input)
      ? applyPhysicalActions(state, player, input, CONFIG)
      : applyAction(state, player, input as PlayerAction);
    if (!result.ok) throw new Error(`${player}: ${result.error.message}`);
    events.push(...result.value.events);
    state = result.value.state;
    deliveries.push(projectHeroView(events, HERO));
  }
  return { events, deliveries };
}

// ---- 表示側の参照実装（UX-07 の契約の下敷き。製品のコードではない） ----

function lastSeqOf(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/** 受け取った View のうち、まだ表示に積んでいない Event（seq が表示済みより大きいもの）を seq の順に返す。 */
function pendingEvents(view: HeroView, displayedSeq: number): HandEvent[] {
  return view.log.filter((e) => e.seq > displayedSeq);
}

/** 見える Event の列の各時点の卓（Replay の replaySteps と同じ prefix の Projection。操作はさせないので legalActions は null）。 */
function stepViews(log: readonly HandEvent[]): HeroView[] {
  return log.map((_, i) => ({
    ...projectHeroView(log.slice(0, i + 1), HERO),
    legalActions: null,
  }));
}

/**
 * REST の応答と SSE の Push を届いた順に受け、表示のキューへ積む（重複・古い View は seq で捨てる）。
 * authoritative は seq の最も進んだ View（操作の可否・lastSeq の判断に使う唯一の View）。
 */
function consume(deliveries: readonly HeroView[]): {
  queued: HandEvent[];
  authoritative: HeroView | null;
} {
  const queued: HandEvent[] = [];
  let authoritative: HeroView | null = null;
  let queuedSeq = -1;
  for (const view of deliveries) {
    if (authoritative === null || lastSeqOf(view) > lastSeqOf(authoritative)) {
      authoritative = view;
    }
    const fresh = pendingEvents(view, queuedSeq);
    queued.push(...fresh);
    queuedSeq = Math.max(queuedSeq, lastSeqOf(view));
  }
  return { queued, authoritative };
}

const typesOf = (events: readonly HandEvent[]): HandEventType[] =>
  events.map((e) => e.type);

/** 1 通の View に新しく載った Event の種類（サーバーが 1 回の追記でまとめて運ぶ単位）。 */
function batches(deliveries: readonly HeroView[]): HandEventType[][] {
  return deliveries.map((v, i) =>
    typesOf(
      pendingEvents(v, i === 0 ? -1 : lastSeqOf(deliveries[i - 1] as HeroView)),
    ),
  );
}

/**
 * 全時点の卓に、その時点の Hero が知り得ない札・Deck・system の記録が無いこと。Future Cards は、その時点までの全 Event で畳んだ
 * State の Board と一致すること（先の Board が混ざらない）で見る。見えない Event の中身を差し替えても時系列が変わらないことも見る。
 */
function expectNoLeakInTimeline(events: readonly HandEvent[]): void {
  const final = projectHeroView(events, HERO);
  const steps = stepViews(final.log);
  steps.forEach((step, i) => {
    const seq = (final.log[i] as HandEvent).seq;
    const truth = foldHandEvents(events.filter((e) => e.seq <= seq));
    expect(leakedCards(step, truth, HERO)).toEqual([]);
    expect(hiddenMarkers(step)).toEqual([]);
    expect(step.board).toEqual(truth.board);
  });
  const tampered = projectHeroView(tamperHiddenEvents(events, HERO), HERO);
  expect(stepViews(tampered.log)).toEqual(steps);
}

/** 各時点の卓で Chip の総量が保たれる（Σ Stack + Pot が開始時の合計。Uncalled の返却・Pot の配分を二重に数えない）。 */
function expectChipsConservedInTimeline(
  events: readonly HandEvent[],
  total: number,
): void {
  for (const step of stepViews(projectHeroView(events, HERO).log)) {
    const stacks = step.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(stacks + step.pot).toBe(total);
  }
}

// ---- Scenario ----

describe("Live の演出の時系列を HeroView.log だけから復元できる（UX-06・#221）", () => {
  it("連続する CPU Action・Hero の物理的な操作・Flop / Turn / River・通常の Showdown を 1 つずつ並べられる", () => {
    const { events, deliveries } = playHand(
      seatsOf(1000, 1000, 1000),
      { hero: "As Ad", cpu1: "Ks Kd", cpu2: "Qs Qd" },
      "2c 7h 9d Jc 3s",
      [
        ["cpu1", { type: "call" }],
        ["cpu2", { type: "call" }],
        [HERO, [{ type: "declare", declaration: { kind: "check" } }]],
        ["cpu2", { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
        ["cpu2", { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
        ["cpu2", { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
      ],
    );

    // サーバーが配る 1 通に複数の Event が載る（表示側が分けないと、Flop の 3 枚・Showdown が一度に出る）。
    expect(batches(deliveries)).toEqual([
      ["HAND_STARTED", "BLIND_POSTED", "BLIND_POSTED", "HOLE_CARD_DEALT"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN"],
      ["PLAYER_DECLARED", "DEALER_RULING", "ACTION_TAKEN", "BOARD_DEALT"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN", "BOARD_DEALT"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN", "BOARD_DEALT"],
      ["ACTION_TAKEN"],
      ["ACTION_TAKEN"],
      [
        "ACTION_TAKEN",
        "CARDS_TABLED",
        "CARDS_TABLED",
        "CARDS_TABLED",
        "POT_AWARDED",
        "HAND_FINISHED",
      ],
    ]);

    const final = deliveries.at(-1) as HeroView;
    // Board は Street ごとに 1 つの Event で、Flop は 3 枚を 1 つの Event で運ぶ（3 枚を順に出すのは表示側の演出）。
    const boards = final.log.filter((e) => e.type === "BOARD_DEALT");
    expect(boards.map((e) => [e.street, e.cards.length])).toEqual([
      ["flop", 3],
      ["turn", 1],
      ["river", 1],
    ]);
    // 公開は Button の左から（cpu2 → hero → cpu1）。公開の前の時点の卓には、その CPU の札が無い。
    const steps = stepViews(final.log);
    const tabled = final.log.flatMap((e, i) =>
      e.type === "CARDS_TABLED" ? [{ playerId: e.playerId, index: i }] : [],
    );
    expect(tabled.map((t) => t.playerId)).toEqual(["cpu2", HERO, "cpu1"]);
    for (const { playerId, index } of tabled) {
      const seatBefore = (steps[index - 1] as HeroView).seats.find(
        (s) => s.playerId === playerId,
      );
      if (playerId !== HERO) expect(seatBefore?.holeCards).toBeNull();
      const seatAfter = (steps[index] as HeroView).seats.find(
        (s) => s.playerId === playerId,
      );
      expect(seatAfter?.holeCards).not.toBeNull();
    }
    // 勝者と配分は POT_AWARDED に入る（役の名前は公開の札と Board から表示側で決定論に求められる）。
    const awarded = final.log.filter((e) => e.type === "POT_AWARDED");
    expect(awarded).toMatchObject([
      {
        potIndex: 0,
        potTotal: 30,
        eligible: ["cpu2", HERO, "cpu1"],
        awards: [{ playerId: HERO, amount: 30 }],
        showdown: true,
      },
    ]);
    expectNoLeakInTimeline(events);
    expectChipsConservedInTimeline(events, 3000);
  });

  it("All-in の後の Runout と Main / Side Pot・Uncalled の返却を、公開 → Board → Pot ごとの配分の順に並べられる", () => {
    // cpu1 300・cpu2 1000 が All-in、hero が 600 で Call（Stack 全額）。cpu2 の 1000 のうち 400 は誰も Call していないので返る。
    // Main Pot = 300 × 3 = 900（cpu1 の AA）、Side Pot = 300 × 2 = 600（cpu2 の KK が hero の QQ に勝つ）。
    const { events, deliveries } = playHand(
      seatsOf(600, 300, 1000),
      { hero: "Qs Qd", cpu1: "As Ad", cpu2: "Ks Kd" },
      "2c 7h 9d 4s 3h",
      [
        ["cpu1", { type: "all_in" }],
        ["cpu2", { type: "all_in" }],
        [HERO, { type: "call" }],
      ],
    );

    // 最後の 1 通に、Uncalled の返却・全員の公開・3 つの Street・2 つの Pot・終了がまとめて載る。
    expect(batches(deliveries).at(-1)).toEqual([
      "ACTION_TAKEN",
      "UNCALLED_BET_RETURNED",
      "CARDS_TABLED",
      "CARDS_TABLED",
      "CARDS_TABLED",
      "BOARD_DEALT",
      "BOARD_DEALT",
      "BOARD_DEALT",
      "POT_AWARDED",
      "POT_AWARDED",
      "HAND_FINISHED",
    ]);
    const final = deliveries.at(-1) as HeroView;
    expect(
      final.log.find((e) => e.type === "UNCALLED_BET_RETURNED"),
    ).toMatchObject({ playerId: "cpu2", amount: 400 });
    expect(final.log.filter((e) => e.type === "POT_AWARDED")).toMatchObject([
      {
        potIndex: 0,
        potTotal: 900,
        awards: [{ playerId: "cpu1", amount: 900 }],
        showdown: true,
      },
      {
        potIndex: 1,
        potTotal: 600,
        eligible: ["cpu2", HERO],
        awards: [{ playerId: "cpu2", amount: 600 }],
        showdown: true,
      },
    ]);
    // 札の公開は Runout の Board より前（その時点で Board は空。先の札は見えていない）。
    const steps = stepViews(final.log);
    const firstTabled = final.log.findIndex((e) => e.type === "CARDS_TABLED");
    expect((steps[firstTabled] as HeroView).board).toEqual([]);
    // Pot の演出の前の卓の Pot は、Uncalled を返した後の額 = 配る Pot の合計（二重に数えない）。
    const firstAward = final.log.findIndex((e) => e.type === "POT_AWARDED");
    expect((steps[firstAward - 1] as HeroView).pot).toBe(900 + 600);
    expect((steps[firstAward] as HeroView).pot).toBe(600);
    expect(final.pot).toBe(0);
    expectNoLeakInTimeline(events);
    expectChipsConservedInTimeline(events, 1900);
  });

  it("Split Pot（端数あり）を Pot の 1 Event の awards で受け、端数の行き先まで表示できる", () => {
    // cpu1 が Call・cpu2（SB 5）が Fold・hero（BB）が Check。Board の Royal Flush で cpu1 と hero が引き分け、Pot 25 を 12 / 13 に分ける。
    const { events, deliveries } = playHand(
      seatsOf(1000, 1000, 1000),
      { hero: "2c 3d", cpu1: "4c 5d", cpu2: "6c 7d" },
      "Ah Kh Qh Jh Th",
      [
        ["cpu1", { type: "call" }],
        ["cpu2", { type: "fold" }],
        [HERO, { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
        [HERO, { type: "check" }],
        ["cpu1", { type: "check" }],
      ],
    );
    const final = deliveries.at(-1) as HeroView;
    const [pot] = final.log.filter((e) => e.type === "POT_AWARDED");
    expect(pot).toMatchObject({
      potIndex: 0,
      potTotal: 25,
      eligible: [HERO, "cpu1"],
      showdown: true,
    });
    // 端数（1）は Button の左から最初の勝者（hero）へ（oddChipRule: first_left_of_button）。
    expect(pot?.type === "POT_AWARDED" ? pot.awards : []).toEqual([
      { playerId: HERO, amount: 13 },
      { playerId: "cpu1", amount: 12 },
    ]);
    // Fold した cpu2 の札は最後まで出ない（Muck した札を出さない）。
    expect(
      final.seats.find((s) => s.playerId === "cpu2")?.holeCards,
    ).toBeNull();
    expectNoLeakInTimeline(events);
    expectChipsConservedInTimeline(events, 3000);
  });

  it("Fold で Showdown に至らない終了では、札の公開が無く、CPU の札はどの時点の卓にも出ない", () => {
    const { events, deliveries } = playHand(
      seatsOf(1000, 1000, 1000),
      { hero: "As Ad", cpu1: "Ks Kd", cpu2: "Qs Qd" },
      "2c 7h 9d Jc 3s",
      [
        ["cpu1", { type: "fold" }],
        ["cpu2", { type: "fold" }],
      ],
    );
    expect(batches(deliveries).at(-1)).toEqual([
      "ACTION_TAKEN",
      "UNCALLED_BET_RETURNED",
      "POT_AWARDED",
      "HAND_FINISHED",
    ]);
    const final = deliveries.at(-1) as HeroView;
    expect(final.log.some((e) => e.type === "CARDS_TABLED")).toBe(false);
    expect(final.log.filter((e) => e.type === "POT_AWARDED")).toMatchObject([
      {
        potTotal: 10,
        awards: [{ playerId: HERO, amount: 10 }],
        showdown: false,
      },
    ]);
    for (const step of stepViews(final.log)) {
      for (const seat of step.seats) {
        if (seat.playerId !== HERO) expect(seat.holeCards).toBeNull();
      }
    }
    expectNoLeakInTimeline(events);
    expectChipsConservedInTimeline(events, 3000);
  });
});

describe("受信の重複・順不同・欠落・再接続に対する復元（UX-06・#221）", () => {
  const hand = () =>
    playHand(
      seatsOf(1000, 1000, 1000),
      { hero: "As Ad", cpu1: "Ks Kd", cpu2: "Qs Qd" },
      "2c 7h 9d Jc 3s",
      [
        ["cpu1", { type: "call" }],
        ["cpu2", { type: "call" }],
        [HERO, { type: "check" }],
        ["cpu2", { type: "bet", amount: 20 }],
        [HERO, { type: "call" }],
        ["cpu1", { type: "fold" }],
      ],
    );

  it("View だけで最新の卓をそのまま作り直せる（log を projectHeroView に通すと、配られた View と一致する）", () => {
    for (const view of hand().deliveries) {
      expect(projectHeroView(view.log, HERO)).toEqual(view);
    }
  });

  it("Hero から見た seq は連続しない（engine / system / 他者宛ての Event の分が抜ける）ので、欠落の検出に seq の連続を使えない", () => {
    const final = hand().deliveries.at(-1) as HeroView;
    const seqs = final.log.map((e) => e.seq);
    const gaps = seqs.slice(1).filter((s, i) => s !== (seqs[i] as number) + 1);
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("重複・順不同・途中の View の欠落があっても、最後の View を受ければ時系列は全量で、同じ Event を 2 回積まない", () => {
    const { deliveries } = hand();
    const final = deliveries.at(-1) as HeroView;
    const patterns: HeroView[][] = [
      deliveries,
      // REST の応答と SSE の Push で同じ View が 2 回届く
      deliveries.flatMap((v) => [v, v]),
      // 遅れた古い View が新しい View の後に届く
      [
        ...deliveries.slice(0, 3),
        deliveries[5],
        deliveries[2],
        deliveries[4],
        ...deliveries.slice(5),
      ].filter((v): v is HeroView => v !== undefined),
      // 途中の View が届かない（切断中に進んだ）。再接続の最初の View が全量を運ぶ
      [deliveries[0] as HeroView, final],
    ];
    for (const received of patterns) {
      const { queued, authoritative } = consume(received);
      expect(queued).toEqual(final.log);
      expect(authoritative).toEqual(final);
    }
  });

  it("再接続で古いキューを捨てる場合も、見逃した Event は最新の View の log に残る（Replay と同じ prefix で後から見られる）", () => {
    const { deliveries } = hand();
    const before = deliveries[2] as HeroView;
    const latest = deliveries.at(-1) as HeroView;
    const missed = pendingEvents(latest, lastSeqOf(before));
    expect(missed.length).toBeGreaterThan(1);
    // 古いキューを捨てて最新へ同期した後の卓は、全 Event を順に演出し終えた卓と同じ。
    const steps = stepViews(latest.log);
    expect(steps.at(-1)).toEqual({ ...latest, legalActions: null });
  });

  it("Hero の手番が来た View だけが legalActions を持ち、途中の時点の卓（演出中の表示）は操作を持たない", () => {
    const { deliveries } = hand();
    // hero が cpu2 の Bet に答える手番（cpu2 の bet の直後の 1 通）。
    const heroTurn = deliveries.find(
      (v) => v.actorId === HERO && v.street === "flop" && v.currentBet > 0,
    ) as HeroView;
    expect(heroTurn.legalActions?.playerId).toBe(HERO);
    for (const step of stepViews(heroTurn.log)) {
      expect(step.legalActions).toBeNull();
    }
  });
});
