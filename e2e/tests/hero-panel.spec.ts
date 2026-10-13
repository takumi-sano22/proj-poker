// UX-05（#220・D137・D138）の E2E: 狭い画面の Hero の操作パネルの折りたたみ（手番で自動で開く・手動で開閉・開いた高さの上限・内部の
// スクロール）と、操作用の Chip の大きさ・Betting Area の判定領域・Chip の移動の演出を確かめる。下書き（#219・D146）・再確認・
// ETIQUETTE の Ack（#226・D145・D147）と干渉しないこと（閉じても下書きを失わない・開閉を Ack や送信にしない）も確かめる。
// CPU の障害（Outage）は E2E で起こせないので扱わない（障害のダイアログの間は折りたたみを出さないことは lib/hero-panel.test.ts）。
// 表示の数値（Chip の大きさ・高さの上限）は OI-012 の暫定値で、ここでは D138 / D137 の目安の幅で測る。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ackButton,
  countRequests,
  etiquetteOverlay,
  isEtiquetteAck,
} from "../support/etiquette.js";
import {
  expectNoBlockingOverlap,
  intersects,
  type Rect,
} from "../support/layout.js";
import { startNextHand } from "../support/next-hand.js";
import { startFirstHand } from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";
import {
  callAndWaitForCpu,
  changeNotice,
  confirmButton,
  declarationButton,
  discardNotice,
  dockOf,
  goTo,
  handAmount,
  huEnv,
  pick,
  pickAndPush,
  pushedAmount,
  RAISE_SEED,
  recordPhysicalActions,
  submitButton,
  waitForPhysicalResponse,
} from "../support/turn-draft.js";

/** #220 で測る画面の大きさ（スマホ 2・中間幅 1・PC 2）。 */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 720, height: 600 },
  { width: 1280, height: 720 },
  { width: 1280, height: 900 },
] as const;

/** 開いた Hero の操作パネルの高さの上限（画面の高さに対する比。D137 の 65〜70% の上端）。 */
const MAX_PANEL_RATIO = 0.7;

/** スクリーンショットとレイアウトの実測値の置き場（CI の playwright-report とは別に、PR に記録する値を書き出す）。 */
const OUT_DIR = join(process.cwd(), "test-results", "hero-panel");

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-hero-panel-"));
});

// Playwright は第 1 引数（fixture）を分割代入で受けることを求めるので、使わない fixture も {} で受ける。
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

function toggleOf(page: Page): Locator {
  return dockOf(page).locator(".dock__toggle");
}

function chipControls(page: Page): Locator {
  return dockOf(page).locator(".chip-controls");
}

/** Hero の手番になるまで進める（手番が来ないまま Hand が終わったら次の Hand を始める）。 */
async function untilHeroTurn(page: Page): Promise<void> {
  const dock = dockOf(page);
  const turn = dock.getByText("Hero の手番です。");
  const done = dock.getByText("Hand が終了しました。");
  for (let i = 0; i < 10; i++) {
    await expect(turn.or(done)).toBeVisible({ timeout: 30_000 });
    if (await turn.isVisible()) return;
    await startNextHand(page);
  }
  throw new Error("Hero の手番が来ない");
}

/** タッチで from の中心から to の中心まで Drag する（CDP の touch の Event。Pointer Events の touch になる）。 */
async function touchDrag(
  page: Page,
  from: Locator,
  to: Locator,
): Promise<boolean> {
  // 操作の欄は局面ごと（operationKey）に作り直すので、作り直しの瞬間は矩形が無い。そのときは Drag しない（false）
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) return false;
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  const sx = a.x + a.width / 2;
  const sy = a.y + a.height / 2;
  const tx = b.x + b.width / 2;
  const ty = b.y + b.height / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(sx, sy),
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  return true;
}

/** マウスで from の中心から to の中心まで Drag する。 */
async function mouseDrag(
  page: Page,
  from: Locator,
  to: Locator,
): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error("矩形が無い");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

