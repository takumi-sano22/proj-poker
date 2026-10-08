// Opponent Memory の Eval の手動実行（#142・docs/09 §5）。RuleBot の決定論だけで回し、Claude も API キーも使わない。
// CI（memory-eval.test.ts）は向き・境界だけを判定し、ここでは分布と計算時間の値を表示する（値は作業ログに残す。#150 の材料）。
// 実行: pnpm --filter @proj-poker/server eval:opponent-memory [--hands 200,200] [--repeats 5]
//   --hands: Session ごとの Hand の数（カンマ区切り）。--repeats: 計算時間を測る繰り返し（中央値）。
import { parseArgs } from "node:util";
import { PERSONA_PRESET_IDS } from "../../opponents/persona.js";
import {
  LAYER_CONDITIONS,
  rateOf,
  runRuleBotSessions,
  spotDistribution,
  summarizeLayerCondition,
} from "./memory-eval.js";

const { values } = parseArgs({
  options: {
    hands: { type: "string", default: "200,200" },
    repeats: { type: "string", default: "5" },
  },
});
const handsPerSession = (values.hands ?? "").split(",").map(Number);
const repeats = Number(values.repeats);
if (handsPerSession.some((n) => !Number.isSafeInteger(n) || n < 1)) {
  throw new RangeError(
    `--hands は 1 以上の整数のカンマ区切り: ${values.hands}`,
  );
}
if (!Number.isSafeInteger(repeats) || repeats < 1) {
  throw new RangeError(`--repeats は 1 以上の整数: ${values.repeats}`);
}

// 1. 代表 Spot: Memory の有無と Subject の傾向で、River の Call と Flop の C-bet の割合がどう動くか。
console.log(
  "## Memory が効く代表 Spot（Persona ごとの割合。none / loose / tight）",
);
for (const [spotId, types] of [
  ["river_facing_big_bet", ["call"]],
  ["flop_cbet", ["bet"]],
] as const) {
  for (const personaId of PERSONA_PRESET_IDS) {
    const rate = (id: string) => {
      const c = LAYER_CONDITIONS.find((x) => x.id === id);
      if (c === undefined) throw new Error(id);
      return rateOf(
        spotDistribution(spotId, personaId, c).counts,
        types,
      ).toFixed(3);
    };
    console.log(
      `${spotId} ${types.join("/")} ${personaId}: ${rate("none")} / ${rate("memory_loose")} / ${rate("memory_tight")}`,
    );
  }
}

// 2. 層の条件ごとの Persona Differentiation・Action Diversity・攻撃性。
console.log(
  "\n## 層の条件ごとの分布（Persona Differentiation / Illegal / Check できるのに Fold）",
);
for (const c of LAYER_CONDITIONS) {
  const s = summarizeLayerCondition(c);
  console.log(
    `${c.id}: PD ${s.personaDifferentiation} / illegal ${s.illegal} / foldWhenCheck ${s.foldWhenCheck}`,
  );
  console.log(`  diversity ${JSON.stringify(s.actionDiversity)}`);
  console.log(`  aggression ${JSON.stringify(s.aggressionRate)}`);
}

// 3. 計算時間: 本番の Hand Orchestrator で Session を進め、Hand の開始時の 3 つの層の計算時間を保存済みの Hand の数ごとに出す。
console.log(
  `\n## Latency（Session ごとの Hand ${handsPerSession.join(" + ")}・中央値 ${repeats} 回。ミリ秒）`,
);
const started = performance.now();
const run = await runRuleBotSessions({
  handsPerSession,
  seedOfHand: (n) => 42_000 + n,
  timingRepeats: repeats,
});
console.log(
  `進めた Hand ${run.hands.length}・CPU の判断 ${run.decisions.length}・全体 ${Math.round(performance.now() - started)} ms`,
);
console.log("savedHands | sessionHands | memory | tilt | tableTendency");
const checkpoints = new Set([0, 10, 25, 50, 100, 150, 200, 300, 400, 600, 800]);
for (const h of run.hands) {
  if (!checkpoints.has(h.savedHands) && h !== run.hands.at(-1)) continue;
  const t = h.timings;
  console.log(
    `${h.savedHands} | ${h.sessionHands} | ${t.memoryMs.toFixed(2)} | ${t.tiltMs.toFixed(2)} | ${t.tableTendencyMs.toFixed(2)}`,
  );
}
