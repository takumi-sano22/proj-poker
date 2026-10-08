// Runtime の卓設定。値は Open Item の暫定値で、永久仕様ではない（Config に置いて差し替えられるようにする）。
import { fileURLToPath } from "node:url";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PHASE1_CASH_PRESET,
  type TableConfig,
} from "@proj-poker/engine";
import {
  PERSONA_PRESET_IDS,
  isPersonaPresetId,
  type PersonaPresetId,
} from "./opponents/persona.js";

/** 卓に座る Player。kind は Hero（ユーザー）か CPU か。displayName は表示用で、Engine は playerId だけを使う。 */
export interface SeatPlayer {
  readonly playerId: string;
  readonly displayName: string;
  readonly kind: "hero" | "cpu";
}

export interface TableSetup {
  readonly table: TableConfig;
  /** Session の最初の Hand の全員の Stack（均等 Stack。D70）。2 Hand 目以降は前 Hand の Stack を持ち越す（D80）。 */
  readonly startingStack: number;
  /** 席順（時計回り）。Hero はちょうど 1 人。 */
  readonly players: readonly SeatPlayer[];
  /**
   * CPU の playerId → Persona の Preset（#51）。CPU 自身の判断にだけ使うサーバー内の設定で、
   * players（Hero への応答に載る）・Event・DB には入れない（Secret Persona。D28）。
   * Phase 7（#136・D118）では席に求める Persona で（載っていない席の Guest は Persona なし）、実際の Persona は Session の編成で決まる（Fixed CPU は常に Fixed Pool の Persona。
   * 既定の割り当て順では同じ値。opponents/cpu-pool.ts の composeSessionParticipants）。
   */
  readonly personas: Readonly<Record<string, PersonaPresetId>>;
}

/** 卓の既定の人数（6-max。Hero 1 人 + CPU 5 人）。 */
export const DEFAULT_TABLE_SIZE = 6;

/**
 * CPU に Persona を割り当てる既定の順番（OI-005 の暫定値。D85）。席順の CPU 1 から順に当て、足りなければ先頭から繰り返す。
 * 6-max（CPU 5 人）では Maniac が出ない並び: 大半はカジュアル経験者以上で、弱い CPU は少数（FR-CPU-003）。
 */
export const DEFAULT_PERSONA_ROTATION: readonly PersonaPresetId[] = [
  "tag_regular",
  "lag",
  "nit",
  "calling_station",
  "weak_tight_recreational",
  "maniac",
];

/**
 * Hero 1 人 + CPU（人数 - 1）人の卓を作る。人数は Engine が扱える 2〜8（MIN_PLAYERS〜MAX_PLAYERS）。
 * Persona は席順で決定論的に割り当てる（CPU i に rotation[(i - 1) % 長さ]。同じ設定なら毎回同じ。rotation は空にしない）。
 * CPU の人数・名前は OI-005（CPU Pool）の暫定値で、永久仕様ではない。Chip Preset は OI-004 の暫定値（PHASE1_CASH_PRESET）。
 * 席順は Hero → CPU 1 → CPU 2 …（時計回り）。Session の最初の Hand は席順の先頭（Hero）が Button で、
 * 以降の席と Button は Hand Orchestrator が前 Hand の結果から Position Engine で決める（D80）。
 */
export function buildTableSetup(
  tableSize: number,
  personaRotation: readonly PersonaPresetId[] = DEFAULT_PERSONA_ROTATION,
): TableSetup {
  if (
    !Number.isSafeInteger(tableSize) ||
    tableSize < MIN_PLAYERS ||
    tableSize > MAX_PLAYERS
  ) {
    throw new RangeError(
      `卓の人数は ${MIN_PLAYERS}〜${MAX_PLAYERS}: ${tableSize}`,
    );
  }
  if (personaRotation.length === 0) {
    throw new RangeError("Persona の割り当て順が空");
  }
  const cpus: SeatPlayer[] = Array.from({ length: tableSize - 1 }, (_, i) => ({
    playerId: `cpu${i + 1}`,
    displayName: `CPU ${i + 1}`,
    kind: "cpu",
  }));
  const personas: Record<string, PersonaPresetId> = {};
  cpus.forEach((cpu, i) => {
    personas[cpu.playerId] = personaRotation[
      i % personaRotation.length
    ] as PersonaPresetId;
  });
  return {
    table: PHASE1_CASH_PRESET,
    startingStack: PHASE1_CASH_PRESET.startingStack,
    players: [{ playerId: "hero", displayName: "Hero", kind: "hero" }, ...cpus],
    personas,
  };
}

