// CPU Memory の都度計算が、保存済みの Hand の数でどれだけ遅くなるかの手動の測定（#150。D111・docs/04 §12）。
// 実 SQLite（一時ファイルの DB）に本番の Hand Orchestrator（RuleBot）で Hand を溜め、各チェックポイントで次の 2 つを測る。
//   A. 層ごとの計算時間（Hand の開始時に呼ぶ 3 つの層。孤立して繰り返す）: Memory / Tilt / Table Tendency / その合計
//   B. Hand の開始全体（HandOrchestrator.startHand の所要時間。層の計算を含む）。層が無い序盤（保存済み 20〜59 Hand）との差で層の分を見る
// #165（D124）で Observation の Cache（v12 の observed_hand_cache）を足した。Orchestrator は本番と同じく Cache を使い、A の Memory は
// Cache が温まった状態（Hand の開始ごとに足りない Hand を足している）で測る。比べるために、同じ時点の Cache なし（Event Log から都度抽出）と、
// Cache を全部消した直後の 1 回（作り直し）も測る。
// #174: --size-report を付けると、DB の大きさの内訳（page_count・freelist・dbstat・VACUUM 前後・Cache なしの fresh な DB）も測る。
//   実行の最後に DB ファイルを使い捨てのコピーへ複製して測る（元の DB・開発データには触れない）。
// CI の pnpm test には入らない（手で実行する）。Claude も API キーも使わない。
// 実行: pnpm --filter @proj-poker/server bench:memory [--checkpoints 400,1000,2000,5000] [--repeats 30] [--session-hands 250] [--window 20] [--size-report]
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { openDatabase } from "../db/database.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import { SqliteObservationCache } from "../memory/observation-cache.js";
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
    "size-report": { type: "boolean", default: false },
  },
});
const sizeReport = values["size-report"] === true;
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

const MIB = 1024 ** 2;
const mib = (n: number) => (n / MIB).toFixed(2);

/** SQLite のページの数（PRAGMA）。file は statSync のファイルの大きさ。 */
function pageCounts(db: DatabaseSync, path: string) {
  const one = (pragma: string) =>
    Object.values(db.prepare(`PRAGMA ${pragma}`).get() as object)[0] as number;
  const pageSize = one("page_size");
  const pageCount = one("page_count");
  const freelist = one("freelist_count");
  return {
    fileBytes: statSync(path).size,
    pageSize,
    pageCount,
    freelist,
  };
}

interface CacheDataRow {
  rows: number;
  hands: number;
  observers: number;
  nullRows: number;
  observedBytes: number;
  eventsBytes: number;
  keyBytes: number;
}

