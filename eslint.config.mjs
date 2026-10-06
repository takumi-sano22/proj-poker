import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Engine が依存してはいけない先。D68（Engine は I/O・DB・LLM に依存しない純粋 TS）を lint でも補強する。
// tsconfig の `types: []` は型を拒否するだけで import は止めないため、ここで import 自体を拒否する。
const ENGINE_FORBIDDEN_IMPORTS = {
  paths: [
    {
      name: "fastify",
      message: "Engine は HTTP フレームワークに依存しない（D68）",
    },
    { name: "react", message: "Engine は UI に依存しない（D68）" },
    { name: "react-dom", message: "Engine は UI に依存しない（D68）" },
    {
      name: "better-sqlite3",
      message: "永続化は Runtime 側だけが扱う（D67・D68）",
    },
    { name: "sqlite3", message: "永続化は Runtime 側だけが扱う（D67・D68）" },
    { name: "sqlite", message: "永続化は Runtime 側だけが扱う（D67・D68）" },
    { name: "libsql", message: "永続化は Runtime 側だけが扱う（D67・D68）" },
    { name: "sql.js", message: "永続化は Runtime 側だけが扱う（D67・D68）" },
  ],
  patterns: [
    {
      group: ["fastify/*", "@fastify/*"],
      message: "Engine は HTTP フレームワークに依存しない（D68）",
    },
    {
      group: ["react/*", "react-dom/*"],
      message: "Engine は UI に依存しない（D68）",
    },
    {
      group: ["@anthropic-ai/*"],
      message:
        "LLM 呼び出しは Runtime 側だけが扱う。Engine は LLM に依存しない（D40・D67・D68）",
    },
    {
      group: ["@libsql/*"],
      message: "永続化は Runtime 側だけが扱う（D67・D68）",
    },
    {
      // node: 接頭辞あり・なしの両方で、I/O を伴う Node 組み込みモジュールを拒否する。
      regex:
        "^(node:)?(fs|net|http|https|http2|dgram|dns|tls|child_process|cluster|worker_threads|readline|stream|zlib|os|sqlite)(/.*)?$",
      message:
        "Engine は I/O を持たない（D68）。必要なら Runtime 側で扱い、Engine へは値で渡す",
    },
  ],
};

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "docs/**",
      ".claude/**",
      "apps/web/public/**",
      // Playwright（E2E）の結果（機械生成）
      "e2e/test-results/**",
      "e2e/playwright-report/**",
    ],
  },

  // 型情報ありの推奨ルール（no-floating-promises・no-misused-promises を含む）を全 TS に適用する。
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // 各パッケージの tsconfig.json を自動解決する。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 握りつぶされた Promise と、Promise を返す関数の誤った渡し方（Fastify handler・React event 等）を拒否する。
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // verbatimModuleSyntax と揃え、型だけの import を `import type` に統一する。
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  {
    files: ["packages/engine/**/*.ts"],
    rules: { "no-restricted-imports": ["error", ENGINE_FORBIDDEN_IMPORTS] },
  },

  // React の hooks ルールは Web にだけ当てる（server / engine には React が無い）。
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