/** 既定の卓: 6-max（Hero 1 人 + CPU 5 人）。 */
export const PHASE1_TABLE_SETUP: TableSetup =
  buildTableSetup(DEFAULT_TABLE_SIZE);

/**
 * 環境変数 TABLE_SIZE の値を卓の人数として読む。未設定・不正（範囲外・小数・文字列）なら既定の 6 人に戻す
 * （parseBotDelayMs と同じ作法）。UI での人数選択は作らず、起動時の設定だけで選ぶ。
 */
export function parseTableSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TABLE_SIZE;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= MIN_PLAYERS &&
    value <= MAX_PLAYERS
    ? value
    : DEFAULT_TABLE_SIZE;
}

/**
 * 環境変数 CPU_PERSONAS の値を Persona の割り当て順として読む（カンマ区切りの Preset ID。例: "maniac,nit"）。
 * 未設定・空なら既定の順番。知らない ID は起動時に誤りとして止める（黙って既定に戻さない。parseOpponentProvider と同じ作法）。
 */
export function parsePersonaRotation(
  raw: string | undefined,
): readonly PersonaPresetId[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PERSONA_ROTATION;
  const ids = raw.split(",").map((id) => id.trim());
  const unknown = ids.filter((id) => !isPersonaPresetId(id));
  if (unknown.length > 0) {
    throw new RangeError(
      `CPU_PERSONAS は ${PERSONA_PRESET_IDS.join(" / ")} のカンマ区切り: ${JSON.stringify(raw)}`,
    );
  }
  return ids as PersonaPresetId[];
}

/**
 * CPU の思考に見せる待ち時間（ミリ秒）の既定値。演出のためだけの値で、ルールには影響しない。
 * 環境変数 BOT_THINK_DELAY_MS で上書きできる。テストでは 0 を渡す。
 */
export const DEFAULT_BOT_THINK_DELAY_MS = 600;

/** 環境変数の値を待ち時間として読む。未設定・不正なら既定値に戻す（負数・小数・文字列は受け付けない）。 */
export function parseBotDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BOT_THINK_DELAY_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_BOT_THINK_DELAY_MS;
}

/**
 * CPU の 1 回の判断（OpponentAgent.decide の 1 呼び出し）を待つ上限（ミリ秒）。
 * 暫定値（OI-001 の Cost / Latency Policy が決まるまでの仮置き。永久仕様ではない）。
 * 超えたら「障害」として Hand を止める（RuleBot へ自動で切り替えない。D86）。
 * 環境変数 OPPONENT_TIMEOUT_MS で上書きできる。
 * #47 で 15000ms と置き、#50 の Claude の実測（最大 約 15.5 秒）で超える回があったため、最大の約 2 倍に見直した（docs/11 OI-001）。
 */
export const DEFAULT_OPPONENT_TIMEOUT_MS = 30_000;

/** 環境変数の値を判断待ちの上限として読む。未設定・不正（0 以下・小数・文字列）なら既定値に戻す。 */
export function parseOpponentTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_OPPONENT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_OPPONENT_TIMEOUT_MS;
}

/**
 * SQLite の DB ファイルの既定の置き場所: apps/server/data/poker.sqlite（gitignore 済み）。
 * src（dev）からも dist（start）からも 1 階層上なので、同じ場所になる。worktree ごとに別の DB になる。
 */
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../data/poker.sqlite", import.meta.url),
);

