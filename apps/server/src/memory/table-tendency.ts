// Table Tendency（卓全体の観察可能な傾向。D106・#141。docs/05 §5・docs/04 §12）。
// 今の Session の保存済み（終わった）Hand の public の Event だけから、卓の aggression・looseness・showdown の頻度を数える
// 決定論の純粋関数で、結果は保存しない（D111。都度作り直せる Projection）。
// - 入力の whitelist は Observation の抽出と同じ isObservable（保存された Visibility と Engine が種類から決める Visibility の両方が public）。
//   Hole Cards（private）・Deck（engine。Future Cards）・system の記録・Learning-only Reveal は読まない
// - 個々の CPU の Private Observation / Hypothesis（opponent-hypothesis.ts・memory-summary.ts）・Persona・Tilt を集約して作らない。
//   import もしない（table-tendency-isolation.test.ts が import をたどって確かめる）
// - D10 の「ユーザーが選ぶ卓の傾向（卓の編成）」とは別物（あちらは卓の設定、こちらは観察から作る Projection）
// - 範囲と順序は論理順序（ordinals.ord）で決め、壁時計を使わない（D117）
// - 入り口は CPU 用（そのCPU が座っていた Hand）と Hero 用（Hero が座って見えた Hand）に分ける
import {
  STAT_DEFINITIONS,
  toStatsHand,
  type HandEvent,
  type StatDefinition,
  type StatsHand,
} from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import { isObservable } from "./observation.js";
import {
  DEFAULT_TABLE_TENDENCY_POLICY,
  type TableTendencyItemId,
  type TableTendencyPolicy,
} from "./table-tendency-policy.js";

/** 入力の 1 Hand（今の Session の保存済みの Hand）。 */
export interface TableTendencySourceHand {
  readonly handId: string;
  /** Hand の保存の論理順序（ordinals.ord。D117）。 */
  readonly ord: number;
  /** その Hand の全 Event（正本。ここで public のものだけに絞る）。 */
  readonly events: readonly HandEvent[];
}

/** 項目 1 つの値。割合は numerator / denominator で、読む側が計算する（重みは掛けない）。 */
export interface TableTendencyItem {
  readonly item: TableTendencyItemId;
  readonly policyVersion: string;
  readonly numerator: number;
  /** 機会の数。 */
  readonly denominator: number;
  /** その項目の機会があった Hand の数。 */
  readonly hands: number;
  /** Policy の基準（Hand の数と機会の数）以上か。不十分なら「保留」として扱う。 */
  readonly sufficient: boolean;
}

/** viewer から見た卓の傾向（viewer 自身の Action は looseness・aggression に入れない）。 */
export interface TableTendency {
  readonly policyVersion: string;
  /** 数えた Hand の数（範囲に入った、viewer が座っていた終わった Hand）。 */
  readonly hands: number;
  /** Policy の項目の順。 */
  readonly items: readonly TableTendencyItem[];
}

/** 数える前に整えた 1 Hand（public の Event だけから作る）。 */
interface PreparedHand {
  readonly ord: number;
  readonly stats: StatsHand;
  /** 札を比べて決めた Pot があったか。 */
  readonly showdown: boolean;
}

function definitionOf(item: TableTendencyItemId): StatDefinition {
  const def = STAT_DEFINITIONS.find((d) => d.id === item);
  if (def === undefined) {
    throw new RangeError(`Table Tendency の項目 ${item} の定義が無い`);
  }
  return def;
}

/**
 * ord を検査して小さい順に並べ、Hand ごとに public の Event だけを畳む（viewer をまたいで使い回す）。
 * HAND_FINISHED の無い Hand（打ち切った Hand）は Stats と同じく数えない。
 */
function prepare(hands: readonly TableTendencySourceHand[]): PreparedHand[] {
  const ords = new Set<number>();
  for (const h of hands) {
    if (!Number.isSafeInteger(h.ord) || ords.has(h.ord)) {
      throw new RangeError(
        `Hand ${h.handId} の論理順序の番号 ${h.ord} が不正か重複している`,
      );
    }
    ords.add(h.ord);
  }
  return [...hands]
    .sort((a, b) => a.ord - b.ord)
    .flatMap((h) => {
      const shown = h.events.filter(isObservable);
      const stats = toStatsHand(shown);
      if (stats === null) return [];
      const showdown = shown.some(
        (e) => e.type === "POT_AWARDED" && e.showdown,
      );
      return [{ ord: h.ord, stats, showdown }];
    });
}

