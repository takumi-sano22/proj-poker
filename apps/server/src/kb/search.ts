// Local KB の検索（Vector DB は使わない。D98・docs/research/06 §4）。Metadata で絞り → Topic・Spot の特徴で加点 → 全文（語）で加点し、
// 点の高い順・同点は id の昇順で返す。メモリ上の項目だけを見る純粋関数なので、同じ KB・同じ入力なら必ず同じ結果になる。
import type { LoadedKb } from "./load.js";
import {
  kbEvidenceId,
  type KbEntry,
  type KbHit,
  type KbQuery,
  type KbSearchResult,
  type KbSpot,
} from "./types.js";

/** 加点（暫定値）。Review が論点を決めた Topic ＞ Spot の種類 ＞ Action 列 ＞ その他の特徴 ＞ 全文、の順で重くする。 */
export const KB_SCORE = {
  topic: 5,
  spotKind: 4,
  actions: 3,
  street: 2,
  position: 2,
  players: 2,
  /** 条件が 1 つの値だけの項目（その Spot 専用の項目）が当たったときの加点。広く当てはまる項目より上に出す。 */
  narrow: 1,
  /** 語が title / keywords に当たった。 */
  textHead: 3,
  /** 語が本文に当たった。 */
  textBody: 1,
} as const;

export const DEFAULT_KB_SEARCH_LIMIT = 5;

/** 全文検索の語に分ける（空白・句読点区切り。日本語は分かち書きしないので、語は部分一致で見る）。1 文字の語は捨てる。 */
export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[\s、。，．,.;:：；・/／()（）「」『』[\]{}"'!?！？]+/)
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)];
}

interface Scored {
  readonly score: number;
  readonly matched: readonly string[];
}

/**
 * 項目を Spot の特徴に当てる。渡された特徴について、項目が条件（空でないリスト）を持ち、それに当たらなければ null（除外）。
 * 条件が空の項目は何にでも当てはまるが、加点はしない。
 */
function matchSpot(entry: KbEntry, spot: KbSpot): Scored | null {
  let score = 0;
  const matched: string[] = [];
  const check = <T extends string>(
    name: string,
    value: T | undefined,
    condition: readonly T[],
    points: number,
  ): boolean => {
    if (value === undefined || condition.length === 0) return true;
    if (!condition.includes(value)) return false;
    score += points + (condition.length === 1 ? KB_SCORE.narrow : 0);
    matched.push(`${name}:${value}`);
    return true;
  };
  if (!check("spotKind", spot.spotKind, entry.spots, KB_SCORE.spotKind))
    return null;
  if (!check("street", spot.street, entry.streets, KB_SCORE.street))
    return null;
  if (!check("position", spot.position, entry.positions, KB_SCORE.position))
    return null;
  if (!check("players", spot.players, entry.players, KB_SCORE.players))
    return null;
  // Action 列は相手ごとの分類の列。1 つでも当たれば残す（当たった分類の名前を、列に現れた順で残す）。
  if (
    spot.actions !== undefined &&
    spot.actions.length > 0 &&
    entry.actions.length > 0
  ) {
    const hit = [...new Set(spot.actions)].filter((a) =>
      entry.actions.includes(a),
    );
    if (hit.length === 0) return null;
    score +=
      KB_SCORE.actions + (entry.actions.length === 1 ? KB_SCORE.narrow : 0);
    for (const a of hit) matched.push(`actions:${a}`);
  }
  return { score, matched };
}

/** 全文の語の加点。語ごとに、title / keywords に当たれば textHead、なければ本文に当たれば textBody（1 語 1 回）。 */
function matchText(entry: KbEntry, tokens: readonly string[]): Scored {
  const head = [entry.title, ...entry.keywords].join("\n").toLowerCase();
  const body = entry.body.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const token of tokens) {
    if (head.includes(token)) {
      score += KB_SCORE.textHead;
      matched.push(`text:${token}`);
    } else if (body.includes(token)) {
      score += KB_SCORE.textBody;
      matched.push(`text:${token}`);
    }
  }
  return { score, matched };
}

/**
 * KB を検索する。渡した条件（Topic・Spot の特徴・語）のすべてを満たす項目だけを残し（Spot の特徴は上のとおり、条件に当たらない項目は除外）、
 * 1 点以上取った項目を点の高い順（同点は id の昇順）に limit 件まで返す。何も渡さなければ空。
 * 各 hit は KB の Version・項目の ID と Version・Evidence ID を持つ（Review の Evidence に残せる）。
 */
export function searchKb(kb: LoadedKb, query: KbQuery): KbSearchResult {
  const limit = query.limit ?? DEFAULT_KB_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit は 1 以上の整数: ${limit}`);
  }
  const spot = query.spot ?? {};
  const topics = query.topics ?? [];
  const tokens = tokenize(query.text ?? "");

  const hits: KbHit[] = [];
  for (const entry of kb.entries) {
    const bySpot = matchSpot(entry, spot);
    if (bySpot === null) continue;
    let score = bySpot.score;
    const matched = [...bySpot.matched];
    if (topics.length > 0) {
      // Topic を指定したなら、その Topic の項目だけ。
      if (!topics.includes(entry.topic)) continue;
      score += KB_SCORE.topic;
      matched.push(`topic:${entry.topic}`);
    }
    if (tokens.length > 0) {
      const byText = matchText(entry, tokens);
      // 語を指定したなら、どれかの語に当たった項目だけ。
      if (byText.score === 0) continue;
      score += byText.score;
      matched.push(...byText.matched);
    }
    if (score === 0) continue;
    const ref = { kbVersion: kb.version, id: entry.id, version: entry.version };
    hits.push({
      ...ref,
      evidenceId: kbEvidenceId(ref),
      topic: entry.topic,
      title: entry.title,
      label: entry.label,
      source: entry.source,
      score,
      matched,
      body: entry.body,
    });
  }
  hits.sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { kbVersion: kb.version, hits: hits.slice(0, limit) };
}

/** ID から項目を引く（Evidence の ID から本文を読み直すとき）。無ければ undefined。 */
export function getKbEntry(kb: LoadedKb, id: string): KbEntry | undefined {
  return kb.entries.find((e) => e.id === id);
}
