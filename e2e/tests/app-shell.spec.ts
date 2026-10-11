// App Shell（Home / Play / Learn。#218・D136・D144）の E2E:
// - 起動（Cold Start・再読み込み）は必ず Home。Home は GET /api/session/current を読むだけで、POST /api/hands を送らない
// - 開始は Hero の明示の操作（「新しい Session を始める」「続きから遊ぶ」）だけ。連打しても開始の要求は 1 回
// - 画面の往復（Home / Play / Learn・Learn の画面・戻る）では開始を送らず、卓は同じ Hand のまま
// - 「続きから遊ぶ」は既存の冪等な開始: Hand の途中の再読み込みは同じ Hand へ、Hand の終わりの直後の再読み込みは結果を見ていない
//   その Hand へ戻り（次の Hand を作らない）、「次の Hand へ」を押して初めて次の Hand
// - Learn の画面は戻り先と閲覧位置（開いていた判断）を覚える
// - 照会の通信エラー・知らない state では開始の Button を出さない
// - 画面の大きさ（320×568〜1280×900）とタッチ・キーボードで、ナビゲーションが卓・Hero 欄を覆わず操作できる
// CPU は RuleBot（既定）で Claude を呼ばない（D98）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { intersects, type Rect } from "../support/layout.js";
import { startNextHand } from "../support/next-hand.js";
import {
  countHandStarts,
  playToHandEnd,
  startFirstHand,
} from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-"));
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (server !== null) {
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

function nav(page: Page) {
  return page.getByRole("navigation", { name: "画面の切り替え" });
}

/** 上部のナビゲーションで領域を選び、その領域が今の領域（aria-current）になるのを待つ。 */
async function goTo(page: Page, area: "Home" | "Play" | "Learn") {
  const tab = nav(page).getByRole("button", { name: area });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

/** 保存済みの Hand の数（進行中の Hand を含む）。画面の移動で Hand が作られていないことを確かめる。 */
async function handCount(page: Page): Promise<number> {
  const res = await page.request.get("/api/replay/hands");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { hands: unknown[] }).hands.length;
}

test("Cold Start は Home。画面の往復・連打・再読み込みで、開始は Hero の操作だけ・冪等な続きになる", async ({
  page,
}) => {
  test.setTimeout(180_000);
  server = await startServer(join(dir, "poker.sqlite"));
  const starts = countHandStarts(page);
  let lookups = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/session/current") lookups++;
  });
  const dock = page.getByRole("region", { name: "Hero" });
  const home = page.getByRole("region", { name: "Session" });

  await test.step("Cold Start: Home を出し、照会だけを使う（開始を送らない）", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(
      nav(page).getByRole("button", { name: "Home" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(home).toContainText("続けられる Session はありません");
    await expect(
      home.getByRole("button", { name: "新しい Session を始める" }),
    ).toBeVisible();
    await expect(
      home.getByRole("button", { name: "続きから遊ぶ" }),
    ).toHaveCount(0);
    expect(lookups, "Home は照会を読む").toBeGreaterThan(0);
    expect(starts(), "Home の表示で開始を送らない").toBe(0);
  });

  await test.step("まだ卓が無い間の Play・Learn は、開始を送らず Home へ誘導する", async () => {
    await goTo(page, "Play");
    await expect(page.getByText("まだ卓に着いていません。")).toBeVisible();
    await goTo(page, "Learn");
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    // 開けない入口は Button を出さず理由を出す（偽の入口を作らない）。
    await expect(
      page.getByRole("button", { name: "Session Review を開く" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Replay を開く" }).click();
    await expect(page.locator(".replay-item")).toHaveCount(0);
    await page.getByRole("button", { name: "Learn の一覧へ" }).click();
    await goTo(page, "Play");
    await page.getByRole("button", { name: "Home へ" }).click();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    expect(starts(), "画面の移動で開始を送らない").toBe(0);
    expect(await handCount(page)).toBe(0);
  });

  let firstHandId = "";
  await test.step("連打: 「新しい Session を始める」を続けて押しても、開始の要求は 1 回", async () => {
    const button = home.getByRole("button", {
      name: "新しい Session を始める",
    });
    await expect(button).toBeEnabled();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands",
    );
    // 同じ tick で 2 回押す（描画の更新より前の 2 回目を、二重送信の止め方が止める）。
    await button.evaluate((el: HTMLElement) => {
      el.click();
      el.click();
    });
    firstHandId = ((await (await response).json()) as { handId: string })
      .handId;
    await expect(dock.getByText("Hero の手番です。")).toBeVisible({
      timeout: 30_000,
    });
    expect(starts(), "開始の要求は 1 回").toBe(1);
    expect(await handCount(page)).toBe(1);
  });

  await test.step("Hand の途中の画面の往復: Learn・Home へ移っても Hand を作らず、卓は同じ Hand のまま", async () => {
    await goTo(page, "Learn");
    await goTo(page, "Home");
    await expect(home).toContainText("Hand の途中です");
    await expect(
      home.getByRole("button", { name: "新しい Session を始める" }),
    ).toHaveCount(0);
    // この画面で続けている Session は、「続きから遊ぶ」で卓へ移るだけ（開始を送らない）。
    await home.getByRole("button", { name: "続きから遊ぶ" }).click();
    await expect(dock.getByText("Hero の手番です。")).toBeVisible();
    expect(starts(), "画面の往復で開始を送らない").toBe(1);
    expect(await handCount(page)).toBe(1);
  });

  await test.step("Hand の途中で再読み込み: Home から「続きから遊ぶ」で同じ Hand に戻る", async () => {
    await page.reload();
    await expect(home).toContainText("Hand の途中です");
    expect(starts(), "再読み込みの Home は開始を送らない").toBe(1);
    const resumed = await startFirstHand(page, "続きから遊ぶ");
    expect(resumed, "進行中の Hand に戻る（新しく作らない）").toBe(firstHandId);
    await expect(dock.getByText("Hero の手番です。")).toBeVisible();
    expect(await handCount(page)).toBe(1);
  });

  await test.step("Hand の終わりの直後に再読み込み: 結果を見ていない同じ Hand に戻り、次の Hand は作らない", async () => {
    await playToHandEnd(page);
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    await page.reload();
    await expect(home).toContainText("Hand の合間");
    const again = await startFirstHand(page, "続きから遊ぶ");
    expect(again, "結果を見ていない Hand").toBe(firstHandId);
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "次の Hand へ" }),
    ).toBeVisible();
    expect(await handCount(page)).toBe(1);
  });

  await test.step("Learn の戻り先と閲覧位置: Review で開いた判断を、Play を挟んで Learn に戻っても覚えている", async () => {
    const before = starts();
    await goTo(page, "Learn");
    await page
      .getByRole("button", { name: "直前の Hand の Review を開く" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Hand Review" }),
    ).toBeVisible();
    await page.locator(".spot-row").first().click();
    const backToList = page.getByRole("button", { name: "判断の一覧へ" });
    await expect(backToList).toBeVisible();
    await goTo(page, "Play");
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    await goTo(page, "Learn");
    await expect(backToList).toBeVisible();
    // 一覧から開いた画面の戻り先は Learn の一覧。Learn を押し直しても一覧。
    await goTo(page, "Learn");
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    // 卓から開いた Review の戻り先は卓。
    await goTo(page, "Play");
    await dock.getByRole("button", { name: "この Hand の Review" }).click();
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    expect(starts(), "Learn の移動で開始を送らない").toBe(before);
    expect(await handCount(page)).toBe(1);
  });

  await test.step("「次の Hand へ」を押して初めて次の Hand", async () => {
    const next = await startNextHand(page);
    expect(next).not.toBe(firstHandId);
    expect(await handCount(page)).toBe(2);
  });
});

test("照会の通信エラー・知らない state では、開始の Button を出さない", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"));
  const starts = countHandStarts(page);
  const home = page.getByRole("region", { name: "Session" });

  await test.step("通信エラー: 案内と読み直しだけ。読み直すと照会の結果を出す", async () => {
    await page.route("**/api/session/current", (route) => route.abort());
    await page.goto("/");
    await expect(home).toContainText("Session の状態を読めませんでした");
    await expect(home.getByRole("button")).toHaveText(["もう一度読み込む"]);
    await page.unroute("**/api/session/current");
    await home.getByRole("button", { name: "もう一度読み込む" }).click();
    await expect(
      home.getByRole("button", { name: "新しい Session を始める" }),
    ).toBeVisible();
  });

  await test.step("知らない state（#230 の paused 等）: 続きも新しい Session も出さない", async () => {
    await page.route("**/api/session/current", (route) =>
      route.fulfill({
        json: { session: { state: "paused", kind: { mode: "cash" } } },
      }),
    );
    await page.reload();
    await expect(home).toContainText("この画面では確かめられませんでした");
    await expect(home.getByRole("button")).toHaveText(["もう一度読み込む"]);
    await page.unroute("**/api/session/current");
  });
  expect(starts(), "開始を送らない").toBe(0);
});

