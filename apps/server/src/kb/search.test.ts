import { describe, expect, it } from "vitest";
import { buildKb, loadKb, type LoadedKb } from "./load.js";
import { KB_SCORE, getKbEntry, searchKb, tokenize } from "./search.js";
import { kbEvidenceId } from "./types.js";

/** 検索の点数を手計算できる小さな KB の項目。 */
function file(
  id: string,
  fields: {
    topic?: string;
    extra?: string;
    title?: string;
    body?: string;
  } = {},
): [string, string] {
  return [
    `${id}.md`,
    `---
id: ${id}
title: ${fields.title ?? id}
topic: ${fields.topic ?? "pot_odds"}
label: HEURISTIC
formats: [cash]
${fields.extra ?? ""}
source:
  - docs/research/02_strategy_and_math.md §2
date: 2026-10-06
version: 3
---

${fields.body ?? "本文"}
`,
  ];
}

const MANIFEST = { version: "9.8.7", contentHash: "a".repeat(64) };

function fixture(files: [string, string][]): LoadedKb {
  return buildKb(MANIFEST, new Map(files));
}

const KB = fixture([
  file("river_call", {
    topic: "river_decision",
    extra:
      "streets: [river]\nspots: [postflop_facing_bet]\nkeywords: [ブラフキャッチ]",
    title: "River で Call",
    body: "Pot Odds と相手の Range を比べる。",
  }),
  file("flop_cbet", {
    topic: "cbet",
    extra:
      "streets: [flop]\nspots: [postflop_aggressor]\npositions: [BTN, CO]\nplayers: [heads_up]",
    title: "Flop の C-bet",
    body: "Board と Range で決める。",
  }),
  file("blind_defense", {
    topic: "blind_defense",
    extra:
      "streets: [preflop]\nspots: [preflop_facing_raise]\npositions: [SB, BB]\nactions: [open, call_open]",
    body: "価格が安いが先に動く。",
  }),
  file("any_glossary", {
    topic: "pot_odds",
    title: "用語集",
    body: "Pot Odds の定義。",
  }),
  file("a_second", {
    topic: "pot_odds",
    extra: "spots: [postflop_facing_bet]",
    title: "もう 1 つ",
    body: "別の説明。",
  }),
]);

