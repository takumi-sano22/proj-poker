// Presentation Controller（#222・D140・D143）の E2E。ブラウザの時計（page.clock）を止めて演出の途中を作り、次を確かめる:
// - 演出の途中は Hero の手番・Hand の結果を先に出さず、Skip で最新の公開状態に追いつく
// - Learn へ移って戻る・タブの再表示（visibilitychange）で、古い演出を捨てて最新に合わせる（画面の移動で開始を送らない）
// - 演出の途中の卓から操作しても送らず（POST を出さない）、表示を最新へ合わせて案内する（D143。古い lastSeq を送らない）
// - 演出なし・prefers-reduced-motion では待たずに最新を出す（内容は省かない）。速度の設定はこのブラウザに保存する
// - Replay の再生の速度は Live の演出の速度と別に持つ
// - 演出の速度・Skip の欄は、画面の大きさ（320×568〜1280×900）ごとに覆われずに操作できる
// CPU は RuleBot（既定）で Claude を呼ばない（D98）。server の CPU の待ちは 0（support/server.ts）なので、Hero の操作の応答に
// CPU の Action・Board・Showdown が一度に載る（演出のキューが必ずできる）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LAYOUT_VIEWPORTS } from "../support/layout.js";
import { countHandStarts, startFirstHand } from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

// table-layout.spec.ts と同じ山札（6 人卓・Hero が Call / Check だけで打つと数 Hand で Bust する）。
const SEED = "20261042";

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-presentation-"));
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

const dockOf = (page: Page) => page.getByRole("region", { name: "Hero" });
const skipOf = (page: Page) =>
  page.locator(".app__side").getByRole("button", { name: "Skip" });
const heroTurn = (page: Page) => dockOf(page).getByText("Hero の手番です。");
const handDone = (page: Page) =>
  dockOf(page).getByText(/Hand が終了しました。|Session が終了しました。/);

/** ブラウザの時計を止める（演出のタイマーが進まない）。 */
async function pauseClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 10);
}

/**
 * Hero の手番か Hand の終わりが出るまで待ってから、Hero の操作（Call / Check）か「次の Hand へ」で卓を進め、演出の待ち
 * （Skip）ができるまで繰り返す。時計は止めておく（呼ぶ前に pauseClock）。
 */
async function makePending(page: Page): Promise<void> {
  const dock = dockOf(page);
  for (let i = 0; i < 12; i++) {
    await expect(heroTurn(page).or(handDone(page))).toBeVisible({
      timeout: 30_000,
    });
    if (await handDone(page).isVisible()) {
      const next = page.getByRole("button", { name: "次の Hand へ" });
      if ((await next.count()) === 0) {
        throw new Error("Session が終わった（seed が変わった可能性）");
      }
      await next.first().click();
    } else {
      const call = dock.getByRole("button", { name: /^コール（Call）/ });
      if ((await call.locator(".declaration__amount").count()) > 0) {
        await call.click();
      } else {
        await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
      }
    }
    try {
      await expect(skipOf(page)).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      // 演出の待ちが無かった（Hero から始まる Hand など）。もう一度進める。
    }
  }
  throw new Error("演出の待ちを作れなかった");
}

test("演出の途中は結果を先に出さず、Skip・画面の復帰・タブの再表示で最新に追いつく。途中の卓から操作を送らない", async ({
  page,
}) => {
  test.setTimeout(240_000);
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  const starts = countHandStarts(page);
  let physicalPosts = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/physical-actions")
    ) {
      physicalPosts++;
    }
  });
  await page.clock.install();
  await page.goto("/");
  await startFirstHand(page);
  await expect(heroTurn(page)).toBeVisible({ timeout: 30_000 });
  await pauseClock(page);

  await test.step("演出の途中は Hero の手番を出さず、Skip で最新に追いつく", async () => {
    await makePending(page);
    await expect(heroTurn(page)).toHaveCount(0);
    await skipOf(page).click();
    await expect(heroTurn(page).or(handDone(page))).toBeVisible();
    await expect(skipOf(page)).toHaveCount(0);
  });

  await test.step("Learn へ移って戻ると、古い演出を捨てて最新から見せる（開始を送らない）", async () => {
    await makePending(page);
    const before = starts();
    const nav = page.getByRole("navigation", { name: "画面の切り替え" });
    await nav.getByRole("button", { name: "Learn" }).click();
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    await nav.getByRole("button", { name: "Play" }).click();
    await expect(heroTurn(page).or(handDone(page))).toBeVisible();
    await expect(skipOf(page)).toHaveCount(0);
    expect(starts(), "画面の移動で開始を送らない").toBe(before);
  });

  await test.step("タブを再表示（visibilitychange）すると最新に合わせる", async () => {
    await makePending(page);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(heroTurn(page).or(handDone(page))).toBeVisible();
    await expect(skipOf(page)).toHaveCount(0);
  });

  await test.step("演出の途中の卓から操作しても送らず、表示を最新に合わせて案内する（D143）", async () => {
    await makePending(page);
    const before = physicalPosts;
    // 手番外の操作（Out-of-Turn）も同じ規則。Fold の宣言は押した時点で Dealer に渡す操作。
    await dockOf(page)
      .getByRole("button", { name: /^フォールド（Fold）/ })
      .click();
    await expect(
      dockOf(page).getByText("操作はまだ送っていません", { exact: false }),
    ).toBeVisible();
    await expect(skipOf(page)).toHaveCount(0);
    await expect(heroTurn(page).or(handDone(page))).toBeVisible();
    expect(physicalPosts, "古い表示からは送らない").toBe(before);
  });
});

