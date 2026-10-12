// Hero の操作の下書き（TurnDraft。#219・D146）の寿命の E2E: 下書き（手元の Chip・Betting Area の Chip・宣言）は Session ごとに画面の切り替えより
// 上で持ち、Home / Learn への移動と復帰・CPU の動き・Hero の手番が来ることでは消えない。Street の変化などで無効になれば、中身があったときだけ通知する。
// 組んだ後に同じ Street で currentBet が変わったら送らずに再確認させ、送信の応答が届かなければ同じ操作の再送だけを許し、stale_view は
// 自動で送り直さない。実サーバー（RuleBot・固定の山札・HU 卓）で確かめる。障害は server に入れず、ブラウザ側の page.route だけで起こす。
// Outage（障害のダイアログ）は E2E で起こせないので扱わない（component テストで確かめる）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ackButton, etiquetteOverlay } from "../support/etiquette.js";
import { startFirstHand } from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";
import {
  RAISE_SEED,
  STREET_SEED,
  changeNotice,
  confirmButton,
  declarationButton,
  declaredLabel,
  discardNotice,
  dockOf,
  goTo,
  handAmount,
  huEnv,
  pickAndPush,
  pick,
  pushedAmount,
  recordPhysicalActions,
  resendButton,
  startHuAndCall,
  submitButton,
  waitForPhysicalResponse,
} from "../support/turn-draft.js";

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-turn-draft-"));
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

/** 送った操作のうち Chip を出した動作の合計額。 */
function chipsOf(actions: Record<string, unknown>[]): number {
  return actions.reduce((total, op) => {
    const chips = op["chips"];
    return Array.isArray(chips)
      ? total + (chips as number[]).reduce((a, c) => a + c, 0)
      : total;
  }, 0);
}

/**
 * RAISE_SEED で、Hero の Call の後の CPU の思考待ちに、手元 1 枚・Betting Area に 2 を組む。CPU が 4 へ Raise し、Hero の手番が来るまで待つ。
 * 組んだ額（Call に要る額 2 ちょうど）は補正されず、そのまま残る。
 */
async function buildDraftThenCpuRaises(page: Page): Promise<void> {
  await startHuAndCall(page);
  await pickAndPush(page, 2);
  await pick(page, 1);
  await expect(handAmount(page)).toHaveText("1");
  await expect(pushedAmount(page)).toHaveText("2");
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
}

test("手番外で組んだ下書きは、Home / Learn / Replay の往復で消えない", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 15_000),
  );
  await startHuAndCall(page);
  await pickAndPush(page, 2);
  await pick(page, 1);
  await expect(handAmount(page)).toHaveText("1");
  await expect(pushedAmount(page)).toHaveText("2");

  await test.step("Home を挟んでも手元 1・Betting Area 2 が残る", async () => {
    await goTo(page, "Home");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await goTo(page, "Play");
    await expect(handAmount(page)).toHaveText("1");
    await expect(pushedAmount(page)).toHaveText("2");
  });

  await test.step("Learn と Replay を挟んでも残る", async () => {
    await goTo(page, "Learn");
    await page.getByRole("button", { name: "Replay を開く" }).click();
    await expect(page.locator(".replay-item").first()).toBeVisible();
    await goTo(page, "Play");
    await expect(handAmount(page)).toHaveText("1");
    await expect(pushedAmount(page)).toHaveText("2");
    await expect(discardNotice(page)).toHaveCount(0);
  });
});

test("CPU が Raise した後の再確認: 送らずに前後を示し、確定して初めて 1 回だけ組んだとおりに送る", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 4_000),
  );
  const sent = recordPhysicalActions(page);
  await buildDraftThenCpuRaises(page);
  // Call の宣言 1 回だけを送った（下書きを組む間は送っていない）。
  expect(sent.count()).toBe(1);

  await test.step("CPU の Raise を挟んでも下書きは残り、通知は出ない", async () => {
    await expect(handAmount(page)).toHaveText("1");
    await expect(pushedAmount(page)).toHaveText("2");
    await expect(discardNotice(page)).toHaveCount(0);
  });

  await test.step("「確定して Dealer に渡す」は送らず、変化の前後と送る操作を示す", async () => {
    await submitButton(page).click();
    const notice = changeNotice(page);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("この Street の Bet の額");
    await expect(notice).toContainText("2 → 4");
    await expect(notice).toContainText("送る操作: 出した Chip 2");
    expect(sent.count(), "再確認の前に送らない").toBe(1);
  });

  await test.step("「この内容で確定して Dealer に渡す」で 1 回だけ、組んだとおり（補正なし）に送る", async () => {
    const response = waitForPhysicalResponse(page);
    await confirmButton(page).click();
    await response;
    expect(sent.count()).toBe(2);
    const body = sent.bodies()[1];
    expect(chipsOf(body?.actions ?? []), "Chip は組んだ額のまま").toBe(2);
    expect(
      (body?.actions ?? []).some((op) => op["type"] === "declare"),
      "宣言を足さない",
    ).toBe(false);
    await expect(changeNotice(page)).toBeHidden();
    // 送った下書きは消費される（通知なし）。
    await expect(pushedAmount(page)).toHaveCount(0);
    await expect(discardNotice(page)).toHaveCount(0);
  });
});

