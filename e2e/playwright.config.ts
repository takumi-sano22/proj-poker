// 6-max Session の E2E（docs/09 §8・D98）。web（Vite の dev サーバー）は Playwright が起動し、server はテストが起動・再起動する
// （Resume を確かめるため。support/server.ts）。ブラウザは Chromium だけ（CI の所要時間を抑える）。
import { defineConfig, devices } from "@playwright/test";
import { E2E_SERVER_PORT, E2E_WEB_PORT } from "./support/server.js";

const CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "./tests",
  // 1 本の Session を順に通す（server とポート・DB を共有するので並列にしない）。
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // 卓の表示演出（#222・D140）の速度は、このブラウザの保存値を「超高速」にして始める。演出のタイマーの経路は通しつつ、
    // Hand を何十も進める spec を CI の時間内に収める（標準の速さの挙動は presentation.spec.ts が時計を止めて確かめる）。
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${E2E_WEB_PORT}`,
          localStorage: [
            { name: "proj-poker.display.presentationSpeed", value: "turbo" },
          ],
        },
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @proj-poker/web exec vite --port ${E2E_WEB_PORT} --strictPort`,
    url: `http://127.0.0.1:${E2E_WEB_PORT}`,
    // web の /api の proxy 先を E2E の server のポートにする（vite.config.ts は PORT を読む）。
    env: { PORT: String(E2E_SERVER_PORT) },
    // 別の proxy 先で動く手元の Vite を取り違えないよう、常に起動し直す。
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