test("演出なし・reduced-motion は待たずに最新を出し、速度は保存する。Replay の速度は Live と別", async ({
  page,
}) => {
  test.setTimeout(240_000);
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  await page.clock.install();
  await page.goto("/");
  await startFirstHand(page);
  await expect(heroTurn(page)).toBeVisible({ timeout: 30_000 });
  const liveSpeed = page
    .locator(".app__side")
    .getByRole("combobox", { name: "演出の速度" });

  await test.step("演出なしを選ぶと、時計が止まっていても最新の卓をすぐ出し、設定を保存する", async () => {
    await liveSpeed.selectOption({ label: "演出なし" });
    await pauseClock(page);
    const dock = dockOf(page);
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    if ((await call.locator(".declaration__amount").count()) > 0) {
      await call.click();
    } else {
      await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    }
    await expect(heroTurn(page).or(handDone(page))).toBeVisible();
    await expect(skipOf(page)).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("proj-poker.display.presentationSpeed"),
      ),
    ).toBe("none");
  });

  await test.step("reduced-motion では、選んだ速度に関わらず演出なしで進めることを示す", async () => {
    await liveSpeed.selectOption({ label: "標準" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(
      page.getByText("OS の設定で動きを減らしているため", { exact: false }),
    ).toBeVisible();
    await makePendingOrSynced(page);
    await expect(skipOf(page)).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.resume();
  });

  await test.step("Replay の再生の速度を変えても、Live の演出の速度は変わらない", async () => {
    await liveSpeed.selectOption({ label: "高速" });
    const nav = page.getByRole("navigation", { name: "画面の切り替え" });
    await nav.getByRole("button", { name: "Learn" }).click();
    await page.getByRole("button", { name: "Replay を開く" }).click();
    await page.locator(".replay-item").first().click();
    const replaySpeed = page.getByRole("combobox", { name: "再生の速度" });
    await expect(replaySpeed).toHaveValue("standard");
    await replaySpeed.selectOption({ label: "超高速" });
    await nav.getByRole("button", { name: "Play" }).click();
    await expect(liveSpeed).toHaveValue("fast");
  });

  await test.step("再読み込みの後も、保存した速度を使う", async () => {
    await page.reload();
    await startFirstHand(page, "続きから遊ぶ");
    await expect(liveSpeed).toHaveValue("fast");
  });
});

/** reduced-motion の間に卓を進め、演出の待ちを作らずに最新が出ることを確かめる。 */
async function makePendingOrSynced(page: Page): Promise<void> {
  const dock = dockOf(page);
  await expect(heroTurn(page).or(handDone(page))).toBeVisible({
    timeout: 30_000,
  });
  if (await handDone(page).isVisible()) {
    const next = page.getByRole("button", { name: "次の Hand へ" });
    if ((await next.count()) > 0) await next.first().click();
  } else {
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    if ((await call.locator(".declaration__amount").count()) > 0) {
      await call.click();
    } else {
      await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    }
  }
  await expect(heroTurn(page).or(handDone(page))).toBeVisible();
}

test("演出の速度・Skip の欄は、画面の大きさごとに覆われずに操作できる", async ({
  page,
}) => {
  test.setTimeout(180_000);
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  await page.clock.install();
  await page.goto("/");
  await startFirstHand(page);
  await expect(heroTurn(page)).toBeVisible({ timeout: 30_000 });
  await pauseClock(page);
  await makePending(page);
  for (const { width, height } of [
    ...LAYOUT_VIEWPORTS,
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize({ width, height });
    const side = page.locator(".app__side");
    // 通常の click（force なし）で押せる（Hero 欄・見出しに覆われていない。trial は押さずに確かめるだけ）。
    await side
      .getByRole("combobox", { name: "演出の速度" })
      .click({ trial: true });
    await skipOf(page).click({ trial: true });
  }
  await skipOf(page).click();
  await expect(skipOf(page)).toHaveCount(0);
});
