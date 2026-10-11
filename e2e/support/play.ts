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

/**
 * 起動（goto / reload）の直後に出る Home（#218・D136）から、Hero の明示の操作で Hand を始め、その handId を返す。
 * Home は Session の状態を読むだけなので、押す前の Home の表示（照会の結果）を待ってから押す。
 * - 新しい Session を始める: Session が無い・終わったとき（種類は押す前に Home の「新しい Session の種類」で選ぶ）
 * - 続きから遊ぶ: Session が続いているとき（再起動後の Resume など）
 */
export async function startFirstHand(
  page: Page,
  buttonName:
    "新しい Session を始める" | "続きから遊ぶ" = "新しい Session を始める",
): Promise<string> {
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands",
    ),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  expect(res.ok(), "最初の Hand の開始").toBe(true);
  return ((await res.json()) as { handId: string }).handId;
}

/**
 * POST /api/hands（Hand の開始の要求）を数え始める。返す関数で、それまでに送った数を読む（画面の移動・Home の表示で開始を送って
 * いないことの検査に使う。#218）。page.goto の前に呼ぶ。
 */
export function countHandStarts(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/hands"
    ) {
      count++;
    }
  });
  return () => count;
}

/** Session が終わったか（Hero の欄の表示）。 */
export async function sessionEnded(page: Page): Promise<boolean> {
  return page
    .getByRole("region", { name: "Hero" })
    .getByText("Session が終了しました。")
    .first()
    .isVisible();
}
