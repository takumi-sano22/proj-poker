// Hand Orchestrator（docs/03 §4）。Engine・Event Store・CPU（Opponent Agent）をつなぎ、1 Hand を最後まで進める。
// - State は毎回 Event Log（Event Store）から畳み込んで作る。Orchestrator は「もう一つの State」を持たない（D37）。
// - Session（D80）も同じ: Orchestrator が持つのは「今の Session の ID と最後の Hand の ID」と、Event の写し（Emergency Bot の CPU）・
//   Session の開始時の設定（Persona の割り当て）だけで、次 Hand の席・Button・持ち越す Stack は、最後の Hand の HAND_STARTED と
//   HAND_FINISHED から Position Engine で決める。Session の開始・終了は SESSION_STARTED / SESSION_ENDED として Event Log に残す（D95）。
// - 再起動の前に Hand の合間で止まった Session は、Session Projection と最後の Hand の Event から戻して続ける（Resume。D62・D95）。
// - 合法性は Engine だけが判定する。CPU の出力も Hero の入力も applyAction で検証する（D40）。
// - CPU の判断は非同期（LLM を差し込めるように）。出力は Schema → Legal Action → Amount Range で検証し、
//   不正なら理由を付けて 1 回だけ再要求、再度不正なら RuleBot の判断で続行する（D41）。
//   不正な出力と Fallback の利用は AI_ACTION_INVALID / AI_FALLBACK_USED として Event Log に残す（D83。system Visibility で、
//   Hero の View と CPU の KnowledgeState には入らない）。
//   例外・応答時間の超過は「障害」として Hand を止め、RuleBot へ自動で切り替えない（D86）。
//   続け方は Hero が選ぶ（resolveOutage。#52）: Retry（同じ手番をもう一度）/ Emergency Bot（EMERGENCY_BOT_ENGAGED を残し、その CPU を
//   Session の終わりまで RuleBot にし、手番ごとに AI_FALLBACK_USED の emergency_bot を残す）/ Session 終了（その Hand を HAND_ABORTED で
//   打ち切って SESSION_ENDED を続け、次は新しい Session）。選んだ結果は Event Log に残す（D95。メモリだけの状態にしない）。
//   選ぶまでは止めたまま（Pause）。Hero に返す障害の情報は「どの CPU の手番か・障害の種類」だけで、エラー本文は返さない。
// - CPU に渡すのはその CPU の KnowledgeState（projectKnowledgeState）と Legal Action だけ、Hero へ返すのは projectHeroView だけ（D28・D71・D73）。
// - Hero の物理的な操作（宣言・Chip を出す・足す）は Ruling Engine で Canonical Action に裁定し、操作と裁定も Event Log に残す
//   （heroPhysicalAction。D90・D91）。手番でない操作は保留し、Hero の手番が来た時点で拘束か撤回かを裁定する（runCpuTurns）。
// - Hand の開始時に、App Version・Rule Profile・Persona の Preset 一式の版と、席ごとの CPU の実装（RuleBot / Claude と
//   Model Role・具体モデル / Emergency Bot）を HAND_METADATA_RECORDED（system Visibility）として残す（#97・docs/04 §9）。
//   Best-effort な Debug / Re-analysis 用で、AI の Request / Response の生データは残さない（D100）。
// - Session の mode（cash / tournament。D108・D129・#183）は新しい Session の開始で決め、Tournament の設定の Snapshot を SESSION_STARTED に
//   残す。同じ Session の Hand・Resume はその Snapshot で続ける（mode を指定しない開始は cash で、既存の Cash の経路・Event は変えない）。
// - Tournament の Hand の Level（D128・#184）は Hand の開始時に、前の Hand の HAND_STARTED に残した Level と経過（Session の何 Hand 目か・
//   プレイ時間の累計）と、前の Hand のプレイ時間（開始から終わりまで）から決め、その Level の Blind / Ante で始めて HAND_STARTED に固定する。
//   Hand の長さはプロセスの中の単調な時計（playClock）で測る。前のプロセスで終わった Hand（Resume の直後）だけは、保存した記録時刻の差
//   （壁時計。負なら 0）で測る。どちらも経過時間の計測にだけ使い、順序には使わない（Hand の順は論理順序。D117）。
import { randomUUID } from "node:crypto";
import {
  FIRST_TOURNAMENT_PROGRESS,
  applyAction,
  applyPhysicalActions,
  foldHandEvents,
  getLegalActions,
  MAX_PLAYERS,
  nextHandSeating,
  nextTournamentProgress,
  projectHeroView,
  projectKnowledgeState,
  recordAiEvent,
  recordSessionEvent,
  recordUserRead,
  resolvePendingOutOfTurn,
  sessionSettingsOf,
  startDrillHand,
  startHand,
  tableConfigForLevel,
  tournamentHandContext,
  tournamentResult,
  tournamentStandings,
  TOURNAMENT_PRESETS,
  type CpuSeatMetadata,
  type DrillSpot,
  type EngineError,
  type FallbackKind,
  type HandEvent,
  type HandMetadataInput,
  type HandProgress,
  type HandState,
  type HeroView,
  type PhysicalAction,
  type PlayerAction,
  type SeatInit,
  type SessionEndReason,
  type SessionSettings,
  type TableConfig,
  type TournamentHandContext,
  type TournamentPresetId,
  type TournamentProgress,
  type TournamentResult,
  type TournamentStandings,
} from "@proj-poker/engine";
import { APP_VERSION } from "./app-version.js";
import {
  RULE_BOT_INFO,
  type OpponentInfo,
  type SeatPlayer,
  type TableSetup,
} from "./config.js";
import type { EventStore } from "./event-store.js";
import {
  buildOpponentMemoriesFromStore,
  type MemoryObserverSeat,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "./memory/memory-summary.js";
import type { OpponentMemoryResetStore } from "./memory/memory-reset.js";
import type { ObservationCacheStore } from "./memory/observation-cache.js";
import { participantRefOf } from "./memory/observation.js";
import {
  buildCpuTableTendenciesFromStore,
  type TableTendency,
} from "./memory/table-tendency.js";
import type { SessionPlayerSubject } from "./notes/subject.js";
import {
  composeSessionParticipants,
  type SessionParticipant,
} from "./opponents/cpu-pool.js";
import {
  OpponentOutageError,
  type OpponentAgent,
  type OpponentFactory,
  type OpponentInput,
  type OutageKind,
} from "./opponents/opponent-agent.js";
import { checkOpponentOutput } from "./opponents/opponent-output.js";
import {
  isPersonaPresetId,
  PERSONA_PRESETS,
  PERSONA_PROFILE_VERSION,
  type PersonaPresetId,
} from "./opponents/persona.js";
import {
  buildTiltsFromStore,
  type CpuTilt,
  type TiltSeat,
} from "./opponents/tilt.js";
import { RuleBot } from "./opponents/rule-bot.js";

/** Orchestrator が返す失敗。Engine の拒否理由はそのまま通す。 */
export type OrchestratorError =
  | EngineError
  | { readonly kind: "hand_not_found"; readonly message: string }
  /** Hero が見ていた卓の状態より Log が進んでいる（二重送信・古い画面からの送信）。 */
  | { readonly kind: "stale_view"; readonly message: string }
  /** 選んだ障害がもう無い・別の障害に変わっている（二重送信・古いダイアログからの送信）。 */
  | { readonly kind: "stale_outage"; readonly message: string }
  /** Fast Forward は Hero が Hand から外れている間（Fold 後）だけ入れられる。Hero がまだ Hand にいる、または Hand が終わっている。 */
  | { readonly kind: "not_spectating"; readonly message: string };

/**
 * Hand の開始で、新しい Session に求める設定（#183）。Session が続くときは今の Session の設定と同じでなければならない（違えば
 * session_mode_mismatch）。省略すると、続く Session はそのまま続け、新しい Session は cash で始める（既存の経路）。
 */
export type SessionRequest =
  | { readonly mode: "cash" }
  | { readonly mode: "tournament"; readonly presetId: TournamentPresetId };

/**
 * Hand の開始の失敗。Orchestrator の失敗に、求めた Session の設定が今の Session と違う（今の Session が続いている）を足したもの。
 * Hero が Hand の合間に Session を終える経路は無い（Session の終了は Bust・勝ち残り・障害の後の選択だけ）ので、黙って設定を無視したり今の Session を捨てたりせずに拒否する。
 */
export type StartHandError =
  | OrchestratorError
  | { readonly kind: "session_mode_mismatch"; readonly message: string }
  /** 求めた Tournament の Preset の参加人数と、卓の人数（設定）が違う（6-max の Preset を別の人数の卓で始めない）。 */
  | { readonly kind: "tournament_unavailable"; readonly message: string };

/** Session が終わった理由（D80・D86）。SESSION_ENDED の Event にも残すので、型は Engine の Event と共有する（D95）。 */
export type { SessionEndReason };

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
 * 障害の Hand はその手番で止まり、RuleBot へ自動では切り替えない。続け方は Hero が選ぶ（resolveOutage）。
 * サーバー内でだけ使う（message は内部のエラー本文で、資格情報・パスを含みうるので Hero へ返さない）。
 */
export interface OpponentOutage {
  /** 止まった手番の Action が入るはずだった seq。 */
  readonly seq: number;
  readonly playerId: string;
  readonly kind: OutageKind;
  readonly message: string;
}

/**
 * Hero に返す障害の状態。「どの CPU の手番か・障害の種類」だけを持つ（エラー本文・Persona・CPU の出力は持たない）。
 * revision は障害が起きる・解けるたびに進む。REST と SSE のどちらが先に届いても新しい方を選べるようにし、
 * 続け方の選択でも送り返させて、古いダイアログからの選択（二重送信）を弾く。
 */
export interface OutageStatus {
  readonly revision: number;
  /** 止まっていなければ null。 */
  readonly current: {
    readonly playerId: string;
    readonly kind: OutageKind;
  } | null;
}

/** 障害の後の続け方（D86）。 */
export type OutageChoice = "retry" | "emergency_bot" | "end_session";

export interface OrchestratorLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HandOrchestratorOptions {
  readonly store: EventStore;
  readonly setup: TableSetup;
  readonly createOpponent: OpponentFactory;
  /**
   * createOpponent が作る CPU の実装の記録用の説明（HAND_METADATA_RECORDED の席ごとの provider / Model Role / 具体モデル。#97）。
   * 省略時は RuleBot（createOpponent の既定と同じ）。
   */
  readonly opponentInfo?: OpponentInfo;
  /** HAND_METADATA_RECORDED に残すアプリの版。省略時は apps/server の package.json の version。 */
  readonly appVersion?: string;
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
  /**
   * Resume（D95）で戻さない Hand（Drill の Hand。D116）。最後の Hand がこの中にある Session（Drill の専用の Session）は戻さない。
   * 省略時は空。
   */
  readonly excludeFromResume?: () => ReadonlySet<string>;
  /**
   * Opponent Memory Reset の区切り（D120・#143）。CPU の Memory は、その CPU に効く最後の区切りより後に保存された Hand だけから作る。
   * Event Store と同じ順序の源（同じ DB の ordinals、またはメモリ内の同じカウンタ）を使う Store を渡す。省略時は区切り無し。
   */
  readonly memoryResets?: OpponentMemoryResetStore;
  /**
   * CPU Memory の Observation の Cache（D124・#165。起動時は SQLite の v12）。Event Store と同じ DB の Store を渡す。省略時は Cache を使わず、
   * Event Log から都度抽出する（メモリ内の Event Store）。Cache の有無で Memory は変わらない。
   */
  readonly observationCache?: ObservationCacheStore;
  /**
   * Hand のプレイ時間（Tournament の time_base の Level。D128・#184）を測る単調な時計（ms）。壁時計の巻き戻りで戻らない時計を渡す。
   * 省略時は performance.now()。テストでは進め方を決めた時計を渡す。
   */
  readonly playClock?: () => number;
  readonly logger?: OrchestratorLogger;
}

/**
 * Drill の Hand の開始（#117・D116）。Spot は Engine の Validation を通ったもの（drill/drill-plan.ts）で、相手の Action は
 * 判断の直前までは Spot の Script（元の Hand の公開の Action）、その後は RuleBot の決定論（persona があればその Preset）で決める。
 * CPU の LLM は呼ばない（課金の経路を増やさない）。ユーザーの弱点（Profile・Hypothesis・Score）は受け取らない（不変条件 2）。
 */
export interface DrillHandStart {
  readonly handId: string;
  readonly sessionId: string;
  readonly spot: DrillSpot;
  /** RuleBot の seed の元（Drill の seed）。 */
  readonly seed: number;
  readonly persona: PersonaPresetId | null;
}

export type HeroViewListener = (view: HeroView) => void;
export type OutageListener = (status: OutageStatus) => void;

interface HandRuntime {
  readonly handId: string;
  readonly sessionId: string;
  readonly opponents: ReadonlyMap<string, OpponentAgent>;
  /**
   * CPU ごとの、その CPU 自身の Memory の要約（D121・#139）。Hand の開始時に保存済みの Hand だけから作り、Hand の間は変えない。
   * 参加者の引けない CPU（v10 より前の Session・Drill）は持たない。
   */
  readonly memories: ReadonlyMap<string, OpponentMemorySummary>;
  /**
   * CPU ごとの、その CPU 自身の Tilt（D107・#140）。Hand の開始時に今の Session の保存済みの Hand だけから作り、Hand の間は変えない。
   * 1 以上の CPU だけが持つ。Persona の無い CPU・Drill は持たない。
   */
  readonly tilts: ReadonlyMap<string, CpuTilt>;
  /**
   * CPU ごとの、その CPU から見た卓の傾向（Table Tendency。D106・#141）。Hand の開始時に今の Session の、その CPU が座っていた
   * 保存済みの Hand の public の Event だけから作り、Hand の間は変えない。数えた Hand が 0 の CPU・Drill は持たない。
   */
  readonly tableTendencies: ReadonlyMap<string, TableTendency>;
  /** 不正な出力が続いたときに使う CPU ごとの RuleBot（Deterministic Fallback。D41）。 */
  readonly fallbackBots: ReadonlyMap<string, RuleBot>;
  readonly listeners: Set<HeroViewListener>;
  readonly outageListeners: Set<OutageListener>;
  /**
   * Hero が Emergency Bot を選んだ CPU → 選んだきっかけの障害の種類（EMERGENCY_BOT_ENGAGED の写し）。Session の終わりまで続くので、
   * 同じ Session の Hand は同じ Map を共有する（SessionPointer.emergencyBots）。
   */
  readonly emergencyBots: Map<string, OutageKind>;
  /** Hand を始めた時点の playClock の値（Hand のプレイ時間の起点。D128）。 */
  readonly playStartedAt: number;
  /** Hand が終わった（HAND_FINISHED を追記した）時点の playClock の値。まだ終わっていなければ null。 */
  playFinishedAt: number | null;
  /** CPU の手番を進めている最中ならその Promise（同じ Hand で 2 本同時に進めない）。 */
  running: Promise<void> | null;
  /** 今の待ち（思考待ち・判断待ち）を打ち切る（アプリ終了時）。待っていなければ null。 */
  cancelWait: (() => void) | null;
  /** 進行を止めた内部エラー。以降この Hand の CPU は動かさない。 */
  failure: string | null;
  /** CPU の障害で止まった手番。Hero が続け方を選ぶまで、この Hand の CPU は動かさない。 */
  outage: OpponentOutage | null;
  /** 障害の状態が変わった回数（OutageStatus.revision）。 */
  outageRevision: number;
  /**
   * Fast Forward（D12・D15・D93）。Hero が Hand から外れている間だけ入れられ、その Hand の残りの CPU の思考待ち（演出）を 0 にする。
   * CPU の判断そのものの待ち（Claude の応答）は縮めない。Hand が終わる（commit が HAND_FINISHED を追記する）と切れる。
   * 演出の状態なのでメモリにだけ持ち、Event には残さない。
   */
  fastForward: boolean;
  /** 今の思考待ち（演出）を今すぐ終わらせる。思考待ちの最中でなければ null（判断待ち・アプリ終了の打ち切りとは別）。 */
  endThinkWait: (() => void) | null;
}

/** CPU に 1 回判断を求めた結果。 */
type AskOutcome =
  | { readonly kind: "output"; readonly output: unknown }
  | {
      readonly kind: "outage";
      readonly cause: OutageKind;
      readonly message: string;
    }
  /** アプリ終了で待ちを打ち切った。 */
  | { readonly kind: "cancelled" };

/** 次 Hand の席・Button と、その Hand が属する Session。 */
interface HandPlan {
  readonly sessionId: string;
  /** 新しい Session の最初の Hand（SESSION_STARTED を置く）。 */
  readonly newSession: boolean;
  /** Session の設定（mode と Tournament の設定の Snapshot。D129）。 */
  readonly settings: SessionSettings;
  readonly personas: Readonly<Record<string, PersonaPresetId>>;
  /** CPU の席の参加者（Fixed CPU / Guest。D118）。新しい Session では seed で決め、続く Session では Session の値を使う。 */
  readonly participants: readonly SessionParticipant[];
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
}

/**
 * 今の Session。持つのは ID の参照と Emergency Bot の選択（EMERGENCY_BOT_ENGAGED の写し）と Persona の割り当てだけで、
 * Stack・席・Button は lastHandId の Event Log から読む（D37）。再起動後は Session Projection から戻す（resumeSession。D95）。
 */
interface SessionPointer {
  readonly sessionId: string;
  readonly lastHandId: string;
  readonly emergencyBots: Map<string, OutageKind>;
  /** CPU の Persona の割り当て（Session の開始時の設定。Session の途中で設定を変えて再起動しても変えない）。 */
  readonly personas: Readonly<Record<string, PersonaPresetId>>;
  /** CPU の席の参加者（Session の開始時に決めた値。Resume では Event Store の session_participants から戻す。D118）。 */
  readonly participants: readonly SessionParticipant[];
  /** Session の設定（Session の開始時の値。Resume では Session の最初の Hand の SESSION_STARTED から戻す。D129）。 */
  readonly settings: SessionSettings;
}

/** Hand の終わりから見た Session の状態と、続くなら次 Hand の席。 */
interface SessionAfter {
  readonly status: SessionStatus;
  readonly next: Omit<
    HandPlan,
    "sessionId" | "newSession" | "personas" | "participants" | "settings"
  > | null;
}

/** Persona の無い CPU の Skill（Persona の軸の平均。docs/05 §2）。Memory の十分な Sample の基準に使う。 */
const AVERAGE_SKILL = 0.5;

const silentLogger: OrchestratorLogger = { warn: () => {}, error: () => {} };

export class HandOrchestrator {
  private readonly hands = new Map<string, HandRuntime>();
  private readonly heroId: string;
  private readonly logger: OrchestratorLogger;
  private readonly playClock: () => number;
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
    this.playClock = options.playClock ?? (() => performance.now());
    this.session = this.resumeSession();
  }

  /**
   * 再起動の前に Hand の合間で止まった Session を、最後に Hand が終わった Session の Session Projection と、その最後の Hand の
   * Event から戻す（Resume。D62・D95）。戻すのは Projection が ready_for_next_hand で、最後の Hand の席の Player が今の卓の設定に
   * そろっている（Hero が座っている）ときだけ。人数・Player の設定を変えて起動したら続けられないので、新しい Session で始める。
   * 途中で止まった Hand（保存は Hand の終わり）は戻さない（Hand 途中の完全復帰は求めない）。
   */
  private resumeSession(): SessionPointer | null {
    const projection = this.options.store.latestSessionProjection(
      this.options.excludeFromResume?.() ?? new Set(),
    );
    if (projection === null || projection.state !== "ready_for_next_hand") {
      return null;
    }
    const known = new Set(this.options.setup.players.map((p) => p.playerId));
    let resumable = false;
    let cause: unknown = null;
    let settings: SessionSettings = { mode: "cash" };
    try {
      const started = this.events(projection.lastHandId)[0];
      const seated =
        started?.type === "HAND_STARTED"
          ? started.seats.map((s) => s.playerId)
          : [];
      // Session の設定は Session の最初の Hand の SESSION_STARTED の Snapshot から戻す（D129）。Snapshot が壊れていれば続けない。
      settings = this.sessionSettingsOfSession(projection.lastHandId);
      resumable =
        seated.includes(this.heroId) &&
        seated.every((id) => known.has(id)) &&
        this.sessionAfter(projection.lastHandId).next !== null;
    } catch (error) {
      // 最後の Hand を読めない・次 Hand の席を決められない（保存済みの Event と今の卓の設定が合わない）。
      // 起動は止めず、新しい Session で始める（理由は下の warn に残す）。
      cause = error;
    }
    if (!resumable) {
      this.logger.warn(
        {
          sessionId: projection.sessionId,
          lastHandId: projection.lastHandId,
          ...(cause === null ? {} : { err: cause }),
        },
        "前回の Session は今の卓の設定では続けられないため、新しい Session で始める",
      );
      return null;
    }
    // 保存した Preset ID のうち、今のアプリが知るものだけを使う（知らない ID の CPU は Persona なしで動く）。
    const personas: Record<string, PersonaPresetId> = {};
    for (const [playerId, presetId] of Object.entries(projection.personas)) {
      if (isPersonaPresetId(presetId)) personas[playerId] = presetId;
    }
    return {
      sessionId: projection.sessionId,
      lastHandId: projection.lastHandId,
      emergencyBots: new Map(
        projection.emergencyBots.map((b) => [b.playerId, b.cause]),
      ),
      personas,
      // 同じ Session の参加者をそのまま戻す（D118）。v10 より前の Session は行が無く空のまま続ける（推測で Identity を作らない）。
      participants: this.options.store.sessionParticipants(
        projection.sessionId,
      ),
      settings,
    };
  }

  /**
   * ある Hand の Session の設定（D129）。Session の最初の保存済みの Hand の SESSION_STARTED の Snapshot から読む。
   * Tournament の設定の無い Session（mode を指定しない Session・旧版の行）は cash。Snapshot が壊れていれば例外。
   */
  private sessionSettingsOfSession(handId: string): SessionSettings {
    const first = this.options.store.sessionHandIds(handId)[0] ?? handId;
    return sessionSettingsOf(this.events(first)) ?? { mode: "cash" };
  }

  get players(): readonly SeatPlayer[] {
    return this.options.setup.players;
  }

  /**
   * 今の Session の CPU の席の参加者（Fixed CPU / Guest。D118）。まだ Session が無ければ空。
   * server の中で CPU の Identity を引くためのもので、Hero への応答には載せない。
   */
  get sessionParticipants(): readonly SessionParticipant[] {
    return this.session?.participants ?? [];
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
  async startHand(
    afterHandId: string | null,
    request?: SessionRequest,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: { handId: string; view: HeroView; created: boolean };
      }
    | { readonly ok: false; readonly error: StartHandError }
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
    // 続く Session に違う設定・卓の人数に合わない Preset を求められたら、Hand を作る前に拒否する（seed・Hand ID は使わない）。
    const rejection = this.startRejection(request);
    if (rejection !== null) return { ok: false, error: rejection };
    const handId = this.options.nextHandId();
    if (this.hands.has(handId) || store.read(handId).length > 0) {
      throw new Error(`Hand ID が重複した: ${handId}`);
    }
    const seed = this.options.nextSeed();
    const plan = this.planNextHand(seed, request);
    // Emergency Bot の選択は Session の終わりまで続く（D86）。新しい Session では空から始める。
    const emergencyBots =
      this.session?.sessionId === plan.sessionId
        ? this.session.emergencyBots
        : new Map<string, OutageKind>();
    // Tournament の Hand は、開始時の Level の Blind / Ante で始め、Level と経過を HAND_STARTED に固定する（D128）。
    const tournament = this.tournamentHandOf(plan);
    const started = startHand({
      handId,
      seats: plan.seats,
      buttonPlayerId: plan.buttonPlayerId,
      config: tournament?.config ?? this.options.setup.table,
      deal: { seed },
      metadata: this.handMetadata(plan.seats, emergencyBots),
      ...(tournament === null ? {} : { tournament: tournament.context }),
    });
    if (!started.ok) return started;
    const playStartedAt = this.playClock();
    // CPU の Memory は、この Hand を書く前に保存済みの Hand だけから作る（決まった時点・同じ入力なら同じ要約。D121・D117）。
    const memories = this.opponentMemories(plan);
    // Tilt も同じ時点で、今の Session の保存済みの Hand だけから作る（新しい Session は 0 から。D107・D117）。
    const tilts = this.opponentTilts(plan);
    // Table Tendency も同じ時点で、今の Session の保存済みの Hand の public の Event だけから作る（D106・D117）。
    const tableTendencies = this.opponentTableTendencies(plan);
    // 新しい Session の最初の Hand には、開始の Event に続けて SESSION_STARTED を置く（D95）。
    // Session の最初の Hand は全員が均等 Stack（Big Blind より多い）で始まるので、開始の時点では終わっていない。
    const opening = plan.newSession
      ? [
          ...started.value.events,
          ...recordSessionEvent(started.value.state, {
            type: "SESSION_STARTED",
            sessionId: plan.sessionId,
            // Tournament の Session だけ、設定の Snapshot を残す（D129）。cash の Session の Event は変えない。
            ...(plan.settings.mode === "tournament"
              ? { tournament: plan.settings.tournament }
              : {}),
          }).events,
        ]
      : started.value.events;
    // 開始直後に Hand が終わる（Blind で All-in が決まる）こともあるので、Session の終わりもここで判定する。
    store.append(handId, this.withSessionEnd(handId, plan.sessionId, opening), {
      sessionId: plan.sessionId,
      personas: plan.personas,
      participants: plan.participants,
    });
    // 開始直後に終わった Hand（Blind で All-in が決まる）のプレイ時間は 0。
    const endedAtStart = opening.some((e) => e.type === "HAND_FINISHED");
    this.session = {
      sessionId: plan.sessionId,
      lastHandId: handId,
      emergencyBots,
      personas: plan.personas,
      participants: plan.participants,
      settings: plan.settings,
    };

    // 座っている CPU にだけ Opponent（と Fallback 用の RuleBot）を割り当てる。CPU の seed は卓の設定上の席番号から導く
    // （Bust で席が詰まっても、同じ CPU には同じ導き方の seed が渡る）。
    // Persona は playerId で引くので席が詰まっても変わらない。Opponent の中だけで使い、Event・View には入れない（#51・D28）。
    // Fallback の RuleBot にも同じ Persona を渡す（不正な出力が続いても、その CPU の性格のまま決定論で続ける。D41）。
    const seated = new Set(plan.seats.map((s) => s.playerId));
    const opponents = new Map<string, OpponentAgent>();
    const fallbackBots = new Map<string, RuleBot>();
    setup.players.forEach((p, seatIndex) => {
      if (p.kind === "cpu" && seated.has(p.playerId)) {
        const cpuSeed = deriveSeed(seed, seatIndex);
        const presetId = plan.personas[p.playerId];
        const persona =
          presetId === undefined ? undefined : PERSONA_PRESETS[presetId];
        opponents.set(
          p.playerId,
          this.options.createOpponent(cpuSeed, p.playerId, persona),
        );
        fallbackBots.set(p.playerId, new RuleBot(cpuSeed, persona));
      }
    });
    const rt: HandRuntime = {
      handId,
      sessionId: plan.sessionId,
      opponents,
      memories,
      tilts,
      tableTendencies,
      fallbackBots,
      listeners: new Set(),
      outageListeners: new Set(),
      emergencyBots,
      playStartedAt,
      playFinishedAt: endedAtStart ? playStartedAt : null,
      running: null,
      cancelWait: null,
      failure: null,
      outage: null,
      outageRevision: 0,
      fastForward: false,
      endThinkWait: null,
    };
    this.hands.set(handId, rt);
    await this.proceed(rt);
    return {
      ok: true,
      value: { handId, view: this.heroViewOf(handId), created: true },
    };
  }

  /**
   * Drill の Hand を始める（#117・D116）。専用の Session（その Hand だけの Session）の通常の Hand として、Spot の開始と Script を
   * Engine で判断の直前まで進めて Event Log へ追記し、Hero の手番（練習する判断）の View を返す。
   * 今の Session（this.session）は変えない（Drill の後も通常の Play はそのまま続く。Drill の Hand は Resume でも戻さない）。
   * Hero の Action・SSE・Review は通常の Hand と同じ経路で扱う。CPU は RuleBot だけで、Persona は Drill の設定（Hidden Persona は読まない）。
   */
  async startDrill(
    input: DrillHandStart,
  ): Promise<OrchestratorResult<{ handId: string; view: HeroView }>> {
    const { store, setup } = this.options;
    const { handId, sessionId, spot } = input;
    if (spot.heroId !== this.heroId) {
      return {
        ok: false,
        error: {
          kind: "invalid_input",
          message: `Drill の Hero が卓の Hero と違う: ${spot.heroId}`,
        },
      };
    }
    if (this.hands.has(handId) || store.read(handId).length > 0) {
      throw new Error(`Hand ID が重複した: ${handId}`);
    }
    const cpuSeats = spot.seats.filter((s) => s.playerId !== this.heroId);
    const opened = startDrillHand({
      handId,
      sessionId,
      spot,
      config: setup.table,
      // Drill の CPU は RuleBot だけ（Model は使わない）。
      metadata: {
        appVersion: this.options.appVersion ?? APP_VERSION,
        cpuProfileVersion: PERSONA_PROFILE_VERSION,
        cpuSeats: cpuSeats.map((s): CpuSeatMetadata => ({
          playerId: s.playerId,
          ...RULE_BOT_INFO,
        })),
      },
    });
    if (!opened.ok) return opened;
    const personas: Record<string, PersonaPresetId> = {};
    if (input.persona !== null) {
      for (const s of cpuSeats) personas[s.playerId] = input.persona;
    }
    store.append(handId, opened.value.events, { sessionId, personas });

    // 判断の後の相手は RuleBot（Drill の Persona。無ければ既定）。seed は Drill の seed と Spot の席順から導く（同じ Drill なら同じ判断）。
    const persona =
      input.persona === null ? undefined : PERSONA_PRESETS[input.persona];
    const opponents = new Map<string, OpponentAgent>();
    const fallbackBots = new Map<string, RuleBot>();
    spot.seats.forEach((s, seatIndex) => {
      if (s.playerId === this.heroId) return;
      const cpuSeed = deriveSeed(input.seed, seatIndex);
      opponents.set(s.playerId, new RuleBot(cpuSeed, persona));
      fallbackBots.set(s.playerId, new RuleBot(cpuSeed, persona));
    });
    const rt: HandRuntime = {
      handId,
      sessionId,
      opponents,
      // Drill の専用の Session は参加者の行を持たないので、CPU の Memory も持たない（D116・D118）。
      memories: new Map(),
      // Drill の専用の Session はその Hand だけなので、Tilt も持たない（D116）。
      tilts: new Map(),
      // Drill の専用の Session はその Hand だけなので、Table Tendency も持たない（D116）。
      tableTendencies: new Map(),
      fallbackBots,
      listeners: new Set(),
      outageListeners: new Set(),
      emergencyBots: new Map(),
      playStartedAt: this.playClock(),
      playFinishedAt: null,
      running: null,
      cancelWait: null,
      failure: null,
      outage: null,
      outageRevision: 0,
      fastForward: false,
      endThinkWait: null,
    };
    this.hands.set(handId, rt);
    await this.proceed(rt);
    return { ok: true, value: { handId, view: this.heroViewOf(handId) } };
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
    const stale = this.staleView(events, lastSeq);
    if (stale !== null) return stale;
    const result = applyAction(foldHandEvents(events), this.heroId, action);
    if (!result.ok) return result;
    this.commit(rt, result.value.events);
    await this.proceed(rt);
    return { ok: true, value: this.heroViewOf(handId) };
  }

  /**
   * Hero の物理的な操作（した順の宣言・Chip を出す・足す）を Ruling Engine で裁定し、操作・裁定・決まった Action を
   * 1 回で Event Log へ追記する（D90・D91）。lastSeq の扱いは heroAction と同じ。
   * 手番でなければ Out-of-Turn として保留し（CPU は保留を公開の事実として KnowledgeState で見る）、Hero の手番が来た時点で
   * runCpuTurns が拘束か撤回かを裁定する。その後、次に Hero の手番が来るか Hand が終わるまで CPU を進める。
   */
  async heroPhysicalAction(
    handId: string,
    lastSeq: number,
    actions: readonly PhysicalAction[],
  ): Promise<OrchestratorResult<HeroView>> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    const events = this.events(handId);
    const stale = this.staleView(events, lastSeq);
    if (stale !== null) return stale;
    const result = applyPhysicalActions(
      foldHandEvents(events),
      this.heroId,
      actions,
      this.options.setup.table,
    );
    if (!result.ok) return result;
    this.commit(rt, result.value.events);
    await this.proceed(rt);
    return { ok: true, value: this.heroViewOf(handId) };
  }

  /**
   * Hero の User Read（判断の前の読み・意図）を USER_READ_RECORDED として Event Log へ追記し、Hero の View を配る（D33・D112）。
   * 記録できるのは Hand の途中の Hero の手番の間だけ（Engine の recordUserRead が判定する）。手番の間は CPU を動かしていないので、
   * 追記が CPU の手番の判断（isCurrent）を古くすることはない。Event は Hero だけの private で、CPU の KnowledgeState には入らない。
   * 卓の状態は変えないので、CPU は進めない（次に CPU が動くのは Hero の Action の後）。
   * lastSeq の扱いは heroAction と同じ（応答だけが失われた記録の再送を stale_view で弾き、同じ読みを 2 回追記しない）。
   */
  heroUserRead(
    handId: string,
    lastSeq: number,
    read: { readonly targetPlayerId: string | null; readonly text: string },
  ): OrchestratorResult<HeroView> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    const events = this.events(handId);
    const stale = this.staleView(events, lastSeq);
    if (stale !== null) return stale;
    const result = recordUserRead(foldHandEvents(events), {
      playerId: this.heroId,
      targetPlayerId: read.targetPlayerId,
      text: read.text,
    });
    if (!result.ok) return result;
    this.commit(rt, result.value.events);
    return { ok: true, value: this.heroViewOf(handId) };
  }

  /**
   * Note / Tag の対象（Subject）を、Hand と席から決める（D105・#115）。席の playerId（cpu1 等）は永続の Identity ではないので、
   * その Hand が属する Session の中の参加者として持つ（Phase 7 で Session の席と cpuProfileId の対応から永続の CPU へ引ける）。
   * 対象にできるのは、このプロセスで進めた Hand の Hero 以外の席だけ。
   */
  subjectOf(
    handId: string,
    playerId: string,
  ): OrchestratorResult<SessionPlayerSubject> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    const started = this.events(handId).find((e) => e.type === "HAND_STARTED");
    const seated =
      started?.type === "HAND_STARTED" &&
      started.seats.some((s) => s.playerId === playerId);
    if (!seated || playerId === this.heroId) {
      return {
        ok: false,
        error: {
          kind: "invalid_input",
          message: `Note / Tag の対象はこの Hand の Hero 以外の席: ${playerId}`,
        },
      };
    }
    return {
      ok: true,
      value: { kind: "session_player", sessionId: rt.sessionId, playerId },
    };
  }

  /**
   * Hero が見ていた HeroView の log の最後の seq（lastSeq）より Log が進んでいれば stale_view を返す
   * （二重送信や、CPU の行動を見る前の画面からの送信を、手番の判定より先に弾く）。
   */
  private staleView(
    events: readonly HandEvent[],
    lastSeq: number,
  ): { ok: false; error: OrchestratorError } | null {
    const seen = projectHeroView(events, this.heroId).log.at(-1)?.seq;
    if (seen === lastSeq) return null;
    return {
      ok: false,
      error: {
        kind: "stale_view",
        message: `卓の状態が更新されている（最新の seq は ${seen}、送信は ${lastSeq}）`,
      },
    };
  }

  /** Hero に見える卓の状態。未知の Hand なら null。 */
  heroView(handId: string): HeroView | null {
    return this.hands.has(handId) ? this.heroViewOf(handId) : null;
  }

  /** その Hand から見た Session の状態（Event Log から作る）。未知の Hand なら null。 */
  sessionStatus(handId: string): SessionStatus | null {
    if (!this.hands.has(handId)) return null;
    return this.sessionAfter(handId).status;
  }

  /**
   * その Hand の Session の Tournament の Elimination と順位（D129・#185）。Session の終わった Hand の Event Log から都度計算し、保存しない。
   * cash の Session・未知の Hand・終わった Hand がまだ無い Session は null。Hero の順位は placements から Hero の playerId で引く。
   */
  tournamentStandingsOf(handId: string): TournamentStandings | null {
    const handIds = this.options.store.sessionHandIds(handId);
    return tournamentStandings(handIds.map((id) => this.events(id)));
  }

  /**
   * その Hand の Session の Tournament の Result（順位と Payout。D129・#186）。Session の終わった Hand の Event Log から都度計算し、
   * 保存しない。cash の Session・未知の Hand・終わった Hand がまだ無い Session は null。Hero の順位と Payout は placements から
   * Hero の playerId で引く（未決の順位の Payout は null）。
   */
  tournamentResultOf(handId: string): TournamentResult | null {
    const handIds = this.options.store.sessionHandIds(handId);
    return tournamentResult(handIds.map((id) => this.events(id)));
  }

  /** Hero の View が変わるたびに呼ばれる listener を登録する。戻り値で解除する。未知の Hand なら null。 */
  subscribe(handId: string, listener: HeroViewListener): (() => void) | null {
    const rt = this.hands.get(handId);
    if (rt === undefined) return null;
    rt.listeners.add(listener);
    return () => rt.listeners.delete(listener);
  }

  /** CPU の障害で止まっていればその内容（サーバー内用。Hero へは outageStatus を返す）。止まっていない・未知の Hand なら null。 */
  outageOf(handId: string): OpponentOutage | null {
    return this.hands.get(handId)?.outage ?? null;
  }

  /** Hero に返す障害の状態。未知の Hand なら null。 */
  outageStatus(handId: string): OutageStatus | null {
    const rt = this.hands.get(handId);
    return rt === undefined ? null : outageStatusOf(rt);
  }

  /** 障害の状態が変わるたびに呼ばれる listener を登録する。戻り値で解除する。未知の Hand なら null。 */
  subscribeOutage(
    handId: string,
    listener: OutageListener,
  ): (() => void) | null {
    const rt = this.hands.get(handId);
    if (rt === undefined) return null;
    rt.outageListeners.add(listener);
    return () => rt.outageListeners.delete(listener);
  }

  /**
   * 障害で止まった Hand の続け方を Hero が選ぶ（D86）。revision は Hero が見ていた OutageStatus の revision。
   * 障害が無い・revision が違う（二重送信・古いダイアログ）なら stale_outage で拒否する。
   * - retry: 同じ手番をもう一度 CPU に求める（また障害なら、また止まる）
   * - emergency_bot: EMERGENCY_BOT_ENGAGED を残し、その CPU を Session の終わりまで RuleBot（その CPU の Persona のまま）で動かす。
   *   手番ごとに AI_FALLBACK_USED（emergency_bot）を残す（Opponent Quality の分析で通常の判断と混同しない）
   * - end_session: その Hand を HAND_ABORTED で打ち切り、SESSION_ENDED を続けて Session を終える（Hand は保存され Replay の一覧に残る）。
   *   次の開始は新しい Session（均等 Stack）になる
   * 選んだ後は、Hero の手番か Hand の終了まで CPU を進めた時点の View を返す（思考待ちがあれば後から SSE で届く）。
   */
  async resolveOutage(
    handId: string,
    revision: number,
    choice: OutageChoice,
  ): Promise<OrchestratorResult<HeroView>> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    const outage = rt.outage;
    if (outage === null || rt.outageRevision !== revision) {
      return {
        ok: false,
        error: {
          kind: "stale_outage",
          message: `障害の状態が更新されている（最新の revision は ${rt.outageRevision}、送信は ${revision}）`,
        },
      };
    }
    // 選んだ結果は、障害の状態を解く（購読者へ配る）前に Event Log へ残す（D95）。追記に失敗したら障害のまま残し、選び直せる。
    // 障害で止まった手番はその CPU のまま（Hero の Out-of-Turn の操作は手番を変えない）。
    if (choice === "emergency_bot") {
      this.record(
        rt,
        recordSessionEvent(foldHandEvents(this.events(handId)), {
          type: "EMERGENCY_BOT_ENGAGED",
          playerId: outage.playerId,
          cause: outage.kind,
        }),
      );
      rt.emergencyBots.set(outage.playerId, outage.kind);
    } else if (choice === "end_session") {
      const aborted = recordSessionEvent(foldHandEvents(this.events(handId)), {
        type: "HAND_ABORTED",
        reason: "ai_outage",
      });
      const ended = recordSessionEvent(aborted.state, {
        type: "SESSION_ENDED",
        sessionId: rt.sessionId,
        reason: "ai_outage",
      });
      // HAND_ABORTED で Hand が終わるので、ここで Hand と Session Projection が保存される。
      this.options.store.append(handId, [...aborted.events, ...ended.events], {
        sessionId: rt.sessionId,
      });
    }
    this.logger.warn(
      { handId, playerId: outage.playerId, kind: outage.kind, choice },
      "CPU の障害の続け方が選ばれた",
    );
    this.setOutage(rt, null);
    // 障害で止まった進行の後始末（running の解除）が済んでから進める（済む前だと advance が何もしない）。
    if (rt.running !== null) await rt.running;
    // 打ち切った Hand は終わっている（State は complete）ので進めない。
    if (choice !== "end_session") await this.proceed(rt);
    return { ok: true, value: this.heroViewOf(handId) };
  }

  /** その Hand の Fast Forward が入っているか（Hand が終わっていれば false）。未知の Hand なら null。 */
  fastForwardOf(handId: string): boolean | null {
    const rt = this.hands.get(handId);
    return rt === undefined ? null : rt.fastForward;
  }

  /**
   * Fast Forward を入れる・切る（D12・D15・D93）。入れられるのは Hero が Hand から外れている間（Fold 後）で、Hand が終われば自動で切れる
   * （次の Hand は通常の速さ）。入れると、その Hand の残りの CPU の思考待ち（演出。botDelayMs）を 0 にし、待っている最中の分も今すぐ終える。
   * CPU の判断の待ち（Claude の応答。opponentTimeoutMs の範囲）は縮めない。切るのは Hand が終わった後でも受け付ける（何も起きない）。
   */
  setFastForward(
    handId: string,
    enabled: boolean,
  ): OrchestratorResult<{ fastForward: boolean }> {
    const rt = this.hands.get(handId);
    if (rt === undefined) return notFound(handId);
    if (!enabled) {
      rt.fastForward = false;
      return { ok: true, value: { fastForward: false } };
    }
    const view = this.heroViewOf(handId);
    const hero = view.seats.find((s) => s.playerId === this.heroId);
    if (view.status === "complete" || (hero !== undefined && !hero.folded)) {
      return {
        ok: false,
        error: {
          kind: "not_spectating",
          message:
            "Fast Forward は Hero が Fold した後、Hand の終了までの間だけ使える",
        },
      };
    }
    rt.fastForward = true;
    rt.endThinkWait?.();
    return { ok: true, value: { fastForward: true } };
  }

  /** CPU の待ち（思考待ち・判断待ち）を打ち切る（アプリ終了時）。以降は CPU を進めない。遅れて届いた判断も適用しない。 */
  close(): void {
    this.closed = true;
    for (const rt of this.hands.values()) {
      rt.cancelWait?.();
      rt.listeners.clear();
      rt.outageListeners.clear();
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
   * 内部エラーで止まった Hand・障害の後に Session 終了を選んで打ち切った Hand・再起動前の Hand（Resume した Session の最後の Hand）は
   * 返さない（新しい Hand で始め直せるようにする）。
   */
  private unseenLatestHand(afterHandId: string | null): string | null {
    const current = this.session;
    if (current === null) return null;
    const rt = this.hands.get(current.lastHandId);
    if (rt === undefined || rt.failure !== null) return null;
    const events = this.events(current.lastHandId);
    if (events.some((e) => e.type === "HAND_ABORTED")) return null;
    const finished = this.sessionAfterEvents(events).status.state !== "in_hand";
    return finished && afterHandId === current.lastHandId
      ? null
      : current.lastHandId;
  }

  /**
   * 座っている CPU ごとに、その CPU 自身の Memory の要約を作る（D121・#139）。Event Store へこの Hand を書く前に呼ぶ。
   * - Observer は session_participants の参加者（Fixed CPU / Guest）。参加者の引けない CPU（v10 より前の Session）は作らない
   * - Subject は今の Hand の他の参加者（Hero と他 CPU）で、席の playerId との対応はこの Hand の中だけのもの
   * - Skill は Observer の Persona（Fixed CPU は Pool の Persona、Guest は席の Persona）。Persona が無ければ平均（0.5）
   * - Opponent Memory Reset（D120）の後は、その CPU に効く最後の区切りより後に保存された Hand だけを入力にする
   */
  private opponentMemories(
    plan: HandPlan,
  ): ReadonlyMap<string, OpponentMemorySummary> {
    const participantOf = new Map(
      plan.participants.map((p) => [p.playerId, p] as const),
    );
    const seats: MemoryTableSeat[] = plan.seats.map((s) => {
      const p = participantOf.get(s.playerId);
      return {
        playerId: s.playerId,
        participant:
          s.playerId === this.heroId
            ? { kind: "hero" }
            : p === undefined
              ? null
              : participantRefOf(p),
      };
    });
    const observers: MemoryObserverSeat[] = plan.seats.flatMap((s) => {
      const p = participantOf.get(s.playerId);
      if (s.playerId === this.heroId || p === undefined) return [];
      const presetId = plan.personas[s.playerId];
      const observer = participantRefOf(p);
      return [
        {
          playerId: s.playerId,
          observer,
          observerSkill:
            presetId === undefined
              ? AVERAGE_SKILL
              : PERSONA_PRESETS[presetId].traits.skill,
          // その CPU に効く Opponent Memory Reset の区切りより後に保存された Hand だけから作る（D120）。
          afterOrd:
            this.options.memoryResets?.boundaryFor(observer)?.ord ?? null,
        },
      ];
    });
    if (observers.length === 0) return new Map();
    const cache = this.options.observationCache;
    return buildOpponentMemoriesFromStore(this.options.store, {
      heroPlayerId: this.heroId,
      currentSessionId: plan.sessionId,
      seats,
      observers,
      // Cache（D124）は読むときに足りない Hand だけを足す。失敗は warn に残し、Memory は Event Log から作る。
      ...(cache === undefined
        ? {}
        : { observationCache: { store: cache, logger: this.logger } }),
    });
  }

  /**
   * 座っている CPU ごとに、その CPU 自身の Tilt を作る（D107・D119・#140）。Event Store へこの Hand を書く前に呼ぶ。
   * - Tilt は Session の中の席ごとの transient な状態で、Memory（参加者の Identity）とは別の層。今の Session の Hand だけを読むので、
   *   新しい Session（Session 終了の後・放置された Session の後）は 0 から始まり、Resume では同じ Session の Hand から同じ値になる
   * - 上がり幅・下がり方は席の Persona（Fixed CPU は Pool の Persona、Guest は席の Persona）。Persona の無い CPU は Tilt を持たない
   */
  private opponentTilts(plan: HandPlan): ReadonlyMap<string, CpuTilt> {
    if (plan.newSession) return new Map();
    const seats: TiltSeat[] = plan.seats.flatMap((s) => {
      const presetId = plan.personas[s.playerId];
      if (s.playerId === this.heroId || presetId === undefined) return [];
      return [
        { playerId: s.playerId, traits: PERSONA_PRESETS[presetId].traits },
      ];
    });
    return buildTiltsFromStore(this.options.store, {
      sessionId: plan.sessionId,
      seats,
    });
  }

  /**
   * 座っている CPU ごとに、その CPU から見た Table Tendency を作る（D106・#141）。Event Store へこの Hand を書く前に呼ぶ。
   * 今の Session の Hand だけを読み、各 CPU はその CPU が座っていた Hand の public の Event だけを数える（Persona・Memory・Tilt は使わない）。
   */
  private opponentTableTendencies(
    plan: HandPlan,
  ): ReadonlyMap<string, TableTendency> {
    if (plan.newSession) return new Map();
    return buildCpuTableTendenciesFromStore(this.options.store, {
      sessionId: plan.sessionId,
      playerIds: plan.seats
        .map((s) => s.playerId)
        .filter((playerId) => playerId !== this.heroId),
    });
  }

  /**
   * 次 Hand の席・Button・Session を決める（呼ぶのは最後の Hand を返さないと決めた後だけ）。
   * - 今の Session の最後の Hand が終わり、Session が続くなら: Position Engine の結果で Stack を持ち越す
   * - それ以外（最初の Hand・Session 終了後・最後の Hand が内部エラーで止まった・障害の後に Session 終了を選んだ）: 新しい Session。
   *   均等 Stack で、Button は席順の先頭（止まった Hand は持ち越す Stack が決まらないので、Session ごと始め直す）。
   *   CPU の席の参加者（Fixed CPU / Guest。D118）は、その Hand の seed から導いた seed で決定論に決め、Persona は Fixed CPU なら
   *   Pool の Persona、Guest なら今の卓の設定の割り当て（既定の割り当てでは両者は同じ。composeSessionParticipants）
   */
  private planNextHand(seed: number, request?: SessionRequest): HandPlan {
    const current = this.session;
    if (current !== null) {
      const after = this.sessionAfter(current.lastHandId);
      if (after.next !== null) {
        return {
          sessionId: current.sessionId,
          newSession: false,
          personas: current.personas,
          participants: current.participants,
          settings: current.settings,
          ...after.next,
        };
      }
    }
    const { players, personas } = this.options.setup;
    // 新しい Session の設定は開始の要求で決める（省略は cash）。Tournament は Preset の設定をそのまま Snapshot にする（D129）。
    const settings: SessionSettings =
      request?.mode === "tournament"
        ? {
            mode: "tournament",
            tournament: TOURNAMENT_PRESETS[request.presetId],
          }
        : { mode: "cash" };
    const startingStack =
      settings.mode === "tournament"
        ? settings.tournament.startingStack
        : this.options.setup.startingStack;
    const sessionId = (this.options.nextSessionId ?? randomUUID)();
    // 席番号（0〜MAX_PLAYERS - 1。CPU の seed に使う）と重ならない番号で導き、山札・CPU の乱数と別の列にする。
    const composition = composeSessionParticipants({
      sessionId,
      seats: players
        .filter((p) => p.kind === "cpu")
        .map((p) => ({ playerId: p.playerId, persona: personas[p.playerId] })),
      seed: deriveSeed(seed, MAX_PLAYERS),
    });
    if (composition.unmatched.length > 0) {
      // 席の Persona（CPU_PERSONAS）を満たす Fixed CPU が Pool に残っていない席は、Fixed CPU が Pool の Persona のまま座る
      // （同じ cpuProfileId は常に同じ Persona。D118）。上書きが効かなかった席を残す（座った CPU の Persona は書かない）。
      this.logger.warn(
        { sessionId, seats: composition.unmatched },
        "CPU_PERSONAS の割り当てを満たす Fixed CPU が足りない席は、Fixed Pool の Persona で座らせる（上書きはその席では効かない）",
      );
    }
    return {
      sessionId,
      newSession: true,
      settings,
      // Fixed CPU は Pool の Persona、Guest は席の Persona（Session Projection に残り、Resume でも同じ）。
      personas: composition.personas,
      participants: composition.participants,
      seats: players.map((p) => ({
        playerId: p.playerId,
        stack: startingStack,
      })),
      buttonPlayerId: (players[0] as SeatPlayer).playerId,
    };
  }

  /**
   * 開始の要求を受け付けられなければその失敗（#183）。受け付けられる・要求が無いなら null。
   * - 今の Session が続くとき: 求めた設定が今の Session の設定と違えば session_mode_mismatch。Tournament は Preset の ID で比べる
   *   （Resume した Session は開始時の Snapshot で続けるので、Preset の版が変わっていても同じ Preset なら続ける）
   * - 次の Hand が新しい Session のとき: Tournament の Preset の参加人数が卓の人数と違えば tournament_unavailable
   */
  private startRejection(
    request: SessionRequest | undefined,
  ): StartHandError | null {
    const current = this.session;
    if (request === undefined) return null;
    if (
      current === null ||
      this.sessionAfter(current.lastHandId).next === null
    ) {
      // 次の Hand は新しい Session。Tournament は Preset の参加人数の卓でだけ始める（Payout・Prize Pool の前提）。
      if (request.mode !== "tournament") return null;
      const { tableSize } = TOURNAMENT_PRESETS[request.presetId];
      const seats = this.options.setup.players.length;
      if (seats === tableSize) return null;
      return {
        kind: "tournament_unavailable",
        message: `Preset ${request.presetId} は ${tableSize} 人の卓で始める（今の卓は ${seats} 人）`,
      };
    }
    const { settings } = current;
    const same =
      request.mode === settings.mode &&
      (settings.mode === "cash" ||
        (request.mode === "tournament" &&
          request.presetId === settings.tournament.presetId));
    if (same) return null;
    return {
      kind: "session_mode_mismatch",
      message: `今の Session（${settings.mode === "cash" ? "cash" : `tournament: ${settings.tournament.presetId}`}）が続いているので、違う設定の Session は始められない`,
    };
  }

  /**
   * Tournament の Hand の卓の設定と、開始時の Level と経過（D108・D128・#184）。cash の Hand は null（卓の設定のまま。既存の経路）。
   * Rule Profile は Cash と共有し、Blind / Ante をその Level の額にする。Level は Session の最初の Hand なら 1 Hand 目・プレイ時間 0 から、
   * 続く Hand なら前の Hand の HAND_STARTED の値にその Hand のプレイ時間を足した進みから決める（levelAt）。
   */
  private tournamentHandOf(plan: HandPlan): {
    readonly config: TableConfig;
    readonly context: TournamentHandContext;
  } | null {
    const { settings } = plan;
    if (settings.mode !== "tournament") return null;
    const last = this.session?.lastHandId;
    const progress =
      plan.newSession || last === undefined
        ? FIRST_TOURNAMENT_PROGRESS
        : nextTournamentProgress(
            this.progressAtStartOf(last),
            this.handPlayTimeMs(last),
          );
    const { context, level } = tournamentHandContext(
      settings.tournament,
      progress,
    );
    return {
      config: tableConfigForLevel(
        this.options.setup.table,
        level,
        settings.tournament.anteKind,
      ),
      context,
    };
  }

  /**
   * Tournament の Hand の開始時の進み（HAND_STARTED の tournament）。版 9 で保存した Tournament の Hand（#183。Level を持たない）は、
   * Session の終わった Hand の数（論理順序。D117）を Hand の番号とし、プレイ時間は数えていなかったので 0 から数える。
   */
  private progressAtStartOf(handId: string): TournamentProgress {
    const started = this.events(handId)[0];
    if (started?.type === "HAND_STARTED" && started.tournament !== undefined) {
      return started.tournament;
    }
    const index = this.options.store.sessionHandIds(handId).indexOf(handId);
    return { handNumber: index < 0 ? 1 : index + 1, playTimeMs: 0 };
  }

  /**
   * 終わった Hand のプレイ時間（Hand の開始から終わりまで。ms。D128）。このプロセスで始めて終えた Hand は playClock（単調な時計）で測る。
   * 前のプロセスで終わった Hand（Resume の直後の最初の Hand の計算）は、保存した最初の Event と HAND_FINISHED の記録時刻の差で測る
   * （壁時計なので、巻き戻っていれば 0 として数える。nextTournamentProgress）。終わっていない Hand は 0。
   */
  private handPlayTimeMs(handId: string): number {
    const rt = this.hands.get(handId);
    if (rt !== undefined) {
      return rt.playFinishedAt === null
        ? 0
        : rt.playFinishedAt - rt.playStartedAt;
    }
    const stored = this.options.store.read(handId);
    const first = stored[0];
    const finished = stored.find((s) => s.event.type === "HAND_FINISHED");
    if (first === undefined || finished === undefined) return 0;
    return Date.parse(finished.recordedAt) - Date.parse(first.recordedAt);
  }

  /**
   * Hand の開始時の Metadata（HAND_METADATA_RECORDED。#97）。座っている CPU を席順に、その時点の実装で残す。
   * Emergency Bot を選んだ CPU は emergency_bot（Model は使わないので null）、それ以外は createOpponent の実装（opponentInfo）。
   * Hand の途中で Emergency Bot に切り替えた CPU は、その Hand では開始時の実装のまま（切り替えは EMERGENCY_BOT_ENGAGED に残る）。
   */
  private handMetadata(
    seats: readonly SeatInit[],
    emergencyBots: ReadonlyMap<string, OutageKind>,
  ): HandMetadataInput {
    const cpuIds = new Set(
      this.options.setup.players
        .filter((p) => p.kind === "cpu")
        .map((p) => p.playerId),
    );
    const info = this.options.opponentInfo ?? RULE_BOT_INFO;
    const cpuSeats = seats
      .filter((s) => cpuIds.has(s.playerId))
      .map((s): CpuSeatMetadata =>
        emergencyBots.has(s.playerId)
          ? {
              playerId: s.playerId,
              provider: "emergency_bot",
              modelRole: null,
              model: null,
            }
          : {
              playerId: s.playerId,
              provider: info.provider,
              modelRole: info.modelRole,
              model: info.model,
            },
      );
    return {
      appVersion: this.options.appVersion ?? APP_VERSION,
      cpuProfileVersion: PERSONA_PROFILE_VERSION,
      cpuSeats,
    };
  }

  /** Hand の終了後の Session の状態と、続くなら次 Hand の席。その Hand の Event Log だけから作る（D37）。 */
  private sessionAfter(handId: string): SessionAfter {
    return this.sessionAfterEvents(this.events(handId));
  }

  /**
   * Hand の Event から Session の状態を作る。SESSION_ENDED があればその理由で終わり（D95）。
   * 無ければ、席順と Button は HAND_STARTED、Stack は HAND_FINISHED から読み、Bust の判定と Button の移動は Position Engine に任せる
   * （SESSION_ENDED を置くかどうかも、HAND_FINISHED を追記する前にこの判定で決める。withSessionEnd）。
   */
  private sessionAfterEvents(events: readonly HandEvent[]): SessionAfter {
    const ended = events.find((e) => e.type === "SESSION_ENDED");
    if (ended?.type === "SESSION_ENDED") {
      return { status: { state: "ended", reason: ended.reason }, next: null };
    }
    const started = events[0];
    const finished = events.find((e) => e.type === "HAND_FINISHED");
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
   * Hand が終わり Session も終わるなら、HAND_FINISHED の直後に SESSION_ENDED を足した Event を返す（D80・D95）。
   * 終わらなければ events をそのまま返す。Session の終わりは Hand の Event だけで決まるので、Hand の保存と同じ追記で置く。
   */
  private withSessionEnd(
    handId: string,
    sessionId: string,
    events: readonly HandEvent[],
  ): readonly HandEvent[] {
    if (!events.some((e) => e.type === "HAND_FINISHED")) return events;
    const log = [...this.events(handId), ...events];
    const { status } = this.sessionAfterEvents(log);
    if (status.state !== "ended") return events;
    const ended = recordSessionEvent(foldHandEvents(log), {
      type: "SESSION_ENDED",
      sessionId,
      reason: status.reason,
    });
    return [...events, ...ended.events];
  }

  /**
   * CPU の判断の経緯・Emergency Bot への切り替え（system Visibility の Event）を Log へ追記する。Hero の View は変わらないので配らない。
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
    this.options.store.append(
      rt.handId,
      this.withSessionEnd(rt.handId, rt.sessionId, events),
      { sessionId: rt.sessionId },
    );
    // Hand が終わったら通常の速さに戻し（Fast Forward はその Hand だけ）、プレイ時間の終わりを記録する（D128）。
    if (events.some((e) => e.type === "HAND_FINISHED")) {
      rt.fastForward = false;
      rt.playFinishedAt ??= this.playClock();
    }
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
        const state = foldHandEvents(events);
        const legal = getLegalActions(state);
        if (legal === null) return;
        if (legal.playerId === this.heroId) {
          // Hero の手番。保留した Out-of-Turn があれば、ここで拘束か撤回かを裁定する（D91）。
          // 拘束して Action が決まれば次の手番へ続き、撤回なら Hero が選び直すので止まる。
          if (state.pendingOutOfTurn?.playerId !== this.heroId) return;
          this.resolveHeroOutOfTurn(rt, state);
          continue;
        }
        const expectedSeq = events.length;
        // Fast Forward 中は思考待ち（演出）だけを飛ばす。cpuTurn の判断待ち（Claude の応答）はそのまま待つ。
        if (this.options.botDelayMs > 0 && !rt.fastForward) {
          await this.wait(rt, this.options.botDelayMs);
        }
        await this.cpuTurn(rt, expectedSeq);
      }
    } catch (error) {
      this.fail(rt, error);
    }
  }

  /** 保留した Hero の Out-of-Turn を裁定し、裁定（と決まった Action）を 1 回で追記する。 */
  private resolveHeroOutOfTurn(rt: HandRuntime, state: HandState): void {
    const resolved = resolvePendingOutOfTurn(state, this.options.setup.table);
    if (!resolved.ok) {
      throw new Error(
        `保留した Out-of-Turn を裁定できない: ${resolved.error.message}`,
      );
    }
    this.commit(rt, resolved.value.events);
  }

  // 打ち切った Hand は State が complete になる（HAND_ABORTED）ので、手番が無くなって止まる。
  private canRun(rt: HandRuntime): boolean {
    return !this.closed && rt.failure === null && rt.outage === null;
  }

  /** 障害の状態を変え、購読者（SSE）へ配る。 */
  private setOutage(rt: HandRuntime, outage: OpponentOutage | null): void {
    rt.outage = outage;
    rt.outageRevision += 1;
    const status = outageStatusOf(rt);
    for (const listener of rt.outageListeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn(
          { handId: rt.handId, err: error },
          "障害の状態の配信に失敗した",
        );
      }
    }
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
   * Hero が Emergency Bot を選んだ CPU は、CPU に求めず RuleBot の判断で続ける（AI_FALLBACK_USED の emergency_bot を残す）。
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
    // Memory はその CPU 自身のもの（Hand の開始時に作った要約）だけを足す。無い CPU では項目ごと持たない（D121）。
    // Tilt も同じく、その CPU 自身の 1 以上の段階だけを足す（0 の CPU では項目ごと持たず、Prompt を変えない。D107）。
    const projected = projectKnowledgeState(events, playerId);
    const memory = rt.memories.get(playerId);
    const tilt = rt.tilts.get(playerId);
    // Table Tendency もその CPU が座っていた Hand から作った値だけを足す（Hand が 0 の CPU では項目ごと持たない。#141）。
    const tableTendency = rt.tableTendencies.get(playerId);
    const base: OpponentInput = {
      knowledge: {
        ...projected,
        ...(memory === undefined ? {} : { memory }),
        ...(tilt === undefined ? {} : { tilt }),
        ...(tableTendency === undefined ? {} : { tableTendency }),
      },
      legal,
    };
    const emergency = rt.emergencyBots.get(playerId);
    if (emergency !== undefined) {
      this.useFallback(
        rt,
        state,
        playerId,
        fallbackBot.choose(base),
        "emergency_bot",
        `障害（${emergency}）の後に Hero が Emergency Bot を選んだ`,
      );
      return;
    }
    let input = base;
    let lastInvalid: string | null = null;
    for (const attempt of [1, 2] as const) {
      const outcome = await this.ask(rt, agent, input);
      // 記録を追記した分だけ Log は進むので、今の State の nextSeq で「誰も進めていない」かを見る。
      if (outcome.kind === "cancelled" || !this.isCurrent(rt, state.nextSeq)) {
        return;
      }
      if (outcome.kind === "outage") {
        const outage: OpponentOutage = {
          seq: state.nextSeq,
          playerId,
          kind: outcome.cause,
          message: outcome.message,
        };
        this.logger.error(
          { handId: rt.handId, ...outage },
          "CPU の障害で Hand を止めた",
        );
        this.setOutage(rt, outage);
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
    this.logger.warn(
      { handId: rt.handId, playerId, reason: lastInvalid },
      "CPU の出力を 2 回続けて使えず、RuleBot の判断で続けた",
    );
    this.useFallback(
      rt,
      state,
      playerId,
      fallbackBot.choose(base),
      "automatic",
      lastInvalid ?? "不明",
    );
  }

  /**
   * CPU の判断の代わりに RuleBot の判断で手番を進める。
   * AI_FALLBACK_USED と Fallback の Action は 1 回の追記で置く（記録の直後がその Action になる）。
   */
  private useFallback(
    rt: HandRuntime,
    state: HandState,
    playerId: string,
    action: PlayerAction,
    fallbackKind: FallbackKind,
    reason: string,
  ): void {
    const used = recordAiEvent(state, {
      type: "AI_FALLBACK_USED",
      playerId,
      fallbackKind,
      reason,
    });
    const fallback = applyAction(used.state, playerId, action);
    if (!fallback.ok) {
      throw new Error(
        `Fallback（RuleBot）も Engine に拒否された: ${fallback.error.message}`,
      );
    }
    this.commit(rt, [...used.events, ...fallback.value.events]);
  }

  /**
   * CPU に 1 回判断を求める。応答時間の上限を超えた・例外を投げたら「障害」として返す（不正な出力とは区別する）。
   * 上限を超えた後に届いた判断は捨てる（ここで決まった結果だけが使われる）。
   * 判断を待たなくなったら（上限の超過・アプリ終了）signal を abort し、CPU 側の処理（Claude の子プロセス等）を止めさせる。
   */
  private ask(
    rt: HandRuntime,
    agent: OpponentAgent,
    input: OpponentInput,
  ): Promise<AskOutcome> {
    const limit = this.options.opponentTimeoutMs;
    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: AskOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rt.cancelWait = null;
        // 判断が返る前に打ち切った（timeout・cancelled）ときだけ中断を伝える。返った後・例外の後は何もしない。
        if (
          outcome.kind === "cancelled" ||
          (outcome.kind === "outage" && outcome.cause === "timeout")
        ) {
          controller.abort();
        }
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
      // 種類の分かる例外（未ログイン・利用枠の上限）はその種類で、それ以外は error として障害にする。
      const toError = (error: unknown) =>
        finish({
          kind: "outage",
          cause:
            error instanceof OpponentOutageError ? error.outageKind : "error",
          message: String(error),
        });
      try {
        agent
          .decide(input, controller.signal)
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
        rt.endThinkWait = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      rt.cancelWait = done;
      // Fast Forward を入れたとき、待っている最中の思考待ちも終えられるようにする。
      rt.endThinkWait = done;
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

/** Hero に返す障害の状態。障害の内容のうち、どの CPU の手番か・種類だけを写す（エラー本文は写さない）。 */
function outageStatusOf(rt: HandRuntime): OutageStatus {
  return {
    revision: rt.outageRevision,
    current:
      rt.outage === null
        ? null
        : { playerId: rt.outage.playerId, kind: rt.outage.kind },
  };
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
