// Local KB の読み込みと Metadata の検証。I/O は loadKb の起動時の読み込みだけで、検索（search.ts）はメモリ上の項目だけを見る。
// 検証は純粋関数（parseKbEntry）に分けてあり、必須項目の欠け・未知の Topic・綴りの間違った項目名などをここで弾く。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KB_FORMATS,
  KB_LABELS,
  KB_PLAYER_GROUPS,
  KB_POSITIONS,
  KB_PREFLOP_ACTIONS,
  KB_SPOT_KINDS,
  KB_STREETS,
  KB_TOPICS,
  type KbEntry,
} from "./types.js";

/** KB の既定の置き場所（apps/server/kb/）。src/kb と dist/kb のどちらから見ても 2 つ上。 */
export const DEFAULT_KB_DIR = fileURLToPath(
  new URL("../../kb/", import.meta.url),
);
export const KB_MANIFEST_FILE = "manifest.json";

/** 検証に失敗した項目（またはマニフェスト）。problems に全部の理由を持つ。 */
export class KbValidationError extends Error {
  readonly problems: readonly string[];
  constructor(where: string, problems: readonly string[]) {
    super(
      `KB の検証に失敗: ${where}\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
    this.name = "KbValidationError";
    this.problems = problems;
  }
}

type RawValue = string | string[];

/** front matter（`---` で囲んだ `key: value` / `key: [a, b]` / 次行以降の `  - item`）を読む。YAML の全部は扱わない。 */
function parseFrontMatter(
  text: string,
  problems: string[],
): { raw: Map<string, RawValue>; body: string } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    problems.push("先頭が front matter（---）で始まっていない");
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    problems.push("front matter が --- で閉じていない");
    return null;
  }
  const raw = new Map<string, RawValue>();
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const current = listKey === null ? undefined : raw.get(listKey);
      if (!Array.isArray(current)) {
        problems.push(`リストの項目が先頭にある（"${line.trim()}"）`);
        continue;
      }
      current.push((item[1] ?? "").trim());
      continue;
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) {
      problems.push(`front matter の行を読めない: "${line}"`);
      listKey = null;
      continue;
    }
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();
    if (raw.has(key)) problems.push(`項目名が重複: ${key}`);
    if (value === "") {
      raw.set(key, []);
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      raw.set(key, inner === "" ? [] : inner.split(",").map((s) => s.trim()));
      listKey = null;
    } else {
      raw.set(key, value);
      listKey = null;
    }
  }
  return {
    raw,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

const ID_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_PATTERN = /^docs\/research\/[0-9A-Za-z_]+\.md §\S+( \| .+)?$/;

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const KNOWN_KEYS = new Set([
  "id",
  "title",
  "topic",
  "label",
  "formats",
  "streets",
  "positions",
  "players",
  "spots",
  "actions",
  "keywords",
  "source",
  "date",
  "version",
]);

/**
 * KB の項目 1 つ（ファイルの全文）を検証して KbEntry にする。fileStem はファイル名の拡張子を除いた部分で、id と一致しなければ弾く。
 * 問題は最初の 1 つで止めず全部集めて KbValidationError に入れる（直す側が 1 回で全部分かるように）。
 */
export function parseKbEntry(fileStem: string, text: string): KbEntry {
  const problems: string[] = [];
  const fail = (): never => {
    throw new KbValidationError(fileStem, problems);
  };
  const parsed = parseFrontMatter(text, problems);
  if (parsed === null) return fail();
  const { raw, body } = parsed;

  for (const key of raw.keys()) {
    if (!KNOWN_KEYS.has(key)) problems.push(`未知の項目名: ${key}`);
  }

  const scalar = (key: string): string => {
    const v = raw.get(key);
    if (typeof v !== "string" || v === "") {
      problems.push(`${key} が無い（または空）`);
      return "";
    }
    return v;
  };
  const list = (key: string, required: boolean): string[] => {
    const v = raw.get(key);
    if (v === undefined) {
      if (required) problems.push(`${key} が無い`);
      return [];
    }
    if (typeof v === "string") {
      problems.push(`${key} はリスト（[a, b] か - の行）で書く`);
      return [];
    }
    if (required && v.length === 0) problems.push(`${key} が空`);
    if (v.some((s) => s === "")) problems.push(`${key} に空の要素がある`);
    if (new Set(v).size !== v.length) problems.push(`${key} に重複がある`);
    return v;
  };
  // 閉じた語彙のリスト。語彙に無い値（綴りの揺れ）は弾く。
  const enumList = <T extends string>(
    key: string,
    allowed: readonly T[],
    required: boolean,
  ): T[] => {
    const values = list(key, required);
    const bad = values.filter(
      (s) => !(allowed as readonly string[]).includes(s),
    );
    if (bad.length > 0) {
      problems.push(
        `${key} に未知の値: ${bad.join(", ")}（使えるのは ${allowed.join(" / ")}）`,
      );
    }
    // 全部の値を並べるのは「書かない」と同じ。条件を持つ項目として扱われ、加点の意味が変わるので弾く。
    if (!required && values.length === allowed.length && bad.length === 0) {
      problems.push(`${key} に全部の値を並べている（条件なしは省略する）`);
    }
    return values.filter((s): s is T =>
      (allowed as readonly string[]).includes(s),
    );
  };

  const id = scalar("id");
  if (id !== "") {
    if (!ID_PATTERN.test(id))
      problems.push(`id は小文字英数字と _ だけ: ${id}`);
    if (id !== fileStem)
      problems.push(`id（${id}）がファイル名（${fileStem}）と違う`);
  }
  const title = scalar("title");

  const topicRaw = scalar("topic");
  const topic = KB_TOPICS.find((t) => t === topicRaw);
  if (topicRaw !== "" && topic === undefined) {
    problems.push(
      `未知の topic: ${topicRaw}（使えるのは ${KB_TOPICS.join(" / ")}）`,
    );
  }
  const labelRaw = scalar("label");
  const label = KB_LABELS.find((l) => l === labelRaw);
  if (labelRaw !== "" && label === undefined) {
    problems.push(
      `未知の label: ${labelRaw}（使えるのは ${KB_LABELS.join(" / ")}）`,
    );
  }

  const formats = enumList("formats", KB_FORMATS, true);
  const streets = enumList("streets", KB_STREETS, false);
  const positions = enumList("positions", KB_POSITIONS, false);
  const players = enumList("players", KB_PLAYER_GROUPS, false);
  const spots = enumList("spots", KB_SPOT_KINDS, false);
  const actions = enumList("actions", KB_PREFLOP_ACTIONS, false);
  const keywords = list("keywords", false);

  const source = list("source", true);
  for (const s of source) {
    if (!SOURCE_PATTERN.test(s)) {
      problems.push(
        `source の書式が違う: "${s}"（docs/research/<file>.md §<節> | <元の出典>）`,
      );
    }
  }

  const date = scalar("date");
  if (date !== "" && !isRealDate(date))
    problems.push(`date は YYYY-MM-DD の実在する日付: ${date}`);

  const versionRaw = scalar("version");
  if (versionRaw !== "" && !/^[1-9][0-9]*$/.test(versionRaw)) {
    problems.push(`version は 1 以上の整数: ${versionRaw}`);
  }

  if (body === "") problems.push("本文が空");

  if (problems.length > 0 || topic === undefined || label === undefined)
    return fail();
  return {
    id,
    title,
    topic,
    label,
    formats,
    streets,
    positions,
    players,
    spots,
    actions,
    keywords,
    source,
    date,
    version: Number(versionRaw),
    body,
  };
}

/** KB 全体。version は manifest.json の値、contentHash は全項目の内容から決まる（Evidence の版の取り違えを検出するため）。 */
export interface LoadedKb {
  readonly version: string;
  readonly contentHash: string;
  /** id の昇順。 */
  readonly entries: readonly KbEntry[];
}

export interface KbManifest {
  /** KB 全体の Version（項目を足す・変える・消すたびに上げる）。 */
  readonly version: string;
  /** 全項目の内容のハッシュ（`hashKbFiles`）。項目を変えて Version を上げ忘れるのをテストで捕まえる。 */
  readonly contentHash: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseKbManifest(text: string): KbManifest {
  const problems: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KbValidationError(KB_MANIFEST_FILE, ["JSON として読めない"]);
  }
  const obj = (typeof json === "object" && json !== null ? json : {}) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(obj)) {
    if (key !== "version" && key !== "contentHash")
      problems.push(`未知の項目名: ${key}`);
  }
  const version = obj["version"];
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    problems.push("version は x.y.z 形式の文字列");
  }
  const contentHash = obj["contentHash"];
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) {
    problems.push("contentHash は sha256 の 16 進 64 文字");
  }
  if (problems.length > 0)
    throw new KbValidationError(KB_MANIFEST_FILE, problems);
  return { version: version as string, contentHash: contentHash as string };
}

/** 項目ファイル（ファイル名 → 全文）から決まるハッシュ。ファイル名の昇順で並べ、改行コードの違いは無視する。 */
export function hashKbFiles(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(
      `${name}\n${(files.get(name) ?? "").replace(/\r\n/g, "\n")}\n\0`,
    );
  }
  return hash.digest("hex");
}

/** ディレクトリの項目ファイル（*.md）を全部読む。名前の昇順。 */
export function readKbFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()) {
    files.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return files;
}

/** 検証済みの文字列から KB を組み立てる（I/O なし）。ID の重複もここで弾く。 */
export function buildKb(
  manifest: KbManifest,
  files: ReadonlyMap<string, string>,
): LoadedKb {
  const entries: KbEntry[] = [];
  const failures: string[] = [];
  for (const [name, text] of files) {
    try {
      entries.push(parseKbEntry(basename(name, ".md"), text));
    } catch (e) {
      if (e instanceof KbValidationError) failures.push(e.message);
      else throw e;
    }
  }
  if (failures.length > 0) {
    throw new KbValidationError("KB の項目", failures);
  }
  if (entries.length === 0)
    throw new KbValidationError("KB の項目", ["項目が 1 つも無い"]);
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    version: manifest.version,
    contentHash: hashKbFiles(files),
    entries,
  };
}

/** 起動時に 1 回だけ呼ぶ。以降の検索はメモリだけを見る。 */
export function loadKb(dir: string = DEFAULT_KB_DIR): LoadedKb {
  const manifest = parseKbManifest(
    readFileSync(join(dir, KB_MANIFEST_FILE), "utf8"),
  );
  return buildKb(manifest, readKbFiles(dir));
}
