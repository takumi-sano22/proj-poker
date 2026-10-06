import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KB_DIR,
  KbValidationError,
  buildKb,
  hashKbFiles,
  loadKb,
  parseKbEntry,
  parseKbManifest,
  readKbFiles,
} from "./load.js";
import { KB_PREFLOP_ACTIONS, KB_TOPICS } from "./types.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** 検証を通る最小の項目。各テストはここから 1 か所だけ壊す。 */
const VALID = `---
id: sample_entry
title: サンプル
topic: pot_odds
label: FACT
formats: [cash]
source:
  - docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds
date: 2026-10-06
version: 1
---

# 本文

説明。
`;

function problemsOf(text: string, stem = "sample_entry"): readonly string[] {
  try {
    parseKbEntry(stem, text);
  } catch (e) {
    if (e instanceof KbValidationError) return e.problems;
    throw e;
  }
  throw new Error("検証に失敗するはずが通った");
}

function without(key: string): string {
  return VALID.split("\n")
    .filter((l) => !l.startsWith(`${key}:`))
    .join("\n");
}

describe("parseKbEntry（Metadata の検証）", () => {
  it("必須項目がそろった項目を読む（省略した絞り込みの項目は空の配列）", () => {
    const entry = parseKbEntry("sample_entry", VALID);
    expect(entry).toMatchObject({
      id: "sample_entry",
      title: "サンプル",
      topic: "pot_odds",
      label: "FACT",
      formats: ["cash"],
      streets: [],
      positions: [],
      players: [],
      spots: [],
      actions: [],
      keywords: [],
      source: [
        "docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds",
      ],
      date: "2026-10-06",
      version: 1,
    });
    expect(entry.body).toBe("# 本文\n\n説明。");
  });

  it("リストは [a, b] でも次行の - でも書け、CRLF でも同じに読む", () => {
    const text = VALID.replace(
      "formats: [cash]",
      "formats:\n  - cash\n  - tournament\nstreets: [flop, river]\nkeywords: [ポットオッズ, pot odds]",
    );
    const entry = parseKbEntry("sample_entry", text.replace(/\n/g, "\r\n"));
    expect(entry.formats).toEqual(["cash", "tournament"]);
    expect(entry.streets).toEqual(["flop", "river"]);
    expect(entry.keywords).toEqual(["ポットオッズ", "pot odds"]);
    expect(parseKbEntry("sample_entry", text)).toEqual(entry);
  });

  it.each([
    ["id", "id が無い（または空）"],
    ["title", "title が無い（または空）"],
    ["topic", "topic が無い（または空）"],
    ["label", "label が無い（または空）"],
    ["formats", "formats が無い"],
    ["source", "source が無い"],
    ["date", "date が無い（または空）"],
    ["version", "version が無い（または空）"],
  ])("必須項目 %s が欠けた項目を弾く", (key, message) => {
    expect(problemsOf(without(key))).toContain(message);
  });

  it("未知の topic を弾く（綴りの揺れで検索から漏れるのを防ぐ）", () => {
    const problems = problemsOf(
      VALID.replace("topic: pot_odds", "topic: potodds"),
    );
    expect(problems.some((p) => p.startsWith("未知の topic: potodds"))).toBe(
      true,
    );
  });

  it("未知の label・Street・Position・Spot の種類・Action の分類・Format を弾く", () => {
    const text = VALID.replace("label: FACT", "label: GUESS").replace(
      "formats: [cash]",
      "formats: [cash, live]\nstreets: [flopp]\npositions: [MP]\nplayers: [threeway]\nspots: [cbet]\nactions: [limp_raise]",
    );
    const problems = problemsOf(text).join("\n");
    for (const key of [
      "label",
      "formats",
      "streets",
      "positions",
      "players",
      "spots",
      "actions",
    ]) {
      expect(problems).toContain(key);
    }
    expect(problems).toContain("未知の値: live");
    expect(problems).toContain("未知の値: flopp");
  });

  it("条件に全部の値を並べた項目（書かないのと同じ）を弾く", () => {
    const text = VALID.replace(
      "formats: [cash]",
      "formats: [cash]\nplayers: [heads_up, multiway]",
    );
    expect(problemsOf(text)).toContain(
      "players に全部の値を並べている（条件なしは省略する）",
    );
  });

  it("未知の項目名（綴りの間違い）を弾く", () => {
    const problems = problemsOf(
      VALID.replace("date:", "dtae: 2026-10-06\ndate:"),
    );
    expect(problems).toContain("未知の項目名: dtae");
  });

  it("id がファイル名と違う・id の書式が違う項目を弾く", () => {
    expect(problemsOf(VALID, "other_name")).toContain(
      "id（sample_entry）がファイル名（other_name）と違う",
    );
    expect(
      problemsOf(
        VALID.replace("id: sample_entry", "id: Sample-Entry"),
        "Sample-Entry",
      ),
    ).toContain("id は小文字英数字と _ だけ: Sample-Entry");
  });

  it("date は実在する YYYY-MM-DD、version は 1 以上の整数", () => {
    expect(problemsOf(VALID.replace("2026-10-06", "2026-02-30"))).toContain(
      "date は YYYY-MM-DD の実在する日付: 2026-02-30",
    );
    expect(problemsOf(VALID.replace("2026-10-06", "2026/10/06"))).toContain(
      "date は YYYY-MM-DD の実在する日付: 2026/10/06",
    );
    for (const bad of ["0", "1.5", "-1", "v1"]) {
      expect(
        problemsOf(VALID.replace("version: 1", `version: ${bad}`)),
      ).toContain(`version は 1 以上の整数: ${bad}`);
    }
  });

  it("source は docs/research のファイルと節を持つ書式だけ", () => {
    for (const bad of [
      "PokerStars Learn — Pot Odds",
      "docs/research/02_strategy_and_math.md",
      "docs/other/02_strategy_and_math.md §2",
    ]) {
      const text = VALID.replace(
        "docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds",
        bad,
      );
      expect(problemsOf(text).join("\n")).toContain("source の書式が違う");
    }
    // 元の出典（| 以降）は省略できる。
    const noOrigin = VALID.replace(" | PokerStars Learn — Pot Odds", "");
    expect(parseKbEntry("sample_entry", noOrigin).source).toEqual([
      "docs/research/02_strategy_and_math.md §2",
    ]);
  });

  it("空の必須リスト・重複・本文なし・front matter なしを弾く", () => {
    expect(
      problemsOf(VALID.replace("formats: [cash]", "formats: []")),
    ).toContain("formats が空");
    expect(
      problemsOf(VALID.replace("formats: [cash]", "formats: [cash, cash]")),
    ).toContain("formats に重複がある");
    expect(problemsOf(VALID.slice(0, VALID.indexOf("# 本文")))).toContain(
      "本文が空",
    );
    expect(problemsOf("# タイトルだけ")).toContain(
      "先頭が front matter（---）で始まっていない",
    );
    expect(problemsOf("---\nid: x\n本文")).toContain(
      "front matter が --- で閉じていない",
    );
  });

  it("同じ項目名の重複・リストでない書き方を弾く", () => {
    expect(
      problemsOf(VALID.replace("version: 1", "version: 1\nversion: 2")),
    ).toContain("項目名が重複: version");
    expect(
      problemsOf(VALID.replace("formats: [cash]", "formats: cash")),
    ).toContain("formats はリスト（[a, b] か - の行）で書く");
  });

  it("問題は 1 つで止めず全部集める", () => {
    const text = VALID.replace("topic: pot_odds", "topic: nope").replace(
      "version: 1",
      "version: 0",
    );
    expect(problemsOf(text)).toHaveLength(2);
  });
});