describe("searchKb（Spot の特徴・Topic・全文）", () => {
  it("Spot の特徴で、当てはまる項目を点の高い順に返す", () => {
    const result = searchKb(KB, {
      spot: {
        street: "river",
        spotKind: "postflop_facing_bet",
        players: "heads_up",
      },
    });
    // river_call: spotKind と street の条件がそれぞれ 1 つの値（narrow の加点つき）。a_second: spotKind だけ。flop_cbet は Street が違うので除外。
    expect(result.hits.map((h) => [h.id, h.score])).toEqual([
      ["river_call", KB_SCORE.spotKind + KB_SCORE.street + 2 * KB_SCORE.narrow],
      ["a_second", KB_SCORE.spotKind + KB_SCORE.narrow],
    ]);
    expect(result.hits[0]?.matched).toEqual([
      "spotKind:postflop_facing_bet",
      "street:river",
    ]);
  });

  it("渡した特徴について項目の条件に当たらなければ除外し、条件のない項目には加点しない", () => {
    const flop = searchKb(KB, {
      spot: {
        street: "flop",
        position: "BTN",
        spotKind: "postflop_aggressor",
        players: "heads_up",
      },
    });
    expect(flop.hits.map((h) => h.id)).toEqual(["flop_cbet"]);
    // Position の条件は 2 つの値（BTN・CO）なので narrow は付かない。
    expect(flop.hits[0]?.score).toBe(
      KB_SCORE.spotKind +
        KB_SCORE.street +
        KB_SCORE.position +
        KB_SCORE.players +
        3 * KB_SCORE.narrow,
    );
    // Position が合わない・Player 数が合わない項目は除外される。
    expect(
      searchKb(KB, { spot: { street: "flop", position: "UTG" } }).hits,
    ).toEqual([]);
    expect(
      searchKb(KB, { spot: { street: "flop", players: "multiway" } }).hits,
    ).toEqual([]);
  });

  it("Action 列は、相手の分類のどれかが項目の条件に当たれば残す", () => {
    const hit = searchKb(KB, {
      spot: {
        street: "preflop",
        actions: ["three_bet", "call_open", "call_open"],
      },
    });
    expect(hit.hits.map((h) => [h.id, h.score, h.matched])).toEqual([
      [
        "blind_defense",
        KB_SCORE.street + KB_SCORE.narrow + KB_SCORE.actions,
        ["street:preflop", "actions:call_open"],
      ],
    ]);
    expect(
      searchKb(KB, { spot: { street: "preflop", actions: ["limp"] } }).hits,
    ).toEqual([]);
    // 空の列は「渡さなかった」と同じ。
    expect(
      searchKb(KB, { spot: { street: "preflop", actions: [] } }).hits.map(
        (h) => h.id,
      ),
    ).toEqual(["blind_defense"]);
  });

  it("Topic を渡すと、その Topic の項目だけを返す", () => {
    const result = searchKb(KB, { topics: ["pot_odds"] });
    expect(result.hits.map((h) => [h.id, h.score])).toEqual([
      ["a_second", KB_SCORE.topic],
      ["any_glossary", KB_SCORE.topic],
    ]);
    const both = searchKb(KB, { topics: ["cbet", "river_decision"] });
    expect(both.hits.map((h) => h.id)).toEqual(["flop_cbet", "river_call"]);
  });

  it("全文は title・keywords に当たれば 3 点、本文だけなら 1 点（日本語は部分一致）", () => {
    const head = searchKb(KB, { text: "ブラフキャッチ" });
    expect(head.hits.map((h) => [h.id, h.score])).toEqual([
      ["river_call", KB_SCORE.textHead],
    ]);

    const body = searchKb(KB, { text: "先に動く" });
    expect(body.hits.map((h) => [h.id, h.score])).toEqual([
      ["blind_defense", KB_SCORE.textBody],
    ]);

    // 大文字小文字は区別しない。語ごとに加点し、どれにも当たらない項目は返さない。
    const two = searchKb(KB, { text: "POT ODDS river" });
    expect(two.hits.map((h) => [h.id, h.score])).toEqual([
      // river_call: "pot"（本文 1）+ "odds"（本文 1）+ "river"（title 3）。any_glossary: "pot"・"odds" とも本文 1 + 1。
      ["river_call", 5],
      ["any_glossary", 2],
    ]);
    expect(searchKb(KB, { text: "存在しない語" }).hits).toEqual([]);
  });

  it("Spot・Topic・全文を合わせると、全部を満たす項目だけを足し合わせて返す", () => {
    const result = searchKb(KB, {
      spot: { street: "river", spotKind: "postflop_facing_bet" },
      topics: ["river_decision"],
      text: "Range",
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      id: "river_call",
      score:
        KB_SCORE.spotKind +
        KB_SCORE.street +
        2 * KB_SCORE.narrow +
        KB_SCORE.topic +
        KB_SCORE.textBody,
      matched: [
        "spotKind:postflop_facing_bet",
        "street:river",
        "topic:river_decision",
        "text:range",
      ],
    });
  });

  it("何も渡さなければ空（全項目を返さない）", () => {
    expect(searchKb(KB, {}).hits).toEqual([]);
    expect(searchKb(KB, { spot: {}, topics: [], text: "  、 " }).hits).toEqual(
      [],
    );
  });

  it("同点は id の昇順、limit で件数を絞る（既定 5）", () => {
    const many = fixture(
      ["e", "d", "c", "b", "a", "f", "g"].map((id) =>
        file(id, { extra: "spots: [postflop_facing_bet]" }),
      ),
    );
    const query = { spot: { spotKind: "postflop_facing_bet" } } as const;
    expect(searchKb(many, query).hits.map((h) => h.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(
      searchKb(many, { ...query, limit: 2 }).hits.map((h) => h.id),
    ).toEqual(["a", "b"]);
    expect(searchKb(many, { ...query, limit: 100 }).hits).toHaveLength(7);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => searchKb(many, { ...query, limit })).toThrow(RangeError);
    }
  });

  it("結果は KB の Version と項目の ID・Version・Evidence ID を持つ（Review の Evidence に残せる）", () => {
    const result = searchKb(KB, { topics: ["cbet"] });
    expect(result.kbVersion).toBe("9.8.7");
    const hit = result.hits[0];
    expect(hit).toMatchObject({
      kbVersion: "9.8.7",
      id: "flop_cbet",
      version: 3,
      evidenceId: "kb:9.8.7:flop_cbet@3",
      topic: "cbet",
      label: "HEURISTIC",
      title: "Flop の C-bet",
      source: ["docs/research/02_strategy_and_math.md §2"],
      body: "Board と Range で決める。",
    });
    expect(hit?.evidenceId).toBe(kbEvidenceId(hit as NonNullable<typeof hit>));
    expect(getKbEntry(KB, "flop_cbet")?.version).toBe(3);
    expect(getKbEntry(KB, "nothing")).toBeUndefined();
  });

  it("同じ入力なら同じ結果で、項目の並び順や呼び出しの回数に依らない", () => {
    const query = {
      spot: { street: "river", spotKind: "postflop_facing_bet" },
      text: "Pot Odds",
    } as const;
    const first = searchKb(KB, query);
    expect(searchKb(KB, query)).toEqual(first);
    const shuffled: LoadedKb = {
      ...KB,
      entries: [...KB.entries].reverse(),
    };
    expect(searchKb(shuffled, query)).toEqual(first);
    // 入力を書き換えない。
    expect(KB.entries).toHaveLength(5);
  });

  it("tokenize は空白・句読点で分け、1 文字の語を捨て、重複を 1 つにする", () => {
    expect(tokenize("Pot Odds、ポットオッズ。a  odds")).toEqual([
      "pot",
      "odds",
      "ポットオッズ",
    ]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("実物の KB の代表 Spot", () => {
  const kb = loadKb();
  const ids = (q: Parameters<typeof searchKb>[1]) =>
    searchKb(kb, q).hits.map((h) => h.id);

  it("River で Bet に直面した Spot は、River の判断と Pot Odds が上位に出る", () => {
    const top = ids({
      spot: {
        street: "river",
        spotKind: "postflop_facing_bet",
        players: "heads_up",
      },
      limit: 10,
    });
    // River 専用の項目（条件が River だけ）が、広く当てはまる項目より上に出る。
    expect(top[0]).toBe("river_decision");
    expect(top).toContain("pot_odds_required_equity");
  });

  it("Flop で Preflop の Aggressor だった Spot は C-bet が出る。Multiway の項目は Heads-Up では出ず Multiway で出る", () => {
    const base = {
      street: "flop",
      position: "BTN",
      spotKind: "postflop_aggressor",
    } as const;
    expect(ids({ spot: { ...base, players: "heads_up" } })).toContain(
      "cbet_not_automatic",
    );
    expect(
      ids({ spot: { ...base, players: "heads_up" }, limit: 50 }),
    ).not.toContain("multiway_adjustment");
    expect(
      ids({ spot: { ...base, players: "multiway" }, limit: 50 }),
    ).toContain("multiway_adjustment");
  });

  it("BB が Open に直面した Preflop の Spot は Blind Defense が出る", () => {
    expect(
      ids({
        spot: {
          street: "preflop",
          position: "BB",
          spotKind: "preflop_facing_raise",
          actions: ["open"],
        },
      }),
    ).toContain("blind_defense_basics");
  });

  it("全文（日本語・英語）と Topic で引ける", () => {
    expect(ids({ text: "ポットオッズ" })[0]).toBe("pot_odds_required_equity");
    expect(ids({ text: "c-bet" })[0]).toBe("cbet_not_automatic");
    expect(ids({ topics: ["position"] })).toEqual(["position_basics"]);
  });
});
