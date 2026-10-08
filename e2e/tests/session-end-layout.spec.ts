// Session の終わりの配置の E2E（#158）: 既定の 1280×720 でも、Session が終わった後の「この Session を振り返る」「新しい Session を始める」が
// Hero の席に覆われず押せる。画面の高さによって、卓の中央の結果の欄が下の Hero の席と重なっていた（Button が縦に 2 つ並ぶ分、背が高い）。
// 山札の seed を固定し、既定の 6 人卓・Hero が Call / Check だけで打つと数 Hand で Bust する（RuleBot の決定論。opponent-memory.spec.ts と同じ seed）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
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

/** Session の終わりに出る 2 つの Button。 */
const SESSION_END_BUTTONS = [
  "この Session を振り返る",
  "新しい Session を始める",
] as const;

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-session-end-"));
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

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/** 席・卓の中央の結果の欄・Session の終わりの Button の矩形と、Button の中心を覆う要素が Button 自身か。 */
async function measure(page: Page): Promise<{
  seats: Rect[];
  centerResult: Rect | null;
  buttons: { name: string; rect: Rect; reachable: boolean }[];
  overflowX: number;
}> {
  return page.evaluate((names) => {
    const rectOf = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const result = document.querySelector(".table .result");
    return {
      seats: [...document.querySelectorAll(".table .seat")].map(rectOf),
      centerResult: result === null ? null : rectOf(result),
      buttons: names.map((name) => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === name,
        );
        if (button === undefined) throw new Error(`Button が無い: ${name}`);
        const rect = rectOf(button);
        const hit = document.elementFromPoint(
          (rect.left + rect.right) / 2,
          (rect.top + rect.bottom) / 2,
        );
        return { name, rect, reachable: hit !== null && button.contains(hit) };
      }),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  }, SESSION_END_BUTTONS);
}

test("Session が終わった後の Button が、画面の高さによらず Hero の席に覆われず押せる（1280×720 を含む）", async ({
  page,
}) => {
  test.setTimeout(180_000);
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });

  // Hand は一覧の並びではなく、開始の応答の handId で特定する（#129・D117）。
  const handIds: string[] = [];
  await test.step("Hero が Bust して Session が終わるまで Play する（既定の 1280×720）", async () => {
    expect(page.viewportSize(), "既定の画面の大きさ").toEqual({
      width: 1280,
      height: 720,
    });
    await page.goto("/");
    handIds.push(await startFirstHand(page));
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

  // 席・結果の欄と Button が重ならないこと（矩形）と、Button の中心を Button 自身が受けること（押せる）を、画面の大きさごとに測る。
  // 1280×720 が #158 の再現。1024×768 は卓が小さい（幅 676px）ので、結果の欄が席に近い。
  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
  ] as const) {
    await test.step(`${width}×${height}: 結果の欄・Button が席と重ならない`, async () => {
      await page.setViewportSize({ width, height });
      const dock = page.getByRole("region", { name: "Hero" });
      for (const name of SESSION_END_BUTTONS) {
        await expect(dock.getByRole("button", { name })).toBeVisible();
      }
      const m = await measure(page);
      for (const seat of m.seats) {
        if (m.centerResult !== null) {
          expect(
            intersects(m.centerResult, seat),
            `卓の中央の結果の欄が席と重なっている: ${JSON.stringify(seat)}`,
          ).toBe(false);
        }
        for (const b of m.buttons) {
          expect(
            intersects(b.rect, seat),
            `${b.name} が席と重なっている: ${JSON.stringify(seat)}`,
          ).toBe(false);
        }
      }
      for (const b of m.buttons) {
        expect(b.reachable, `${b.name} の中心が別の要素に覆われている`).toBe(
          true,
        );
      }
      expect(m.overflowX, "横スクロール").toBe(0);
    });
  }

  await test.step("通常の click（force なし）で、振り返る → 卓に戻る → 新しい Session を始める", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "この Session を振り返る" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Session の振り返り（Session Review）",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "卓に戻る" }).click();
    const next = await startNextHand(page, "新しい Session を始める");
    expect(handIds, "新しい Session の Hand は別の Hand").not.toContain(next);
    expect(await sessionEnded(page), "新しい Session は続く").toBe(false);
  });
});

test.describe("狭い画面での Session の終わり（既存の配置を壊さない）", () => {
  for (const [width, height] of [
    [375, 667],
    [320, 568],
  ] as const) {
    test(`${width}×${height}: Button は Hero の欄に出て、席に覆われず、横スクロールは出ない`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      server = await startServer(join(dir, "poker.sqlite"), {
        POKER_SEED: SEED,
      });
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await startFirstHand(page);
      for (let i = 0; i < 30; i++) {
        await playToHandEnd(page);
        if (await sessionEnded(page)) break;
        await startNextHand(page);
      }
      expect(await sessionEnded(page), "Session が終わった").toBe(true);

      // 狭い画面は結果を卓の中央に出さず、Hero の欄に置く。
      await expect(page.locator(".table .result")).toHaveCount(0);
      const dock = page.getByRole("region", { name: "Hero" });
      for (const name of SESSION_END_BUTTONS) {
        await expect(dock.getByRole("button", { name })).toBeVisible();
      }
      const m = await measure(page);
      for (const b of m.buttons) {
        expect(b.reachable, `${b.name} の中心が別の要素に覆われている`).toBe(
          true,
        );
      }
      expect(m.overflowX, "横スクロール").toBe(0);
      // 通常の click で押せる（覆われていれば待ち続けて失敗する）。
      await dock
        .getByRole("button", { name: "この Session を振り返る" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Session の振り返り（Session Review）",
        }),
      ).toBeVisible();
    });
  }
});
