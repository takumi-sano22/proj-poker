// Replay Service（#68・docs/03 §2・D38・D93）。保存済みの Event だけを Hero の視点で一手ずつ再生する材料を作る。
// Re-simulation ではない: Engine・CPU・AI を動かし直さず、Event Log の先頭からの prefix を projectHeroView に渡すだけ（D38）。
// 応答に入るのは Hero に見える Event（public と Hero 宛ての private）から作った値だけで、他者の Hole Cards（Showdown で
// 公開されたもの以外）・Deck・engine / system Visibility の Event・CPU の Persona は入らない（D28・INV-INFO-001）。
// Learning-only Full Reveal と Jump to Important Spot は Phase 5 の Review で扱う（D93）。
import {
  projectHeroView,
  visibleEvents,
  type Card,
  type HandEvent,
  type HeroView,
} from "@proj-poker/engine";
import type { SeatPlayer } from "./config.js";
import type { EventStore, StoredHandSummary } from "./event-store.js";

/** Hand 一覧に出す件数の上限（新しい順）。ローカル単一ユーザーで、画面で選ぶのに足りる数の暫定値。 */
export const REPLAY_LIST_LIMIT = 100;

/** Hand 一覧の 1 行。値はすべて Hero に見える Event から作る。 */
export interface ReplayHandSummary {
  readonly handId: string;
  readonly startedAt: string;
  /** HAND_FINISHED の無い Hand（進行中・AI 障害の後に打ち切った Hand。D88）は null。 */
  readonly finishedAt: string | null;
  readonly complete: boolean;
  readonly bigBlind: number;
  /** Hero の札（配られる前に打ち切った Hand は null）。 */
  readonly heroHoleCards: readonly Card[] | null;
  /** Hero の収支（HAND_FINISHED の Stack − HAND_STARTED の Stack）。未完了の Hand は null。 */
  readonly heroNet: number | null;
}

/** 再生する 1 Hand。steps は Hero に見える Event の prefix ごとの Hero の視点（replaySteps）。 */
export interface ReplayHand {
  readonly handId: string;
  readonly complete: boolean;
  /** この Hand に座った Player の表示情報（席順）。今の卓の設定に無い Player は playerId を名前にする。 */
  readonly players: readonly SeatPlayer[];
  readonly steps: readonly HeroView[];
}

/**
 * Hero に見える Event の prefix ごとの Hero の視点（1 step = 1 Event）。Replay では操作しないので legalActions は持たせない
 * （選べた Action の提示は Phase 5 の Review の範囲）。
 * 例外として、Action に決まった Dealer の裁定（DEALER_RULING・outcome: action）と、その直後の同じ Player の ACTION_TAKEN は
 * 1 step にまとめる。両者は同じ追記で置く 1 つの出来事で（D90）、裁定だけの step では裁定の結果（どの Action になったか）が
 * まだ見えないため。宣言・Chip の操作はそれぞれ 1 step のまま。
 */
export function replaySteps(
  events: readonly HandEvent[],
  heroId: string,
): HeroView[] {
  const visible = visibleEvents(events, heroId);
  const steps: HeroView[] = [];
  visible.forEach((e, i) => {
    const next = visible[i + 1];
    const joinsNext =
      e.type === "DEALER_RULING" &&
      e.outcome === "action" &&
      next?.type === "ACTION_TAKEN" &&
      next.playerId === e.playerId;
    if (joinsNext) return;
    steps.push({
      ...projectHeroView(visible.slice(0, i + 1), heroId),
      legalActions: null,
    });
  });
  return steps;
}

/** 一覧の 1 行を、その Hand の Event（Hero に見える分だけを使う）から作る。 */
export function summarizeReplayHand(
  summary: StoredHandSummary,
  events: readonly HandEvent[],
  heroId: string,
): ReplayHandSummary {
  const visible = visibleEvents(events, heroId);
  const view = projectHeroView(visible, heroId);
  const started = visible.find((e) => e.type === "HAND_STARTED");
  const finished = visible.find((e) => e.type === "HAND_FINISHED");
  const before =
    started?.type === "HAND_STARTED"
      ? started.seats.find((s) => s.playerId === heroId)?.stack
      : undefined;
  const after =
    finished?.type === "HAND_FINISHED"
      ? finished.stacks.find((s) => s.playerId === heroId)?.amount
      : undefined;
  return {
    handId: summary.handId,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    complete: view.status === "complete",
    bigBlind: view.bigBlind,
    heroHoleCards:
      view.seats.find((s) => s.playerId === heroId)?.holeCards ?? null,
    heroNet:
      before === undefined || after === undefined ? null : after - before,
  };
}

export class ReplayService {
  constructor(
    private readonly store: EventStore,
    private readonly heroId: string,
    private readonly players: readonly SeatPlayer[],
  ) {}

  /** Hand 一覧（開始の新しい順。最大 REPLAY_LIST_LIMIT 件）。 */
  list(): ReplayHandSummary[] {
    return this.store
      .listHands(REPLAY_LIST_LIMIT)
      .map((summary) =>
        summarizeReplayHand(summary, this.events(summary.handId), this.heroId),
      );
  }

  /** 1 Hand の再生の材料。Event の無い Hand は null。 */
  hand(handId: string): ReplayHand | null {
    const events = this.events(handId);
    const started = events.find((e) => e.type === "HAND_STARTED");
    if (started?.type !== "HAND_STARTED") return null;
    const steps = replaySteps(events, this.heroId);
    return {
      handId,
      complete: steps.at(-1)?.status === "complete",
      players: started.seats.map(
        (seat): SeatPlayer =>
          this.players.find((p) => p.playerId === seat.playerId) ?? {
            playerId: seat.playerId,
            displayName: seat.playerId,
            kind: seat.playerId === this.heroId ? "hero" : "cpu",
          },
      ),
      steps,
    };
  }

  private events(handId: string): HandEvent[] {
    return this.store.read(handId).map((s) => s.event);
  }
}