/** 環境変数 POKER_DB_PATH の値を DB の場所として読む。未設定・空なら既定の場所。":memory:" も受け付ける。 */
export function resolveDbPath(raw: string | undefined): string {
  return raw === undefined || raw.trim() === "" ? DEFAULT_DB_PATH : raw;
}

/**
 * Model Role ごとの具体モデル名（role-based config。docs/03 §3・docs/05 §13）。Domain Logic にモデル名を書かず、ここで解決する。
 * 値は暫定値（OI-001。確定ではない）。opponent_fast は D85、review_standard / review_deep は D97
 * （review_deep は Hero が「詳しく」を選んだ Spot だけに使う）。
 */
export const MODEL_ROLES = {
  opponent_fast: "claude-haiku-4-5",
  review_standard: "claude-sonnet-5-5",
  review_deep: "claude-opus-5-5",
} as const;

export type ModelRole = keyof typeof MODEL_ROLES;

/** CPU の判断に使う実装。既定は RuleBot（D71）。"claude" のときだけ Claude（Agent SDK・OAuth。D87）を使う。 */
export type OpponentProvider = "rulebot" | "claude";

/**
 * CPU の判断に使う実装の記録用の説明（Hand ごとの Metadata の席ごとの provider / Model Role / Concrete Model。#97）。
 * createOpponent と組で決め、Orchestrator が HAND_METADATA_RECORDED に写す。Emergency Bot は Orchestrator が席ごとに上書きする。
 */
export type OpponentInfo =
  | {
      readonly provider: "rule_bot";
      readonly modelRole: null;
      readonly model: null;
    }
  | {
      readonly provider: "claude";
      readonly modelRole: ModelRole;
      readonly model: string;
    };

/** RuleBot の説明（既定。D71）。 */
export const RULE_BOT_INFO: OpponentInfo = {
  provider: "rule_bot",
  modelRole: null,
  model: null,
};

/** OPPONENT_PROVIDER の値から記録用の説明を作る。Claude のモデルは role-based config（opponent_fast）で解決する。 */
export function opponentInfoOf(provider: OpponentProvider): OpponentInfo {
  return provider === "claude"
    ? {
        provider: "claude",
        modelRole: "opponent_fast",
        model: MODEL_ROLES.opponent_fast,
      }
    : RULE_BOT_INFO;
}

/** 環境変数 OPPONENT_PROVIDER の値を読む。未設定・空なら RuleBot。知らない値は起動時に誤りとして止める（黙って RuleBot にしない）。 */
export function parseOpponentProvider(
  raw: string | undefined,
): OpponentProvider {
  if (raw === undefined || raw.trim() === "") return "rulebot";
  const value = raw.trim();
  if (value === "rulebot" || value === "claude") return value;
  throw new RangeError(
    `OPPONENT_PROVIDER は rulebot か claude: ${JSON.stringify(raw)}`,
  );
}

/**
 * Primary Solver（amaster97/poker_solver。D96）の導入先。環境変数 POKER_SOLVER_HOME で指す（solver/setup-amaster97.sh が作る）。
 * 未設定・空なら null で、Solver Adapter は Unsupported（solver_not_installed）として正常に Fallback する。
 */
export function resolveSolverHome(raw: string | undefined): string | null {
  return raw === undefined || raw.trim() === "" ? null : raw;
}

/**
 * Solver の 1 回の Solve を待つ上限（ミリ秒）。暫定値（永久仕様ではない）。
 * #76 の実測（amaster97・WSL2・200 Iteration・固定 Spot の狭い Range）で Turn が 5.7〜8.0 秒、River が約 0.9 秒だったため 20 秒に置いた。
 * #82 で Review が Range Model の Range（SB の Call 221 Combo 対 BTN の Open 449 Combo・SPR 約 14）の Turn を解くと約 33 秒かかり（1 回の実測。Evidence の組み立て全体）、
 * 20 秒では Timeout したため、その約 1.8 倍の 60 秒に見直した（Review の生成は非同期で、Hand の進行を止めない）。
 * 超えたら結果なしとして Fallback する。環境変数 SOLVER_TIMEOUT_MS で上書きできる。
 */