/** 画面の大きさ（Issue #218 の DoD）。 */
const SHELL_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 720, height: 600 },
  { width: 1280, height: 720 },
  { width: 1280, height: 900 },
] as const;

interface ShellMeasure {
  readonly overflowX: number;
  readonly nav: Rect;
  /** 見出しの右（卓の情報・表示設定）。 */
  readonly headerEnd: Rect;
  readonly table: Rect | null;
  /** 卓の席（上の席は卓の枠の上へはみ出す）。 */
  readonly seats: Rect[];
  readonly dock: Rect | null;
  /** ナビの Button の中心を受ける要素（Button 自身なら "ok"、違えばその要素の class。失敗の手がかり）。 */
  readonly tabsReachable: string[];
}

/** ページの一番上で、ナビ・卓・Hero 欄の矩形と、ナビの Button の hit-test を測る。 */
async function measureShell(page: Page): Promise<ShellMeasure> {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate(() => {
    const rectOf = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const navEl = document.querySelector(".shell-nav");
    if (navEl === null) throw new Error("ナビゲーションが無い");
    const tabsReachable = [...navEl.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(
        (r.left + r.right) / 2,
        (r.top + r.bottom) / 2,
      );
      if (hit === null) return "null";
      return b.contains(hit) ? "ok" : `${hit.tagName}.${hit.className}`;
    });
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      nav: rectOf(navEl) as Rect,
      headerEnd: rectOf(document.querySelector(".app__header-end")) as Rect,
      table: rectOf(document.querySelector(".table")),
      seats: [...document.querySelectorAll(".table .seat")].map(
        (e) => rectOf(e) as Rect,
      ),
      dock: rectOf(document.querySelector(".dock")),
      tabsReachable,
    };
  });
}

