// 卓の配置の E2E（#163）: 720〜1023px の中間幅で、画面下に固定した Hero の欄が折り返して高くなり（720×600 で 434px）、卓の下側を
// 覆っていた。Hand の途中（Hero の手番）・Hand の終わり・Session の終わりを、画面の大きさ（720×600・1024×768・1280×720・375×667・320×568）ごとに
// 測り、席・Board・Pot・操作の欄・Session の終わりの Button に、操作できなくなる重なりが無いことを確かめる。
// #179: 裁定（RULING）が Hero 欄に出ると欄が約 100px 高くなり、720×600 で Hero の席・Board・Pot が収まらず、320×568 で欄が画面より
// 高くなった。最初の Hand の Hero の手番で、Call 額があるのに Check を宣言して RULING（check_facing_bet。Action は決まらず Hero の手番の
// まま）を決定論的に出し、同じ画面の大きさで測る。
// #226: 裁定（RULING）の後、作法の注意（ETIQUETTE）は Hero が「確認しました」を押すまで進行を止める。RULING の欄 → ETIQUETTE の欄 →
// 確認 → 進行の再開を通し、ETIQUETTE を出している間の 5 つの画面の大きさで、欄が Pot・Hero の札と Stack に重ならず、「確認しました」を
// 通常の click で押せて、フォーカスがそこにあることを確かめる。RULING の Feedback の配置（#179）は、確認の後の Hero の手番で測る。
// 山札の seed は session-end-layout.spec.ts と同じ（既定の 6 人卓・Hero が Call / Check だけで打つと数 Hand で Bust する）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  ackButton,
  etiquetteOverlay,
  rulingOverlay,
} from "../support/etiquette.js";
import {
  expectClickable,
  expectNoBlockingOverlap,
  intersects,
  LAYOUT_VIEWPORTS,
  type Rect,
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

/** ETIQUETTE の欄を測る画面の大きさ（LAYOUT_VIEWPORTS に無い 1280×900 も足す）。 */
const ETIQUETTE_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 720, height: 600 },
  { width: 1280, height: 720 },
  { width: 1280, height: 900 },
] as const;

/** 画面の中の矩形（無ければ null）。 */
async function rectOf(page: Page, selector: string): Promise<Rect | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);
}

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

test("Hand の途中（Hero の手番）・裁定（RULING）が出た手番・Hand の終わり・Session の終わりで、中間幅を含む画面の大きさごとに、卓と Hero 欄が操作できなくなる重なりを作らない", async ({
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

  await test.step("裁定（RULING）が出た Hero の手番", async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    // この seed の最初の Hand は、Hero に Call 額がある（Check の宣言は裁定で採られない）。seed が変わったらここで気付く。
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    await expect(call.locator(".declaration__amount")).toBeVisible();
    await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    // RULING の欄（裁定の事実）→ 数秒で閉じて ETIQUETTE の欄（作法の注意）。check_facing_bet は確認が要る（D145）。
    await expect(rulingOverlay(page)).toContainText(
      "相手の Bet があるので、Check の宣言は受けられません。",
    );
    await expect(etiquetteOverlay(page)).toBeVisible();
    await expect(rulingOverlay(page)).toHaveCount(0);
    for (const { width, height } of ETIQUETTE_VIEWPORTS) {
      const label = `ETIQUETTE ${width}×${height}`;
      await page.setViewportSize({ width, height });
      // 画面の幅に依らず Hero 欄に、欄は 1 つだけ出る（卓の中央には出さない。置き場所の回帰も捕まえる）。
      await expect(etiquetteOverlay(page)).toHaveCount(1);
      await expect(dock.getByRole("alertdialog")).toBeVisible();
      // 欄の間は Hero 欄の操作の欄を隠す（外さない）。
      await expect(
        dock.getByRole("group", { name: "宣言（Declaration）" }),
      ).toBeHidden();
      // 通常の click（force なし。trial: 覆われていない・安定している）で押せ、フォーカスがそのボタンにある。
      await ackButton(page).click({ trial: true });
      await expect(ackButton(page), `${label}: フォーカス`).toBeFocused();
      // Hero 欄は画面下に sticky で固定され、文書の末尾では通常の位置に戻る（#163・#179 の配置の規則）。欄は Hero 欄の中にあるので、
      // 既存の Hero 欄の規則（狭い画面は欄が画面の高さに収まる・広い画面は欄を除いた高さに Hero の席・Board・Pot が収まる・Button が
      // 覆われない・横スクロールが無い）で確かめ、末尾の位置で欄が Pot と Hero の札・Stack に重ならないことを確かめる。
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await expectNoBlockingOverlap(page, label);
      const overlay = await rectOf(page, ".dealer-overlay");
      expect(overlay, `${label}: 欄`).not.toBeNull();
      for (const [name, selector] of [
        ["Pot", ".table .pot"],
        ["Hero の札・Stack", ".dock__hero"],
      ] as const) {
        const other = await rectOf(page, selector);
        if (overlay === null || other === null) continue;
        expect(
          intersects(overlay, other),
          `${label}: 欄と ${name} が重なっている: ${JSON.stringify(overlay)} / ${JSON.stringify(other)}`,
        ).toBe(false);
      }
    }
    // 確認すると欄が閉じ、Hero の手番の操作が再開する（check_facing_bet は Action を決めないので、Hero の手番のまま）。
    await page.setViewportSize({ width: 1280, height: 720 });
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(
      dock
        .getByRole("group", { name: "宣言（Declaration）" })
        .getByRole("button", { name: /^コール（Call）/ }),
    ).toBeEnabled();
    const ruling = dock.locator(".feedback__item--ruling");
    await expect(ruling).toContainText(
      "相手の Bet があるので、Check の宣言は受けられません。",
    );
    await expect(dock.getByText("Hero の手番です。")).toBeVisible();
    for (const { width, height } of LAYOUT_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(ruling).toBeVisible();
      await expectNoBlockingOverlap(page, `RULING ${width}×${height}`);
      // 宣言 Button と、裁定の用語・作法の補足の Button が、通常の click で押せる（用語の「チェック（Check）」と宣言の Button は
      // 同じ名前なので、置き場所で分ける）。
      const declarations = dock.getByRole("group", {
        name: "宣言（Declaration）",
      });
      for (const name of [
        "フォールド（Fold）",
        "チェック（Check）",
        "コール（Call）",
        "ベット（Bet）",
        "レイズ（Raise）",
        "オールイン（All-in）",
      ]) {
        await declarations.getByRole("button", { name }).click({ trial: true });
      }
      for (const name of ["チェック（Check）", "作法（Etiquette）"]) {
        await ruling.getByRole("button", { name }).click({ trial: true });
      }
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