function tally(
  hands: readonly PreparedHand[],
  viewerPlayerId: string,
  policy: TableTendencyPolicy,
): TableTendency {
  // viewer が座っていた Hand のうち、論理順序で新しいものから windowHands まで（座っていない Hand は入れない）。
  const seated = hands.filter((h) =>
    h.stats.seats.some((s) => s.playerId === viewerPlayerId),
  );
  const recent = seated.slice(Math.max(0, seated.length - policy.windowHands));
  const items = policy.items.map((item): TableTendencyItem => {
    let numerator = 0;
    let denominator = 0;
    let itemHands = 0;
    const def = item === "showdown" ? null : definitionOf(item);
    for (const h of recent) {
      if (def === null) {
        numerator += h.showdown ? 1 : 0;
        denominator += 1;
        itemHands += 1;
        continue;
      }
      let had = false;
      // viewer 以外の席の寄与を合算する（卓の傾向。viewer 自身の Action は入れない）。
      for (const seat of h.stats.seats) {
        if (seat.playerId === viewerPlayerId) continue;
        for (const c of def.contribute(h.stats, seat.playerId)) {
          numerator += c.numerator;
          denominator += c.denominator;
          had = true;
        }
      }
      if (had) itemHands += 1;
    }
    return {
      item,
      policyVersion: policy.version,
      numerator,
      denominator,
      hands: itemHands,
      sufficient:
        itemHands >= policy.minHands && denominator >= policy.minOpportunities,
    };
  });
  return { policyVersion: policy.version, hands: recent.length, items };
}

/**
 * Hand の列から、viewer から見た Table Tendency を作る（純粋関数。同じ入力なら同じ結果。入力の並び・壁時計に依らない）。
 * ord の重複・不正は拒否する。
 */
export function buildTableTendency(
  hands: readonly TableTendencySourceHand[],
  viewerPlayerId: string,
  policy: TableTendencyPolicy = DEFAULT_TABLE_TENDENCY_POLICY,
): TableTendency {
  return tally(prepare(hands), viewerPlayerId, policy);
}

/** Event Store の読む部分（保存済みの Hand・その Session・論理順序）。 */
export type TableTendencyStore = Pick<
  EventStore,
  "finishedHandIds" | "sessionIdOfHand" | "savedOrder" | "read"
>;

/** Event Store から、その Session の保存済み（終わった）Hand を読む。進行中の Hand は ord が無いので入らない。 */
export function loadTableTendencySources(
  store: TableTendencyStore,
  sessionId: string,
): TableTendencySourceHand[] {
  const sources: TableTendencySourceHand[] = [];
  for (const handId of store.finishedHandIds()) {
    if (store.sessionIdOfHand(handId) !== sessionId) continue;
    const ord = store.savedOrder(handId);
    if (ord === null) {
      throw new RangeError(`保存済みの Hand ${handId} に論理順序の番号が無い`);
    }
    sources.push({
      handId,
      ord,
      events: store.read(handId).map((s) => s.event),
    });
  }
  return sources;
}

/**
 * CPU 用の入り口。Hand の開始時（その Hand を Event Store へ書く前）に、今の Session の保存済みの Hand から、座っている CPU ごとの
 * Table Tendency を作る。各 CPU の値は、その CPU が座っていた Hand の public の Event だけから作る。
 * 数えた Hand が 0 の CPU は返さない（KnowledgeState に項目ごと持たせず、Prompt を変えない）。Session の Hand は 1 回だけ読む。
 */
export function buildCpuTableTendenciesFromStore(
  store: TableTendencyStore,
  query: {
    readonly sessionId: string;
    readonly playerIds: readonly string[];
  },
  policy: TableTendencyPolicy = DEFAULT_TABLE_TENDENCY_POLICY,
): ReadonlyMap<string, TableTendency> {
  const tendencies = new Map<string, TableTendency>();
  if (query.playerIds.length === 0) return tendencies;
  const hands = prepare(loadTableTendencySources(store, query.sessionId));
  for (const playerId of query.playerIds) {
    const tendency = tally(hands, playerId, policy);
    if (tendency.hands > 0) tendencies.set(playerId, tendency);
  }
  return tendencies;
}

/**
 * Hero 用の入り口。今の Session の、Hero が座って見えた保存済みの Hand の public の Event だけから作る（Hand が無ければ hands 0）。
 * beforeOrd を渡すと、その論理順序より前に保存した Hand だけを数える（ある判断の時点の値にするため。後の Hand を混ぜない）。
 * まだ Review の Evidence にはつないでいない（docs/05 §6 の Opponent Observation の契約を変えずに入れる経路が無いため。#141 の作業ログ）。
 */
export function buildHeroTableTendencyFromStore(
  store: TableTendencyStore,
  query: {
    readonly sessionId: string;
    readonly heroPlayerId: string;
    readonly beforeOrd?: number;
  },
  policy: TableTendencyPolicy = DEFAULT_TABLE_TENDENCY_POLICY,
): TableTendency {
  const { beforeOrd } = query;
  const sources = loadTableTendencySources(store, query.sessionId).filter(
    (h) => beforeOrd === undefined || h.ord < beforeOrd,
  );
  return buildTableTendency(sources, query.heroPlayerId, policy);
}
