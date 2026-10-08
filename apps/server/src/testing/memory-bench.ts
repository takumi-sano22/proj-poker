// CPU Memory の都度計算が、保存済みの Hand の数でどれだけ遅くなるかの手動の測定（#150。D111・docs/04 §12）。
// 実 SQLite（一時ファイルの DB）に本番の Hand Orchestrator（RuleBot）で Hand を溜め、各チェックポイントで次の 2 つを測る。
//   A. 層ごとの計算時間（Hand の開始時に呼ぶ 3 つの層。孤立して繰り返す）: Memory / Tilt / Table Tendency / その合計
//   B. Hand の開始全体（HandOrchestrator.startHand の所要時間。層の計算を含む）。層が無い序盤（保存済み 20〜59 Hand）との差で層の分を見る
// CI の pnpm test には入らない（手で実行する）。Cache・新しいテーブルは足さない（測って決める Issue）。Claude も API キーも使わない。
// 実行: pnpm --filter @proj-poker/server bench:memory [--checkpoints 400,1000,2000,5000] [--repeats 30] [--session-hands 250] [--window 20]
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { openDatabase } from "../db/database.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import {
  loadObservationSources,
  participantRefOf,
} from "../memory/observation.js";
import type {
  OpponentAgent,
  OpponentFactory,
} from "../opponents/opponent-agent.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { buildLayersAt } from "./opponent-eval/memory-eval.js";

const { values } = parseArgs({
  options: {
    checkpoints: { type: "string", default: "400,1000,2000,5000" },
    repeats: { type: "string", default: "30" },
    "session-hands": { type: "string", default: "250" },
    window: { type: "string", default: "20" },
  },
});
const checkpoints = (values.checkpoints ?? "").split(",").map(Number);
const repeats = Number(values.repeats);
const sessionHands = Number(values["session-hands"]);
const windowSize = Number(values.window);
for (const [name, n] of [
  ["--repeats", repeats],
  ["--session-hands", sessionHands],
  ["--window", windowSize],
] as const) {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`${name} は 1 以上の整数: ${n}`);
  }
}
if (checkpoints.some((n) => !Number.isSafeInteger(n) || n < 1)) {
  throw new RangeError(`--checkpoints は 1 以上の整数のカンマ区切り`);
}

/** 中央値・最大・最小。 */
function stats(values: readonly number[]): {
  median: number;
  max: number;
  min: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return {
    median,
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
  };
}

/** Hero は Check できれば Check、できなければ Fold（Hero が Bust して Session が勝手に終わらないよう、失うのは Blind だけ）。 */
function checkOrFold(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  return types.includes("check") ? { type: "check" } : { type: "fold" };
}

