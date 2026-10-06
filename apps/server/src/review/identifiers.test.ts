// Review の文から内部の識別子を消す処理（#96・D101）のテスト。
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_TERMS,
  evidenceGlossary,
  findIdentifiers,
  outputTexts,
  playerNamesOf,
  sanitizeOutput,
  sanitizeText,
  toPlayerNames,
} from "./identifiers.js";
import type { DecisionContextEvidence } from "./types.js";

const names = toPlayerNames([
  { playerId: "hero", displayName: "Hero" },
  { playerId: "cpu1", displayName: "CPU 1" },
  { playerId: "cpu3", displayName: "CPU 3" },
  { playerId: "cpu10", displayName: "CPU 10" },
]);

describe("sanitizeText", () => {
  it("playerId を表示名にする（cpu1 と cpu10 を取り違えない・大文字小文字・` で囲まれたものも）", () => {
    expect(
      sanitizeText("cpu3 の Bet に cpu1 が Call。`cpu10` は Fold。", names),
    ).toBe("CPU 3 の Bet に CPU 1 が Call。CPU 10 は Fold。");
    expect(sanitizeText("CPU3 と Cpu1", names)).toBe("CPU 3 と CPU 1");
  });

  it("表示名と大文字小文字しか違わない playerId（hero → Hero）は置換しない", () => {
    expect(sanitizeText("hero is Hero", names)).toBe("hero is Hero");
  });

  it("別の語の一部は置換しない（xcpu3・cpu3x）", () => {
    expect(sanitizeText("xcpu3 cpu3x", names)).toBe("xcpu3 cpu3x");
  });

  it("boolean の項目は値ごとの言い回しにする（inAssumedRange=false など）", () => {
    expect(sanitizeText("inAssumedRange=false だった", names)).toBe(
      "実際の札は判断時点に仮定した Range に入っていなかった だった",
    );
    expect(sanitizeText("`inAssumedRange` は true", names)).toBe(
      "実際の札は判断時点に仮定した Range に入っていた",
    );
    expect(sanitizeText("allIn: true", names)).toBe("All-in している");
  });

  it("値が付いた項目は「説明 値」にし、値の無い項目名は説明だけにする", () => {
    expect(sanitizeText("potOdds=0.4 で effectiveStack が 98", names)).toBe(
      "Pot Odds 0.4 で 有効 Stack が 98",
    );
    expect(sanitizeText("activePlayerCount は人数", names)).toBe(
      "Fold していない人数 は人数",
    );
  });

  it("値の後ろの文末のピリオドは値に含めない（potOdds=0.4. → Pot Odds 0.4.）", () => {
    expect(sanitizeText("potOdds=0.4.", names)).toBe("Pot Odds 0.4.");
  });

  it("Evidence 内の位置（math.equity.method）と enum の値（monte_carlo）も置換する", () => {
    expect(sanitizeText("math.equity.method は monte_carlo", names)).toBe(
      "Equity の算出方法 は Monte Carlo",
    );
  });

  it("普通の英単語と同じ綴りの項目名は、値が付いたときだけ置換する（folded・trials・spr）", () => {
    expect(sanitizeText("CPU 1 folded。trials=20000 spr=3", names)).toBe(
      "CPU 1 folded。Equity の試行回数 20000 SPR 3",
    );
    expect(sanitizeText("folded=true", names)).toBe("Fold した");
  });

  it("知らない識別子は残す（置換の対応表に無いものを推測で作らない）", () => {
    expect(sanitizeText("unknownField=3 と cpu99", names)).toBe(
      "unknownField=3 と cpu99",
    );
  });

  it("置換の後は、既知の識別子が残らない", () => {
    const text =
      "cpu3 の betTree と inAssumedRange=false、math.equity.method が monte_carlo、potOdds=0.4、heroHoleCards。";
    expect(
      findIdentifiers(sanitizeText(text, names)).filter((i) => i !== "betTree"),
    ).toEqual([]);
  });
});

describe("findIdentifiers", () => {
  it.each<[string, string[]]>([
    ["cpu3 が Bet", ["cpu3"]],
    ["inAssumedRange=false", ["inAssumedRange"]],
    ["heads の monte_carlo", ["monte_carlo"]],
    ["math.equity.method を見る", ["math.equity.method"]],
    ["根拠は math:review-x/d3 です", ["math:review-x/d3"]],
    ["AJo は 3-bet、All-in、Pot Odds 0.4", []],
    ["CPU 3 の Bet に Hero が Call（BB 換算で 12BB）", []],
  ])("%s", (text, expected) => {
    const found = findIdentifiers(text);
    for (const e of expected) expect(found).toContain(e);
    if (expected.length === 0) expect(found).toEqual([]);
  });
});

describe("sanitizeOutput", () => {
  it("文だけを置換し、enum（assessment・basis）と根拠の id は触らない", () => {
    const out = sanitizeOutput(
      {
        assessment: "mixed_marginal",
        practical: "cpu3 の Bet",
        theory: { basis: "general_theory", text: "cpu1 が Call" },
        assumptions: ["cpu3 の Range"],
        evidenceIds: ["math:h/d3", "kb:1.0.0:x@1"],
      },
      names,
    );
    expect(out).toEqual({
      assessment: "mixed_marginal",
      practical: "CPU 3 の Bet",
      theory: { basis: "general_theory", text: "CPU 1 が Call" },
      assumptions: ["CPU 3 の Range"],
      evidenceIds: ["math:h/d3", "kb:1.0.0:x@1"],
    });
  });

  it("outputTexts は文だけを集める（enum・根拠の id を除く）", () => {
    expect(
      outputTexts({
        assessment: "mixed_marginal",
        practical: "a",
        theory: { basis: "general_theory", text: "b" },
        assumptions: ["c"],
        evidenceIds: ["math:x"],
      }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("evidenceGlossary", () => {
  it("Pass A の説明には Hand 後（Pass B）の項目を出さない。Pass B には両方出す", () => {
    const decision = evidenceGlossary("decision");
    const reveal = evidenceGlossary("reveal");
    expect(decision).toContain("- potOdds: Pot Odds");
    expect(decision).not.toContain("inAssumedRange");
    expect(decision).not.toContain("holeCards:");
    expect(reveal).toContain("- potOdds: Pot Odds");
    expect(reveal).toContain("- inAssumedRange:");
  });

  it("説明のある項目名は重複しない", () => {
    const all = EVIDENCE_TERMS.map((t) => t.name);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("playerNamesOf", () => {
  it("席の displayName から対応を作る（displayName が無い古い Evidence は空）", () => {
    const seat = (playerId: string, displayName?: string) => ({
      playerId,
      ...(displayName === undefined ? {} : { displayName }),
    });
    const context = (seats: unknown[]) =>
      ({ seats }) as unknown as DecisionContextEvidence;
    expect(
      playerNamesOf(context([seat("hero", "Hero"), seat("cpu1", "CPU 1")])),
    ).toEqual({ hero: "Hero", cpu1: "CPU 1" });
    expect(playerNamesOf(context([seat("cpu1")]))).toEqual({});
  });
});