test("空の下書きのまま Street が進んでも、通知は出ない", async ({ page }) => {
  // STREET_SEED: Hero の Call の後、CPU が Check して Flop になり、Flop で CPU が先に Bet する。
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(STREET_SEED, 3_000),
  );
  await startHuAndCall(page);
  // Street が進んだ後の Hero の手番が来るまで待つ（その間に下書きを組んでいない）。
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible({
    timeout: 20_000,
  });
  await expect(discardNotice(page)).toHaveCount(0);
  await expect(handAmount(page)).toHaveText("0");
});

test("Call の後の Street の変化で、手番外に組んだ下書きが戻され、送っていないことを通知する", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(STREET_SEED, 3_000),
  );
  const sent = recordPhysicalActions(page);
  await startHuAndCall(page);
  await pickAndPush(page, 1);
  await pick(page, 1);
  await expect(pushedAmount(page)).toHaveText("1");

  // CPU の Check → Flop で Street が進む。
  const notice = discardNotice(page);
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("Street が進んだため");
  await expect(notice).toContainText("この操作は送っていません。");
  await expect(handAmount(page)).toHaveText("0");
  await expect(pushedAmount(page)).toHaveCount(0);
  expect(sent.count(), "下書きは送られていない").toBe(1);

  await notice.getByRole("button", { name: "閉じる" }).click();
  await expect(notice).toBeHidden();
});

test("応答だけが失われ server は受理していた: SSE で Hero の操作が見えると、下書きは通知なしで消え、自動で送り直さない", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 4_000),
  );
  const sent = recordPhysicalActions(page);
  let drops = 0;
  await page.route("**/api/hands/*/physical-actions", async (route) => {
    drops++;
    if (drops > 1) return route.continue();
    // server に通して受理させ、応答だけを捨てる。
    await route.fetch();
    await route.abort();
  });
  await page.goto("/");
  await startFirstHand(page);
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
  // Hero の SB の手番（Call は 1）。Chip を 1 枚出して Dealer に渡す。
  await pickAndPush(page, 1);
  await submitButton(page).click();

  // 応答が無くても、SSE で Hero の操作が見えたら下書きは黙って消える（通知なし）。再送ボタンが出る時間は SSE の到着との競合なので、
  // 途中の表示は確かめず、最終の状態（消えている・再送ボタンが残らない）だけを見る。
  await expect(pushedAmount(page)).toHaveCount(0);
  await expect(resendButton(page)).toHaveCount(0);
  await expect(discardNotice(page)).toHaveCount(0);
  await expect(handAmount(page)).toHaveText("0");
  expect(sent.count(), "自動で送り直さない").toBe(1);
});

test("応答も届かない: 再送ボタンが出て、押すと同じ lastSeq・同じ操作で送り直す", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 60_000),
  );
  const sent = recordPhysicalActions(page);
  let attempts = 0;
  await page.route("**/api/hands/*/physical-actions", async (route) => {
    attempts++;
    // 1 回目は server に届かない（network エラー）。2 回目は通す。
    if (attempts === 1) return route.abort();
    await route.continue();
  });
  await page.goto("/");
  await startFirstHand(page);
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
  await pickAndPush(page, 1);
  await submitButton(page).click();

  await expect(resendButton(page)).toBeVisible();
  // 下書きは消えず、操作できない（Chip を足せない）。
  await expect(pushedAmount(page)).toHaveText("1");
  await expect(
    dockOf(page).getByRole("button", {
      name: "1 の Chip を手に取る",
      exact: true,
    }),
  ).toBeDisabled();
  expect(sent.count()).toBe(1);

  await resendButton(page).click();
  await expect(resendButton(page)).toBeHidden();
  await expect(pushedAmount(page)).toHaveCount(0);
  expect(sent.count()).toBe(2);
  expect(sent.bodies()[1]).toEqual(sent.bodies()[0]);
  await expect(discardNotice(page)).toHaveCount(0);
});