describe("parseKbManifest / hashKbFiles / buildKb", () => {
  const HASH = "a".repeat(64);

  it("version と contentHash を読み、書式の違いを弾く", () => {
    expect(
      parseKbManifest(`{"version":"1.2.3","contentHash":"${HASH}"}`),
    ).toEqual({
      version: "1.2.3",
      contentHash: HASH,
    });
    expect(() => parseKbManifest("not json")).toThrow(KbValidationError);
    expect(() =>
      parseKbManifest(`{"version":"1.2","contentHash":"${HASH}"}`),
    ).toThrow("version は x.y.z 形式の文字列");
    expect(() =>
      parseKbManifest(`{"version":"1.2.3","contentHash":"xyz"}`),
    ).toThrow("contentHash は sha256");
    expect(() =>
      parseKbManifest(`{"version":"1.2.3","contentHash":"${HASH}","x":1}`),
    ).toThrow("未知の項目名: x");
  });

  it("ハッシュはファイルの並びと改行コードに依らず、内容が変われば変わる", () => {
    const a = new Map([
      ["a.md", "A\nB"],
      ["b.md", "C"],
    ]);
    const reordered = new Map([
      ["b.md", "C"],
      ["a.md", "A\r\nB"],
    ]);
    expect(hashKbFiles(a)).toBe(hashKbFiles(reordered));
    expect(hashKbFiles(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKbFiles(new Map([...a, ["b.md", "D"]]))).not.toBe(
      hashKbFiles(a),
    );
    expect(hashKbFiles(new Map([["a.md", "A\nB"]]))).not.toBe(hashKbFiles(a));
  });

  it("buildKb は項目を id の昇順に並べ、どの項目が壊れているかを全部報告する", () => {
    const manifest = { version: "1.0.0", contentHash: HASH };
    const kb = buildKb(
      manifest,
      new Map([
        ["zeta.md", VALID.replace("sample_entry", "zeta")],
        ["alpha.md", VALID.replace("sample_entry", "alpha")],
      ]),
    );
    expect(kb.entries.map((e) => e.id)).toEqual(["alpha", "zeta"]);
    expect(kb.version).toBe("1.0.0");

    const broken = new Map([
      [
        "alpha.md",
        VALID.replace("sample_entry", "alpha").replace(
          "topic: pot_odds",
          "topic: x",
        ),
      ],
      [
        "zeta.md",
        VALID.replace("sample_entry", "zeta").replace(
          "version: 1",
          "version: 0",
        ),
      ],
    ]);
    expect(() => buildKb(manifest, broken)).toThrow(/alpha[\s\S]*zeta/);
    expect(() => buildKb(manifest, new Map())).toThrow("項目が 1 つも無い");
  });
});

describe("apps/server/kb の Curated KB（実物）", () => {
  const kb = loadKb();
  const files = readKbFiles(DEFAULT_KB_DIR);
  const research = (name: string) =>
    readFileSync(`${REPO_ROOT}docs/research/${name}`, "utf8");
  const sources = research("SOURCES.md");

  it("起動時の読み込みで全項目の Metadata の検証を通る（KB 全体の Version を持つ）", () => {
    expect(kb.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(kb.entries.length).toBeGreaterThanOrEqual(20);
    expect(new Set(kb.entries.map((e) => e.id)).size).toBe(kb.entries.length);
  });

  it("項目を変えたら manifest.json の version と contentHash を更新している（Evidence の版の取り違えを防ぐ）", () => {
    const manifest = parseKbManifest(
      readFileSync(`${DEFAULT_KB_DIR}manifest.json`, "utf8"),
    );
    expect(
      kb.contentHash,
      `項目の内容が変わった。apps/server/kb/manifest.json の version を上げ、contentHash を ${kb.contentHash} に更新する`,
    ).toBe(manifest.contentHash);
    expect(hashKbFiles(files)).toBe(kb.contentHash);
  });

  it("Phase 5 の Review に要る論点（Pot Odds・Range・Position・C-bet・River の判断）を持ち、使っていない Topic が無い", () => {
    const topics = new Set(kb.entries.map((e) => e.topic));
    for (const required of [
      "pot_odds",
      "range_thinking",
      "position",
      "cbet",
      "river_decision",
    ]) {
      expect(topics.has(required as (typeof KB_TOPICS)[number])).toBe(true);
    }
    expect([...topics].sort()).toEqual([...KB_TOPICS].sort());
  });

  it("出典は docs/research の実在するファイルと節で、元の出典は SOURCES.md の見出しにある", () => {
    for (const entry of kb.entries) {
      for (const source of entry.source) {
        const m = /^docs\/research\/(\S+\.md) §(\d+)(?: \| (.+))?$/.exec(
          source,
        );
        expect(m, `${entry.id}: ${source}`).not.toBeNull();
        const [, file, section, origin] = m as RegExpExecArray;
        // 節の番号は、その研究資料の「## N. 」の見出しとして実在する。
        expect(research(file ?? ""), `${entry.id}: ${source}`).toMatch(
          new RegExp(`^## ${section}\\. `, "m"),
        );
        if (origin !== undefined) {
          expect(sources, `${entry.id}: ${origin}`).toContain(
            `### ${origin}\n`,
          );
        }
      }
    }
  });

  it("丸写しをしない（1 項目は研究資料 1 ファイルよりずっと短い）", () => {
    for (const entry of kb.entries) {
      expect(entry.body.length, entry.id).toBeLessThan(1600);
    }
  });

  it("本文が参照する項目 ID は実在する", () => {
    const ids = new Set(kb.entries.map((e) => e.id));
    const allowed = new Set<string>(KB_PREFLOP_ACTIONS);
    for (const entry of kb.entries) {
      for (const m of entry.body.matchAll(/`([a-z0-9]+(?:_[a-z0-9]+)+)`/g)) {
        const token = m[1] ?? "";
        expect(
          ids.has(token) || allowed.has(token),
          `${entry.id} → ${token}`,
        ).toBe(true);
      }
    }
  });
});