test("画面の大きさごとに、ナビゲーションが卓・Hero 欄を覆わず、キーボードで移れる", async ({
  page,
}) => {
  test.setTimeout(120_000);
  server = await startServer(join(dir, "poker.sqlite"));
  const starts = countHandStarts(page);
  const dock = page.getByRole("region", { name: "Hero" });
  await page.goto("/");

  await test.step("Home と Learn の一覧: 横スクロールが無く、開始の Button を押せる", async () => {
    for (const { width, height } of SHELL_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await goTo(page, "Home");
      const m = await measureShell(page);
      expect(m.overflowX, `Home の横スクロール ${width}×${height}`).toBe(0);
      expect(m.tabsReachable, `ナビの hit-test ${width}×${height}`).toEqual([
        "ok",
        "ok",
        "ok",
      ]);
      await page
        .getByRole("button", { name: "新しい Session を始める" })
        .click({ trial: true });
      await goTo(page, "Learn");
      expect(
        (await measureShell(page)).overflowX,
        `Learn の横スクロール ${width}×${height}`,
      ).toBe(0);
      await page
        .getByRole("button", { name: "Replay を開く" })
        .click({ trial: true });
    }
    expect(starts()).toBe(0);
  });

  await test.step("キーボード: Tab でナビへ移り、Enter で領域を切り替える。Home の開始も Enter で押せる", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const homeTab = nav(page).getByRole("button", { name: "Home" });
    await homeTab.focus();
    await page.keyboard.press("Enter");
    await expect(homeTab).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Tab");
    const playTab = nav(page).getByRole("button", { name: "Play" });
    await expect(playTab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(playTab).toHaveAttribute("aria-current", "page");
    await homeTab.focus();
    await page.keyboard.press("Enter");
    const start = page.getByRole("button", { name: "新しい Session を始める" });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(dock.getByText("Hero の手番です。")).toBeVisible({
      timeout: 30_000,
    });
    expect(starts()).toBe(1);
  });

  await test.step("Play（Hand の途中）: ナビが卓・Hero 欄と重ならず、ナビの Button を覆う要素が無い", async () => {
    for (const { width, height } of SHELL_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(dock.getByText("Hero の手番です。")).toBeVisible();
      const m = await measureShell(page);
      expect(m.overflowX, `横スクロール ${width}×${height}`).toBe(0);
      expect(m.table, "卓").not.toBeNull();
      expect(m.dock, "Hero 欄").not.toBeNull();
      expect(
        intersects(m.nav, m.table as Rect),
        `ナビと卓 ${width}×${height}`,
      ).toBe(false);
      expect(
        intersects(m.nav, m.dock as Rect),
        `ナビと Hero 欄 ${width}×${height}`,
      ).toBe(false);
      // 上の席（札を含む）は卓の枠の上へはみ出すので、見出しのナビ・表示設定と重ならないことを席ごとに測る。
      for (const seat of m.seats) {
        expect(
          intersects(seat, m.nav) || intersects(seat, m.headerEnd),
          `席と見出し ${width}×${height}: ${JSON.stringify(seat)}`,
        ).toBe(false);
      }
      expect(m.tabsReachable, `ナビの hit-test ${width}×${height}`).toEqual([
        "ok",
        "ok",
        "ok",
      ]);
      // 往復しても卓は同じ Hand のまま（開始を送らない）。
      await goTo(page, "Learn");
      await goTo(page, "Play");
    }
    expect(starts(), "画面の大きさを変えた往復で開始を送らない").toBe(1);
  });
});

test.describe("タッチ（375×667）", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });

  test("タップで Home から始め、Learn と Play を往復できる", async ({
    page,
  }) => {
    server = await startServer(join(dir, "poker.sqlite"));
    const starts = countHandStarts(page);
    const dock = page.getByRole("region", { name: "Hero" });
    await page.goto("/");
    await page.getByRole("button", { name: "新しい Session を始める" }).tap();
    await expect(dock.getByText("Hero の手番です。")).toBeVisible({
      timeout: 30_000,
    });
    await nav(page).getByRole("button", { name: "Learn" }).tap();
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    await nav(page).getByRole("button", { name: "Play" }).tap();
    await expect(dock.getByText("Hero の手番です。")).toBeVisible();
    expect(starts()).toBe(1);
  });
});
