// 6-max の卓を Hand の終わり・Session の終わりまで進める E2E の共通手順（Call / Check だけで打つ。Fold しないので、数 Hand で Bust しうる）。
// テストの手順だけの待ち・読み取りで、プロダクトの挙動は変えない。
import { expect, type Locator, type Page } from "@playwright/test";

/** 宣言 Button の補助の額（Call は Legal Action の額。合法でなければ出ない）。 */
async function declaredAmount(button: Locator): Promise<number | null> {
  const amount = button.locator(".declaration__amount");
  if ((await amount.count()) === 0) return null;
  const text = (await amount.innerText()).replace(/[,，]/g, "");
  const match = /^\d+/.exec(text);
  return match === null ? null : Number(match[0]);
}

/** Hand の終わりまで、Hero は Call できれば Call、できなければ Check で進める（Fold しないので、数 Hand で Bust しうる）。 */
export async function playToHandEnd(page: Page): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  for (let turn = 0; turn < 30; turn++) {
    const done = dock.getByText(
      /Hand が終了しました。|Session が終了しました。/,
    );
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return;

    const before = await log.count();
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    if ((await declaredAmount(call)) !== null) {
      await call.click();
    } else {
      await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    }
    // 操作が裁定されて卓の状態が進む（ログの行が増える）まで待ってから、次の手番を読む（古い画面で二重に操作しない）。
    await expect
      .poll(() => log.count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  }
  throw new Error("Hand が 30 手番で終わらなかった");
}

/** 最初の Hand を始め、その handId を返す。 */
export async function startFirstHand(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands",
    ),
    page.getByRole("button", { name: "Hand を始める" }).click(),
  ]);
  expect(res.ok(), "最初の Hand の開始").toBe(true);
  return ((await res.json()) as { handId: string }).handId;
}

/** Session が終わったか（Hero の欄の表示）。 */
export async function sessionEnded(page: Page): Promise<boolean> {
  return page
    .getByRole("region", { name: "Hero" })
    .getByText("Session が終了しました。")
    .first()
    .isVisible();
}