/** Hero 欄の Chip の操作の矩形と実測値。 */
interface PanelMeasure {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly overflowX: number;
  readonly dockHeight: number;
  readonly dockScrollHeight: number;
  readonly dockClientHeight: number;
  readonly opChip: { readonly width: number; readonly height: number } | null;
  readonly opChipHit: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly tableChip: number | null;
  readonly area: Rect | null;
  readonly felt: Rect | null;
  readonly neighbours: { readonly name: string; readonly rect: Rect }[];
  readonly areaHit: boolean;
}

async function measurePanel(page: Page): Promise<PanelMeasure> {
  return page.evaluate(() => {
    const rectOf = (el: Element | null): Rect | null => {
      if (el === null || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const dock = document.querySelector(".dock") as HTMLElement;
    const token = document.querySelector(".chip-tray .chip-token");
    const button = document.querySelector(".chip-tray .chip-button");
    const tableChip = document.querySelector(".table .chip");
    const areaEl = document.querySelector(".betting-area");
    // Betting Area の中心を、Betting Area の Button 自身が受けるか（隣の操作に覆われていないか）。画面の中へ入れてから測る。
    areaEl?.scrollIntoView({ block: "nearest" });
    const area = rectOf(areaEl);
    const hit =
      area === null
        ? null
        : document.elementFromPoint(
            (area.left + area.right) / 2,
            (area.top + area.bottom) / 2,
          );
    const target = document.querySelector(".betting-area__target");
    const neighbours = [
      ["Stack の Chip", ".chip-tray"],
      ["手元", ".chip-hand"],
      ["確定", ".chip-controls__submit"],
      ["宣言", ".declarations"],
    ].flatMap(([name, sel]) => {
      const rect = rectOf(document.querySelector(sel as string));
      return rect === null ? [] : [{ name: name as string, rect }];
    });
    const size = (el: Element | null) => {
      const r = rectOf(el);
      return r === null
        ? null
        : { width: r.right - r.left, height: r.bottom - r.top };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      dockHeight: dock.getBoundingClientRect().height,
      dockScrollHeight: dock.scrollHeight,
      dockClientHeight: dock.clientHeight,
      opChip: size(token),
      opChipHit: size(button),
      tableChip: size(tableChip)?.width ?? null,
      area,
      felt: rectOf(document.querySelector(".betting-area__felt")),
      neighbours,
      areaHit: hit !== null && target !== null && target.contains(hit),
    };
  });
}

/** Betting Area の判定領域が隣の操作と重ならず、中心を Betting Area 自身が受け、操作用の Chip が D138 の目安の大きさか。 */
function expectChipLayout(m: PanelMeasure, label: string): void {
  expect(m.overflowX, `${label}: 横スクロール`).toBe(0);
  expect(m.opChip, `${label}: 操作用の Chip`).not.toBeNull();
  const chip = m.opChip?.width ?? 0;
  // PC（1024px 以上）は約 54px、1023px 以下（スマホ・中間幅）は約 48px（D138: スマホ 48〜52px）
  if (m.viewport.width >= 1024) {
    expect(chip, `${label}: PC の操作用 Chip ${chip}px`).toBeGreaterThanOrEqual(
      52,
    );
    expect(chip, `${label}: PC の操作用 Chip ${chip}px`).toBeLessThanOrEqual(
      56,
    );
  } else {
    expect(chip, `${label}: 操作用 Chip ${chip}px`).toBeGreaterThanOrEqual(48);
    expect(chip, `${label}: 操作用 Chip ${chip}px`).toBeLessThanOrEqual(52);
  }
  expect(m.area, `${label}: Betting Area`).not.toBeNull();
  if (m.area === null) return;
  for (const n of m.neighbours) {
    expect(
      intersects(m.area, n.rect),
      `${label}: Betting Area の判定領域と${n.name}が重なっている: ${JSON.stringify(m.area)} / ${JSON.stringify(n.rect)}`,
    ).toBe(false);
  }
  expect(m.areaHit, `${label}: Betting Area の中心が覆われている`).toBe(true);
  // 見た目のフェルトは判定領域の内側（判定領域より大きくしない）
  if (m.felt !== null) {
    expect(m.felt.right - m.felt.left).toBeLessThanOrEqual(
      m.area.right - m.area.left + 0.5,
    );
  }
}

/** 狭い画面: 開いたパネルの高さが上限以下で、収まらない分は欄の中でスクロールでき、一番下の宣言 Button も押せる。 */
async function expectPanelCap(
  page: Page,
  m: PanelMeasure,
  label: string,
): Promise<void> {
  const ratio = m.dockHeight / m.viewport.height;
  expect(
    ratio,
    `${label}: 開いたパネルの高さ ${Math.round(m.dockHeight)}px（${(ratio * 100).toFixed(1)}%）`,
  ).toBeLessThanOrEqual(MAX_PANEL_RATIO + 0.005);
  if (m.dockScrollHeight > m.dockClientHeight + 1) {
    // 欄の中のスクロール: 一番下（宣言 Button）までスクロールでき、通常の click で押せる
    await dockOf(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await declarationButton(page, /^オールイン（All-in）/).click({
      trial: true,
    });
    await dockOf(page).evaluate((el) => {
      el.scrollTop = 0;
    });
  }
}

test("2〜8 人卓 × 5 つの画面の大きさで、操作用 Chip の大きさ・Betting Area の判定領域・パネルの開閉と高さの上限を測る", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  mkdirSync(OUT_DIR, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  for (const seats of [2, 3, 4, 5, 6, 7, 8]) {
    await test.step(`${seats} 人卓`, async () => {
      server = await startServer(join(dir, `poker-${seats}.sqlite`), {
        TABLE_SIZE: String(seats),
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/");
      await startFirstHand(page);
      await untilHeroTurn(page);
      for (const { width, height } of VIEWPORTS) {
        const label = `${seats} 人卓 ${width}×${height}`;
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
        const narrow = width < 720;
        if (!narrow) {
          // 広い画面・中間幅は折りたたまない（D137 はスマホの操作パネル）
          await expect(toggleOf(page)).toHaveCount(0);
        } else {
          // 手番なので開いている（画面の大きさを変えても同じ手番なので、閉じた状態に変わらない）
          await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
        }
        await expect(chipControls(page)).toBeVisible();
        const open = await measurePanel(page);
        expectChipLayout(open, label);
        // 8 人卓の 720×600 は、main でも左側の席の面が約 1px 重なる（#220 と無関係の既存の配置。#252 で直す）ので、卓の矩形の
        // 交差だけを除き、Hero 欄の Button の hit-test・横スクロール・高さは測る
        await expectNoBlockingOverlap(page, label, {
          skipTableOverlap: seats === 8 && width === 720,
        });
        if (narrow) await expectPanelCap(page, open, label);
        const shot = join(OUT_DIR, `${seats}p-${width}x${height}-open.png`);
        if (seats === 2 || seats === 6 || seats === 8) {
          await page.screenshot({ path: shot });
          await testInfo.attach(`${label} 開`, {
            path: shot,
            contentType: "image/png",
          });
        }
        let closedHeight: number | null = null;
        if (narrow) {
          await toggleOf(page).click();
          await expect(toggleOf(page)).toHaveAttribute(
            "aria-expanded",
            "false",
          );
          await expect(chipControls(page)).toBeHidden();
          const closed = await measurePanel(page);
          closedHeight = closed.dockHeight;
          expect(closed.overflowX, `${label}: 閉じた後の横スクロール`).toBe(0);
          await expectNoBlockingOverlap(page, `${label}（閉）`);
          if (seats === 2 || seats === 6 || seats === 8) {
            const closedShot = join(
              OUT_DIR,
              `${seats}p-${width}x${height}-closed.png`,
            );
            await page.screenshot({ path: closedShot });
            await testInfo.attach(`${label} 閉`, {
              path: closedShot,
              contentType: "image/png",
            });
          }
          await toggleOf(page).click();
          await expect(chipControls(page)).toBeVisible();
        }
        rows.push({
          seats,
          viewport: `${width}x${height}`,
          opChipPx: open.opChip?.width,
          opChipHitPx: open.opChipHit?.width,
          tableChipPx: open.tableChip,
          openDockPx: Math.round(open.dockHeight),
          openRatio: Number((open.dockHeight / height).toFixed(3)),
          innerScroll: open.dockScrollHeight > open.dockClientHeight + 1,
          closedDockPx: closedHeight === null ? null : Math.round(closedHeight),
          closedRatio:
            closedHeight === null
              ? null
              : Number((closedHeight / height).toFixed(3)),
          areaPx:
            open.area === null
              ? null
              : `${Math.round(open.area.right - open.area.left)}x${Math.round(open.area.bottom - open.area.top)}`,
          feltPx:
            open.felt === null
              ? null
              : `${Math.round(open.felt.right - open.felt.left)}x${Math.round(open.felt.bottom - open.felt.top)}`,
        });
      }
      if (seats === 6) {
        // 広い画面のマウスの Drag: Stack の Chip を Betting Area へ直接出す（送らない）
        await mouseDrag(
          page,
          dockOf(page).getByRole("button", {
            name: "1 の Chip を手に取る",
            exact: true,
          }),
          dockOf(page).locator(".betting-area"),
        );
        await expect(pushedAmount(page)).toHaveText("1");
      }
      if (server !== null) await stopServer(server);
      server = null;
    });
  }
  const json = JSON.stringify(rows, null, 2);
  writeFileSync(join(OUT_DIR, "metrics.json"), json);
  await testInfo.attach("metrics.json", {
    body: json,
    contentType: "application/json",
  });
});

test.describe("狭い画面（375×667・タッチ）", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });

  test("手番で自動で開き、同じ手番で閉じたら再描画で開き直さない。閉じても下書きを保持し、CPU の Raise の後の手番で開いて再確認を求める", async ({
    page,
  }) => {
    server = await startServer(
      join(dir, "poker.sqlite"),
      huEnv(RAISE_SEED, 4_000),
    );
    const sent = recordPhysicalActions(page);
    await page.goto("/");
    await startFirstHand(page);
    await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();

    await test.step("Hero の手番で開いている。閉じると操作の欄だけが隠れ、再描画（演出の速度の変更）でも閉じたまま", async () => {
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
      await toggleOf(page).click();
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
      await expect(chipControls(page)).toBeHidden();
      // 手番の案内は閉じても見える
      await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
      // App 全体を描き直す（演出の速度を変えて戻す）。同じ手番なので開き直さない
      const speed = page.getByLabel("演出の速度");
      await speed.selectOption({ label: "高速" });
      await speed.selectOption({ label: "超高速" });
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
      await toggleOf(page).click();
      await expect(chipControls(page)).toBeVisible();
    });

    await test.step("手番の外で組んだ下書きは、閉じても残り、閉じた欄に手元・出した Chip の額が出る。開閉は送信にしない", async () => {
      await callAndWaitForCpu(page);
      // Hero の手番が終わっても自動では閉じない
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
      await pickAndPush(page, 2);
      await pick(page, 1);
      await toggleOf(page).click();
      await expect(chipControls(page)).toBeHidden();
      await expect(toggleOf(page)).toContainText("手元 1");
      await expect(toggleOf(page)).toContainText("出した Chip 2");
      expect(sent.count(), "開閉では送らない（Call の 1 回だけ）").toBe(1);
    });

    await test.step("CPU が Raise して Hero の手番が来たら自動で開き、下書きは補正されずに残る", async () => {
      await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
      await expect(handAmount(page)).toHaveText("1");
      await expect(pushedAmount(page)).toHaveText("2");
      await expect(discardNotice(page)).toHaveCount(0);
    });

    await test.step("確定は再確認になり、閉じて開いても再確認が残り、確定して初めて 1 回だけ送る", async () => {
      await submitButton(page).click();
      await expect(changeNotice(page)).toBeVisible();
      expect(sent.count()).toBe(1);
      await toggleOf(page).click();
      await expect(toggleOf(page)).toContainText("もう一度の確定が必要");
      await toggleOf(page).click();
      await expect(changeNotice(page)).toBeVisible();
      const response = waitForPhysicalResponse(page);
      await confirmButton(page).click();
      expect((await response).ok()).toBe(true);
      expect(sent.count()).toBe(2);
    });
  });

  test("ETIQUETTE の Ack 待ちは閉じても欄と「確認しました」が見え、開閉は Ack にならない。確認の後も閉じたまま", async ({
    page,
  }) => {
    server = await startServer(
      join(dir, "poker.sqlite"),
      huEnv(RAISE_SEED, 60_000),
    );
    const acks = countRequests(page, isEtiquetteAck);
    await page.goto("/");
    await startFirstHand(page);
    await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
    // Call 額があるのに Check を宣言すると check_facing_bet の RULING → ETIQUETTE（Hero の手番のまま）
    await declarationButton(page, /^チェック（Check）/).click();
    await expect(etiquetteOverlay(page)).toBeVisible();

    await test.step("閉じても ETIQUETTE の欄・「確認しました」は見え、押せる。閉じた欄に確認が要ることが出る", async () => {
      await toggleOf(page).click();
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
      await expect(toggleOf(page)).toContainText("Dealer の確認が必要");
      await expect(etiquetteOverlay(page)).toBeVisible();
      await ackButton(page).click({ trial: true });
      await expectNoBlockingOverlap(page, "ETIQUETTE（閉）");
      // 開け閉めしても確認は送らない
      await toggleOf(page).click();
      await toggleOf(page).click();
      await expect(etiquetteOverlay(page)).toBeVisible();
      expect(acks(), "開閉は Ack にならない").toBe(0);
    });

    await test.step("Home へ移って戻っても ETIQUETTE が出る（手番なのでパネルは開いて始まる）", async () => {
      await goTo(page, "Home");
      await goTo(page, "Play");
      await expect(etiquetteOverlay(page)).toBeVisible();
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
      expect(acks()).toBe(0);
    });

    await test.step("閉じたまま「確認しました」で 1 回だけ確認し、同じ手番なので閉じたまま。開くと操作できる", async () => {
      await toggleOf(page).click();
      await ackButton(page).click();
      await expect(etiquetteOverlay(page)).toBeHidden();
      expect(acks()).toBe(1);
      await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
      await toggleOf(page).click();
      await expect(declarationButton(page, /^コール（Call）/)).toBeEnabled();
    });
  });

  test("Click・キーボード・タッチの Drag で組め、移動の演出は下書きを遅らせない。reduced-motion・演出なしでは演出せず結果は同じ", async ({
    page,
  }) => {
    server = await startServer(
      join(dir, "poker.sqlite"),
      huEnv(RAISE_SEED, 60_000),
    );
    const sent = recordPhysicalActions(page);
    await page.goto("/");
    await startFirstHand(page);
    await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
    // 演出の要素が足された数を数える（一瞬で消えても数え漏らさない）
    await page.evaluate(() => {
      const w = window as unknown as { __flights: number };
      w.__flights = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof HTMLElement && n.classList.contains("chip-flight"))
              w.__flights++;
          }
        }
      }).observe(document.body, { childList: true });
    });
    const flights = () =>
      page.evaluate(
        () => (window as unknown as { __flights: number }).__flights,
      );
    const chip1 = dockOf(page).getByRole("button", {
      name: "1 の Chip を手に取る",
      exact: true,
    });

    await test.step("Click で手に取ると、手元の額は演出を待たずに変わり、Chip が手元へ飛ぶ", async () => {
      await chip1.click();
      expect(
        await handAmount(page).textContent(),
        "演出の途中でも下書きは変わっている",
      ).toBe("1");
      expect(await flights()).toBe(1);
      await expect(page.locator(".chip-flight")).toHaveCount(0);
    });

    await test.step("キーボード（Enter で手に取る・Space で出す）", async () => {
      await chip1.focus();
      await page.keyboard.press("Enter");
      await expect(handAmount(page)).toHaveText("2");
      await dockOf(page)
        .getByRole("button", {
          name: /^手に取った Chip .* を Betting Area に出す$/,
        })
        .focus();
      await page.keyboard.press("Space");
      await expect(pushedAmount(page)).toHaveText("2");
      await expect(handAmount(page)).toHaveText("0");
      // 手に取る 2 回・出す 1 回の演出
      expect(await flights()).toBe(3);
    });

    await test.step("タッチの Drag で Stack の Chip を Betting Area へ直接出す（Drag は演出を足さない）", async () => {
      expect(
        await touchDrag(page, chip1, dockOf(page).locator(".betting-area")),
      ).toBe(true);
      await expect(pushedAmount(page)).toHaveText("3");
      await expect(handAmount(page)).toHaveText("0");
      expect(await flights()).toBe(3);
    });

    await test.step("reduced-motion・演出なしでは演出の要素を作らず、操作の結果は同じ", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await chip1.click();
      await expect(handAmount(page)).toHaveText("1");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByLabel("演出の速度").selectOption({ label: "演出なし" });
      await chip1.click();
      await expect(handAmount(page)).toHaveText("2");
      expect(await flights(), "演出しない").toBe(3);
    });

    await test.step("組む間は 1 回も送らず、確定で 1 回だけ送る", async () => {
      expect(sent.count()).toBe(0);
      const response = waitForPhysicalResponse(page);
      await submitButton(page).click();
      await response;
      expect(sent.count()).toBe(1);
    });
  });

  test("Drag の Drop と CPU の Action による表示の更新が重なっても、確定せずに送らず、送るときは最新の卓で照合する（#251 の P3 の回帰）", async ({
    page,
  }) => {
    server = await startServer(
      join(dir, "poker.sqlite"),
      huEnv(RAISE_SEED, 1_500),
    );
    const sent = recordPhysicalActions(page);
    await page.goto("/");
    await startFirstHand(page);
    await callAndWaitForCpu(page);
    const chip1 = dockOf(page).getByRole("button", {
      name: "1 の Chip を手に取る",
      exact: true,
    });
    const area = dockOf(page).locator(".betting-area");
    const turn = dockOf(page).getByText("Hero の手番です。");
    // CPU の思考（1.5 秒）の間、Hero の手番が来るまで Drag で 1 を出し続ける（Drop の直後に CPU の Raise が届く時点を跨ぐ）
    for (let i = 0; i < 60 && !(await turn.isVisible()); i++) {
      await touchDrag(page, chip1, area);
    }
    await expect(turn).toBeVisible();
    expect(sent.count(), "Drag の間は送らない（Call の 1 回だけ）").toBe(1);
    const pushed = Number((await pushedAmount(page).textContent()) ?? "0");
    expect(pushed, "Drag で出した額").toBeGreaterThan(0);

    // 確定: 錨と状況を照合する（CPU が Raise したので再確認になる。錨が古ければ捨てて通知する）。どちらでも黙って送らない
    await submitButton(page).click();
    await expect(changeNotice(page).or(discardNotice(page))).toBeVisible();
    expect(sent.count(), "確定の時点では送らない").toBe(1);
    if (await changeNotice(page).isVisible()) {
      const response = waitForPhysicalResponse(page);
      await confirmButton(page).click();
      await response;
      expect(sent.count()).toBe(2);
      const last = sent.bodies()[1];
      const chips = (last?.actions ?? []).reduce((total, op) => {
        const c = op["chips"];
        return Array.isArray(c)
          ? total + (c as number[]).reduce((a, v) => a + v, 0)
          : total;
      }, 0);
      expect(chips, "出した Chip のとおりに送る（補正しない）").toBe(pushed);
    }
  });
});
