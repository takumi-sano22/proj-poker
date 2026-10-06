import { defineConfig } from "vitest/config";

// tsconfig の include（src）の外に置くため .mjs にする（型付き lint の対象から外す）。
//
// 1 テストの時間切れを既定の 5 秒から延ばす。Property テスト（fast-check）は 1 本で 1〜2 秒かかり、
// CI や他の処理と同時に走ると 5 秒を超えて「時間切れ」で落ちる。時間切れには seed も反例も出ないので、
// 一度きりの失敗として残ってしまう（#95）。通常は 2 秒以内に終わるので、延ばしても本当の無限ループの検出は遅れない。
// POKER_PROPERTY_RUNS_FACTOR（ケース数の倍率。src/testing/property.ts）で増やした分は、時間切れも同じ倍率で延ばす。
const factor = Math.max(1, Number(process.env.POKER_PROPERTY_RUNS_FACTOR) || 1);

export default defineConfig({
  test: { testTimeout: 30_000 * factor },
});