export const DEFAULT_SOLVER_TIMEOUT_MS = 60_000;

/** 環境変数の値を Solve の上限として読む。未設定・不正（0 以下・小数・文字列）なら既定値に戻す。 */
export function parseSolverTimeoutMs(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_SOLVER_TIMEOUT_MS);
}

/**
 * Solver を同時に動かす数の上限。Solver は CPU とメモリを使う（#76: Turn で約 430 MiB）ため、既定は 1（超えた分は待ち行列で待つ）。
 * 環境変数 SOLVER_MAX_CONCURRENCY で上書きできる。
 */
export const DEFAULT_SOLVER_MAX_CONCURRENCY = 1;

export function parseSolverMaxConcurrency(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_SOLVER_MAX_CONCURRENCY);
}

/** Solver の Iteration 数（#76 の計測と同じ 200）。暫定値。環境変数 SOLVER_ITERATIONS で上書きできる。 */
export const DEFAULT_SOLVER_ITERATIONS = 200;

export function parseSolverIterations(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_SOLVER_ITERATIONS);
}

/**
 * Review AI の 1 回の呼び出し（Claude の 1 問い合わせ。構造化出力の直しの 1 ターンを含む）を待つ上限（ミリ秒）。
 * 暫定値（OI-001 の Latency Policy。永久仕様ではない）。超えたら呼び出しを止め、その Review の生成は失敗（timeout）として
 * 再要求を待つ（Hand の進行は止めない）。#82 の手動の実測（claude-sonnet-5-5・Review Eval の 4 判断 × 4 回）は 12.5〜24.3 秒で、
 * JSON の直しで 2 ターンになる回・review_deep（Opus）の遅さを見込んで最大の約 5 倍に置いた。環境変数 REVIEW_TIMEOUT_MS で上書きできる。
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;

export function parseReviewTimeoutMs(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_REVIEW_TIMEOUT_MS);
}

/** 正の整数として読む。未設定・不正なら既定値に戻す（parseOpponentTimeoutMs と同じ作法）。 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Review AI の実装。既定は Claude（Agent SDK・OAuth。D87・D97）。"fake" は E2E 用の固定応答（Claude を呼ばない。D98）で、
 * CI の E2E と手元の E2E の実行でだけ使う（本番の既定は変えない）。
 */
export type ReviewProvider = "claude" | "fake";

/** 環境変数 REVIEW_PROVIDER の値を読む。未設定・空なら Claude。知らない値は起動時に誤りとして止める（黙って既定にしない）。 */
export function parseReviewProvider(raw: string | undefined): ReviewProvider {
  if (raw === undefined || raw.trim() === "") return "claude";
  const value = raw.trim();
  if (value === "claude" || value === "fake") return value;
  throw new RangeError(
    `REVIEW_PROVIDER は claude か fake: ${JSON.stringify(raw)}`,
  );
}

/**
 * 環境変数 POKER_SEED の値を、Hand の山札の seed の始まりとして読む（E2E を決定論にするため。D98）。未設定・空なら null（毎回乱数）。
 * 0〜2^32-1 の整数だけを受け付け、不正な値は起動時に誤りとして止める（黙って乱数に戻すと E2E が気付かず不安定になる）。
 */
export function parseFixedSeed(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) {
    throw new RangeError(
      `POKER_SEED は 0〜${2 ** 32 - 1} の整数: ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * seed を固定したときの Hand ごとの seed（start, start+1, … を 2^32 で折り返す）。起動ごとに start から数え直すので、
 * 同じ操作なら同じ山札が配られる（Resume の後の Hand も、起動後の何 Hand 目かで決まる）。
 */
export function fixedSeedSequence(start: number): () => number {
  let next = start;
  return () => {
    const seed = next;
    next = (next + 1) % 2 ** 32;
    return seed;
  };
}
