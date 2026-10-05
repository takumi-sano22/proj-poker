// Hand Orchestrator（docs/03 §4）。Engine・Event Store・CPU（Opponent Agent）をつなぎ、1 Hand を最後まで進める。
// - State は毎回 Event Log（Event Store）から畳み込んで作る。Orchestrator は「もう一つの State」を持たない（D37）。
// - Session（D80）も同じ: Orchestrator が持つのは「今の Session の ID と最後の Hand の ID」だけで、
//   次 Hand の席・Button・持ち越す Stack は、最後の Hand の HAND_STARTED と HAND_FINISHED から Position Engine で決める。
// - 合法性は Engine だけが判定する。CPU の出力も Hero の入力も applyAction で検証する（D40）。
// - CPU に渡すのは projectBotView と Legal Action だけ、Hero へ返すのは projectHeroView だけ（D28・D71・D73）。
import { randomUUID } from "node:crypto";
import {
  applyAction,
  foldHandEvents,
  getLegalActions,
  nextHandSeating,
  projectBotView,
  projectHeroView,
  startHand,
  type EngineError,
  type HandEvent,
  type HeroView,
  type LegalActionSet,
  type PlayerAction,
  type SeatInit,
} from "@proj-poker/engine";
import type { SeatPlayer, TableSetup } from "./config.js";
import type { EventStore } from "./event-store.js";
import type {
  OpponentAgent,
  OpponentFactory,
} from "./opponents/opponent-agent.js";

/** Orchestrator が返す失敗。Engine の拒否理由はそのまま通す。 */
export type OrchestratorError =
  | EngineError
  | { readonly kind: "hand_not_found"; readonly message: string }
  /** Hero が見ていた卓の状態より Log が進んでいる（二重送信・古い画面からの送信）。 */
  | { readonly kind: "stale_view"; readonly message: string };

/**
 * Session が終わった理由（D80）。
 * - hero_busted: Hero の Stack が 0 になった
 * - hero_last_standing: CPU が全員 Bust し、Hero だけが残った
 */
export type SessionEndReason = "hero_busted" | "hero_last_standing";

/**
 * ある Hand から見た Session の状態。Hero に返してよい情報（Hero 自身の結果と、次 Hand があるか）だけを持つ。
 * - in_hand: Hand の途中
 * - ready_for_next_hand: Hand が終わり、Stack を持ち越して次 Hand を始められる
 * - ended: Hand が終わり、Session も終わった（次の Hand は新しい Session として均等 Stack で始まる）
 */
export type SessionStatus =
  | { readonly state: "in_hand" }
  | { readonly state: "ready_for_next_hand" }
  | { readonly state: "ended"; readonly reason: SessionEndReason };

export type OrchestratorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OrchestratorError };

/** CPU の出力が使えず Fallback した記録（docs/03 §5・§6 の Flag）。Event Log とは別の運用 Metadata。 */
export interface BotFallbackRecord {
  /** Fallback で適用した ACTION_TAKEN の seq。 */
  readonly seq: number;
  readonly playerId: string;
  readonly reason: string;
}

export interface OrchestratorLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HandOrchestratorOptions {
  readonly store: EventStore;
  readonly setup: TableSetup;
  readonly createOpponent: OpponentFactory;
  /** CPU が行動するまでの待ち時間（演出用）。0 なら CPU の手番を同期でまとめて進める。 */
  readonly botDelayMs: number;
  /** Hand ごとの seed（Deck のシャッフルと CPU の乱数の元）。テストでは固定値を渡す。 */
  readonly nextSeed: () => number;
  readonly nextHandId: () => string;
  /** 新しい Session の ID。省略時は UUID。 */
  readonly nextSessionId?: () => string;
  readonly logger?: OrchestratorLogger;
}

export type HeroViewListener = (view: HeroView) => void;

interface HandRuntime {
  readonly handId: string;
  readonly sessionId: string;
  readonly opponents: ReadonlyMap<string, OpponentAgent>;
  readonly listeners: Set<HeroViewListener>;
  readonly fallbacks: BotFallbackRecord[];
  /** 予約済みの CPU の手番（botDelayMs > 0 のとき）。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 進行を止めた内部エラー。以降この Hand の CPU は動かさない。 */
  failure: string | null;
}

/** 次 Hand の席・Button と、その Hand が属する Session。 */
interface HandPlan {
  readonly sessionId: string;
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
}

