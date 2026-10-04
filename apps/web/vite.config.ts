import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      // ブラウザからは同一 origin の /api だけを呼ぶ。Runtime のポートは apps/server の既定（3001）に合わせる。
      "/api": "http://127.0.0.1:3001",
    },
  },
});
