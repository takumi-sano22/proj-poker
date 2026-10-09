// Review の文から内部の識別子を消す処理（#96・D101）のテスト。
import { heroInformationSets, projectLearningReveal } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  BUBBLE_CALL,
  BUBBLE_SHOVE,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
  tournamentSessionOf,
} from "../testing/review-eval/hands.js";
import { SAMPLE_TABLE_TENDENCY } from "../testing/table-tendency-fixture.js";
import { buildReviewEvidence, reviewSpotReasons } from "./evidence.js";
import { buildRevealEvidence } from "./reveal-evidence.js";
import {
  EVIDENCE_TERMS,
  evidenceGlossary,
  findIdentifiers,
  outputTexts,
  replacementNamesOf,
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

  it("playerId=cpu3 のように項目名と playerId が並んでも、どちらも残さない（席 CPU 3）", () => {
    expect(
      sanitizeText("playerId=cpu3 の handId と decisionIndex", names),
    ).toBe("席 CPU 3 の Hand の ID と 判断の番号");
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

describe("対応表の網羅（Evidence の項目名・enum の値）", () => {
  /** Supported の Solver Evidence の形（録画の Eval は Solver 未導入なので、実際の Evidence に出ないキーをここで補う）。 */
  const solverSupported = {
    status: "supported",
    solver: { id: "x", version: "1", commit: "abc", pinnedCommit: true },
    scope: "heads_up",
    node: { street: "river", actor: "oop" },
    betTree: {
      betPotFractions: [0.5],
      raiseMultipliers: [3],
      allIn: true,
      raiseCap: 4,
    },
    heroHandClass: "AJo",
    heroHandClassStrategy: null,
    rangeAssumptions: { oop: { comboCount: 6 }, ip: { comboCount: 6 } },
  };
  const rulingRecord = {
    basis: "pending_out_of_turn",
    outcome: "out_of_turn",
    notes: ["out_of_turn_binding", "under_half_raise"],
  };

  it("Review AI へ渡す Evidence（Pass A・Pass B。固定 Hand の全判断）の camelCase の項目名と enum の値が、すべて対応表にある", async () => {
    const kb = loadKb();
    const solver = createAmaster97Adapter({
      install: { installed: false, detail: "テスト" },
      timeoutMs: 1,
      maxConcurrency: 1,
      iterations: 1,
    });
    const keys = new Set<string>();
    const values = new Set<string>();
    const names: Record<string, string> = {};
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(v)) values.add(v);
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (typeof v === "object" && v !== null) {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    // Tournament の Hand（#189。Shove・All-in への Call）の Evidence の項目名・値も網羅する。
    for (const hand of [
      BTN_VS_UTG,
      SB_VS_BTN,
      MULTIWAY_FLOP,
      BUBBLE_SHOVE,
      BUBBLE_CALL,
    ]) {
      const events = playScriptedHand(hand);
      const sets = heroInformationSets(events, "hero");
      const tournament = tournamentSessionOf(hand);
      const reveal = projectLearningReveal(events);
      for (const [i, set] of sets.entries()) {
        const reasons = reviewSpotReasons(sets, i, tournament);
        // 卓の傾向（D122・#153）がある Evidence の項目名・値も網羅する。
        const evidence = await buildReviewEvidence(set, reasons, {
          kb,
          solver,
          tableTendency: SAMPLE_TABLE_TENDENCY,
          ...(tournament === undefined ? {} : { tournament }),
        });
        Object.assign(names, replacementNamesOf(evidence));
        walk(evidence);
        if (reveal !== null) {
          walk(await buildRevealEvidence(set, reveal, events, reasons));
        }
      }
    }
    walk(solverSupported);
    walk(rulingRecord);
    const known = new Set(EVIDENCE_TERMS.map((t) => t.name));
    const camelKeys = [...keys].filter((k) => /[A-Z]/.test(k));
    expect(camelKeys.filter((k) => !known.has(k))).toEqual([]);
    // enum の値と KB の項目の id は、置換で別の語になる（残らない）こと。
    const left = [...values].filter((v) => sanitizeText(v, names) === v);
    expect(left).toEqual([]);
  }, 60_000);
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

  it("卓の傾向（D122・#153）の項目は、Pass A で卓の傾向があるときだけ出す（無い Prompt・Pass B は #153 より前と同じ）", () => {
    const decision = evidenceGlossary("decision");
    const withTendency = evidenceGlossary("decision", { tableTendency: true });
    for (const glossary of [decision, evidenceGlossary("reveal")]) {
      expect(glossary).not.toContain("- tableTendency:");
      expect(glossary).not.toContain("- sufficient:");
    }
    expect(withTendency).toContain("- tableTendency: 卓の傾向");
    expect(withTendency).toContain("- sufficient: サンプルが十分か");
    // 卓の傾向の項目を足しても、他の項目の説明はそのまま。
    const lines = withTendency.split("\n");
    for (const line of decision.split("\n")) expect(lines).toContain(line);
  });

  it("Tournament（#189）の項目は、Pass A で Tournament の Evidence があるときだけ出す（Cash の Prompt は #189 より前と同じ）", () => {
    const decision = evidenceGlossary("decision");
    const withTournament = evidenceGlossary("decision", { tournament: true });
    for (const glossary of [decision, evidenceGlossary("reveal")]) {
      expect(glossary).not.toContain("- icmEquity:");
      expect(glossary).not.toContain("- stage:");
    }
    expect(withTournament).toContain("- icmEquity: ICM Equity");
    expect(withTournament).toContain("- chipEv: Chip EV の必要 Equity");
    const lines = withTournament.split("\n");
    for (const line of decision.split("\n")) expect(lines).toContain(line);
  });

  it("Tournament の項目名・値は置換し、普通の英単語と同じ綴りの項目名は name=値 の形のときだけ置換する", () => {
    expect(
      sanitizeText(
        "stage=bubble で icmEquity が 116.2、in_the_money ではない",
        {},
      ),
    ).toBe(
      "トーナメントの段階 bubble で ICM Equity（賞金の期待値。pt） が 116.2、入賞圏 ではない",
    );
    expect(sanitizeText("the next level and ante", {})).toBe(
      "the next level and ante",
    );
    expect(sanitizeText("foldEquityIncluded=false", {})).toBe(
      "Fold Equity を含まない",
    );
  });

  it("卓の傾向の項目名・値は置換する（Review AI の文に残さない）", () => {
    expect(
      sanitizeText("aggression_frequency は sufficient=false で保留", {}),
    ).toBe(
      "Postflop の Aggression の頻度 は サンプルが足りない（保留） で保留",
    );
    expect(sanitizeText("tableTendency の rate: 0.3", {})).toBe(
      "卓の傾向 の 割合 0.3",
    );
  });

  it("説明のある項目名は重複しない", () => {
    const all = EVIDENCE_TERMS.map((t) => t.name);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("replacementNamesOf", () => {
  it("席の displayName と KB の項目のタイトルから対応を作る（displayName が無い古い Evidence は席の分が空）", () => {
    const seat = (playerId: string, displayName?: string) => ({
      playerId,
      ...(displayName === undefined ? {} : { displayName }),
    });
    const context = (seats: unknown[]) =>
      ({ seats }) as unknown as DecisionContextEvidence;
    expect(
      replacementNamesOf({
        context: context([seat("hero", "Hero"), seat("cpu1", "CPU 1")]),
        knowledge: { items: [{ kbId: "rake_effect", title: "Rake の影響" }] },
      }),
    ).toEqual({ hero: "Hero", cpu1: "CPU 1", rake_effect: "Rake の影響" });
    expect(replacementNamesOf({ context: context([seat("cpu1")]) })).toEqual(
      {},
    );
  });

  it("KB の項目の id はタイトルに置換する", () => {
    expect(
      sanitizeText("rake_effect を参照", { rake_effect: "Rake の影響" }),
    ).toBe("Rake の影響 を参照");
  });
});