/** 今の Session。持つのは ID の参照だけで、Stack・席・Button は lastHandId の Event Log から読む（D37）。 */
interface SessionPointer {
  readonly sessionId: string;
  readonly lastHandId: string;
}

const silentLogger: OrchestratorLogger = { warn: () => {}, error: () => {} };

export class HandOrchestrator {
  private readonly hands = new Map<string, HandRuntime>();
  private readonly heroId: string;
  private readonly logger: OrchestratorLogger;
  private session: SessionPointer | null = null;
  private closed = false;

  constructor(private readonly options: HandOrchestratorOptions) {
    const heroes = options.setup.players.filter((p) => p.kind === "hero");
    const [hero] = heroes;
    if (heroes.length !== 1 || hero === undefined) {
      throw new RangeError("卓の Hero はちょうど 1 人にする");
    }
    if (!Number.isSafeInteger(options.botDelayMs) || options.botDelayMs < 0) {
      throw new RangeError(`botDelayMs は 0 以上の整数: ${options.botDelayMs}`);
    }
    this.heroId = hero.playerId;
    this.logger = options.logger ?? silentLogger;
  }

  get players(): readonly SeatPlayer[] {
    return this.options.setup.players;
  }

  /**
   * Hand を開始し、Hero の手番（または Hand の終了）まで CPU を進める。
   * 今の Session が続くなら、前 Hand の席順・Button・終了時の Stack から次 Hand の席を決めて Stack を持ち越す。
   * Session が終わっていたら（D80）、または前 Hand が終わらないうちに求められたら、新しい Session として均等 Stack で始める。
   */
  startHand(): OrchestratorResult<{ handId: string; view: HeroView }> {
    const { setup, store } = this.options;
    const handId = this.options.nextHandId();
    if (this.hands.has(handId) || store.read(handId).length > 0) {
      throw new Error(`Hand ID が重複した: ${handId}`);
    }
    const seed = this.options.nextSeed();
    const plan = this.planNextHand();
    const started = startHand({
      handId,
      seats: plan.seats,
      buttonPlayerId: plan.buttonPlayerId,
      config: setup.table,
      deal: { seed },
    });
    if (!started.ok) return started;
    store.append(handId, started.value.events, { sessionId: plan.sessionId });
    this.session = { sessionId: plan.sessionId, lastHandId: handId };

    // 座っている CPU にだけ Opponent を割り当てる。CPU の seed は卓の設定上の席番号から導く
    // （Bust で席が詰まっても、同じ CPU には同じ導き方の seed が渡る）。
    const seated = new Set(plan.seats.map((s) => s.playerId));
    const opponents = new Map<string, OpponentAgent>();
    setup.players.forEach((p, seatIndex) => {
      if (p.kind === "cpu" && seated.has(p.playerId)) {
        opponents.set(
          p.playerId,
          this.options.createOpponent(deriveSeed(seed, seatIndex), p.playerId),
        );
      }
    });
    const rt: HandRuntime = {
      handId,
      sessionId: plan.sessionId,
      opponents,
      listeners: new Set(),
      fallbacks: [],
      timer: null,
      failure: null,
    };
    this.hands.set(handId, rt);
    this.advance(rt);
    return { ok: true, value: { handId, view: this.heroViewOf(handId) } };
  }

