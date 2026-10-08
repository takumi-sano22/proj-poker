// 卓の配置の E2E（#163）: 720〜1023px の中間幅で、画面下に固定した Hero の欄が折り返して高くなり（720×600 で 434px）、卓の下側を
// 覆っていた。Hand の途中（Hero の手番）・Hand の終わり・Session の終わりを、画面の大きさ（720×600・1024×768・1280×720・375×667・320×568）ごとに
// 測り、席・Board・Pot・操作の欄・Session の終わりの Button に、操作できなくなる重なりが無いことを確かめる。
// 山札の seed は session-end-layout.spec.ts と同じ（既定の 6 人卓・Hero が Call / Check だけで打つと数 Hand で Bust する）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectClickable,
  expectNoBlockingOverlap,
  LAYOUT_VIEWPORTS,
} from "../support/layout.js";
import { startNextHand } from "../support/next-hand.js";
import {
  playToHandEnd,
  sessionEnded,
  startFirstHand,
} from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

const SEED = "20261042";

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-table-layout-"));
});

// Playwright は第 1 引数（fixture）を分割代入で受けることを求めるので、使わない fixture も {} で受ける。
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (server !== null) {
    // 失敗したら server のログを添付する（原因の手がかり）。
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("server.log", {
        body: server.output(),
        contentType: "text/plain",
      });
    }
    await stopServer(server);
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("Hand の途中（Hero の手番）・Hand の終わり・Session の終わりで、中間幅を含む画面の大きさごとに、卓と Hero 欄が操作できなくなる重なりを作らない", async ({
  page,
}) => {
  test.setTimeout(240_000);
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  const dock = page.getByRole("region", { name: "Hero" });

  // Hand は一覧の並びではなく、開始の応答の handId で特定する（#129・D117）。
  const handIds: string[] = [];
  await page.goto("/");
  handIds.push(await startFirstHand(page));
  await expect(dock.getByText("Hero の手番です。")).toBeVisible();

  await test.step("Hand の途中（Hero の手番）", async () => {
    for (const { width, height } of LAYOUT_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(dock.getByText("Hero の手番です。")).toBeVisible();
      await expectNoBlockingOverlap(page, `Hand の途中 ${width}×${height}`);
      // 宣言 Button が、通常の click（force なし）で押せる。確定は Chip を出すまで押せない（disabled）ので除く。
      await expectClickable(page, [
        "フォールド（Fold）",
        "チェック（Check）",
        "ベット（Bet）",
        "レイズ（Raise）",
        "オールイン（All-in）",
      ]);
    }
  });

  await test.step("Hand の終わり（Session は続く）", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await playToHandEnd(page);
    expect(await sessionEnded(page), "Session は続いている").toBe(false);
    for (const { width, height } of LAYOUT_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
      await expectNoBlockingOverlap(page, `Hand の終わり ${width}×${height}`);
      // 「次の Hand へ」は、広い画面は卓の中央・狭い画面は Hero 欄の結果の中にある。
      await page
        .getByRole("button", { name: "次の Hand へ" })
        .click({ trial: true });
    }
    handIds.push(await startNextHand(page));
  });

  await test.step("Hero が Bust して Session が終わるまで Play する（既定の 1280×720）", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    for (let i = 0; i < 30; i++) {
      await playToHandEnd(page);
      if (await sessionEnded(page)) break;
      handIds.push(await startNextHand(page));
    }
    expect(await sessionEnded(page), "Session が終わった").toBe(true);
    // 終わった Hand は、最後に始めた Hand（画面の結果はこの Hand のもの）。
    const res = await page.request.get("/api/replay/hands");
    const { hands } = (await res.json()) as {
      hands: { handId: string; complete: boolean }[];
    };
    expect(hands.find((h) => h.handId === handIds.at(-1))?.complete).toBe(true);
  });

  await test.step("Session の終わり", async () => {
    for (const { width, height } of LAYOUT_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(dock.getByText("Session が終了しました。")).toBeVisible();
      await expectNoBlockingOverlap(
        page,
        `Session の終わり ${width}×${height}`,
      );
      await expectClickable(page, [
        "この Session を振り返る",
        "新しい Session を始める",
      ]);
    }
  });
});