const tmp = mkdtempSync(join(tmpdir(), "poker-bench-memory-"));
try {
  const dbPath = join(tmp, "bench.sqlite");
  const db = openDatabase(dbPath);
  const store = new SqliteEventStore(db);
  const setup = PHASE1_TABLE_SETUP;
  const heroId = setup.players.find((p) => p.kind === "hero")?.playerId ?? "";

  let handNo = 0;
  let sessionNo = 0;
  let failNext = false;
  const createOpponent: OpponentFactory = (seed, playerId, persona) => {
    const bot = createRuleBot(seed, playerId, persona);
    const agent: OpponentAgent = {
      async decide(input, signal) {
        if (failNext) {
          failNext = false;
          throw new Error("bench: Session を区切る障害");
        }
        return bot.decide(input, signal);
      },
    };
    return agent;
  };
  const orchestrator = new HandOrchestrator({
    store,
    setup,
    createOpponent,
    botDelayMs: 0,
    opponentTimeoutMs: 5_000,
    nextSeed: () => 42_000 + handNo,
    nextHandId: () => `hand-${++handNo}`,
    nextSessionId: () => `session-${++sessionNo}`,
  });

  /** startHand の所要時間の記録（保存済みの Hand の数 = startHand を呼ぶ時点で終わっていた Hand の数）。 */
  const startSamples: {
    saved: number;
    ms: number;
    aborted: boolean;
  }[] = [];
  let saved = 0;

  /** 1 Hand を終わりまで進める（startHand の所要時間を測る）。aborted なら障害 → Session 終了で打ち切った Hand。 */
  const play = async (afterHandId: string | null, aborted: boolean) => {
    const t = performance.now();
    const started = await orchestrator.startHand(afterHandId);
    startSamples.push({ saved, ms: performance.now() - t, aborted });
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    let view = started.value.view;
    for (let guard = 0; guard < 200; guard++) {
      const outage = orchestrator.outageStatus(handId);
      if (outage?.current != null) {
        const resolved = await orchestrator.resolveOutage(
          handId,
          outage.revision,
          "end_session",
        );
        if (!resolved.ok) throw new Error(resolved.error.message);
        saved += 1;
        return handId;
      }
      if (view.status === "complete") {
        saved += 1;
        return handId;
      }
      const acted = await orchestrator.heroAction(
        handId,
        view.log.at(-1)?.seq ?? -1,
        checkOrFold(view),
      );
      if (!acted.ok) throw new Error(acted.error.message);
      view = acted.value;
    }
    throw new Error(`Hand が終わらない: ${handId}`);
  };

  /** A. 今の状態（次の Hand の開始の直前）で、層の計算を孤立して繰り返し測る。 */
  const measureLayers = (lastHandId: string) => {
    const projection = store.latestSessionProjection();
    if (projection === null) throw new Error("Session Projection が無い");
    const started = store.read(lastHandId)[0]?.event;
    if (started?.type !== "HAND_STARTED")
      throw new Error("HAND_STARTED が無い");
    const context = {
      sessionId: projection.sessionId,
      personas: projection.personas,
      participants: store.sessionParticipants(projection.sessionId),
    };
    const seatIds = started.seats.map((s) => s.playerId);
    // 1 回目は捨てる（計測の前に Statement・JIT を温める）。
    buildLayersAt(store, context, seatIds, heroId, 1);
    const memory: number[] = [];
    const tilt: number[] = [];
    const table: number[] = [];
    const total: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const t = performance.now();
      const { timings } = buildLayersAt(store, context, seatIds, heroId, 1);
      total.push(performance.now() - t);
      memory.push(timings.memoryMs);
      tilt.push(timings.tiltMs);
      table.push(timings.tableTendencyMs);
    }
    // Memory のうち Event の読み出し（SQLite の SELECT・JSON.parse・upcast）だけの時間。1 Observer の分（Orchestrator は 1 回の計算の間
    // 読み出しを使い回すので、5 人分でも Event の読み出しは 1 回分）。
    const observerSeat = context.participants.find(
      (p) => p.playerId !== heroId,
    );
    const load: number[] = [];
    if (observerSeat !== undefined) {
      for (let i = 0; i < repeats; i++) {
        const t = performance.now();
        loadObservationSources(store, {
          observer: participantRefOf(observerSeat),
          heroPlayerId: heroId,
          currentSessionId: context.sessionId,
        });
        load.push(performance.now() - t);
      }
    }
    return {
      memory: stats(memory),
      tilt: stats(tilt),
      table: stats(table),
      total: stats(total),
      load: stats(load),
      sessionHands: store.sessionHandIds(lastHandId).length,
    };
  };

  interface CheckpointResult {
    readonly target: number;
    readonly savedHands: number;
    readonly events: number;
    readonly dbBytes: number;
    readonly layers: ReturnType<typeof measureLayers>;
  }
  const results: CheckpointResult[] = [];
  const pending = [...checkpoints].sort((a, b) => a - b);
  const last = Math.max(...pending) + windowSize;
  const wallStart = performance.now();
  let lastHandId: string | null = null;
  let inSession = 0;
  while (saved < last) {
    // 層の測定は、checkpoint に達した直後（次の Hand の開始の直前）。
    const next = pending[0];
    if (next !== undefined && saved >= next && lastHandId !== null) {
      pending.shift();
      const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      };
      results.push({
        target: next,
        savedHands: store.finishedHandIds().length,
        events: row.n,
        dbBytes: statSync(dbPath).size,
        layers: measureLayers(lastHandId),
      });
    }
    // Session を区切る Hand（最初の CPU の判断を障害にして Session 終了を選ぶ。本番の D86 の経路）。
    const cut = inSession >= sessionHands;
    if (cut) {
      failNext = true;
      inSession = 0;
    }
    lastHandId = await play(lastHandId, cut);
    if (cut) failNext = false;
    else inSession += 1;
    if (orchestrator.sessionStatus(lastHandId)?.state === "ended") {
      inSession = 0;
    }
  }
  orchestrator.close();
  const wallSeconds = (performance.now() - wallStart) / 1000;

  // B. Hand の開始全体: checkpoint の後の window 個の startHand（打ち切りの Hand は除く）。序盤の基準は保存済み 20〜59 Hand。
  const startOf = (from: number, to: number) =>
    stats(
      startSamples
        .filter((s) => !s.aborted && s.saved >= from && s.saved < to)
        .map((s) => s.ms),
    );
  const baseline = startOf(20, 60);

  const fmt = (n: number) => n.toFixed(2);
  const cell = (s: { median: number; max: number }) =>
    `${fmt(s.median)} / ${fmt(s.max)}`;
  console.log("## 環境");
  console.log(`- Node: ${process.version}`);
  console.log(
    `- CPU: ${cpus()[0]?.model ?? "?"} x ${cpus().length}・メモリ ${Math.round(totalmem() / 1024 ** 3)} GiB・${process.platform} ${process.arch}`,
  );
  console.log(
    `- SQLite: ${(db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v}（node:sqlite・一時ファイルの DB）`,
  );
  console.log(
    `- 層の測定: 各 checkpoint で ${repeats} 回（1 回の warm-up を捨てる）・Hand の開始全体: checkpoint の直後の ${windowSize} Hand・Session は ${sessionHands} Hand ごとに区切る`,
  );
  console.log(`- Hand の生成に ${wallSeconds.toFixed(1)} 秒`);
  console.log(
    `\n## A. 層ごとの計算時間（ミリ秒。中央値 / 最大。CPU 5 人分・孤立して繰り返し）`,
  );
  console.log(
    "| 保存済みの Hand | 今の Session の Hand | Event 行数 | DB (MiB) | (1) Memory | うち Event の読み出し（1 Observer 分）| (2) Tilt | (3) Table Tendency | (4) 合計 |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const l = r.layers;
    console.log(
      `| ${r.savedHands} | ${l.sessionHands} | ${r.events} | ${(r.dbBytes / 1024 ** 2).toFixed(1)} | ${cell(l.memory)} | ${cell(l.load)} | ${cell(l.tilt)} | ${cell(l.table)} | ${cell(l.total)} |`,
    );
  }
  console.log(
    `\n## B. Hand の開始全体 startHand（ミリ秒。中央値 / 最大 / 最小。CPU が Hero の手番まで進める分を含む）`,
  );
  console.log(
    `序盤の基準（保存済み 20〜59 Hand・${startSamples.filter((s) => !s.aborted && s.saved >= 20 && s.saved < 60).length} 回）: ${fmt(baseline.median)} / ${fmt(baseline.max)} / ${fmt(baseline.min)}`,
  );
  console.log(
    "| 保存済みの Hand（開始時）| 回数 | startHand 中央値 | 最大 | 最小 | 基準との差（中央値）|",
  );
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    const w = startSamples.filter(
      (s) =>
        !s.aborted &&
        s.saved >= r.savedHands &&
        s.saved < r.savedHands + windowSize,
    );
    const s = stats(w.map((x) => x.ms));
    console.log(
      `| ${r.savedHands}〜${r.savedHands + windowSize - 1} | ${w.length} | ${fmt(s.median)} | ${fmt(s.max)} | ${fmt(s.min)} | ${fmt(s.median - baseline.median)} |`,
    );
  }
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