test("stale_view で拒否されても下書きは残り、宣言は下書きに残らず、自動で送り直さない", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 60_000),
  );
  const sent = recordPhysicalActions(page);
  await page.route("**/api/hands/*/physical-actions", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { kind: "stale_view", message: "x" },
      }),
    }),
  );
  await page.goto("/");
  await startFirstHand(page);
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
  await pickAndPush(page, 1);
  await declarationButton(page, /^コール（Call）/).click();
  await expect.poll(() => sent.count()).toBe(1);

  // 拒否された後も、Chip は残り、送ろうとした Call の宣言は下書きに足されない。
  await expect(pushedAmount(page)).toHaveText("1");
  await expect(declaredLabel(page)).toHaveCount(0);
  await expect(resendButton(page)).toHaveCount(0);
  // 自動の再送が起きないことを、少し待ってから数え直して確かめる（拒否の後の再読込・再描画の時間）。
  await page.waitForTimeout(1_500);
  expect(sent.count()).toBe(1);
  await expect(pushedAmount(page)).toHaveText("1");
});

test("手番外の Call の宣言は保留の裁定になり、送った下書きは通知なしで消える（Out-of-Turn）", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 20_000),
  );
  const sent = recordPhysicalActions(page);
  await startHuAndCall(page);
  await pickAndPush(page, 1);
  const response = waitForPhysicalResponse(page);
  await declarationButton(page, /^コール（Call）/).click();
  expect((await response).ok()).toBe(true);
  expect(sent.count()).toBe(2);

  // Hero への裁定（Out-of-Turn の保留）で下書きは役目を終えて消える。無効化ではないので通知しない。
  await expect(pushedAmount(page)).toHaveCount(0);
  await expect(handAmount(page)).toHaveText("0");
  await expect(discardNotice(page)).toHaveCount(0);
});

test("ETIQUETTE の Ack 待ちは操作欄が隠れ、Home 往復でも再表示される。確認の後に組んだ下書きは Home 往復で残る", async ({
  page,
}) => {
  server = await startServer(
    join(dir, "poker.sqlite"),
    huEnv(RAISE_SEED, 60_000),
  );
  await page.goto("/");
  await startFirstHand(page);
  await expect(dockOf(page).getByText("Hero の手番です。")).toBeVisible();
  // Call 額があるのに Check を宣言すると check_facing_bet の RULING → ETIQUETTE になる（Action は決まらず Hero の手番のまま）。
  await declarationButton(page, /^チェック（Check）/).click();
  await expect(etiquetteOverlay(page)).toBeVisible();

  await test.step("Ack 待ちの間は操作欄（Chip・宣言）が隠れ、下書きを組む経路が無い", async () => {
    await expect(
      dockOf(page).getByRole("button", {
        name: "1 の Chip を手に取る",
        exact: true,
      }),
    ).toBeHidden();
    await expect(declarationButton(page, /^コール（Call）/)).toBeHidden();
  });

  await test.step("Home へ移って戻っても ETIQUETTE が再び出る", async () => {
    await goTo(page, "Home");
    await goTo(page, "Play");
    await expect(etiquetteOverlay(page)).toBeVisible();
  });

  await test.step("確認しました の後に操作欄が戻り、その後に組んだ下書きは Home 往復で残る", async () => {
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toBeHidden();
    await expect(declarationButton(page, /^コール（Call）/)).toBeVisible();
    await pickAndPush(page, 1);
    await pick(page, 1);
    await goTo(page, "Home");
    await goTo(page, "Play");
    await expect(handAmount(page)).toHaveText("1");
    await expect(pushedAmount(page)).toHaveText("1");
    await expect(discardNotice(page)).toHaveCount(0);
  });
});

test.describe("狭い画面（320×568）", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("下書きが残り、再確認欄の確定を押せて、横スクロールが無い。キーボードでも確定できる", async ({
    page,
  }) => {
    server = await startServer(
      join(dir, "poker.sqlite"),
      huEnv(RAISE_SEED, 4_000),
    );
    const sent = recordPhysicalActions(page);
    await buildDraftThenCpuRaises(page);
    await expect(handAmount(page)).toHaveText("1");
    await expect(pushedAmount(page)).toHaveText("2");

    await submitButton(page).click();
    await expect(changeNotice(page)).toBeVisible();
    expect(sent.count()).toBe(1);

    // 覆われていない（通常の click の確認）。画面の幅を超えない。
    await confirmButton(page).click({ trial: true });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, "横スクロール").toBeLessThanOrEqual(0);

    // Tab で確定の Button まで移り、Enter で確定する。
    const target = confirmButton(page);
    await page.keyboard.press("Tab");
    for (let i = 0; i < 60; i++) {
      if (await target.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(target).toBeFocused();
    const response = waitForPhysicalResponse(page);
    await page.keyboard.press("Enter");
    await response;
    expect(sent.count()).toBe(2);
    expect(chipsOf(sent.bodies()[1]?.actions ?? [])).toBe(2);
  });
});