  /**
   * Hero の Action を適用し、次に Hero の手番が来るか Hand が終わるまで CPU を進める。
   * lastSeq は Hero が見ていた HeroView の log の最後の seq。Log がそこから進んでいれば stale_view で拒否する
   * （二重送信や、CPU の行動を見る前の画面からの送信を、手番の判定より先に弾く）。
   */
  heroAction(
    handId: string,
    lastSeq: number,
    action: PlayerAction,
  ): OrchestratorResult<HeroView> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    const events = this.events(handId);
    const seen = projectHeroView(events, this.heroId).log.at(-1)?.seq;
    if (seen !== lastSeq) {
      return {
        ok: false,
        error: {
          kind: "stale_view",
          message: `卓の状態が更新されている（最新の seq は ${seen}、送信は ${lastSeq}）`,
        },
      };
    }
    const result = applyAction(foldHandEvents(events), this.heroId, action);
    if (!result.ok) return result;
    this.commit(rt, result.value.events);
    this.advance(rt);
    return { ok: true, value: this.heroViewOf(handId) };
  }

  /** Hero に見える卓の状態。未知の Hand なら null。 */
  heroView(handId: string): HeroView | null {
    return this.hands.has(handId) ? this.heroViewOf(handId) : null;
  }

  /** その Hand から見た Session の状態。未知の Hand なら null。 */
  sessionStatus(handId: string): SessionStatus | null {
    return this.hands.has(handId) ? this.sessionAfter(handId).status : null;
  }

  /** Hero の View が変わるたびに呼ばれる listener を登録する。戻り値で解除する。未知の Hand なら null。 */
  subscribe(handId: string, listener: HeroViewListener): (() => void) | null {
    const rt = this.hands.get(handId);
    if (rt === undefined) return null;
    rt.listeners.add(listener);
    return () => rt.listeners.delete(listener);
  }

  /** CPU の出力が使えず Fallback した記録。 */
  fallbacksOf(handId: string): readonly BotFallbackRecord[] {
    return [...(this.hands.get(handId)?.fallbacks ?? [])];
  }

  /** 予約済みの CPU の手番を取り消す（アプリ終了時）。以降は CPU を進めない。 */
  close(): void {
    this.closed = true;
    for (const rt of this.hands.values()) {
      if (rt.timer !== null) clearTimeout(rt.timer);
      rt.timer = null;
      rt.listeners.clear();
    }
  }

  private events(handId: string): HandEvent[] {
    return this.options.store.read(handId).map((s) => s.event);
  }

  private heroViewOf(handId: string): HeroView {
    return projectHeroView(this.events(handId), this.heroId);
  }

  /**
   * 次 Hand の席・Button・Session を決める。
   * - 今の Session の最後の Hand が終わり、Session が続くなら: Position Engine の結果で Stack を持ち越す
   * - それ以外（最初の Hand・Session 終了後・前 Hand が未完了）: 新しい Session。均等 Stack で、Button は席順の先頭
   *   （前 Hand が未完了だと持ち越す Stack が決まらないので、新しい Hand は新しい Session になる。
   *   Session を入れる前の「いつでも新しい Hand を均等 Stack で始められる」挙動と同じ）
   */
  private planNextHand(): HandPlan {
    const current = this.session;
    if (current !== null) {
      const after = this.sessionAfter(current.lastHandId);
      if (after.next !== null) {
        return { sessionId: current.sessionId, ...after.next };
      }
    }
    const { players, startingStack } = this.options.setup;
    return {
      sessionId: (this.options.nextSessionId ?? randomUUID)(),
      seats: players.map((p) => ({
        playerId: p.playerId,
        stack: startingStack,
      })),
      buttonPlayerId: (players[0] as SeatPlayer).playerId,
    };
  }

  /**
   * Hand の終了後の Session の状態と、続くなら次 Hand の席。その Hand の Event Log だけから作る（D37）。
   * 席順と Button は HAND_STARTED、Stack は HAND_FINISHED から読み、Bust の判定と Button の移動は Position Engine に任せる。
   */
  private sessionAfter(handId: string): {
    status: SessionStatus;
    next: Omit<HandPlan, "sessionId"> | null;
  } {
    const events = this.events(handId);
    const started = events[0];
    const finished = events.at(-1);
    if (
      started?.type !== "HAND_STARTED" ||
      finished?.type !== "HAND_FINISHED"
    ) {
      return { status: { state: "in_hand" }, next: null };
    }
    const seating = nextHandSeating(
      {
        seatOrder: started.seats.map((s) => s.playerId),
        stacks: finished.stacks,
        buttonPlayerId: started.buttonPlayerId,
      },
      this.options.setup.table,
    );
    if (!seating.ok) {
      throw new Error(`次 Hand の席を決められない: ${seating.error.message}`);
    }
    const heroStack =
      finished.stacks.find((s) => s.playerId === this.heroId)?.amount ?? 0;
    // Hero が Bust したら、CPU が何人残っていても Session を終える（D80）。
    if (heroStack === 0) {
      return { status: { state: "ended", reason: "hero_busted" }, next: null };
    }
    // Hero の Stack が残っていて次 Hand が無い＝残ったのは Hero だけ。
    if (seating.value.kind === "no_next_hand") {
      return {
        status: { state: "ended", reason: "hero_last_standing" },
        next: null,
      };
    }
    return {
      status: { state: "ready_for_next_hand" },
      next: {
        seats: seating.value.seats,
        buttonPlayerId: seating.value.buttonPlayerId,
      },
    };
  }

  /** Event を Log へ追記し、Hero の View を購読者へ配る。 */
  private commit(rt: HandRuntime, events: readonly HandEvent[]): void {
    this.options.store.append(rt.handId, events, { sessionId: rt.sessionId });
    if (rt.listeners.size === 0) return;
    const view = this.heroViewOf(rt.handId);
    for (const listener of rt.listeners) {
      try {
        listener(view);
      } catch (error) {
        // 1 つの配信先の失敗で Hand の進行を止めない（Log への追記は済んでいる）。
        this.logger.warn(
          { handId: rt.handId, err: error },
          "Hero View の配信に失敗した",
        );
      }
    }
  }

  /** CPU の手番が続く間、CPU を進める。Hero の手番か Hand の終了で止まる。 */
  private advance(rt: HandRuntime): void {
    try {
      while (!this.closed && rt.failure === null && rt.timer === null) {
        const events = this.events(rt.handId);
        const legal = getLegalActions(foldHandEvents(events));
        if (legal === null || legal.playerId === this.heroId) return;
        const expectedSeq = events.length;
        if (this.options.botDelayMs === 0) {
          this.cpuTurn(rt, expectedSeq);
          continue;
        }
        rt.timer = setTimeout(() => {
          rt.timer = null;
          try {
            this.cpuTurn(rt, expectedSeq);
          } catch (error) {
            this.fail(rt, error);
            return;
          }
          this.advance(rt);
        }, this.options.botDelayMs);
      }
    } catch (error) {
      this.fail(rt, error);
    }
  }

  /**
   * CPU 1 手分。予約したときから Log が進んでいたら、古い予約として何もしない（遅れて届いた判断を適用しない）。
   * CPU の出力は Engine で検証し、拒否されたら決定論的な Safe Fallback（Check、できなければ Fold）にする（docs/03 §5）。
   */
  private cpuTurn(rt: HandRuntime, expectedSeq: number): void {
    if (this.closed) return;
    const events = this.events(rt.handId);
    if (events.length !== expectedSeq) return;
    const state = foldHandEvents(events);
    const legal = getLegalActions(state);
    if (legal === null || legal.playerId === this.heroId) return;
    const agent = rt.opponents.get(legal.playerId);
    if (agent === undefined) {
      throw new Error(`CPU が割り当てられていない席: ${legal.playerId}`);
    }

    let reason: string | null = null;
    let result: ReturnType<typeof applyAction> | null = null;
    try {
      // CPU に渡すのはその CPU に見える Projection と Legal Action だけ（global State・他者の札・Deck を渡さない）。
      const decided = agent.decide({
        view: projectBotView(events, legal.playerId),
        legal,
      });
      result = applyAction(state, legal.playerId, decided);
      if (!result.ok) {
        reason = `${result.error.kind}: ${result.error.message}`;
      }
    } catch (error) {
      reason = `decide が例外を投げた: ${String(error)}`;
    }

    if (result === null || !result.ok) {
      const fallback = applyAction(state, legal.playerId, safeFallback(legal));
      if (!fallback.ok) {
        throw new Error(
          `Safe Fallback も Engine に拒否された: ${fallback.error.message}`,
        );
      }
      result = fallback;
      const record: BotFallbackRecord = {
        seq: fallback.value.events[0]?.seq ?? expectedSeq,
        playerId: legal.playerId,
        reason: reason ?? "不明",
      };
      rt.fallbacks.push(record);
      this.logger.warn(
        { handId: rt.handId, ...record },
        "CPU の出力を使えず Safe Fallback した",
      );
    }
    this.commit(rt, result.value.events);
  }

  private fail(rt: HandRuntime, error: unknown): void {
    rt.failure = String(error);
    this.logger.error(
      { handId: rt.handId, err: error },
      "Hand の進行を止めた（内部エラー）",
    );
  }
}

/** Check できれば Check、できなければ Fold（どちらも追加の Chip を出さない）。 */
function safeFallback(legal: LegalActionSet): PlayerAction {
  return legal.actions.some((a) => a.type === "check")
    ? { type: "check" }
    : { type: "fold" };
}

/** Hand の seed から席ごとの CPU の seed を導く（同じ Hand seed なら同じ CPU の乱数列になる）。 */
export function deriveSeed(handSeed: number, seatIndex: number): number {
  return (handSeed + Math.imul(seatIndex + 1, 0x9e3779b9)) >>> 0;
}

function notFound(handId: string): { ok: false; error: OrchestratorError } {
  return {
    ok: false,
    error: { kind: "hand_not_found", message: `Hand が無い: ${handId}` },
  };
}
