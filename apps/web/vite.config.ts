import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Engine を build せずに src から読む（packages/engine の exports の条件。tsconfig の customConditions と同じ）。
    // 指定すると既定値を置き換えるので、既定の条件も並べ直す。ブラウザが使う Engine の値は Chip の額面と構成の関数
    // （表示用。ルールの判定ではない）だけで、ほかの Engine のコードはバンドルに入らない。
    conditions: ["@proj-poker/source", ...defaultClientConditions],
  },
  // Vitest（Node の SSR 解決）にも同じ条件を効かせる。指定すると既定値を置き換えるので既定の条件も並べ直す
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
  server: {
    host: "127.0.0.1",
    proxy: {
      // ブラウザからは同一 origin の /api だけを呼ぶ。Runtime のポートは apps/server の既定（3001）に合わせる。
      "/api": "http://127.0.0.1:3001",
    },
  },
});
