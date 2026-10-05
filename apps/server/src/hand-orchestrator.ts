// Hand Orchestrator（docs/03 §4）。Engine・Event Store・CPU（Opponent Agent）をつなぎ、1 Hand を最後まで進める。
// - State は毎回 Event Log（Event Store）から畳み込んで作る。Orchestrator は「もう一つの State」を持たない（D37）。
// - Session（D80）も同じ: Orchestrator が持つのは「今の Session の ID と最後の Hand の ID」だけで、
//   次 Hand の席・Button・持ち越す Stack は、最後の Hand の HAND_STARTED と HAND_FINISHED から Position Engine で決める。
// - 合法性は Engine だけが判定する。CPU の出力も Hero の入力も applyAction で検証する（D40）。
// - CPU の判断は非同期（LLM を差し込めるように）。出力は Schema → Legal Action → Amount Range で検証し、
//   不正なら理由を付けて 1 回だけ再要求、再度不正なら RuleBot の判断で続行する（D41）。
//   不正な出力と Fallback の利用は AI_ACTION_INVALID / AI_FALLBACK_USED として Event Log に残す（D83。system Visibility で、
//   Hero の View と CPU の KnowledgeState には入らない）。
//   例外・応答時間の超過は「障害」として Hand を止め、RuleBot へ自動で切り替えない（D86。続け方の選択は #52）。
// - CPU に渡すのはその CPU の KnowledgeState（projectKnowledgeState）と Legal Action だけ、Hero へ返すのは projectHeroView だけ（D28・D71・D73）。
import { randomUUID } from "node:crypto";
import {
  applyAction,
  foldHandEvents,
  getLegalActions,
  nextHandSeating,
  projectHeroView,
  projectKnowledgeState,
  recordAiEvent,
  startHand,
  type EngineError,
  type HandEvent,
  type HandProgress,
  type HandState,
  type HeroView,
  type PlayerAction,
  type SeatInit,
} from "@proj-poker/engine";
import type { SeatPlayer, TableSetup } from "./config.js";
import type { EventStore } from "./event-store.js";
import type {
  OpponentAgent,
  OpponentFactory,
  OpponentInput,
} from "./opponents/opponent-agent.js";
import { checkOpponentOutput } from "./opponents/opponent-output.js";
import { RuleBot } from "./opponents/rule-bot.js";

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

/**
 * CPU が判断を返せなかった「障害」（応答時間の超過・例外。API 障害を含む）。不正な出力とは区別する（D86）。
 * 障害の Hand はその手番で止まり、RuleBot へ自動では切り替えない。続け方（Retry / Emergency Bot / Session 終了）の選択は #52。
 */
export interface OpponentOutage {
  /** 止まった手番の Action が入るはずだった seq。 */
  readonly seq: number;
  readonly playerId: string;
  readonly kind: "timeout" | "error";
  readonly message: string;
}

export interface OrchestratorLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HandOrchestratorOptions {
  readonly store: EventStore;
  readonly setup: TableSetup;
  readonly createOpponent: OpponentFactory;
  /**
   * CPU が行動するまでの待ち時間（演出用）。0 なら startHand / heroAction は CPU の手番が尽きるまで待ってから返す。
   * 0 より大きければ、CPU の手番は応答の後に 1 手ずつ進み、購読者（SSE）へ届く。
   */
  readonly botDelayMs: number;
  /** CPU の 1 回の判断（decide の 1 呼び出し）を待つ上限（ミリ秒。Config の暫定値）。超えたら障害として Hand を止める。 */
  readonly opponentTimeoutMs: number;
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
  /** 不正な出力が続いたときに使う CPU ごとの RuleBot（Deterministic Fallback。D41）。 */
  readonly fallbackBots: ReadonlyMap<string, RuleBot>;
  readonly listeners: Set<HeroViewListener>;
  /** CPU の手番を進めている最中ならその Promise（同じ Hand で 2 本同時に進めない）。 */
  running: Promise<void> | null;
  /** 今の待ち（思考待ち・判断待ち）を打ち切る（アプリ終了時）。待っていなければ null。 */
  cancelWait: (() => void) | null;
  /** 進行を止めた内部エラー。以降この Hand の CPU は動かさない。 */
  failure: string | null;
  /** CPU の障害で止まった手番。以降この Hand の CPU は動かさない（続け方の選択は #52）。 */
  outage: OpponentOutage | null;
}