/** Cache の実データの量（バイト。length(TEXT) は文字数なので BLOB に直して数える）と、events の Observer 間の重複の量。 */
function cacheData(db: DatabaseSync) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows, COUNT(DISTINCT hand_id) AS hands, COUNT(DISTINCT observer_key) AS observers,
        COALESCE(SUM(observed IS NULL), 0) AS nullRows,
        COALESCE(SUM(length(CAST(observed AS BLOB))), 0) AS observedBytes,
        COALESCE(SUM(length(CAST(events AS BLOB))), 0) AS eventsBytes,
        COALESCE(SUM(length(observer_key) + length(hand_id) + length(extraction_version) + length(hero_player_id)), 0) AS keyBytes
       FROM observed_hand_cache`,
    )
    .get() as unknown as CacheDataRow;
  // Hand ごとに 1 行ぶんだけ持てば済むと仮定したときの events の量（Hand ごとの最大の events）。差が重複の量。
  const once = db
    .prepare(
      `SELECT COALESCE(SUM(m), 0) AS bytes FROM (SELECT MAX(length(CAST(events AS BLOB))) AS m FROM observed_hand_cache GROUP BY hand_id)`,
    )
    .get() as { bytes: number };
  return { ...row, eventsOnceBytes: once.bytes };
}

/** 表・索引ごとの使用量（dbstat。使えなければ null）。 */
function dbstatByName(db: DatabaseSync) {
  try {
    return db
      .prepare(
        `SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes, SUM(payload) AS payload, SUM(unused) AS unused
         FROM dbstat GROUP BY name ORDER BY bytes DESC`,
      )
      .all() as {
      name: string;
      pages: number;
      bytes: number;
      payload: number;
      unused: number;
    }[];
  } catch {
    return null;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "poker-bench-memory-"));
try {
  const dbPath = join(tmp, "bench.sqlite");
  const db = openDatabase(dbPath);
  const store = new SqliteEventStore(db);
  const observationCache = new SqliteObservationCache(db);
  // Cache の読み書きの失敗の数（失敗しても Memory は Event Log から作るので、結果は変わらない。数が 0 であることを出力で確かめる）。
  let cacheWarnings = 0;
  const cacheLogger = {
    warn: () => {
      cacheWarnings += 1;
    },
  };
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
    observationCache,
    logger: {
      warn: (_obj, msg) => {
        if (msg.includes("Cache")) cacheWarnings += 1;
      },
      error: () => {},
    },
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
    const withCache = { store: observationCache, logger: cacheLogger };
    // Cache を全部消した直後の 1 回（Event Log から作り直して Cache に足す）。この呼び出しで Cache はまた温まる。
    db.exec("DELETE FROM observed_hand_cache");
    const coldStart = performance.now();
    buildLayersAt(store, context, seatIds, heroId, 1, withCache);
    const cold = performance.now() - coldStart;
    // 1 回目は捨てる（計測の前に Statement・JIT を温める）。
    buildLayersAt(store, context, seatIds, heroId, 1, withCache);
    const memory: number[] = [];
    const tilt: number[] = [];
    const table: number[] = [];
    const total: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const t = performance.now();
      const { timings } = buildLayersAt(
        store,
        context,
        seatIds,
        heroId,
        1,
        withCache,
      );
      total.push(performance.now() - t);
      memory.push(timings.memoryMs);
      tilt.push(timings.tiltMs);
      table.push(timings.tableTendencyMs);
    }
    // 比べるための Cache なし（#150 と同じ都度計算。同じ回数・同じ時点）。
    buildLayersAt(store, context, seatIds, heroId, 1);
    const memoryNoCache: number[] = [];
    for (let i = 0; i < repeats; i++) {
      memoryNoCache.push(
        buildLayersAt(store, context, seatIds, heroId, 1).timings.memoryMs,
      );
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
    const cacheRow = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(length(observed) + length(events)), 0) AS bytes FROM observed_hand_cache",
      )
      .get() as { n: number; bytes: number };
    return {
      memory: stats(memory),
      memoryNoCache: stats(memoryNoCache),
      cold,
      cacheRows: cacheRow.n,
      cacheBytes: cacheRow.bytes,
      tilt: stats(tilt),
      table: stats(table),
      total: stats(total),
      load: stats(load),
      sessionHands: store.sessionHandIds(lastHandId).length,
    };
  };

  /**
   * #174: measureLayers の直前（= Hand の開始ごとに足してきた Cache が、全削除される前）の DB を使い捨てのコピーに複製して測る。
   * Cache の行数・実データ・dbstat と、コピーを VACUUM したときの大きさ、さらに Cache を消して VACUUM した（Event Log だけの）大きさ。
   */
  function probeCheckpoint(target: number) {
    const path = join(tmp, `probe-${target}.sqlite`);
    copyFileSync(dbPath, path);
    const d = openDatabase(path);
    try {
      const asIs = pageCounts(d, path);
      const data = cacheData(d);
      const stat = dbstatByName(d);
      d.exec("VACUUM");
      const vacuumed = pageCounts(d, path);
      d.exec("DELETE FROM observed_hand_cache");
      d.exec("VACUUM");
      const eventsOnly = pageCounts(d, path);
      return { asIs, data, stat, vacuumed, eventsOnly };
    } finally {
      d.close();
      rmSync(path, { force: true });
    }
  }

  /** #174: DB の大きさの内訳。元の DB を使い捨てのコピーに複製して測る（元の DB・開発データには触れない）。 */
  function reportSizes(lastHandId: string) {
    const copies: DatabaseSync[] = [];
    const openCopy = (name: string, from: string) => {
      const path = join(tmp, name);
      copyFileSync(from, path);
      const d = openDatabase(path);
      copies.push(d);
      return { db: d, path };
    };
    const rows: string[] = [];
    const record = (label: string, c: { db: DatabaseSync; path: string }) => {
      const p = pageCounts(c.db, c.path);
      rows.push(
        `| ${label} | ${mib(p.fileBytes)} | ${p.pageSize} | ${p.pageCount} | ${p.freelist} | ${((p.freelist / p.pageCount) * 100).toFixed(1)}% | ${mib(p.pageCount * p.pageSize)} | ${mib((p.pageCount - p.freelist) * p.pageSize)} |`,
      );
    };
    const vacuum = (c: { db: DatabaseSync }) => c.db.exec("VACUUM");
    const dropCache = (c: { db: DatabaseSync }) =>
      c.db.exec("DELETE FROM observed_hand_cache");
    // 本番の Cache を温める呼び出し（measureLayers の「全部消した直後の 1 回」と同じ入力）。
    const warm = (c: { db: DatabaseSync }) => {
      const st = new SqliteEventStore(c.db);
      const cache = new SqliteObservationCache(c.db);
      const projection = st.latestSessionProjection();
      if (projection === null) throw new Error("Session Projection が無い");
      const started = st.read(lastHandId)[0]?.event;
      if (started?.type !== "HAND_STARTED")
        throw new Error("HAND_STARTED が無い");
      const context = {
        sessionId: projection.sessionId,
        personas: projection.personas,
        participants: st.sessionParticipants(projection.sessionId),
      };
      const t = performance.now();
      buildLayersAt(
        st,
        context,
        started.seats.map((s) => s.playerId),
        heroId,
        1,
        { store: cache, logger: cacheLogger },
      );
      return performance.now() - t;
    };
    const stat = (title: string, c: { db: DatabaseSync }) => {
      const t = dbstatByName(c.db);
      console.log(`\n#### dbstat: ${title}`);
      if (t === null) {
        console.log("dbstat は使えない");
        return;
      }
      console.log(
        "| 名前 | ページ数 | 使用 (MiB) | 実データ payload (MiB) | 未使用 unused (MiB) |",
      );
      console.log("|---|---|---|---|---|");
      for (const r of t.slice(0, 8)) {
        console.log(
          `| ${r.name} | ${r.pages} | ${mib(r.bytes)} | ${mib(r.payload)} | ${mib(r.unused)} |`,
        );
      }
    };
    const dataLine = (title: string, c: { db: DatabaseSync }) => {
      const d = cacheData(c.db);
      const ev = c.db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM events",
        )
        .get() as { n: number; bytes: number };
      console.log(
        `- ${title}: Cache ${d.rows} 行（Observer ${d.observers} 人・Hand ${d.hands} 個・座っている行は 1 Hand あたり ${((d.rows - d.nullRows) / Math.max(d.hands, 1)).toFixed(2)} 行・座っていない Hand の NULL 行 ${d.nullRows}・1 Hand あたり ${(d.rows / Math.max(d.hands, 1)).toFixed(2)} 行）。` +
          `observed ${mib(d.observedBytes)} MiB・events ${mib(d.eventsBytes)} MiB・鍵の列 ${mib(d.keyBytes)} MiB（実データの合計 ${mib(d.observedBytes + d.eventsBytes + d.keyBytes)} MiB）。` +
          `events を Hand ごとに 1 回だけ持つなら ${mib(d.eventsOnceBytes)} MiB（重複の分 ${mib(d.eventsBytes - d.eventsOnceBytes)} MiB）。` +
          `Event Log の payload ${ev.n} 行・${mib(ev.bytes)} MiB`,
      );
    };

    console.log("\n## C. DB の大きさの内訳（#174。使い捨てのコピーで測る）");
    // 各 checkpoint の DB（dbBytes は measureLayers の直前。= 層の測定の Cache の全削除を、それまでの checkpoint の数だけ経た後）。
    console.log(
      "\n### C1. 各 checkpoint の測定の直前の DB（表の「DB (MiB)」と同じ時点）",
    );
    console.log(
      "| 保存済みの Hand | ファイル (MiB) | page_size | page_count | freelist_count | 空き割合 |",
    );
    console.log("|---|---|---|---|---|---|");
    for (const r of results) {
      const p = r.pages;
      console.log(
        `| ${r.savedHands} | ${mib(p.fileBytes)} | ${p.pageSize} | ${p.pageCount} | ${p.freelist} | ${((p.freelist / p.pageCount) * 100).toFixed(1)}% |`,
      );
    }
    console.log(
      "\n### C1b. 各 checkpoint の測定の直前の DB の内訳（Cache は Hand の開始ごとに足してきた分。全削除の前。使い捨てのコピーで VACUUM 等を試す）",
    );
    console.log(
      "| 保存済みの Hand | ファイル (MiB) | freelist | VACUUM 後 (MiB) | 縮んだ割合 | Cache を消して VACUUM（Event Log だけ・MiB）| Cache の行数 | うち座っている行 | Observer | Cache の実データ observed / events / 鍵 (MiB) | events の重複の分 (MiB) |",
    );
    console.log("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of results) {
      const q = r.probe;
      if (q === undefined) continue;
      const d = q.data;
      console.log(
        `| ${r.savedHands} | ${mib(q.asIs.fileBytes)} | ${q.asIs.freelist} | ${mib(q.vacuumed.fileBytes)} | ${(((q.asIs.fileBytes - q.vacuumed.fileBytes) / q.asIs.fileBytes) * 100).toFixed(1)}% | ${mib(q.eventsOnly.fileBytes)} | ${d.rows} | ${d.rows - d.nullRows} | ${d.observers} | ${mib(d.observedBytes)} / ${mib(d.eventsBytes)} / ${mib(d.keyBytes)} | ${mib(d.eventsBytes - d.eventsOnceBytes)} |`,
      );
    }
    console.log(
      "\n各 checkpoint の測定の直前の dbstat（使用 MiB = ページの合計 / 実データ payload MiB）",
    );
    console.log(
      "| 保存済みの Hand | events 表 | events の索引 2 つ | observed_hand_cache 表 | その索引 | Cache 表の unused (MiB) | その他 |",
    );
    console.log("|---|---|---|---|---|---|---|");
    for (const r of results) {
      const t = r.probe?.stat;
      if (t === undefined || t === null) continue;
      const pick = (f: (n: string) => boolean) =>
        t
          .filter((x) => f(x.name))
          .reduce(
            (a, x) => ({
              bytes: a.bytes + x.bytes,
              payload: a.payload + x.payload,
              unused: a.unused + x.unused,
            }),
            { bytes: 0, payload: 0, unused: 0 },
          );
      const ev = pick((n) => n === "events");
      const evIdx = pick((n) => n.startsWith("sqlite_autoindex_events"));
      const ca = pick((n) => n === "observed_hand_cache");
      const caIdx = pick((n) => n.startsWith("sqlite_autoindex_observed"));
      const total = pick(() => true);
      const other =
        total.bytes - ev.bytes - evIdx.bytes - ca.bytes - caIdx.bytes;
      const f = (x: { bytes: number; payload: number }) =>
        `${mib(x.bytes)} / ${mib(x.payload)}`;
      console.log(
        `| ${r.savedHands} | ${f(ev)} | ${f(evIdx)} | ${f(ca)} | ${f(caIdx)} | ${mib(ca.unused)} | ${mib(other)} |`,
      );
    }
    const asIs = openCopy("as-is.sqlite", dbPath);
    console.log("\n### C2. 実行の最後の状態から\n");
    dataLine(
      "最後の状態（Cache を全削除→作り直し を checkpoint の数だけ経た後）",
      asIs,
    );
    stat("最後の状態", asIs);
    record(
      "S1 最後の状態（bench の DB そのまま。最後の checkpoint の層の測定で Cache は全削除→今の卓の Observer の分だけ作り直し済み）",
      asIs,
    );
    const vacuumed = openCopy("as-is-vacuum.sqlite", asIs.path);
    vacuum(vacuumed);
    record("S2 S1 を VACUUM（Cache を温めた状態 + VACUUM）", vacuumed);
    const dropped = openCopy("as-is-dropped.sqlite", asIs.path);
    dropCache(dropped);
    record("S3 S1 の Cache を全削除（VACUUM なし）", dropped);
    vacuum(dropped);
    record(
      "S4 S3 を VACUUM（Cache 無し = Event Log だけの fresh な DB）",
      dropped,
    );
    stat("S4 Cache 無し + VACUUM（Event Log だけ）", dropped);
    const fresh = openCopy("fresh.sqlite", dropped.path);
    const coldMs = warm(fresh);
    record(
      `S5 S4 に Cache を 1 回温める（今の卓の CPU・Guest の Observer の分だけ。${coldMs.toFixed(0)} ms。VACUUM なし）`,
      fresh,
    );
    dataLine("S5", fresh);
    stat("S5 Cache を 1 回温めた直後", fresh);
    const freshVac = openCopy("fresh-vacuum.sqlite", fresh.path);
    vacuum(freshVac);
    record("S6 S5 を VACUUM", freshVac);
    stat("S6 S5 を VACUUM", freshVac);
    console.log(
      "\n| 状態 | ファイル (MiB) | page_size | page_count | freelist_count | 空き割合 | page_count × page_size (MiB) | 使用中のページ (MiB) |",
    );
    console.log("|---|---|---|---|---|---|---|---|");
    for (const r of rows) console.log(r);
    for (const d of copies) d.close();
  }

  interface CheckpointResult {
    readonly target: number;
    readonly savedHands: number;
    readonly events: number;
    readonly dbBytes: number;
    readonly pages: ReturnType<typeof pageCounts>;
    /** --size-report のときだけ。measureLayers の直前（Cache の全削除の前）の DB の内訳。 */
    readonly probe: ReturnType<typeof probeCheckpoint> | undefined;
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
        pages: pageCounts(db, dbPath),
        probe: sizeReport ? probeCheckpoint(next) : undefined,
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
  console.log(`- Cache の読み書きの失敗（warn）: ${cacheWarnings} 回`);
  console.log(
    `\n## A. 層ごとの計算時間（ミリ秒。中央値 / 最大。CPU 5 人分・孤立して繰り返し。(1)〜(4) は Cache が温まった状態）`,
  );
  console.log(
    "| 保存済みの Hand | 今の Session の Hand | Event 行数 | DB (MiB) | Cache の行数 / JSON (MiB) | (1) Memory | Memory（Cache なし）| Memory（Cache を消した直後の 1 回）| うち Event の読み出し（1 Observer 分）| (2) Tilt | (3) Table Tendency | (4) 合計 |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const l = r.layers;
    console.log(
      `| ${r.savedHands} | ${l.sessionHands} | ${r.events} | ${(r.dbBytes / 1024 ** 2).toFixed(1)} | ${l.cacheRows} / ${(l.cacheBytes / 1024 ** 2).toFixed(1)} | ${cell(l.memory)} | ${cell(l.memoryNoCache)} | ${fmt(l.cold)} | ${cell(l.load)} | ${cell(l.tilt)} | ${cell(l.table)} | ${cell(l.total)} |`,
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
  if (sizeReport && lastHandId !== null) {
    reportSizes(lastHandId);
  }
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
