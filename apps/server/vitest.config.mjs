import { defineConfig } from "vitest/config";

// tsconfig の include（src）の外に置くため .mjs にする（型付き lint の対象から外す）。

// Engine を build せずに src から読む（packages/engine の exports の条件。tsconfig の customConditions と同じ）。
// Vitest の Node 実行は SSR の解決を使うため ssr 側に置く。指定すると既定値を置き換えるので、既定の条件も並べ直す。
export default defineConfig({
  ssr: {
    resolve: {
      conditions: [
        "@proj-poker/source",
        "module",
        "node",
        "development|production",
      ],
    },
  },
});