/** CPU に 1 回判断を求めた結果。 */
type AskOutcome =
  | { readonly kind: "output"; readonly output: unknown }
  | {
      readonly kind: "outage";
      readonly cause: OpponentOutage["kind"];
      readonly message: string;
    }
  /** アプリ終了で待ちを打ち切った。 */
  | { readonly kind: "cancelled" };

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
    if (
      !Number.isSafeInteger(options.opponentTimeoutMs) ||
      options.opponentTimeoutMs <= 0
    ) {
      throw new RangeError(
        `opponentTimeoutMs は 1 以上の整数: ${options.opponentTimeoutMs}`,
      );
    }
    this.heroId = hero.playerId;
    this.logger = options.logger ?? silentLogger;
  }

  get players(): readonly SeatPlayer[] {
    return this.options.setup.players;
  }

  /**
   * Hand を開始し、Hero の手番（または Hand の終了）まで CPU を進める。
   * afterHandId はクライアントが結果まで見た最後の Hand（まだ無ければ null）。Action の lastSeq と同じく、
   * 「どの Hand の次を求めているか」で開始の再送と明示的な「次の Hand」を区別する（開始を冪等にする）。
   * - 今の Session の最後の Hand が進行中なら、新しい Hand を作らずその Hand を返す（created: false）
   * - 最後の Hand が終わっていても、クライアントがまだその Hand を見ていなければ（afterHandId が違う）その Hand を返す。
   *   開始の応答だけが失われて再送されても、結果を見ないまま Button・Stack を進めない／Session を捨てない
   * - クライアントが最後の Hand を見たうえで求めたら、Session が続くなら Stack を持ち越して次 Hand を始め、
   *   Session が終わっていたら（D80）新しい Session として均等 Stack で始める
   * - 最後の Hand が内部エラーで止まっていたら、新しい Session として均等 Stack で始める
   */
  async startHand(afterHandId: string | null): Promise<
    OrchestratorResult<{
      handId: string;
      view: HeroView;
      created: boolean;
    }>
  > {
    const { setup, store } = this.options;
    const unseen = this.unseenLatestHand(afterHandId);
    if (unseen !== null) {
      return {
        ok: true,
        value: {
          handId: unseen,
          view: this.heroViewOf(unseen),
          created: false,
        },
      };
    }
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

    // 座っている CPU にだけ Opponent（と Fallback 用の RuleBot）を割り当てる。CPU の seed は卓の設定上の席番号から導く
    // （Bust で席が詰まっても、同じ CPU には同じ導き方の seed が渡る）。
    const seated = new Set(plan.seats.map((s) => s.playerId));
    const opponents = new Map<string, OpponentAgent>();
    const fallbackBots = new Map<string, RuleBot>();
    setup.players.forEach((p, seatIndex) => {
      if (p.kind === "cpu" && seated.has(p.playerId)) {
        const cpuSeed = deriveSeed(seed, seatIndex);
        opponents.set(
          p.playerId,
          this.options.createOpponent(cpuSeed, p.playerId),
        );
        fallbackBots.set(p.playerId, new RuleBot(cpuSeed));
      }
    });
    const rt: HandRuntime = {
      handId,
      sessionId: plan.sessionId,
      opponents,
      fallbackBots,
      listeners: new Set(),
      running: null,
      cancelWait: null,
      failure: null,
      outage: null,
    };
    this.hands.set(handId, rt);
    await this.proceed(rt);
    return {
      ok: true,
      value: { handId, view: this.heroViewOf(handId), created: true },
    };
  }

  /**
   * Hero の Action を適用し、次に Hero の手番が来るか Hand が終わるまで CPU を進める。
   * lastSeq は Hero が見ていた HeroView の log の最後の seq。Log がそこから進んでいれば stale_view で拒否する
   * （二重送信や、CPU の行動を見る前の画面からの送信を、手番の判定より先に弾く）。
   */
  async heroAction(
    handId: string,
    lastSeq: number,
    action: PlayerAction,
  ): Promise<OrchestratorResult<HeroView>> {
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
    await this.proceed(rt);
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

  /** CPU の障害で止まっていればその内容。止まっていない・未知の Hand なら null。 */
  outageOf(handId: string): OpponentOutage | null {
    return this.hands.get(handId)?.outage ?? null;
  }

  /** CPU の待ち（思考待ち・判断待ち）を打ち切る（アプリ終了時）。以降は CPU を進めない。遅れて届いた判断も適用しない。 */
  close(): void {
    this.closed = true;
    for (const rt of this.hands.values()) {
      rt.cancelWait?.();
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
   * 新しい Hand を作らずに返すべき Hand（今の Session の最後の Hand）。無ければ null。
   * 進行中なら常に、終わっていればクライアントがまだ見ていないとき（afterHandId が違う）だけ返す。
   * 内部エラーで止まった Hand は返さない（新しい Session で始め直せるようにする）。
   */
  private unseenLatestHand(afterHandId: string | null): string | null {
    const current = this.session;
    if (current === null) return null;
    const rt = this.hands.get(current.lastHandId);
    if (rt === undefined || rt.failure !== null) return null;
    const finished =
      this.sessionAfter(current.lastHandId).status.state !== "in_hand";
    return finished && afterHandId === current.lastHandId
      ? null
      : current.lastHandId;
  }

  /**
   * 次 Hand の席・Button・Session を決める（呼ぶのは最後の Hand を返さないと決めた後だけ）。
   * - 今の Session の最後の Hand が終わり、Session が続くなら: Position Engine の結果で Stack を持ち越す
   * - それ以外（最初の Hand・Session 終了後・最後の Hand が内部エラーで止まった）: 新しい Session。
   *   均等 Stack で、Button は席順の先頭（止まった Hand は持ち越す Stack が決まらないので、Session ごと始め直す）
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

  /**
   * CPU の判断の経緯（system Visibility の Event）を Log へ追記する。Hero の View は変わらないので配らない。
   * 追記後の State（seq だけが進む）を返す。
   */
  private record(rt: HandRuntime, progress: HandProgress): HandState {
    this.options.store.append(rt.handId, progress.events, {
      sessionId: rt.sessionId,
    });
    return progress.state;
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

  /**
   * CPU の手番を進める。思考待ちが 0 なら CPU の手番が尽きるまで待ち、0 より大きければ待たずに返す
   * （CPU の行動は後から 1 手ずつ購読者へ届く）。
   */
  private async proceed(rt: HandRuntime): Promise<void> {
    const running = this.advance(rt);
    if (this.options.botDelayMs === 0) await running;
  }

  /** CPU の手番が続く間、CPU を進める。Hero の手番・Hand の終了・障害・内部エラー・終了で止まる。 */
  private advance(rt: HandRuntime): Promise<void> {
    // すでに進めている最中なら、その進行に任せる（同じ手番を 2 回判断させない）。
    if (rt.running !== null) return rt.running;
    const running = this.runCpuTurns(rt).finally(() => {
      rt.running = null;
    });
    rt.running = running;
    return running;
  }

  private async runCpuTurns(rt: HandRuntime): Promise<void> {
    try {
      while (this.canRun(rt)) {
        const events = this.events(rt.handId);
        const legal = getLegalActions(foldHandEvents(events));
        if (legal === null || legal.playerId === this.heroId) return;
        const expectedSeq = events.length;
        if (this.options.botDelayMs > 0) {
          await this.wait(rt, this.options.botDelayMs);
        }
        await this.cpuTurn(rt, expectedSeq);
      }
    } catch (error) {
      this.fail(rt, error);
    }
  }

  private canRun(rt: HandRuntime): boolean {
    return !this.closed && rt.failure === null && rt.outage === null;
  }

  /** Log が expectedSeq のまま（待っている間に誰も進めていない）で、まだ CPU を動かしてよいか。 */
  private isCurrent(rt: HandRuntime, expectedSeq: number): boolean {
    return this.canRun(rt) && this.events(rt.handId).length === expectedSeq;
  }

  /**
   * CPU 1 手分。待っている間に Log が進んでいたら、古い手番として何もしない（遅れて届いた判断を適用しない）。
   * 出力は Schema → Legal Action → Amount Range で検証し、Engine（applyAction）が最後に適用可否を決める（D40）。
   * 不正なら AI_ACTION_INVALID を残して理由を付けて 1 回だけ再要求し、再度不正なら AI_FALLBACK_USED を残して
   * RuleBot の判断で続ける（D41・D83）。記録はその手番の Action より前の seq に入る。
   * 障害（応答時間の超過・例外）なら Hand をその手番で止める（D86）。
   */
  private async cpuTurn(rt: HandRuntime, expectedSeq: number): Promise<void> {
    if (!this.isCurrent(rt, expectedSeq)) return;
    const events = this.events(rt.handId);
    let state = foldHandEvents(events);
    const legal = getLegalActions(state);
    if (legal === null || legal.playerId === this.heroId) return;
    const playerId = legal.playerId;
    const agent = rt.opponents.get(playerId);
    const fallbackBot = rt.fallbackBots.get(playerId);
    if (agent === undefined || fallbackBot === undefined) {
      throw new Error(`CPU が割り当てられていない席: ${playerId}`);
    }

    // CPU に渡すのはその CPU の KnowledgeState と Legal Action だけ（global State・他者の札・Deck を渡さない）。
    // AI_ACTION_INVALID は誰の Projection にも入らないので、再要求でも KnowledgeState は同じ。
    const base: OpponentInput = {
      knowledge: projectKnowledgeState(events, playerId),
      legal,
    };
    let input = base;
    let lastInvalid: string | null = null;
    for (const attempt of [1, 2] as const) {
      const outcome = await this.ask(rt, agent, input);
      // 記録を追記した分だけ Log は進むので、今の State の nextSeq で「誰も進めていない」かを見る。
      if (outcome.kind === "cancelled" || !this.isCurrent(rt, state.nextSeq)) {
        return;
      }
      if (outcome.kind === "outage") {
        rt.outage = {
          seq: state.nextSeq,
          playerId,
          kind: outcome.cause,
          message: outcome.message,
        };
        this.logger.error(
          { handId: rt.handId, ...rt.outage },
          "CPU の障害で Hand を止めた",
        );
        return;
      }
      const checked = checkOpponentOutput(outcome.output, legal);
      const applied = checked.ok
        ? applyAction(state, playerId, checked.action)
        : null;
      if (applied?.ok === true) {
        this.commit(rt, applied.value.events);
        return;
      }
      // 検証は通ったのに Engine が拒否した場合も不正な出力として扱う（合法性の最終判断は Engine。D40）。
      const { stage, reason } = checked.ok
        ? {
            stage: "legal_action" as const,
            reason: applied?.ok === false ? applied.error.message : "不明",
          }
        : checked;
      state = this.record(
        rt,
        recordAiEvent(state, {
          type: "AI_ACTION_INVALID",
          playerId,
          attempt,
          stage,
          reason,
        }),
      );
      lastInvalid = `${stage}: ${reason}`;
      this.logger.warn(
        {
          handId: rt.handId,
          playerId,
          attempt,
          stage,
          reason,
          output: outcome.output,
        },
        "CPU の出力が不正だった",
      );
      input = { ...base, correction: { stage, reason } };
    }

    // 2 回続けて不正: RuleBot の判断（Deterministic Fallback）で続ける。RuleBot は同期で、障害を起こさない。
    // AI_FALLBACK_USED と Fallback の Action は 1 回の追記で置く（記録の直後がその Action になる）。
    const used = recordAiEvent(state, {
      type: "AI_FALLBACK_USED",
      playerId,
      fallbackKind: "automatic",
      reason: lastInvalid ?? "不明",
    });
    const fallback = applyAction(
      used.state,
      playerId,
      fallbackBot.choose(base),
    );
    if (!fallback.ok) {
      throw new Error(
        `Deterministic Fallback（RuleBot）も Engine に拒否された: ${fallback.error.message}`,
      );
    }
    this.logger.warn(
      { handId: rt.handId, playerId, reason: lastInvalid },
      "CPU の出力を 2 回続けて使えず、RuleBot の判断で続けた",
    );
    this.commit(rt, [...used.events, ...fallback.value.events]);
  }

  /**
   * CPU に 1 回判断を求める。応答時間の上限を超えた・例外を投げたら「障害」として返す（不正な出力とは区別する）。
   * 上限を超えた後に届いた判断は捨てる（ここで決まった結果だけが使われる）。
   */
  private ask(
    rt: HandRuntime,
    agent: OpponentAgent,
    input: OpponentInput,
  ): Promise<AskOutcome> {
    const limit = this.options.opponentTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: AskOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rt.cancelWait = null;
        resolve(outcome);
      };
      const timer = setTimeout(
        () =>
          finish({
            kind: "outage",
            cause: "timeout",
            message: `${limit}ms 以内に判断が返らなかった`,
          }),
        limit,
      );
      rt.cancelWait = () => finish({ kind: "cancelled" });
      const toError = (error: unknown) =>
        finish({ kind: "outage", cause: "error", message: String(error) });
      try {
        agent
          .decide(input)
          .then((output) => finish({ kind: "output", output }), toError);
      } catch (error) {
        // Promise を返す前に投げた場合も、Promise の reject と同じ障害として扱う。
        toError(error);
      }
    });
  }

  /** 思考待ち（演出）。アプリ終了時は打ち切る。 */
  private wait(rt: HandRuntime, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        rt.cancelWait = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      rt.cancelWait = done;
    });
  }

  private fail(rt: HandRuntime, error: unknown): void {
    rt.failure = String(error);
    this.logger.error(
      { handId: rt.handId, err: error },
      "Hand の進行を止めた（内部エラー）",
    );
  }
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
